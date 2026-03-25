import { EventEmitter } from 'node:events';
import { spawn as spawnProcess } from 'node:child_process';
import {
  buildSessionTitle,
  compactText,
  createId,
  escapePowerShellSingleQuoted,
  formatError,
  nowIso,
  truncateText,
} from './utils.mjs';

const INITIALIZE_REQUEST_ID = '__codex_initialize__';

export class AppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config;
    this.proc = null;
    this.stdoutBuffer = '';
    this.stderrText = '';
    this.pending = new Map();
    this.readyPromise = null;
    this.initialized = false;
    this.closed = false;
  }

  async ensureReady() {
    if (this.initialized && this.proc && this.proc.exitCode == null && !this.proc.killed) {
      return;
    }

    if (!this.readyPromise) {
      this.readyPromise = this.startProcess();
    }

    try {
      await this.readyPromise;
    } finally {
      this.readyPromise = null;
    }
  }

  async listThreads(options = {}) {
    const hasOverallLimit = Number.isFinite(options.limit) && options.limit > 0;
    const pageSize = Math.max(1, Math.min(
      hasOverallLimit ? options.limit : (options.pageSize || 100),
      100,
    ));
    const items = [];
    const visitedCursors = new Set();
    let cursor = options.cursor || null;

    while (true) {
      const response = await this.request('thread/list', {
        limit: hasOverallLimit ? Math.min(pageSize, options.limit - items.length) : pageSize,
        cursor,
        sortKey: options.sortKey || 'updated_at',
        modelProviders: options.modelProviders ?? null,
        archived: Boolean(options.archived),
        sourceKinds: options.sourceKinds ?? null,
      });

      const pageItems = Array.isArray(response?.data) ? response.data : [];
      items.push(...pageItems);

      if (hasOverallLimit && items.length >= options.limit) {
        return items.slice(0, options.limit);
      }

      const nextCursor = String(response?.nextCursor || '').trim();
      if (!nextCursor || !pageItems.length || visitedCursors.has(nextCursor)) {
        return items;
      }

      visitedCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  async readThread(threadId, options = {}) {
    const normalizedThreadId = String(threadId || '').trim();
    if (!normalizedThreadId) {
      throw new Error('threadId 不能为空');
    }

    const response = await this.request('thread/read', {
      threadId: normalizedThreadId,
      includeTurns: Boolean(options.includeTurns),
    });
    return response?.thread || null;
  }

  async startThread(params = {}) {
    return this.request('thread/start', params);
  }

  async setThreadName(threadId, name) {
    const normalizedThreadId = String(threadId || '').trim();
    const normalizedName = String(name || '').trim();
    if (!normalizedThreadId || !normalizedName) {
      return null;
    }

    return this.request('thread/name/set', {
      threadId: normalizedThreadId,
      name: normalizedName,
    });
  }

  async startTurn(params = {}) {
    return this.request('turn/start', params, {
      timeoutMs: Number.isFinite(this.config?.requestTimeoutMs)
        ? Math.max(this.config.requestTimeoutMs, 30_000)
        : 15 * 60 * 1000,
    });
  }

  async interruptTurn(params = {}) {
    return this.request('turn/interrupt', params);
  }

  close() {
    this.closed = true;
    this.rejectAllPending(new Error('app-server 已关闭'));
    if (this.proc && this.proc.exitCode == null && !this.proc.killed) {
      this.proc.kill();
    }
    this.proc = null;
    this.initialized = false;
  }

  async startProcess() {
    this.initialized = false;
    this.stdoutBuffer = '';
    this.stderrText = '';

    const proc = spawnAppServerProcess(this.config);
    this.proc = proc;

    proc.stdout.on('data', (chunk) => {
      this.handleStdout(chunk.toString('utf8'));
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.stderrText += text;
      const normalized = text.trim();
      if (normalized) {
        this.emit('stderr', normalized);
      }
    });

    proc.on('error', (error) => {
      this.handleProcessClose(error);
    });

    proc.on('close', (exitCode, signal) => {
      const message = this.closed
        ? 'app-server 已关闭'
        : `app-server 已退出（code=${exitCode ?? 'null'} signal=${signal ?? 'null'}）`;
      this.handleProcessClose(new Error(message));
    });

    await this.sendInitialize();
  }

  async sendInitialize() {
    await new Promise((resolve, reject) => {
      this.pending.set(INITIALIZE_REQUEST_ID, {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.pending.delete(INITIALIZE_REQUEST_ID);
          reject(new Error('初始化 app-server 超时'));
        }, 15_000),
      });

      this.writeMessage({
        id: INITIALIZE_REQUEST_ID,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'web-codex-console',
            version: '0.1.0',
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: [],
          },
        },
      });
    });

    this.initialized = true;
  }

  async request(method, params = {}, options = {}) {
    await this.ensureReady();

    const id = `${method}:${createId('req')}`;
    const timeoutMs = options.timeoutMs === undefined ? 30_000 : options.timeoutMs;

    return new Promise((resolve, reject) => {
      const timeout = timeoutMs == null
        ? null
        : setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }, timeoutMs);

      this.pending.set(id, {
        resolve: (message) => {
          if (timeout) {
            clearTimeout(timeout);
          }
          if (message.error) {
            reject(new Error(message.error.message || JSON.stringify(message.error)));
            return;
          }
          resolve(message.result);
        },
        reject: (error) => {
          if (timeout) {
            clearTimeout(timeout);
          }
          reject(error);
        },
        timeout,
      });

      try {
        this.writeMessage({
          id,
          method,
          params,
        });
      } catch (error) {
        this.pending.delete(id);
        if (timeout) {
          clearTimeout(timeout);
        }
        reject(error);
      }
    });
  }

  writeMessage(message) {
    if (!this.proc || this.proc.exitCode != null || this.proc.killed) {
      throw new Error('app-server 未启动');
    }

    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;

    while (true) {
      const lineBreakIndex = this.stdoutBuffer.indexOf('\n');
      if (lineBreakIndex < 0) {
        break;
      }

      const line = this.stdoutBuffer.slice(0, lineBreakIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(lineBreakIndex + 1);
      if (!line) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (entry.timeout) {
        clearTimeout(entry.timeout);
      }
      entry.resolve(message);
      return;
    }

    if (typeof message.method === 'string') {
      this.emit('notification', message);
    }
  }

  handleProcessClose(error) {
    if (this.proc) {
      this.proc.stdout?.removeAllListeners();
      this.proc.stderr?.removeAllListeners();
      this.proc.removeAllListeners();
    }

    this.proc = null;
    this.initialized = false;
    this.rejectAllPending(error);
  }

  rejectAllPending(error) {
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      if (entry.timeout) {
        clearTimeout(entry.timeout);
      }
      entry.reject(error);
    }
  }
}

export function buildAppServerThreadStartParams(config, cwd, options = {}) {
  const normalizedCwd = String(cwd || config?.webWorkdir || config?.codexWorkdir || '').trim();
  if (!normalizedCwd) {
    throw new Error('缺少有效工作目录');
  }

  const params = {
    cwd: normalizedCwd,
  };

  if (options.ephemeral) {
    params.ephemeral = true;
  }

  if (config?.codexModel) {
    params.model = config.codexModel;
  }

  const permissions = buildAppServerPermissions(config, normalizedCwd);
  if (permissions) {
    params.approvalPolicy = permissions.approvalPolicy;
    params.sandbox = permissions.sandbox;
  }

  return params;
}

export function buildAppServerTurnParams(config, threadId, prompt, cwd) {
  const normalizedThreadId = String(threadId || '').trim();
  const normalizedPrompt = String(prompt || '').trim();
  const normalizedCwd = String(cwd || config?.webWorkdir || config?.codexWorkdir || '').trim();

  if (!normalizedThreadId) {
    throw new Error('缺少 threadId');
  }

  if (!normalizedPrompt) {
    throw new Error('消息不能为空');
  }

  const params = {
    threadId: normalizedThreadId,
    input: [
      {
        type: 'text',
        text: normalizedPrompt,
        text_elements: [],
      },
    ],
  };

  if (normalizedCwd) {
    params.cwd = normalizedCwd;
  }

  const permissions = buildAppServerPermissions(config, normalizedCwd);
  if (permissions) {
    params.approvalPolicy = permissions.approvalPolicy;
    params.sandbox = permissions.sandbox;
  }

  if (config?.codexModel) {
    params.model = config.codexModel;
  }

  return params;
}

export function threadToSessionMeta(thread) {
  if (!thread?.id) {
    return null;
  }

  return {
    id: String(thread.id).trim(),
    title: String(thread.name || '').trim(),
    cwd: normalizeCwd(thread.cwd),
    timestamp: fromUnixSeconds(thread.createdAt),
    lastWriteTime: fromUnixSeconds(thread.updatedAt),
    preview: compactPreview(sanitizeWebPromptText(thread.preview || '')),
  };
}

export function threadToTranscript(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const messages = [];
  let sequence = 0;
  const baseTime = toMilliseconds(thread?.createdAt) || Date.now();

  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      const normalized = itemToMessage(item, baseTime + sequence * 1000, ++sequence);
      if (normalized) {
        messages.push(normalized);
      }
    }
  }

  return { messages };
}

export function threadToSessionSummary(thread, localSession = null) {
  const meta = threadToSessionMeta(thread);
  if (!meta) {
    return null;
  }

  return {
    id: meta.id,
    title: meta.title || buildSessionTitle(meta.preview, '历史会话'),
    source: localSession?.source || 'imported',
    status: localSession?.status || 'idle',
    preview: meta.preview,
    updatedAt: meta.lastWriteTime || nowIso(),
    createdAt: meta.timestamp || meta.lastWriteTime || nowIso(),
    lastActivityAt: localSession?.lastActivityAt || meta.lastWriteTime || nowIso(),
    workdir: meta.cwd,
    codexThreadId: meta.id,
    hasLocalState: Boolean(localSession),
    lastError: localSession?.lastError || '',
  };
}

function buildAppServerPermissions(config, cwd) {
  const sandboxMode = config?.codexBypassApprovals
    ? 'danger-full-access'
    : String(config?.codexSandbox || '').trim();

  if (config?.codexBypassApprovals) {
    return {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    };
  }

  switch (sandboxMode) {
    case 'read-only':
      return {
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
      };
    case 'workspace-write':
      return {
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      };
    case 'danger-full-access':
      return {
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      };
    default:
      return null;
  }
}

function spawnAppServerProcess(config) {
  const args = ['app-server', '--analytics-default-enabled'];
  if (process.platform !== 'win32') {
    return spawnProcess(config.codexCommand, args, {
      cwd: config.webWorkdir || config.codexWorkdir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  const encodedArgs = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
  const command = escapePowerShellSingleQuoted(config.codexCommand);
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$argsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedArgs}')) | ConvertFrom-Json`,
    `& '${command}' @argsJson`,
    `exit $LASTEXITCODE`,
  ].join('; ');

  return spawnProcess('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: config.webWorkdir || config.codexWorkdir,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function itemToMessage(item, fallbackTimestampMs, sequence) {
  if (!item || typeof item.type !== 'string') {
    return null;
  }

  if (item.type === 'userMessage') {
    const text = extractUserMessageText(item.content);
    if (!text) {
      return null;
    }
    return {
      id: `remote-${sequence}`,
      role: 'user',
      text,
      createdAt: new Date(fallbackTimestampMs).toISOString(),
      source: 'codex',
    };
  }

  if (item.type === 'agentMessage') {
    const text = String(item.text || '').trim();
    if (!text) {
      return null;
    }
    return {
      id: `remote-${sequence}`,
      role: 'assistant',
      text,
      createdAt: new Date(fallbackTimestampMs).toISOString(),
      source: 'codex',
    };
  }

  return null;
}

function extractUserMessageText(content) {
  const items = Array.isArray(content) ? content : [];
  const parts = [];

  for (const item of items) {
    if (item?.type === 'text') {
      const text = String(item.text || '').trim();
      if (text) {
        parts.push(text);
      }
      continue;
    }

    if (item?.type === 'localImage' && item.path) {
      parts.push(`localImage: ${item.path}`);
      continue;
    }

    if (item?.type === 'image' && item.url) {
      const imageUrl = String(item.url || '').trim();
      parts.push(imageUrl.startsWith('data:') ? 'image: [attached]' : `image: ${imageUrl}`);
      continue;
    }

    if (item?.type === 'skill' && item.name) {
      parts.push(`skill: ${item.name}`);
      continue;
    }

    if (item?.type === 'mention' && item.name) {
      parts.push(`mention: ${item.name}`);
    }
  }

  return sanitizeWebPromptText(parts.join('\n').trim());
}

function fromUnixSeconds(value) {
  const timeMs = toMilliseconds(value);
  return timeMs ? new Date(timeMs).toISOString() : '';
}

function toMilliseconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return numeric * 1000;
}

function compactPreview(text) {
  return truncateText(compactText(text), 100);
}

function normalizeCwd(value) {
  return String(value || '').replace(/^\\\\\?\\/, '').trim();
}

function sanitizeWebPromptText(text) {
  const normalized = String(text || '').replace(/\r/g, '').trim();
  if (!normalized) {
    return '';
  }

  const marker = '\n\n附加要求：\n1. 如果本次任务生成了需要在 Web 控制台展示或下载的本地文件';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex >= 0) {
    return normalized.slice(0, markerIndex).trim();
  }

  return normalized;
}
