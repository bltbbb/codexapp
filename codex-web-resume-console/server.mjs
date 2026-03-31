import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { URL } from 'node:url';
import { config } from './lib/config.mjs';
import { listRecentCodexSessions, findCodexSessionById, loadCodexSessionTranscript } from '../codex-web-console/lib/codex-history.mjs';
import { ArtifactManager } from '../codex-web-console/lib/artifact-manager.mjs';
import {
  createId,
  formatError,
  guessArtifactKind,
  guessMimeType,
  isSubPath,
  nowIso,
  truncateText,
} from '../codex-web-console/lib/utils.mjs';
import { SessionStore } from './lib/session-store.mjs';
import { CodexResumeRunner } from './lib/codex-resume-runner.mjs';
import { DesktopSessionSync } from './lib/desktop-session-sync.mjs';
import { PushService } from './lib/push/push-service.mjs';

const vendorAssets = new Map([
  ['/vendor/vue.global.prod.js', path.join(config.rootDir, 'node_modules', 'vue', 'dist', 'vue.global.prod.js')],
  ['/vendor/vant.min.js', path.join(config.rootDir, 'node_modules', 'vant', 'lib', 'vant.min.js')],
  ['/vendor/vant.css', path.join(config.rootDir, 'node_modules', 'vant', 'lib', 'index.css')],
]);

const sessionStore = new SessionStore(config.statePath);
const artifactManager = new ArtifactManager({
  sessionStore,
  allowedRoots: config.allowedArtifactRoots,
});
const desktopSessionSync = new DesktopSessionSync(config);
const pushService = new PushService(config);

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

const codexRunner = new CodexResumeRunner({
  config,
  sessionStore,
  artifactManager,
  publishEvent,
  syncDesktopSession: syncDesktopSessionById,
  pushService,
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
  console.log(`[web-resume] Resume Web Console 已启动：http://${config.host}:${config.port}`);
  if (config.generatedAccessToken) {
    console.log(`[web-resume] 已生成临时访问令牌：${config.accessToken}`);
  }
});

async function handleApi(req, res, requestUrl) {
  const pathname = requestUrl.pathname;

  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      now: nowIso(),
      push: pushService.getStatus(),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/push/status') {
    sendJson(res, 200, {
      push: pushService.getStatus(),
      devices: pushService.listDevices(),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/push/devices') {
    sendJson(res, 200, {
      devices: pushService.listDevices(),
      push: pushService.getStatus(),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/push/register') {
    const body = await readJsonBody(req, { maxBytes: 64 * 1024 });
    const device = pushService.registerDevice(body);
    sendJson(res, 200, {
      ok: true,
      device,
      push: pushService.getStatus(),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/push/unregister') {
    const body = await readJsonBody(req, { maxBytes: 64 * 1024 });
    const removed = pushService.unregisterDevice(body);
    sendJson(res, 200, {
      ok: removed,
      push: pushService.getStatus(),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/push/test') {
    const body = await readJsonBody(req, { maxBytes: 64 * 1024 });
    const result = await pushService.sendTestNotification(body);
    sendJson(res, 200, {
      ok: result.ok,
      result,
      push: pushService.getStatus(),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/sessions') {
    const items = listSessionSummaries();
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
      const session = ensureSession(targetThreadId);
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
      text: '会话已创建，发送首条消息后将创建可恢复的 Codex 会话',
    });
    sendJson(res, 201, { session: serializeSessionDetail(session) });
    return;
  }

  if (req.method === 'GET' && /^\/api\/sessions\/[^/]+$/.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.split('/').pop() || '');
    const session = ensureSession(sessionId);
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
    const session = ensureSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: '会话不存在' });
      return;
    }

    const page = buildDisplayMessagePage(session.messages, {
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
    const session = ensureSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: '会话不存在' });
      return;
    }

    const body = await readJsonBody(req, { maxBytes: 16 * 1024 * 1024 });
    const message = String(body?.message || '').trim();
    const debugBodyLength = String(req.headers['x-debug-message-body-length'] || '').trim();
    const debugBodyLines = String(req.headers['x-debug-message-body-lines'] || '').trim();
    const debugBodyPreview = String(req.headers['x-debug-message-body-preview'] || '').trim();
    if (debugBodyLength || debugBodyLines || debugBodyPreview) {
      console.log(
        `[web-resume][msg-client] session=${session.id} bodyLen=${debugBodyLength || '-'} bodyLines=${debugBodyLines || '-'} bodyPreview=${debugBodyPreview || '-'}`
      );
    }
    console.log(`[web-resume][msg-recv] session=${session.id} len=${message.length} preview=${summarizeDebugText(message)}`);
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
    const session = ensureSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: '会话不存在' });
      return;
    }
    handleSse(req, res, session.id);
    return;
  }

  if (req.method === 'GET' && /^\/api\/sessions\/[^/]+\/project-tree$/.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.split('/')[3] || '');
    const session = ensureSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: '会话不存在' });
      return;
    }

    try {
      const payload = buildProjectTreePayload(session, requestUrl.searchParams.get('path') || '');
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 400, { error: formatError(error) });
    }
    return;
  }

  if (req.method === 'GET' && /^\/api\/sessions\/[^/]+\/project-file$/.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.split('/')[3] || '');
    const session = ensureSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: '会话不存在' });
      return;
    }

    try {
      const payload = buildProjectFilePreview(session, requestUrl.searchParams.get('path') || '');
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 400, { error: formatError(error) });
    }
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
  const filePath = resolveStaticFile(relativePath);
  if (!filePath) {
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

function resolveStaticFile(relativePath) {
  const candidates = [
    config.publicDir,
    config.fallbackPublicDir,
  ];

  for (const baseDir of candidates) {
    const resolvedBase = path.resolve(baseDir);
    const filePath = path.resolve(resolvedBase, relativePath);
    if (!filePath.startsWith(resolvedBase)) {
      continue;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      continue;
    }
    return filePath;
  }

  return '';
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

function ensureSession(sessionId) {
  const existing = sessionStore.get(sessionId) || sessionStore.findByThreadId(sessionId);
  if (existing) {
    const nativeThreadId = String(existing.codexThreadId || sessionId || '').trim();
    if (nativeThreadId) {
      const native = findCodexSessionById(config.codexSessionRoot, nativeThreadId);
      if (native) {
        const transcript = normalizeTranscriptForDisplay(loadCodexSessionTranscript(native.filePath));
        if (existing.source === 'imported') {
          const synced = sessionStore.ensureImportedSession(native, { messages: [] });
          let changed = false;
          const nextMessages = mergeTranscriptMessages(synced.messages, transcript.messages, {
            allowReplace: !codexRunner.isRunning(synced.id),
          });
          if (nextMessages !== synced.messages) {
            synced.messages = nextMessages;
            changed = true;
          }
          if (syncSessionDerivedFields(synced, native, transcript)) {
            changed = true;
          }
          if (changed) {
            sessionStore.persist();
          }
          syncDesktopSessionState(synced, native, transcript);
          artifactManager.rebuild();
          return synced;
        }

        let changed = false;
        const nextMessages = mergeTranscriptMessages(existing.messages, transcript.messages, {
          allowReplace: !codexRunner.isRunning(existing.id),
        });
        if (nextMessages !== existing.messages) {
          existing.messages = nextMessages;
          changed = true;
        }
        if (!String(existing.codexThreadId || '').trim()) {
          existing.codexThreadId = native.id;
          changed = true;
        }
        if (!String(existing.workdir || '').trim() && native.cwd) {
          existing.workdir = native.cwd;
          changed = true;
        }
        if (!String(existing.preview || '').trim() && native.preview) {
          existing.preview = native.preview;
          changed = true;
        }

        const nextUpdatedAt = laterIso(existing.updatedAt, native.lastWriteTime || native.timestamp || nowIso());
        if (nextUpdatedAt !== existing.updatedAt) {
          existing.updatedAt = nextUpdatedAt;
          changed = true;
        }

        const nextLastActivityAt = laterIso(existing.lastActivityAt, native.lastWriteTime || native.timestamp || nowIso());
        if (nextLastActivityAt !== existing.lastActivityAt) {
          existing.lastActivityAt = nextLastActivityAt;
          changed = true;
        }

        if (syncSessionDerivedFields(existing, native, transcript)) {
          changed = true;
        }

        if (changed) {
          sessionStore.persist();
        }

        syncDesktopSessionState(existing, native, transcript);
      }
    }
    return existing;
  }

  const native = findCodexSessionById(config.codexSessionRoot, sessionId);
  if (!native) {
    return null;
  }

  const transcript = normalizeTranscriptForDisplay(loadCodexSessionTranscript(native.filePath));
  const session = sessionStore.ensureImportedSession(native, transcript);
  syncDesktopSessionState(session, native, transcript);
  artifactManager.rebuild();
  return session;
}

function syncDesktopSessionById(sessionId, explicitThreadId = '') {
  const session = sessionStore.get(sessionId) || sessionStore.findByThreadId(explicitThreadId);
  if (!session) {
    return false;
  }

  const nativeThreadId = String(explicitThreadId || session.codexThreadId || '').trim();
  if (!nativeThreadId) {
    return false;
  }

  const native = findCodexSessionById(config.codexSessionRoot, nativeThreadId);
  if (!native) {
    return false;
  }

  const transcript = normalizeTranscriptForDisplay(loadCodexSessionTranscript(native.filePath));
  return syncDesktopSessionState(session, native, transcript);
}

function syncDesktopSessionState(session, native, transcript) {
  try {
    return desktopSessionSync.sync({
      session,
      native,
      transcript,
    });
  } catch {
    return false;
  }
}

function listSessionSummaries() {
  const items = new Map();

  for (const localSession of sessionStore.getAll()) {
    items.set(localSession.id, buildLocalSessionSummary(localSession));
  }

  const nativeSessionItems = listRecentCodexSessions(config.codexSessionRoot, {
    limit: 500,
  });

  for (const item of nativeSessionItems) {
    const mappedLocal = findLocalSessionByThreadId(item.id);
    if (mappedLocal) {
      items.set(mappedLocal.id, {
        ...buildLocalSessionSummary(mappedLocal),
        updatedAt: laterIso(mappedLocal.updatedAt, item.lastWriteTime || item.timestamp || nowIso()),
        lastActivityAt: laterIso(mappedLocal.lastActivityAt, item.lastWriteTime || item.timestamp || nowIso()),
      });
      continue;
    }

    items.set(item.id, {
      id: item.id,
      title: item.title || item.preview || '历史会话',
      source: 'imported',
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

  return Array.from(items.values())
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

function findLocalSessionByThreadId(threadId) {
  const normalizedThreadId = String(threadId || '').trim();
  if (!normalizedThreadId) {
    return null;
  }

  return sessionStore.findByThreadId(normalizedThreadId) || null;
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
    model: String(session.model || '').trim(),
    reasoningEffort: String(session.reasoningEffort || '').trim(),
    tokenUsage: buildDisplayTokenUsage(session),
  };
}

function laterIso(left, right) {
  const leftTime = new Date(left || 0).getTime();
  const rightTime = new Date(right || 0).getTime();
  return leftTime >= rightTime ? (left || right) : (right || left);
}

function normalizeTranscriptForDisplay(transcript) {
  const messages = Array.isArray(transcript?.messages) ? transcript.messages : [];
  return {
    messages: messages
      .map((message, index) => sanitizeTranscriptMessage(message, index))
      .filter(Boolean),
  };
}

function sanitizeTranscriptMessage(message, index) {
  const promptAttachmentInfo = message?.role === 'user'
    ? parseWebAttachmentPrompt(message?.text)
    : null;
  const text = sanitizeTranscriptMessageText(message?.text, message?.role, promptAttachmentInfo);
  if (!text) {
    return null;
  }

  return {
    id: String(message?.id || `native-${index + 1}`),
    role: message?.role === 'assistant' ? 'assistant' : 'user',
    text,
    createdAt: String(message?.createdAt || nowIso()),
    source: String(message?.source || 'codex'),
    attachments: promptAttachmentInfo?.attachments?.length
      ? promptAttachmentInfo.attachments
      : sanitizeMessageAttachments(message?.attachments),
  };
}

function sanitizeTranscriptMessageText(text, role, promptAttachmentInfo = null) {
  const normalized = String(text || '').replace(/\r/g, '').trim();
  if (!normalized) {
    return '';
  }

  if (role === 'assistant') {
    return normalized;
  }

  if (promptAttachmentInfo?.displayText) {
    return promptAttachmentInfo.displayText;
  }

  const lower = normalized.toLowerCase();
  if (
    lower.includes('agents.md instructions')
    && !lower.includes('my request for codex')
    && !lower.includes('我的请求')
    && !lower.includes('请求:')
    && !lower.includes('请求：')
  ) {
    return '';
  }

  const explicitRequest = extractExplicitRequestText(normalized);
  if (explicitRequest) {
    return explicitRequest;
  }

  if (isPureContextEnvelope(normalized)) {
    return '';
  }

  return normalized;
}

function extractExplicitRequestText(text) {
  const patterns = [
    /## My request for Codex:\s*([\s\S]+)$/i,
    /我的请求[：:]\s*([\s\S]+)$/i,
    /请求[：:]\s*([\s\S]+)$/i,
  ];

  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (!match) {
      continue;
    }

    const body = String(match[1] || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !isContextNoiseLine(line));

    if (body.length) {
      return body.join('\n');
    }
  }

  return '';
}

function parseWebAttachmentPrompt(text) {
  const normalized = String(text || '').replace(/\r/g, '').trim();
  if (!normalized || !normalized.includes('本条消息附带了以下本地附件，请优先查看这些文件：')) {
    return null;
  }

  const lines = normalized.split('\n');
  const markerIndex = lines.findIndex((line) => line.trim() === '本条消息附带了以下本地附件，请优先查看这些文件：');
  if (markerIndex < 0) {
    return null;
  }

  const introText = lines.slice(0, markerIndex).join('\n').trim();
  const parsedAttachments = [];

  for (const rawLine of lines.slice(markerIndex + 1)) {
    const line = rawLine.trim();
    if (!line || line === '要求：') {
      break;
    }

    const match = line.match(/^\d+\.\s*(.+?):\s*([A-Za-z]:\\.+)$/);
    if (!match) {
      continue;
    }

    const name = String(match[1] || '').trim();
    const filePath = path.resolve(String(match[2] || '').trim());
    if (!name || !filePath) {
      continue;
    }

    const artifact = artifactManager.findByPath(filePath);
    parsedAttachments.push(artifact || {
      id: `att-${parsedAttachments.length + 1}`,
      name,
      size: 0,
      mimeType: 'application/octet-stream',
      kind: inferAttachmentKindFromPath(filePath),
      createdAt: nowIso(),
      source: 'attachment',
      path: filePath,
    });
  }

  if (!parsedAttachments.length) {
    return null;
  }

  const names = parsedAttachments.map((item) => item.name).join('、');
  const normalizedIntro = introText === '请先查看本条消息附带的附件，并根据附件内容继续处理。'
    ? ''
    : introText;

  return {
    attachments: sanitizeMessageAttachments(parsedAttachments),
    displayText: normalizedIntro ? `${normalizedIntro}\n\n附件：${names}` : `请查看附件：${names}`,
  };
}

function isPureContextEnvelope(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return true;
  }

  return lines.every((line) => isContextNoiseLine(line));
}

function isContextNoiseLine(line) {
  const normalized = String(line || '').trim();
  if (!normalized) {
    return true;
  }

  const lower = normalized.toLowerCase();
  const patterns = [
    /^# /,
    /^## /,
    /^```/,
    /^<instructions?>/i,
    /^<\/instructions?>/i,
    /^<environment_context>/i,
    /^<\/environment_context>/i,
    /^<context/i,
    /^active file:/i,
    /^active selection of the file:/i,
    /^open tabs:/i,
    /^language/i,
    /^1\.\s*只允许使用中文回答/,
    /^2\.\s*中文优先/,
    /^3\.\s*中文注释/,
    /^4\.\s*中文思维/,
    /^<cwd>/i,
    /^<shell>/i,
    /^<current_date>/i,
    /^<timezone>/i,
  ];

  if (patterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  return (
    lower.includes('agents.md instructions') ||
    lower.includes('environment_context') ||
    lower.includes('current_date') ||
    lower.includes('timezone') ||
    lower.includes('context from my ide setup') ||
    lower.includes('open tabs:') ||
    lower.includes('active file:')
  );
}

function mergeTranscriptMessages(currentMessages, transcriptMessages, options = {}) {
  const current = Array.isArray(currentMessages) ? currentMessages : [];
  const transcript = Array.isArray(transcriptMessages)
    ? transcriptMessages.filter((message) => String(message?.text || '').trim())
    : [];

  if (!transcript.length) {
    return current;
  }

  if (!current.length) {
    return cloneMessages(transcript);
  }

  const prefixLength = getMessagePrefixLength(current, transcript);
  if (prefixLength === transcript.length && current.length >= transcript.length) {
    return current;
  }

  if (prefixLength === current.length) {
    return current.concat(cloneMessages(transcript.slice(prefixLength)));
  }

  if (options.allowReplace) {
    return overlayLocalMessageEnhancements(current, cloneMessages(transcript));
  }

  return current;
}

function overlayLocalMessageEnhancements(currentMessages, transcriptMessages) {
  const merged = Array.isArray(transcriptMessages) ? transcriptMessages : [];
  if (!merged.length) {
    return merged;
  }

  let searchStartIndex = 0;
  for (const currentMessage of Array.isArray(currentMessages) ? currentMessages : []) {
    const matchIndex = findMatchingMessageIndex(currentMessage, merged, searchStartIndex);
    if (matchIndex < 0) {
      continue;
    }

    merged[matchIndex] = mergeMatchedMessage(currentMessage, merged[matchIndex]);
    searchStartIndex = matchIndex + 1;
  }

  return merged;
}

function findMatchingMessageIndex(targetMessage, messages, startIndex = 0) {
  const items = Array.isArray(messages) ? messages : [];
  for (let index = Math.max(0, startIndex); index < items.length; index += 1) {
    if (sameConversationMessage(targetMessage, items[index])) {
      return index;
    }
  }
  return -1;
}

function mergeMatchedMessage(currentMessage, transcriptMessage) {
  const baseMessage = {
    ...transcriptMessage,
    attachments: sanitizeMessageAttachments(transcriptMessage?.attachments),
  };
  const currentAttachments = sanitizeMessageAttachments(currentMessage?.attachments);
  const currentText = String(currentMessage?.text || '').trim();
  const transcriptText = String(baseMessage.text || '').trim();

  if (
    String(currentMessage?.role || '').trim() === 'user'
    && isLikelyAbbreviatedUserMessage(currentText, transcriptText)
  ) {
    baseMessage.text = preferLongerMessageText(currentText, transcriptText);
  }

  if (
    String(currentMessage?.role || '').trim() === 'user'
    && currentText
    && transcriptText
    && currentText !== transcriptText
  ) {
    console.log(
      `[web-resume][msg-merge] currentLen=${currentText.length} transcriptLen=${transcriptText.length} chosenLen=${String(baseMessage.text || '').trim().length}`
      + ` current=${summarizeDebugText(currentText)} transcript=${summarizeDebugText(transcriptText)} chosen=${summarizeDebugText(baseMessage.text)}`
    );
  }

  if (!currentAttachments.length) {
    return baseMessage;
  }

  if (!baseMessage.attachments.length) {
    baseMessage.attachments = currentAttachments;
  }

  if (
    isAttachmentPlaceholderText(transcriptText)
    || parseWebAttachmentPrompt(transcriptText)?.displayText
  ) {
    baseMessage.text = currentText || baseMessage.text;
  }

  return baseMessage;
}

function getMessagePrefixLength(leftMessages, rightMessages) {
  const size = Math.min(leftMessages.length, rightMessages.length);
  let index = 0;
  while (index < size && sameConversationMessage(leftMessages[index], rightMessages[index])) {
    index += 1;
  }
  return index;
}

function sameConversationMessage(left, right) {
  const leftRole = String(left?.role || '').trim();
  const rightRole = String(right?.role || '').trim();
  const leftText = String(left?.text || '').trim();
  const rightText = String(right?.text || '').trim();
  if (!leftRole || leftRole !== rightRole) {
    return false;
  }

  if (leftText === rightText) {
    return true;
  }

  const leftAttachments = sanitizeMessageAttachments(left?.attachments);
  const rightAttachments = sanitizeMessageAttachments(right?.attachments);
  if (
    leftRole === 'user'
    && (
      (leftAttachments.length && isAttachmentPlaceholderText(rightText))
      || (rightAttachments.length && isAttachmentPlaceholderText(leftText))
    )
  ) {
    return true;
  }

  const leftPromptAttachmentInfo = leftRole === 'user' ? parseWebAttachmentPrompt(leftText) : null;
  const rightPromptAttachmentInfo = rightRole === 'user' ? parseWebAttachmentPrompt(rightText) : null;
  if (leftPromptAttachmentInfo?.displayText && leftPromptAttachmentInfo.displayText === rightText) {
    return true;
  }
  if (rightPromptAttachmentInfo?.displayText && rightPromptAttachmentInfo.displayText === leftText) {
    return true;
  }

  if (
    leftRole === 'user'
    && (
      leftAttachments.length
      || rightAttachments.length
      || leftPromptAttachmentInfo?.displayText
      || rightPromptAttachmentInfo?.displayText
    )
    && isLikelyAbbreviatedUserMessage(leftText, rightText)
  ) {
    return true;
  }

  return false;
}

function isLikelyAbbreviatedUserMessage(leftText, rightText) {
  const normalizedLeft = normalizeComparableMessageText(leftText);
  const normalizedRight = normalizeComparableMessageText(rightText);
  if (!normalizedLeft || !normalizedRight || normalizedLeft === normalizedRight) {
    return false;
  }

  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = shorter === normalizedLeft ? normalizedRight : normalizedLeft;
  if (shorter.length < 16 || longer.length < 80) {
    return false;
  }

  return longer.startsWith(shorter);
}

function preferLongerMessageText(leftText, rightText) {
  const normalizedLeft = String(leftText || '').trim();
  const normalizedRight = String(rightText || '').trim();
  return normalizedLeft.length >= normalizedRight.length ? normalizedLeft : normalizedRight;
}

function normalizeComparableMessageText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .trim()
    .replace(/[ \t]+/g, ' ');
}

function cloneMessages(messages) {
  return messages.map((message, index) => ({
    id: String(message?.id || `native-${index + 1}`),
    role: message?.role === 'assistant' ? 'assistant' : 'user',
    text: String(message?.text || '').trim(),
    createdAt: String(message?.createdAt || nowIso()),
    source: String(message?.source || 'codex'),
    attachments: sanitizeMessageAttachments(message?.attachments),
  }));
}

function sanitizeMessageAttachments(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, index) => ({
      id: String(item?.id || `att-${index + 1}`),
      name: String(item?.name || '').trim(),
      size: Number(item?.size || 0),
      mimeType: String(item?.mimeType || 'application/octet-stream').trim() || 'application/octet-stream',
      kind: String(item?.kind || 'file').trim() || 'file',
      createdAt: String(item?.createdAt || nowIso()),
      source: String(item?.source || 'attachment').trim() || 'attachment',
      path: String(item?.path || '').trim(),
    }))
    .filter((item) => item.id && item.name);
}

function isAttachmentPlaceholderText(text) {
  return String(text || '').trim() === '请先查看本条消息附带的附件，并根据附件内容继续处理。';
}

function inferAttachmentKindFromPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'].includes(ext)) {
    return 'image';
  }
  if (['.txt', '.md', '.json', '.log', '.csv', '.html'].includes(ext)) {
    return 'text';
  }
  if (['.zip'].includes(ext)) {
    return 'archive';
  }
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(ext)) {
    return 'document';
  }
  return 'file';
}

function syncSessionDerivedFields(session, native, transcript) {
  let changed = false;
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const lastAssistant = findLastMessageByRole(messages, 'assistant');
  const lastMessage = messages[messages.length - 1] || null;
  const nextPreview = String(lastMessage?.text || native?.preview || '').replace(/\s+/g, ' ').trim();
  const nextLastReply = String(lastAssistant?.text || '').trim();

  if (nextPreview && nextPreview !== String(session.preview || '').trim()) {
    session.preview = truncateText(nextPreview, 120);
    changed = true;
  }

  if (nextLastReply !== String(session.lastReply || '').trim()) {
    session.lastReply = nextLastReply;
    changed = true;
  }

  if (nextLastReply && session.lastError) {
    session.lastError = '';
    changed = true;
  }

  const nextModel = String(native?.model || session.model || '').trim();
  if (nextModel !== String(session.model || '').trim()) {
    session.model = nextModel;
    changed = true;
  }

  const nextReasoningEffort = String(native?.reasoningEffort || session.reasoningEffort || '').trim();
  if (nextReasoningEffort !== String(session.reasoningEffort || '').trim()) {
    session.reasoningEffort = nextReasoningEffort;
    changed = true;
  }

  const nextTokenUsageSerialized = JSON.stringify(native?.tokenUsage || null);
  if (nextTokenUsageSerialized !== JSON.stringify(session.tokenUsage || null)) {
    session.tokenUsage = native?.tokenUsage || null;
    changed = true;
  }

  if (
    session?.source === 'web'
    && session.tokenUsageBaselineTotal == null
    && native?.filePath
  ) {
    const baselineTotal = findTokenUsageBaselineTotalBefore(native.filePath, session.createdAt || session.updatedAt || '');
    if (baselineTotal != null) {
      session.tokenUsageBaselineTotal = baselineTotal;
      changed = true;
    }
  }

  if (
    (session.title === '新会话' || session.title === '历史会话')
    && Array.isArray(transcript?.messages)
  ) {
    const firstUser = transcript.messages.find((message) => message?.role === 'user' && String(message?.text || '').trim());
    if (firstUser) {
      const title = truncateText(String(firstUser.text || '').replace(/\s+/g, ' ').trim(), 80);
      if (title && title !== session.title) {
        session.title = title;
        changed = true;
      }
    }
  }

  return changed;
}

function findLastMessageByRole(messages, role) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === role && String(message?.text || '').trim()) {
      return message;
    }
  }
  return null;
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
    model: String(session.model || '').trim(),
    reasoningEffort: String(session.reasoningEffort || '').trim(),
    tokenUsage: buildDisplayTokenUsage(session),
  };
}

function buildDisplayTokenUsage(session) {
  const raw = session?.tokenUsage;
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const total = raw.total && typeof raw.total === 'object'
    ? { ...raw.total }
    : null;

  const baselineTotal = Number(session?.tokenUsageBaselineTotal);
  if (total && Number.isFinite(baselineTotal) && baselineTotal >= 0) {
    total.totalTokens = Math.max(0, Number(total.totalTokens || 0) - baselineTotal);
  }

  return {
    ...raw,
    total,
  };
}

function findTokenUsageBaselineTotalBefore(filePath, referenceIso) {
  const referenceTime = new Date(referenceIso || '').getTime();
  if (!Number.isFinite(referenceTime) || !fs.existsSync(filePath)) {
    return 0;
  }

  let baselineTotal = 0;
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry?.type !== 'event_msg' || entry?.payload?.type !== 'token_count') {
        continue;
      }

      const eventTime = new Date(entry.timestamp || '').getTime();
      if (!Number.isFinite(eventTime) || eventTime >= referenceTime) {
        continue;
      }

      const totalTokens = Number(entry.payload?.info?.total_token_usage?.total_tokens);
      if (!Number.isFinite(totalTokens) || totalTokens < 0) {
        continue;
      }
      baselineTotal = Math.floor(totalTokens);
    }
  } catch {
    return 0;
  }

  return baselineTotal;
}

function serializeSessionDetail(session, options = {}) {
  const messagePage = buildDisplayMessagePage(session.messages, options.messages);
  return {
    ...serializeSessionSummary(session),
    lastReply: String(session.lastReply || '').trim(),
    messages: messagePage.messages,
    messagePage: messagePage.meta,
    events: session.events,
    artifacts: session.artifacts,
    canStop: codexRunner.isRunning(session.id),
  };
}

function buildProjectTreePayload(session, relativePathInput) {
  const rootDir = resolveProjectRoot(session);
  const relativePath = normalizeProjectRelativePath(relativePathInput);
  const targetPath = resolveProjectChildPath(rootDir, relativePath);
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
    throw new Error('目录不存在');
  }

  const ignoredDirectoryNames = new Set([
    '.git',
    'node_modules',
    'DerivedData',
    '.next',
    'dist',
    'build',
    '.turbo',
  ]);
  const maxEntries = 400;
  const dirents = fs.readdirSync(targetPath, { withFileTypes: true })
    .filter((item) => !(item.isDirectory() && ignoredDirectoryNames.has(item.name)))
    .sort((lhs, rhs) => {
      if (lhs.isDirectory() !== rhs.isDirectory()) {
        return lhs.isDirectory() ? -1 : 1;
      }
      return lhs.name.localeCompare(rhs.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });

  const visibleDirents = dirents.slice(0, maxEntries);
  const entries = visibleDirents.map((dirent) => {
    const fullPath = path.join(targetPath, dirent.name);
    const entryRelativePath = normalizeProjectRelativePath(path.relative(rootDir, fullPath));
    const stat = fs.statSync(fullPath);
    return {
      name: dirent.name,
      relativePath: entryRelativePath,
      type: dirent.isDirectory() ? 'directory' : 'file',
      size: dirent.isDirectory() ? null : stat.size,
      mimeType: dirent.isDirectory() ? null : guessMimeType(fullPath),
      kind: dirent.isDirectory() ? null : guessArtifactKind(fullPath),
    };
  });

  return {
    rootName: path.basename(rootDir),
    workdir: rootDir,
    currentPath: relativePath,
    truncated: dirents.length > visibleDirents.length,
    entries,
  };
}

function buildProjectFilePreview(session, relativePathInput) {
  const rootDir = resolveProjectRoot(session);
  const relativePath = normalizeProjectRelativePath(relativePathInput);
  if (!relativePath) {
    throw new Error('缺少文件路径');
  }

  const filePath = resolveProjectChildPath(rootDir, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error('文件不存在');
  }

  if (!isPreviewableProjectFile(filePath)) {
    throw new Error('当前文件暂不支持预览');
  }

  const maxLines = 240;
  const maxChars = 20000;
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) {
    throw new Error('当前文件看起来不是文本文件');
  }

  const content = buffer.toString('utf8');
  const clipped = content.slice(0, maxChars);
  const lines = clipped.split(/\r?\n/).slice(0, maxLines);

  return {
    name: path.basename(filePath),
    relativePath,
    truncated: content.length > clipped.length || content.split(/\r?\n/).length > lines.length,
    text: lines.join('\n'),
  };
}

function resolveProjectRoot(session) {
  const workdir = path.resolve(String(session?.workdir || '').trim() || config.webWorkdir);
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    throw new Error('当前会话工作目录不存在');
  }
  return workdir;
}

function normalizeProjectRelativePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/^\.$/, '')
    .trim();
}

function resolveProjectChildPath(rootDir, relativePath) {
  const targetPath = path.resolve(rootDir, relativePath || '.');
  if (!isSubPath(rootDir, targetPath)) {
    throw new Error('请求路径超出项目目录');
  }
  return targetPath;
}

function isPreviewableProjectFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (guessArtifactKind(filePath) === 'text') {
    return true;
  }

  return [
    '.swift',
    '.m',
    '.mm',
    '.h',
    '.c',
    '.cc',
    '.cpp',
    '.hpp',
    '.js',
    '.jsx',
    '.ts',
    '.tsx',
    '.mjs',
    '.cjs',
    '.css',
    '.scss',
    '.sass',
    '.less',
    '.java',
    '.kt',
    '.kts',
    '.go',
    '.rs',
    '.py',
    '.rb',
    '.php',
    '.sh',
    '.bash',
    '.zsh',
    '.ps1',
    '.toml',
    '.ini',
    '.cfg',
    '.conf',
    '.env',
    '.plist',
    '.pbxproj',
    '.xcconfig',
    '.yml',
    '.yaml',
    '.xml',
  ].includes(ext);
}

function sanitizeMessagesForDisplay(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message, index) => sanitizeTranscriptMessage(message, index))
    .filter(Boolean);
}

function buildDisplayMessagePage(messages, options = {}) {
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

  const collected = [];
  let earliestLoadedIndex = endExclusive;
  for (let index = endExclusive - 1; index >= 0 && collected.length < limit; index -= 1) {
    const sanitized = sanitizeTranscriptMessage(sourceMessages[index], index);
    if (!sanitized) {
      continue;
    }
    collected.push(sanitized);
    earliestLoadedIndex = index;
  }

  const pageMessages = collected.reverse();
  let hasMore = false;
  if (earliestLoadedIndex > 0) {
    for (let index = earliestLoadedIndex - 1; index >= 0; index -= 1) {
      if (sanitizeTranscriptMessage(sourceMessages[index], index)) {
        hasMore = true;
        break;
      }
    }
  }

  return {
    messages: pageMessages,
    meta: {
      limit,
      loaded: pageMessages.length,
      hasMore,
      nextBeforeId: hasMore && pageMessages.length ? String(pageMessages[0].id || '') : '',
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

  const imageCount = attachments.filter((item) => String(item?.kind || '').trim().toLowerCase() === 'image').length;

  return [
    normalizedMessage,
    ...(imageCount > 0
      ? ['', `本条消息还附带了 ${imageCount} 张图片，这些图片已作为多模态输入附加，请直接查看图片内容。`]
      : []),
    '',
    '本条消息附带了以下本地附件，请优先查看这些文件：',
    ...attachments.map((item, index) => `${index + 1}. ${item.name}: ${item.path}`),
    '',
    '要求：',
    '1. 优先结合已附加图片和上述附件文件内容回答。',
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

function summarizeDebugText(text, maxLength = 120) {
  const normalized = String(text || '')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return truncateText(normalized, maxLength);
}
