import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { URL } from 'node:url';
import { config } from './lib/config.mjs';
import {
  AppServerClient,
  threadToSessionMeta,
  threadToSessionSummary,
  threadToTranscript,
} from './lib/app-server-client.mjs';
import { listRecentCodexSessions, findCodexSessionById, loadCodexSessionTranscript } from './lib/codex-history.mjs';
import { SessionStore } from './lib/session-store.mjs';
import { ArtifactManager } from './lib/artifact-manager.mjs';
import { CodexRunner } from './lib/codex-runner.mjs';
import { createId, formatError, nowIso, truncateText } from './lib/utils.mjs';

const vendorAssets = new Map([
  ['/vendor/vue.global.prod.js', path.join(config.rootDir, 'node_modules', 'vue', 'dist', 'vue.global.prod.js')],
  ['/vendor/vant.min.js', path.join(config.rootDir, 'node_modules', 'vant', 'lib', 'vant.min.js')],
  ['/vendor/vant.css', path.join(config.rootDir, 'node_modules', 'vant', 'lib', 'index.css')],
]);

const sessionStore = new SessionStore(config.webStatePath);
const artifactManager = new ArtifactManager({
  sessionStore,
  allowedRoots: config.allowedArtifactRoots,
});
const appServerClient = new AppServerClient({ config });

const streamClients = new Map();
const DEFAULT_MESSAGE_PAGE_SIZE = 60;
const MAX_MESSAGE_PAGE_SIZE = 120;

const publishEvent = (sessionId, type, payload) => {
  const event = sessionStore.appendEvent(sessionId, {
    id: createId('evt'),
    type,
    sessionId,
    timestamp: nowIso(),
    payload,
  });

  if (!event) {
    return null;
  }

  const clients = streamClients.get(sessionId);
  if (clients) {
    const serialized = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      client.write(serialized);
    }
  }

  return event;
};

const codexRunner = new CodexRunner({
  config,
  sessionStore,
  artifactManager,
  publishEvent,
  appServerClient,
});

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

  try {
    if (requestUrl.pathname.startsWith('/api/')) {
      if (!authorize(req, requestUrl)) {
        sendJson(res, 401, { error: '未授权，请提供访问令牌' });
        return;
      }
      await handleApi(req, res, requestUrl);
      return;
    }

    await handleStatic(req, res, requestUrl);
  } catch (error) {
    sendJson(res, 500, {
      error: formatError(error),
    });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`[web] Web Codex Console 已启动：http://${config.host}:${config.port}`);
  if (config.generatedAccessToken) {
    console.log(`[web] 已生成临时访问令牌：${config.accessToken}`);
  }
});

async function handleApi(req, res, requestUrl) {
  const pathname = requestUrl.pathname;

  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, now: nowIso() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/sessions') {
    const items = await listSessionSummaries();

    sendJson(res, 200, {
      sessions: items,
      host: config.host,
      port: config.port,
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/sessions') {
    const body = await readJsonBody(req);
    const targetThreadId = String(body?.threadId || '').trim();
    if (targetThreadId) {
      const session = await ensureSession(targetThreadId);
      if (!session) {
        sendJson(res, 404, { error: '没有找到对应的历史会话' });
        return;
      }
      sendJson(res, 200, { session: serializeSessionDetail(session) });
      return;
    }

    const title = String(body?.title || '').trim();
    const session = sessionStore.createSession({
      title: title || '新会话',
      source: 'web',
      workdir: config.webWorkdir,
      status: 'idle',
    });

    publishEvent(session.id, 'status', {
      text: '会话已创建，发送首条消息后将连接原生端',
    });
    sendJson(res, 201, { session: serializeSessionDetail(session) });
    return;
  }

  if (req.method === 'GET' && /^\/api\/sessions\/[^/]+$/.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.split('/').pop() || '');
    const session = await ensureSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: '会话不存在' });
      return;
    }
    sendJson(res, 200, {
      session: serializeSessionDetail(session, {
        messages: {
          limit: readMessagePageLimit(requestUrl.searchParams.get('messageLimit')),
        },
      }),
    });
    return;
  }

  if (req.method === 'GET' && /^\/api\/sessions\/[^/]+\/messages$/.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.split('/')[3] || '');
    const session = await ensureSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: '会话不存在' });
      return;
    }

    const page = buildMessagePage(session.messages, {
      beforeId: requestUrl.searchParams.get('before'),
      limit: readMessagePageLimit(requestUrl.searchParams.get('limit')),
    });
    sendJson(res, 200, {
      sessionId: session.id,
      messages: page.messages,
      page: page.meta,
    });
    return;
  }

  if (req.method === 'DELETE' && /^\/api\/sessions\/[^/]+$/.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.split('/').pop() || '');
    if (codexRunner.isRunning(sessionId)) {
      sendJson(res, 409, { error: '当前会话仍在执行，不能删除' });
      return;
    }
    const removed = sessionStore.removeSession(sessionId);
    sendJson(res, 200, { ok: removed });
    return;
  }

  if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/messages$/.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.split('/')[3] || '');
    const session = await ensureSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: '会话不存在' });
      return;
    }

    const body = await readJsonBody(req, { maxBytes: 16 * 1024 * 1024 });
    const message = String(body?.message || '').trim();
    const attachments = saveIncomingAttachments(session.id, body?.attachments);
    if (!message && !attachments.length) {
      sendJson(res, 400, { error: '消息和附件不能同时为空' });
      return;
    }

    const prompt = buildMessagePrompt(message, attachments);
    const displayMessage = buildDisplayMessage(message, attachments);
    const run = await codexRunner.start(session.id, prompt, {
      displayPrompt: displayMessage,
      attachments,
    });
    sendJson(res, 202, {
      run,
      session: serializeSessionDetail(sessionStore.get(session.id)),
    });
    return;
  }

  if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/stop$/.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.split('/')[3] || '');
    const stopped = await codexRunner.stop(sessionId, 'manual');
    sendJson(res, 200, { ok: stopped });
    return;
  }

  if (req.method === 'GET' && /^\/api\/sessions\/[^/]+\/stream$/.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.split('/')[3] || '');
    const session = await ensureSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: '会话不存在' });
      return;
    }
    handleSse(req, res, session.id);
    return;
  }

  if (req.method === 'GET' && /^\/api\/files\/[^/]+$/.test(pathname)) {
    const artifactId = decodeURIComponent(pathname.split('/').pop() || '');
    const artifact = artifactManager.get(artifactId);
    if (!artifact) {
      sendJson(res, 404, { error: '文件不存在' });
      return;
    }

    if (requestUrl.searchParams.get('preview') === '1') {
      const preview = artifactManager.readTextPreview(artifact);
      if (!preview) {
        sendJson(res, 400, { error: '该文件不支持文本预览' });
        return;
      }
      sendJson(res, 200, preview);
      return;
    }

    if (!fs.existsSync(artifact.path) || !fs.statSync(artifact.path).isFile()) {
      sendJson(res, 404, { error: '文件不存在或已被删除' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': artifact.mimeType,
      'Content-Disposition': artifact.kind === 'image'
        ? `inline; filename="${encodeURIComponent(artifact.name)}"`
        : `attachment; filename="${encodeURIComponent(artifact.name)}"`,
    });
    pipeFileResponse(artifact.path, res);
    return;
  }

  sendJson(res, 404, { error: '未找到接口' });
}

async function handleStatic(req, res, requestUrl) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendPlain(res, 405, 'Method Not Allowed');
    return;
  }

  if (vendorAssets.has(requestUrl.pathname)) {
    const filePath = vendorAssets.get(requestUrl.pathname);
    if (!filePath || !fs.existsSync(filePath)) {
      sendPlain(res, 404, 'Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
    };

    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    pipeFileResponse(filePath, res);
    return;
  }

  let relativePath = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  relativePath = relativePath.replace(/^\/+/, '');
  const filePath = path.resolve(config.publicDir, relativePath);
  if (!filePath.startsWith(path.resolve(config.publicDir)) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendPlain(res, 404, 'Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };

  res.writeHead(200, {
    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  pipeFileResponse(filePath, res);
}

function handleSse(req, res, sessionId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('retry: 1500\n\n');

  let clients = streamClients.get(sessionId);
  if (!clients) {
    clients = new Set();
    streamClients.set(sessionId, clients);
  }
  clients.add(res);

  const heartbeat = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const currentClients = streamClients.get(sessionId);
    if (!currentClients) {
      return;
    }
    currentClients.delete(res);
    if (!currentClients.size) {
      streamClients.delete(sessionId);
    }
  });
}

function authorize(req, requestUrl) {
  const headerToken = String(req.headers['x-access-token'] || '').trim();
  const queryToken = String(requestUrl.searchParams.get('token') || '').trim();
  const token = headerToken || queryToken;
  return Boolean(token) && token === config.accessToken;
}

async function ensureSession(sessionId) {
  const existing = sessionStore.resolve(sessionId) || sessionStore.get(sessionId);
  const targetThreadId = String(existing?.codexThreadId || sessionId || '').trim();

  if (targetThreadId) {
    try {
      const thread = await appServerClient.readThread(targetThreadId, {
        includeTurns: true,
      });
      if (thread) {
        const meta = threadToSessionMeta(thread);
        const transcript = threadToTranscript(thread);
        if (existing && existing.id !== targetThreadId) {
          syncSessionWithThread(existing, meta);
          if (!Array.isArray(existing.messages) || !existing.messages.length) {
            existing.messages = transcript.messages;
          }
          sessionStore.persist();
          artifactManager.rebuild();
          return sessionStore.resolve(existing.id) || existing;
        }
        const session = meta
          ? sessionStore.ensureImportedSession(meta, transcript)
          : existing;
        sessionStore.reconcileLinkedSessions();
        artifactManager.rebuild();
        return sessionStore.resolve(session?.id || targetThreadId);
      }
    } catch {}
  }

  const native = findCodexSessionById(config.codexSessionRoot, targetThreadId);
  if (native) {
    const transcript = loadCodexSessionTranscript(native.filePath);
    const session = sessionStore.ensureImportedSession(native, transcript);
    sessionStore.reconcileLinkedSessions();
    artifactManager.rebuild();
    return sessionStore.resolve(session.id);
  }

  return existing || null;
}

async function listSessionSummaries() {
  try {
    const threads = await appServerClient.listThreads({
      sortKey: 'updated_at',
    });

    const items = new Map();
    for (const thread of threads) {
      const meta = threadToSessionMeta(thread);
      if (meta) {
        sessionStore.ensureImportedSession(meta, { messages: [] });
      }

      const localSession = findLocalSessionByThreadId(thread.id);
      const summary = buildThreadBackedSummary(thread, localSession);
      if (!summary) {
        continue;
      }
      summary.status = codexRunner.isRunning(summary.id)
        ? 'running'
        : (localSession?.status || 'idle');
      items.set(summary.id, summary);
    }

    for (const localSession of sessionStore.getAll()) {
      const resolved = sessionStore.resolve(localSession.id) || localSession;
      if (!resolved || resolved.hidden || hasSummaryForSession(items, resolved)) {
        continue;
      }

      items.set(resolved.id, buildLocalSessionSummary(resolved));
    }

    return Array.from(items.values())
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  } catch {
    const items = new Map();

    const nativeSessionItems = listRecentCodexSessions(config.codexSessionRoot, {
      limit: 500,
    });

    for (const item of nativeSessionItems) {
      items.set(item.id, {
        id: item.id,
        title: item.title || item.preview || '历史会话',
        source: 'codex',
        status: 'idle',
        preview: item.preview || '',
        updatedAt: item.lastWriteTime || item.timestamp || nowIso(),
        createdAt: item.timestamp || item.lastWriteTime || nowIso(),
        lastActivityAt: item.lastWriteTime || item.timestamp || nowIso(),
        workdir: item.cwd || '',
        codexThreadId: item.id,
        hasLocalState: false,
        lastError: '',
      });
    }

    for (const localSession of sessionStore.getAll()) {
      const resolved = sessionStore.resolve(localSession.id) || localSession;
      if (!resolved || resolved.hidden || hasSummaryForSession(items, resolved)) {
        continue;
      }

      items.set(resolved.id, buildLocalSessionSummary(resolved));
    }

    return Array.from(items.values())
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }
}

function findLocalSessionByThreadId(threadId) {
  const normalizedThreadId = String(threadId || '').trim();
  if (!normalizedThreadId) {
    return null;
  }

  const direct = sessionStore.resolve(normalizedThreadId) || sessionStore.get(normalizedThreadId);
  if (direct && !direct.hidden) {
    return direct;
  }

  return sessionStore.getAll().find((item) => String(item.codexThreadId || '').trim() === normalizedThreadId) || null;
}

function buildThreadBackedSummary(thread, localSession = null) {
  const summary = threadToSessionSummary(thread, localSession);
  if (!summary) {
    return null;
  }

  if (!localSession || localSession.id === summary.id) {
    return summary;
  }

  return {
    ...summary,
    id: localSession.id,
    title: localSession.title || summary.title,
    source: localSession.source || summary.source,
    preview: localSession.preview || summary.preview,
    updatedAt: laterIso(localSession.updatedAt, summary.updatedAt),
    createdAt: localSession.createdAt || summary.createdAt,
    lastActivityAt: laterIso(localSession.lastActivityAt, summary.lastActivityAt),
    workdir: localSession.workdir || summary.workdir,
    codexThreadId: summary.codexThreadId,
    hasLocalState: true,
    lastError: localSession.lastError || '',
  };
}

function buildLocalSessionSummary(session) {
  return {
    id: session.id,
    title: session.title,
    source: session.source,
    status: codexRunner.isRunning(session.id) ? 'running' : session.status,
    preview: session.preview,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    workdir: session.workdir,
    codexThreadId: session.codexThreadId,
    hasLocalState: true,
    lastError: session.lastError,
  };
}

function syncSessionWithThread(session, meta) {
  if (!session || !meta) {
    return;
  }

  session.codexThreadId = String(meta.id || session.codexThreadId || '').trim();
  session.workdir = session.workdir || meta.cwd || '';
  if (meta.preview && !session.preview) {
    session.preview = meta.preview;
  }
  if (
    meta.title
    && (
      !session.title
      || session.title === '新会话'
      || session.title === '历史会话'
    )
  ) {
    session.title = meta.title;
  }
}

function hasSummaryForSession(items, session) {
  for (const item of items.values()) {
    if (item.id === session.id) {
      return true;
    }

    if (session.codexThreadId && item.codexThreadId === session.codexThreadId) {
      return true;
    }
  }

  return false;
}

function laterIso(left, right) {
  const leftTime = new Date(left || 0).getTime();
  const rightTime = new Date(right || 0).getTime();
  return leftTime >= rightTime ? (left || right) : (right || left);
}

function serializeSessionSummary(session) {
  return {
    id: session.id,
    title: session.title,
    source: session.source,
    status: session.status,
    preview: session.preview,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    workdir: session.workdir,
    codexThreadId: session.codexThreadId,
    hasLocalState: true,
    lastError: session.lastError,
  };
}

function serializeSessionDetail(session, options = {}) {
  const messagePage = buildMessagePage(session.messages, options.messages);
  return {
    ...serializeSessionSummary(session),
    lastReply: session.lastReply,
    messages: messagePage.messages,
    messagePage: messagePage.meta,
    events: session.events,
    artifacts: session.artifacts,
    canStop: codexRunner.isRunning(session.id),
  };
}

function buildMessagePage(messages, options = {}) {
  const sourceMessages = Array.isArray(messages) ? messages : [];
  const limit = readMessagePageLimit(options.limit);
  const beforeId = String(options.beforeId || '').trim();
  let endExclusive = sourceMessages.length;

  if (beforeId) {
    const beforeIndex = sourceMessages.findIndex((message) => String(message?.id || '').trim() === beforeId);
    if (beforeIndex >= 0) {
      endExclusive = beforeIndex;
    }
  }

  const startIndex = Math.max(0, endExclusive - limit);
  const pageMessages = sourceMessages.slice(startIndex, endExclusive);
  return {
    messages: pageMessages,
    meta: {
      limit,
      loaded: pageMessages.length,
      hasMore: startIndex > 0,
      nextBeforeId: startIndex > 0 && pageMessages.length ? String(pageMessages[0]?.id || '') : '',
    },
  };
}

function readMessagePageLimit(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MESSAGE_PAGE_SIZE;
  }
  return Math.max(1, Math.min(MAX_MESSAGE_PAGE_SIZE, parsed));
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendPlain(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function pipeFileResponse(filePath, res) {
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      sendPlain(res, 404, 'Not Found');
      return;
    }

    if (!res.writableEnded) {
      res.destroy();
    }
  });
  stream.pipe(res);
}

function saveIncomingAttachments(sessionId, items) {
  const normalizedItems = normalizeIncomingAttachmentPayloads(items);
  if (!normalizedItems.length) {
    return [];
  }

  const attachmentDir = path.join(config.runtimeDir, 'uploads', sessionId);
  fs.mkdirSync(attachmentDir, { recursive: true });

  const artifacts = [];
  for (const item of normalizedItems) {
    const safeName = sanitizeAttachmentName(item.name);
    const targetPath = path.join(attachmentDir, `${Date.now()}-${createId('upl')}-${safeName}`);
    fs.writeFileSync(targetPath, decodeAttachmentBase64(item.base64));
    const artifact = artifactManager.register(sessionId, targetPath, 'attachment');
    if (artifact) {
      artifacts.push(artifact);
      publishEvent(sessionId, 'artifact', { artifact });
    }
  }

  return artifacts;
}

function normalizeIncomingAttachmentPayloads(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  const normalized = [];
  let totalBytes = 0;

  for (const item of items.slice(0, 6)) {
    const name = String(item?.name || '').trim();
    const base64 = extractBase64Payload(item?.dataBase64);
    if (!name || !base64) {
      continue;
    }

    const estimatedBytes = Math.floor((base64.length * 3) / 4);
    totalBytes += estimatedBytes;
    if (totalBytes > 10 * 1024 * 1024) {
      throw new Error('附件总体积不能超过 10MB');
    }

    normalized.push({
      name,
      base64,
    });
  }

  return normalized;
}

function extractBase64Payload(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  const markerIndex = text.indexOf('base64,');
  return markerIndex >= 0 ? text.slice(markerIndex + 7).trim() : text;
}

function decodeAttachmentBase64(value) {
  try {
    return Buffer.from(String(value || ''), 'base64');
  } catch {
    throw new Error('附件数据不是合法的 base64');
  }
}

function sanitizeAttachmentName(name) {
  const normalized = path.basename(String(name || '').trim()).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_');
  return normalized || 'attachment.bin';
}

function buildDisplayMessage(message, attachments) {
  const normalizedMessage = String(message || '').trim();
  if (!attachments.length) {
    return normalizedMessage;
  }

  const names = attachments.map((item) => item.name).join('、');
  if (!normalizedMessage) {
    return `请查看附件：${names}`;
  }

  return `${normalizedMessage}\n\n附件：${names}`;
}

function buildMessagePrompt(message, attachments) {
  const normalizedMessage = String(message || '').trim()
    || '请先查看本条消息附带的附件，并根据附件内容继续处理。';
  if (!attachments.length) {
    return normalizedMessage;
  }

  return [
    normalizedMessage,
    '',
    '本条消息附带了以下本地附件，请优先查看这些文件：',
    ...attachments.map((item, index) => `${index + 1}. ${item.name}: ${item.path}`),
    '',
    '要求：',
    '1. 如果需要引用附件内容，请直接读取上述文件。',
    '2. 回复中不要原样重复这些绝对路径，除非确有必要。',
  ].join('\n');
}

async function readJsonBody(req, options = {}) {
  const chunks = [];
  let total = 0;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 1024 * 1024;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`请求体超过 ${Math.ceil(maxBytes / 1024 / 1024)}MB 限制`);
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`请求体不是合法 JSON：${truncateText(raw, 120)}`);
  }
}
