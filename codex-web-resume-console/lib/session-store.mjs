import fs from 'node:fs';
import { buildSessionTitle, createId, nowIso, truncateText, compactText } from '../../codex-web-console/lib/utils.mjs';

export class SessionStore {
  constructor(statePath) {
    this.statePath = statePath;
    this.sessions = new Map();
    this.load();
  }

  load() {
    if (!fs.existsSync(this.statePath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.statePath, 'utf8');
      const data = JSON.parse(raw);
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      for (const session of sessions) {
        const normalized = normalizeSession(session);
        this.sessions.set(normalized.id, normalized);
      }
    } catch {
      this.sessions.clear();
    }
  }

  persist() {
    const sessions = Array.from(this.sessions.values())
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
    fs.writeFileSync(this.statePath, JSON.stringify({ sessions }, null, 2), 'utf8');
  }

  getAll() {
    return Array.from(this.sessions.values())
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  resolve(sessionId) {
    return this.get(sessionId);
  }

  findByThreadId(threadId) {
    const normalized = String(threadId || '').trim();
    if (!normalized) {
      return null;
    }

    for (const session of this.sessions.values()) {
      if (String(session.codexThreadId || '').trim() === normalized) {
        return session;
      }
    }

    return null;
  }

  createSession(input = {}) {
    const now = nowIso();
    const session = normalizeSession({
      id: input.id || createId('web'),
      title: String(input.title || '').trim() || '新会话',
      source: input.source || 'web',
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now,
      lastActivityAt: input.lastActivityAt || now,
      workdir: String(input.workdir || '').trim(),
      codexThreadId: String(input.codexThreadId || '').trim(),
      status: input.status || 'idle',
      lastError: String(input.lastError || ''),
      lastReply: String(input.lastReply || ''),
      preview: String(input.preview || ''),
      model: String(input.model || ''),
      reasoningEffort: String(input.reasoningEffort || ''),
      tokenUsage: input.tokenUsage,
      messages: Array.isArray(input.messages) ? input.messages : [],
      events: Array.isArray(input.events) ? input.events : [],
      artifacts: Array.isArray(input.artifacts) ? input.artifacts : [],
      currentRun: null,
    });
    this.sessions.set(session.id, session);
    this.persist();
    return session;
  }

  ensureImportedSession(meta, transcript = { messages: [] }) {
    const preferredTitle = String(meta.title || '').trim() || buildSessionTitle(meta.preview, '历史会话');
    const existing = this.get(meta.id);
    if (existing) {
      if (shouldRefreshImportedMessages(existing, transcript)) {
        existing.messages = normalizeMessages(transcript.messages);
      }
      existing.codexThreadId = existing.codexThreadId || meta.id;
      existing.workdir = existing.workdir || meta.cwd || '';
      applyImportedRuntimeState(existing, meta);
      if (meta.preview) {
        existing.preview = meta.preview;
      }
      if (
        preferredTitle
        && (
          existing.source === 'imported'
          || existing.title === '新会话'
          || existing.title === '历史会话'
        )
      ) {
        existing.title = preferredTitle;
      }
      existing.updatedAt = latestIso(existing.updatedAt, meta.lastWriteTime);
      existing.lastActivityAt = latestIso(existing.lastActivityAt, meta.lastWriteTime);
      existing.source = 'imported';
      this.persist();
      return existing;
    }

    return this.createSession({
      id: meta.id,
      title: preferredTitle,
      source: 'imported',
      createdAt: meta.timestamp || meta.lastWriteTime || nowIso(),
      updatedAt: meta.lastWriteTime || meta.timestamp || nowIso(),
      lastActivityAt: meta.lastWriteTime || meta.timestamp || nowIso(),
      workdir: meta.cwd || '',
      codexThreadId: meta.id,
      status: 'idle',
      preview: meta.preview || '',
      model: meta.model || '',
      reasoningEffort: meta.reasoningEffort || '',
      tokenUsage: meta.tokenUsage || null,
      messages: Array.isArray(transcript.messages) ? transcript.messages : [],
    });
  }

  updateSession(sessionId, patch = {}) {
    const session = this.get(sessionId);
    if (!session) {
      return null;
    }

    Object.assign(session, patch);
    session.updatedAt = nowIso();
    session.lastActivityAt = patch.lastActivityAt || session.updatedAt;
    this.persist();
    return session;
  }

  appendMessage(sessionId, role, text, options = {}) {
    const session = this.get(sessionId);
    if (!session) {
      return null;
    }

    const normalizedText = String(text || '').trim();
    if (!normalizedText) {
      return null;
    }

    const message = {
      id: createId('msg'),
      role: role === 'assistant' ? 'assistant' : 'user',
      text: normalizedText,
      createdAt: options.createdAt || nowIso(),
      source: options.source || 'web',
      attachments: normalizeMessageAttachments(options.attachments),
    };

    session.messages.push(message);
    if (session.messages.length > 200) {
      session.messages.splice(0, session.messages.length - 200);
    }

    session.updatedAt = nowIso();
    session.lastActivityAt = session.updatedAt;
    session.preview = truncateText(compactText(normalizedText), 120);

    if ((session.title === '新会话' || session.title === '历史会话') && message.role === 'user') {
      session.title = buildSessionTitle(normalizedText, session.title);
    }

    if (message.role === 'assistant') {
      session.lastReply = normalizedText;
      session.lastError = '';
    }

    this.persist();
    return message;
  }

  appendEvent(sessionId, event) {
    const session = this.get(sessionId);
    if (!session) {
      return null;
    }

    const normalized = {
      id: event.id || createId('evt'),
      type: event.type || 'status',
      sessionId,
      timestamp: event.timestamp || nowIso(),
      payload: event.payload || {},
    };

    session.events.push(normalized);
    if (session.events.length > 240) {
      session.events.splice(0, session.events.length - 240);
    }

    session.updatedAt = normalized.timestamp;
    session.lastActivityAt = normalized.timestamp;
    this.persist();
    return normalized;
  }

  addArtifact(sessionId, artifact) {
    const session = this.get(sessionId);
    if (!session) {
      return null;
    }

    const existing = session.artifacts.find((item) => item.path === artifact.path);
    if (existing) {
      return existing;
    }

    session.artifacts.push(artifact);
    session.updatedAt = nowIso();
    session.lastActivityAt = session.updatedAt;
    this.persist();
    return artifact;
  }

  removeSession(sessionId) {
    const removed = this.sessions.delete(sessionId);
    if (removed) {
      this.persist();
    }
    return removed;
  }
}

function normalizeSession(raw) {
  const now = nowIso();
  const session = {
    id: String(raw?.id || createId('web')),
    title: String(raw?.title || '新会话'),
    source: raw?.source === 'imported' ? 'imported' : 'web',
    createdAt: String(raw?.createdAt || now),
    updatedAt: String(raw?.updatedAt || now),
    lastActivityAt: String(raw?.lastActivityAt || raw?.updatedAt || now),
    workdir: String(raw?.workdir || ''),
    codexThreadId: String(raw?.codexThreadId || '').trim(),
    status: normalizeStatus(raw?.status),
    lastError: String(raw?.lastError || ''),
    lastReply: String(raw?.lastReply || ''),
    preview: String(raw?.preview || ''),
    model: String(raw?.model || '').trim(),
    reasoningEffort: String(raw?.reasoningEffort || '').trim(),
    tokenUsage: normalizeTokenUsage(raw?.tokenUsage),
    messages: normalizeMessages(raw?.messages),
    events: normalizeEvents(raw?.events),
    artifacts: normalizeArtifacts(raw?.artifacts),
    currentRun: null,
  };

  if (session.status === 'running') {
    session.status = 'idle';
  }

  return session;
}

function normalizeMessages(messages) {
  return Array.isArray(messages)
    ? messages
      .map((item, index) => ({
        id: String(item?.id || `msg-${index + 1}`),
        role: item?.role === 'assistant' ? 'assistant' : 'user',
        text: String(item?.text || '').trim(),
        createdAt: String(item?.createdAt || nowIso()),
        source: String(item?.source || 'web'),
        attachments: normalizeMessageAttachments(item?.attachments),
      }))
      .filter((item) => item.text)
    : [];
}

function normalizeMessageAttachments(items) {
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

function normalizeEvents(events) {
  return Array.isArray(events)
    ? events.map((item, index) => ({
      id: String(item?.id || `evt-${index + 1}`),
      type: String(item?.type || 'status'),
      sessionId: String(item?.sessionId || ''),
      timestamp: String(item?.timestamp || nowIso()),
      payload: item?.payload && typeof item.payload === 'object' ? item.payload : {},
    }))
    : [];
}

function normalizeArtifacts(artifacts) {
  return Array.isArray(artifacts)
    ? artifacts
      .map((item, index) => ({
        id: String(item?.id || `art-${index + 1}`),
        sessionId: String(item?.sessionId || ''),
        name: String(item?.name || ''),
        path: String(item?.path || ''),
        size: Number(item?.size || 0),
        mimeType: String(item?.mimeType || 'application/octet-stream'),
        kind: String(item?.kind || 'file'),
        createdAt: String(item?.createdAt || nowIso()),
        source: String(item?.source || 'reply'),
      }))
      .filter((item) => item.path)
    : [];
}

function normalizeStatus(status) {
  if (status === 'running' || status === 'error' || status === 'stopped') {
    return status;
  }
  return 'idle';
}

function applyImportedRuntimeState(session, meta) {
  if (!session || !meta) {
    return;
  }

  if (meta.model) {
    session.model = String(meta.model).trim();
  }

  if (meta.reasoningEffort) {
    session.reasoningEffort = String(meta.reasoningEffort).trim();
  }

  if (meta.tokenUsage && typeof meta.tokenUsage === 'object') {
    session.tokenUsage = normalizeTokenUsage(meta.tokenUsage);
  }
}

function normalizeTokenUsage(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const modelContextWindow = normalizeOptionalNumber(raw.modelContextWindow);
  const contextTokens = normalizeOptionalNumber(raw.contextTokens);
  const remainingTokens = normalizeOptionalNumber(raw.remainingTokens);
  const contextUsagePercent = normalizeOptionalFloat(raw.contextUsagePercent);
  const total = normalizeTokenBreakdown(raw.total);
  const last = normalizeTokenBreakdown(raw.last);

  if (
    !String(raw.updatedAt || '').trim()
    && modelContextWindow == null
    && contextTokens == null
    && remainingTokens == null
    && contextUsagePercent == null
    && !total
    && !last
  ) {
    return null;
  }

  return {
    updatedAt: String(raw.updatedAt || '').trim(),
    modelContextWindow,
    contextTokens,
    remainingTokens,
    contextUsagePercent,
    total,
    last,
  };
}

function normalizeTokenBreakdown(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const normalized = {
    inputTokens: normalizeRequiredNumber(raw.inputTokens),
    cachedInputTokens: normalizeRequiredNumber(raw.cachedInputTokens),
    outputTokens: normalizeRequiredNumber(raw.outputTokens),
    reasoningOutputTokens: normalizeRequiredNumber(raw.reasoningOutputTokens),
    totalTokens: normalizeRequiredNumber(raw.totalTokens),
  };

  return Object.values(normalized).some((value) => value > 0) ? normalized : null;
}

function normalizeOptionalNumber(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return null;
  }
  return Math.floor(normalized);
}

function normalizeOptionalFloat(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return null;
  }
  return Math.round(normalized * 10) / 10;
}

function normalizeRequiredNumber(value) {
  const normalized = normalizeOptionalNumber(value);
  return normalized == null ? 0 : normalized;
}

function shouldRefreshImportedMessages(session, transcript) {
  const nextMessages = Array.isArray(transcript?.messages) ? transcript.messages : [];
  const currentMessages = Array.isArray(session?.messages) ? session.messages : [];

  if (!nextMessages.length) {
    return false;
  }

  if (!currentMessages.length) {
    return true;
  }

  if (nextMessages.length !== currentMessages.length) {
    return true;
  }

  const nextLast = nextMessages[nextMessages.length - 1];
  const currentLast = currentMessages[currentMessages.length - 1];
  return String(nextLast?.text || '') !== String(currentLast?.text || '');
}

function latestIso(left, right) {
  const leftTime = new Date(left || 0).getTime();
  const rightTime = new Date(right || 0).getTime();
  if (!Number.isFinite(leftTime)) {
    return right || nowIso();
  }
  if (!Number.isFinite(rightTime)) {
    return left || nowIso();
  }
  return leftTime >= rightTime ? left : right;
}
