import {
  buildAppServerThreadStartParams,
  buildAppServerTurnParams,
} from './app-server-client.mjs';
import {
  createId,
  extractLocalArtifactPathsFromText,
  formatError,
  parseArtifactEnvelope,
  truncateText,
} from './utils.mjs';

export class CodexRunner {
  constructor(options) {
    this.config = options.config;
    this.sessionStore = options.sessionStore;
    this.artifactManager = options.artifactManager;
    this.publishEvent = options.publishEvent;
    this.appServerClient = options.appServerClient;
    this.activeRuns = new Map();
    this.threadToSession = new Map();

    this.handleNotification = this.handleNotification.bind(this);
    this.appServerClient.on('notification', this.handleNotification);
  }

  isRunning(sessionId) {
    return this.activeRuns.has(sessionId);
  }

  async start(sessionId, prompt, options = {}) {
    const session = this.sessionStore.resolve(sessionId) || this.sessionStore.get(sessionId);
    if (!session) {
      throw new Error('会话不存在');
    }

    const normalizedPrompt = String(prompt || '').trim();
    if (!normalizedPrompt) {
      throw new Error('消息不能为空');
    }

    if (this.activeRuns.has(session.id)) {
      throw new Error('当前会话仍在执行中');
    }

    let threadId = String(session.codexThreadId || session.id || '').trim();
    if (!threadId || threadId.startsWith('web-')) {
      threadId = await this.createThreadForSession(session);
    } else {
      try {
        await this.appServerClient.readThread(threadId);
      } catch (error) {
        if (!isThreadNotFoundError(error)) {
          throw error;
        }
        threadId = await this.createThreadForSession(session);
        this.publishEvent(session.id, 'status', {
          text: '原生历史线程不可直接续聊，已切换到新的续聊线程',
        });
      }
    }

    const resolvedSession = this.sessionStore.resolve(threadId) || this.sessionStore.resolve(session.id) || session;
    const run = {
      id: createId('run'),
      sessionId: resolvedSession.id,
      threadId,
      prompt: normalizedPrompt,
      startedAt: new Date().toISOString(),
      turnId: '',
      stopRequested: false,
      stopReason: '',
      timeoutHandle: null,
      finalized: false,
      agentMessageBuffer: new Map(),
      publishedMessageIds: new Set(),
    };

    this.activeRuns.set(run.sessionId, run);
    this.threadToSession.set(threadId, run.sessionId);
    const displayPrompt = String(options.displayPrompt || normalizedPrompt).trim() || normalizedPrompt;
    this.sessionStore.appendMessage(run.sessionId, 'user', displayPrompt, {
      attachments: Array.isArray(options.attachments) ? options.attachments : [],
      source: options.messageSource || 'web',
    });
    this.sessionStore.updateSession(run.sessionId, {
      codexThreadId: threadId,
      status: 'running',
      lastError: '',
      preview: truncateText(displayPrompt.replace(/\s+/g, ' '), 120),
      currentRun: {
        id: run.id,
        startedAt: run.startedAt,
      },
    });

    this.publishEvent(run.sessionId, 'status', {
      text: '已提交到 Codex',
      runId: run.id,
    });

    run.timeoutHandle = setTimeout(() => {
      void this.stop(run.sessionId, 'timeout');
    }, this.config.requestTimeoutMs);

    try {
      await this.startTurnWithRecovery(run, resolvedSession, normalizedPrompt);
    } catch (error) {
      this.finalizeRun(run, {
        status: 'error',
        error,
      });
      throw error;
    }

    return {
      runId: run.id,
      startedAt: run.startedAt,
    };
  }

  async startTurnWithRecovery(run, session, prompt) {
    try {
      await this.appServerClient.startTurn(
        buildAppServerTurnParams(
          this.config,
          run.threadId,
          buildWebPrompt(prompt),
          session.workdir || this.config.webWorkdir,
        ),
      );
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }

      const nextThreadId = await this.createThreadForSession(session);
      const previousThreadId = run.threadId;
      run.threadId = nextThreadId;
      this.threadToSession.set(nextThreadId, run.sessionId);
      if (this.threadToSession.get(previousThreadId) === run.sessionId) {
        this.threadToSession.delete(previousThreadId);
      }

      this.sessionStore.updateSession(run.sessionId, {
        codexThreadId: nextThreadId,
        status: 'running',
        lastError: '',
        currentRun: {
          id: run.id,
          startedAt: run.startedAt,
        },
      });

      this.publishEvent(run.sessionId, 'status', {
        text: '原线程已失效，已切换到新的续聊线程',
        runId: run.id,
      });

      await this.appServerClient.startTurn(
        buildAppServerTurnParams(
          this.config,
          nextThreadId,
          buildWebPrompt(prompt),
          session.workdir || this.config.webWorkdir,
        ),
      );
    }
  }

  async createThreadForSession(session) {
    const created = await this.appServerClient.startThread(
      buildAppServerThreadStartParams(this.config, session.workdir || this.config.webWorkdir),
    );
    const threadId = String(created?.thread?.id || '').trim();
    if (!threadId) {
      throw new Error('创建线程失败');
    }

    const sessionTitle = String(session?.title || '').trim();
    if (sessionTitle && sessionTitle !== '新会话' && sessionTitle !== '历史会话') {
      await this.appServerClient.setThreadName(threadId, sessionTitle).catch(() => null);
    }

    this.sessionStore.updateSession(session.id, {
      codexThreadId: threadId,
    });

    return threadId;
  }

  async stop(sessionId, reason = 'manual') {
    const run = this.activeRuns.get(sessionId);
    if (!run) {
      return false;
    }

    if (run.stopRequested) {
      return true;
    }

    run.stopRequested = true;
    run.stopReason = reason;
    this.publishEvent(run.sessionId, 'status', {
      text: reason === 'timeout' ? '任务超时，正在停止' : '正在停止任务',
    });

    if (!run.turnId) {
      return true;
    }

    try {
      await this.appServerClient.interruptTurn({
        threadId: run.threadId,
        turnId: run.turnId,
      });
    } catch (error) {
      this.publishEvent(run.sessionId, 'error', {
        message: `停止任务失败：${formatError(error)}`,
      });
    }

    return true;
  }

  handleNotification(message) {
    const method = String(message?.method || '').trim();
    if (!method) {
      return;
    }

    const params = message.params || {};
    const threadId = extractThreadId(params);
    if (!threadId) {
      return;
    }

    const sessionId = this.threadToSession.get(threadId);
    if (!sessionId) {
      return;
    }

    const run = this.activeRuns.get(sessionId);
    if (!run) {
      return;
    }

    if (method === 'turn/started') {
      run.turnId = String(params?.turn?.id || '').trim();
      this.publishEvent(run.sessionId, 'status', {
        text: '开始处理',
      });
      if (run.stopRequested && run.turnId) {
        void this.stop(run.sessionId, run.stopReason || 'manual');
      }
      return;
    }

    if (method === 'item/started') {
      this.handleItemStarted(run, params.item);
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const itemId = String(params?.itemId || '').trim();
      if (!itemId) {
        return;
      }
      const delta = String(params?.delta || '');
      run.agentMessageBuffer.set(itemId, `${run.agentMessageBuffer.get(itemId) || ''}${delta}`);
      return;
    }

    if (method === 'item/completed') {
      this.handleItemCompleted(run, params.item);
      return;
    }

    if (method === 'error') {
      this.finalizeRun(run, {
        status: 'error',
        error: new Error(String(params?.error?.message || '执行失败')),
      });
      return;
    }

    if (method === 'turn/completed') {
      const turnStatus = String(params?.turn?.status || '').trim();
      if (turnStatus === 'completed') {
        this.finalizeRun(run, {
          status: run.stopRequested ? 'stopped' : 'completed',
        });
        return;
      }

      this.finalizeRun(run, {
        status: run.stopRequested ? 'stopped' : 'error',
        error: turnStatus && turnStatus !== 'interrupted'
          ? new Error(`任务结束状态：${turnStatus}`)
          : null,
      });
    }
  }

  handleItemStarted(run, item) {
    if (!item || typeof item.type !== 'string') {
      return;
    }

    if (item.type === 'commandExecution') {
      const command = truncateText(String(item.command || '').replace(/\s+/g, ' ').trim(), 96);
      this.publishEvent(run.sessionId, 'status', {
        text: command ? `执行命令：${command}` : '开始执行命令',
      });
      return;
    }

    if (item.type === 'agentMessage') {
      run.agentMessageBuffer.set(String(item.id || '').trim(), String(item.text || ''));
    }
  }

  handleItemCompleted(run, item) {
    if (!item || typeof item.type !== 'string') {
      return;
    }

    if (item.type === 'commandExecution') {
      const command = truncateText(String(item.command || '').replace(/\s+/g, ' ').trim(), 96);
      const exitCode = item.exitCode ?? item.exit_code;
      const suffix = exitCode == null ? '' : `（exit=${exitCode}）`;
      this.publishEvent(run.sessionId, 'status', {
        text: command ? `命令执行完成${suffix}：${command}` : `命令执行完成${suffix}`,
      });
      return;
    }

    if (item.type !== 'agentMessage') {
      return;
    }

    const itemId = String(item.id || '').trim();
    if (itemId && run.publishedMessageIds.has(itemId)) {
      return;
    }

    const buffered = itemId ? run.agentMessageBuffer.get(itemId) || '' : '';
    const rawText = String(item.text || buffered || '').trim();
    if (!rawText) {
      return;
    }

    const parsed = parseArtifactEnvelope(rawText, 'WEB_ARTIFACTS:');
    const cleanText = String(parsed.text || '').trim();
    const artifactPaths = new Set([
      ...parsed.artifactPaths,
      ...extractLocalArtifactPathsFromText(cleanText),
    ]);

    for (const artifactPath of artifactPaths) {
      const artifact = this.artifactManager.register(run.sessionId, artifactPath, 'reply');
      if (!artifact) {
        continue;
      }
      this.publishEvent(run.sessionId, 'artifact', {
        artifact,
      });
    }

    if (cleanText) {
      this.sessionStore.appendMessage(run.sessionId, 'assistant', cleanText);
      this.publishEvent(run.sessionId, 'message', {
        role: 'assistant',
        text: cleanText,
      });
    }

    if (itemId) {
      run.publishedMessageIds.add(itemId);
      run.agentMessageBuffer.delete(itemId);
    }
  }

  finalizeRun(run, result) {
    if (run.finalized) {
      return;
    }
    run.finalized = true;

    clearTimeout(run.timeoutHandle);
    this.activeRuns.delete(run.sessionId);
    if (this.threadToSession.get(run.threadId) === run.sessionId) {
      this.threadToSession.delete(run.threadId);
    }

    const errorText = result.error ? formatError(result.error) : '';
    if (result.status === 'completed') {
      this.sessionStore.updateSession(run.sessionId, {
        status: 'idle',
        lastError: '',
        currentRun: null,
      });
      this.publishEvent(run.sessionId, 'done', {
        ok: true,
        sessionId: run.sessionId,
      });
      return;
    }

    if (result.status === 'stopped') {
      const stoppedText = run.stopReason === 'timeout' ? '任务已因超时停止' : '任务已停止';
      this.sessionStore.updateSession(run.sessionId, {
        status: 'stopped',
        lastError: '',
        currentRun: null,
      });
      this.publishEvent(run.sessionId, 'status', {
        text: stoppedText,
      });
      this.publishEvent(run.sessionId, 'done', {
        ok: false,
        sessionId: run.sessionId,
      });
      return;
    }

    this.sessionStore.updateSession(run.sessionId, {
      status: 'error',
      lastError: errorText,
      currentRun: null,
    });
    if (errorText) {
      this.publishEvent(run.sessionId, 'error', {
        message: errorText,
      });
    }
    this.publishEvent(run.sessionId, 'done', {
      ok: false,
      sessionId: run.sessionId,
    });
  }
}

function buildWebPrompt(userPrompt) {
  return [
    userPrompt.trim(),
    '',
    '附加要求：',
    '1. 如果本次任务生成了需要在 Web 控制台展示或下载的本地文件，请在回复最后单独输出一行：WEB_ARTIFACTS: 绝对路径1|绝对路径2',
    '2. 这一行只保留绝对路径，多个路径用 | 分隔。',
    '3. 如果没有产物文件，不要输出 WEB_ARTIFACTS: 这一行。',
  ].join('\n');
}

function extractThreadId(params) {
  if (typeof params?.threadId === 'string' && params.threadId.trim()) {
    return params.threadId.trim();
  }

  if (typeof params?.thread?.id === 'string' && params.thread.id.trim()) {
    return params.thread.id.trim();
  }

  return '';
}

function isThreadNotFoundError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('thread not found');
}
