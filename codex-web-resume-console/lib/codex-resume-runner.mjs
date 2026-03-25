import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import {
  createId,
  extractLocalArtifactPathsFromText,
  formatError,
  parseArtifactEnvelope,
  truncateText,
  escapePowerShellSingleQuoted,
} from '../../codex-web-console/lib/utils.mjs';

export class CodexResumeRunner {
  constructor(options) {
    this.config = options.config;
    this.sessionStore = options.sessionStore;
    this.artifactManager = options.artifactManager;
    this.publishEvent = options.publishEvent;
    this.pushService = options.pushService || null;
    this.syncDesktopSession = typeof options.syncDesktopSession === 'function'
      ? options.syncDesktopSession
      : null;
    this.activeRuns = new Map();
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

    const startedAt = new Date().toISOString();
    const run = {
      id: createId('run'),
      sessionId: session.id,
      prompt: normalizedPrompt,
      threadId: String(session.codexThreadId || '').trim(),
      startedAt,
      proc: null,
      stopRequested: false,
      stopReason: '',
      timeoutHandle: null,
      stdoutBuffer: '',
      stdoutText: '',
      stderrText: '',
      lastAgentMessage: '',
      publishedReplyKeys: new Set(),
      lastStatusSummary: '已收到任务',
      lastMessagePath: path.join(this.config.lastMessageDir, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`),
      finalized: false,
    };

    this.activeRuns.set(run.sessionId, run);
    const displayPrompt = String(options.displayPrompt || normalizedPrompt).trim() || normalizedPrompt;
    this.sessionStore.appendMessage(run.sessionId, 'user', displayPrompt, {
      attachments: Array.isArray(options.attachments) ? options.attachments : [],
      source: options.messageSource || 'web',
    });
    this.sessionStore.updateSession(run.sessionId, {
      status: 'running',
      lastError: '',
      preview: truncateText(displayPrompt.replace(/\s+/g, ' '), 120),
      currentRun: {
        id: run.id,
        startedAt,
      },
    });

    this.publishEvent(run.sessionId, 'status', {
      text: run.threadId ? '已提交到 Codex（resume）' : '已提交到 Codex',
      runId: run.id,
    });

    const args = buildCodexExecArgs(this.config, normalizedPrompt, {
      cwd: session.workdir || this.config.webWorkdir,
      lastMessagePath: run.lastMessagePath,
      threadId: run.threadId,
      imagePaths: resolveAttachedImagePaths(options.attachments),
    });

    const proc = spawnCodexCommand(this.config, args, {
      cwd: session.workdir || this.config.webWorkdir,
    });
    run.proc = proc;
    run.timeoutHandle = setTimeout(() => {
      void this.stop(run.sessionId, 'timeout');
    }, this.config.requestTimeoutMs);

    proc.stdout.on('data', (chunk) => {
      this.handleStdout(run, chunk.toString('utf8'));
    });

    proc.stderr.on('data', (chunk) => {
      run.stderrText = appendLimitedText(run.stderrText, chunk.toString('utf8'), 120000);
    });

    proc.once('error', (error) => {
      void this.finalizeRun(run, {
        status: 'error',
        error,
      });
    });

    proc.once('exit', (code) => {
      void this.finalizeRun(run, {
        status: run.stopRequested ? 'stopped' : (Number(code ?? 0) === 0 ? 'completed' : 'error'),
        exitCode: Number(code ?? 0),
      });
    });

    return {
      runId: run.id,
      startedAt,
    };
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
      runId: run.id,
    });

    try {
      run.proc?.kill();
    } catch {}

    return true;
  }

  handleStdout(run, chunk) {
    run.stdoutBuffer += chunk;
    run.stdoutText = appendLimitedText(run.stdoutText, chunk, 120000);

    while (true) {
      const lineBreakIndex = run.stdoutBuffer.indexOf('\n');
      if (lineBreakIndex < 0) {
        break;
      }

      const line = run.stdoutBuffer.slice(0, lineBreakIndex).trim();
      run.stdoutBuffer = run.stdoutBuffer.slice(lineBreakIndex + 1);
      if (!line) {
        continue;
      }

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      const summary = summarizeExecJsonEvent(event);
      if (!summary) {
        continue;
      }

      if (summary.threadId) {
        run.threadId = summary.threadId;
        this.sessionStore.updateSession(run.sessionId, {
          codexThreadId: run.threadId,
          status: 'running',
          currentRun: {
            id: run.id,
            startedAt: run.startedAt,
          },
        });
        this.trySyncDesktopSession(run.sessionId, run.threadId);
      }

      if (summary.reply) {
        run.lastAgentMessage = summary.reply;
        this.publishAssistantReply(run, summary.reply, {
          source: 'stream',
        });
      }

      if (summary.status) {
        run.lastStatusSummary = summary.status;
        this.publishEvent(run.sessionId, 'status', {
          text: summary.status,
          runId: run.id,
        });
      }

      if (summary.output) {
        run.stderrText = appendLimitedText(run.stderrText, `${summary.output}\n`, 120000);
      }
    }
  }

  async finalizeRun(run, result = {}) {
    if (run.finalized) {
      return;
    }
    run.finalized = true;

    clearTimeout(run.timeoutHandle);
    this.activeRuns.delete(run.sessionId);

    const session = this.sessionStore.get(run.sessionId);
    const lastMessage = fs.existsSync(run.lastMessagePath)
      ? fs.readFileSync(run.lastMessagePath, 'utf8').trim()
      : '';
    const reply = normalizeCodexReply(lastMessage, run.prompt)
      || normalizeProtoReply(run.lastAgentMessage)
      || extractCodexTextFromStdout(run.stdoutText)
      || '';
    const status = result.status || 'completed';

    if (status === 'error') {
      const errorText = [
        result.error ? formatError(result.error) : '',
        normalizeProtoReply(run.stderrText),
        result.exitCode ? `Codex 执行失败（exit=${result.exitCode}）` : '',
      ]
        .filter(Boolean)
        .join('\n')
        .trim() || '执行失败';
      this.sessionStore.updateSession(run.sessionId, {
        status: 'error',
        lastError: errorText,
        currentRun: null,
        codexThreadId: run.threadId || session?.codexThreadId || '',
      });
      this.publishEvent(run.sessionId, 'error', {
        message: errorText,
      });
      this.publishEvent(run.sessionId, 'done', {
        ok: false,
        status: 'error',
        sessionId: run.sessionId,
      });
      await this.notifyRunFinished({
        session: this.sessionStore.get(run.sessionId) || session,
        run,
        status: 'error',
        errorText,
      });
      return;
    }

    if (reply) {
      this.publishAssistantReply(run, reply, {
        source: 'final',
      });
    }

    this.sessionStore.updateSession(run.sessionId, {
      status: status === 'stopped' ? 'stopped' : 'idle',
      lastError: '',
      currentRun: null,
      codexThreadId: run.threadId || session?.codexThreadId || '',
    });
    this.trySyncDesktopSession(run.sessionId, run.threadId || session?.codexThreadId || '');

    if (status === 'stopped') {
      this.publishEvent(run.sessionId, 'status', {
        text: run.stopReason === 'timeout' ? '任务已超时停止' : '任务已停止',
        runId: run.id,
      });
    }

    this.publishEvent(run.sessionId, 'done', {
      ok: true,
      status,
      sessionId: run.sessionId,
    });
    await this.notifyRunFinished({
      session: this.sessionStore.get(run.sessionId) || session,
      run,
      status,
      reply,
    });
  }

  trySyncDesktopSession(sessionId, threadId) {
    if (!this.syncDesktopSession) {
      return;
    }

    try {
      this.syncDesktopSession(sessionId, threadId);
    } catch {}
  }

  publishAssistantReply(run, text, options = {}) {
    const parsed = parseReplyPayload(text);
    if (!parsed.cleanText && !parsed.artifactPaths.length) {
      return false;
    }

    const replyKey = buildReplyKey(parsed.cleanText, parsed.artifactPaths);
    if (!options.allowDuplicate && replyKey && run.publishedReplyKeys.has(replyKey)) {
      return false;
    }

    for (const artifactPath of parsed.artifactPaths) {
      const artifact = this.artifactManager.register(run.sessionId, artifactPath, 'reply');
      if (!artifact) {
        continue;
      }
      this.publishEvent(run.sessionId, 'artifact', {
        artifact,
      });
    }

    if (parsed.cleanText) {
      this.sessionStore.appendMessage(run.sessionId, 'assistant', parsed.cleanText, {
        source: options.source || 'codex',
      });
      this.publishEvent(run.sessionId, 'message', {
        role: 'assistant',
        text: parsed.cleanText,
      });
    }

    if (replyKey) {
      run.publishedReplyKeys.add(replyKey);
    }

    return true;
  }

  async notifyRunFinished(input = {}) {
    if (!this.pushService) {
      return;
    }

    try {
      await this.pushService.notifyRunFinished({
        session: input.session,
        status: input.status,
        reply: input.reply,
        errorText: input.errorText,
        runId: String(input?.run?.id || '').trim(),
      });
    } catch (error) {
      console.warn(`[web-resume] 推送通知失败：${formatError(error)}`);
    }
  }
}

function buildCodexExecArgs(config, prompt, options = {}) {
  const threadId = String(options.threadId || '').trim();
  const isResume = Boolean(threadId);
  const args = isResume
    ? ['exec', 'resume', '--json', '--skip-git-repo-check']
    : ['exec', '--json', '--skip-git-repo-check'];

  const cwd = options.cwd || config.codexWorkdir;
  if (cwd && !isResume) {
    args.push('--cd', cwd);
  }

  if (options.lastMessagePath) {
    args.push('--output-last-message', options.lastMessagePath);
  }

  if (config.codexBypassApprovals) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (config.codexSandbox === 'workspace-write') {
    args.push('--sandbox', 'workspace-write');
  } else if (config.codexSandbox === 'read-only') {
    args.push('--sandbox', 'read-only');
  } else if (config.codexSandbox === 'danger-full-access') {
    args.push('--sandbox', 'danger-full-access');
  }

  if (config.codexModel) {
    args.push('--model', config.codexModel);
  }

  const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths : [];
  for (const imagePath of imagePaths) {
    args.push('--image', imagePath);
  }

  if (isResume) {
    args.push(threadId);
  }
  args.push(prompt);
  return args;
}

function resolveAttachedImagePaths(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  const imagePaths = [];
  for (const item of attachments) {
    const kind = String(item?.kind || '').trim().toLowerCase();
    const filePath = String(item?.path || '').trim();
    if (kind !== 'image' || !filePath) {
      continue;
    }
    if (!fs.existsSync(filePath)) {
      continue;
    }
    imagePaths.push(filePath);
  }

  return imagePaths;
}

function spawnCodexCommand(config, args, options = {}) {
  if (process.platform !== 'win32') {
    return spawnProcess(config.codexCommand, args, {
      cwd: options.cwd || config.codexWorkdir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  const encodedArgs = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
  const codexCommand = escapePowerShellSingleQuoted(config.codexCommand);
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$argsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedArgs}')) | ConvertFrom-Json`,
    `& '${codexCommand}' @argsJson`,
    `exit $LASTEXITCODE`,
  ].join('; ');

  return spawnProcess('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: options.cwd || config.codexWorkdir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function summarizeExecJsonEvent(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  if (event.model) {
    return {
      status: `已连接 Codex（${event.model}）`,
    };
  }

  if (event.type === 'thread.started') {
    return {
      threadId: String(event.thread_id || '').trim(),
      status: '已创建会话',
    };
  }

  if (event.type === 'turn.started') {
    return {
      status: '开始处理',
    };
  }

  if (event.type === 'error') {
    return {
      status: String(event.message || '执行失败'),
    };
  }

  const item = event.item;
  if (!item || typeof item.type !== 'string') {
    return null;
  }

  if (item.type === 'agent_message' && event.type === 'item.completed') {
    return {
      reply: String(item.text || '').trim(),
      status: '正在整理回复',
    };
  }

  if (item.type === 'command_execution') {
    const command = String(item.command || '').trim();
    const shortCommand = truncateText(command.replace(/\s+/g, ' '), 120);
    if (event.type === 'item.started') {
      return {
        status: shortCommand ? `执行命令：${shortCommand}` : '开始执行命令',
      };
    }

    if (event.type === 'item.completed') {
      const exitCode = item.exit_code;
      const suffix = exitCode === undefined || exitCode === null ? '' : `（exit=${exitCode}）`;
      return {
        status: shortCommand ? `命令执行完成${suffix}：${shortCommand}` : `命令执行完成${suffix}`,
        output: normalizeProtoReply(item.aggregated_output || ''),
      };
    }
  }

  return null;
}

function appendLimitedText(current, extra, maxLength) {
  const next = `${current}${extra}`;
  if (next.length <= maxLength) {
    return next;
  }
  return next.slice(next.length - maxLength);
}

function parseReplyPayload(text) {
  const parsed = parseArtifactEnvelope(text, 'WEB_ARTIFACTS:');
  const cleanText = String(parsed.text || '').trim();
  const artifactPaths = Array.from(new Set([
    ...parsed.artifactPaths,
    ...extractLocalArtifactPathsFromText(cleanText),
  ]));

  return {
    cleanText,
    artifactPaths,
  };
}

function buildReplyKey(cleanText, artifactPaths) {
  const text = String(cleanText || '').trim();
  const artifacts = Array.isArray(artifactPaths) ? artifactPaths.join('|') : '';
  return `${text}@@${artifacts}`;
}

function extractCodexTextFromStdout(stdout) {
  const normalized = String(stdout || '').trim();
  if (!normalized) {
    return '';
  }

  const marker = /\n\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s+codex\s*\n/i;
  const match = normalized.match(marker);
  if (!match || match.index == null) {
    return normalized;
  }

  const text = normalized.slice(match.index + match[0].length);
  return text.replace(/\n\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s+tokens used:[\s\S]*$/i, '').trim();
}

function normalizeCodexReply(text, userPrompt) {
  let normalized = String(text || '').trim();

  normalized = normalized.replace(
    /收到，我会按远程任务方式处理，并(?:严格)?遵守你的规范：[\s\S]*?(?:请把具体任务内容发给我，我马上开始。|请直接发我具体任务内容[\s\S]*?(?:我收到后会先分析，再给出最小且精准的处理方案。)?)\s*/g,
    '',
  );

  normalized = normalized.trim();

  const simpleReplyMatch = String(userPrompt || '').match(/^\s*回复一句[:：]\s*(.+?)\s*$/s);
  if (simpleReplyMatch) {
    const expected = simpleReplyMatch[1].trim();
    if (
      !normalized
      || /^(好的[。！!]?)|(收到[。！!]?)|(可以[。！!]?)$/.test(normalized)
      || /收到，我会按远程任务方式处理/.test(normalized)
    ) {
      return expected;
    }
  }

  return normalized;
}

function normalizeProtoReply(text) {
  return String(text || '').replace(/\r/g, '').trim();
}
