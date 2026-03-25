import fs from 'node:fs';
import { buildSessionTitle, createId, nowIso, truncateText, compactText } from './utils.mjs';

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
      this.reconcileLinkedSessions();
    } catch {
      this.sessions.clear();
    }
  }

  persist() {
    const sessions = Array.from(this.sessions.values())
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
    fs.writeFileSync(this.statePath, JSON.stringify({ sessions }, null, 2), 'utf8');
  }

  getAll(options = {}) {
    const includeHidden = Boolean(options.includeHidden);
    return Array.from(this.sessions.values())
      .filter((item) => includeHidden || !item.hidden)
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  resolve(sessionId) {
    let current = this.get(sessionId);
    const visited = new Set();

    while (current?.mergedInto && !visited.has(current.id)) {
      visited.add(current.id);
      const next = this.get(current.mergedInto);
      if (!next) {
        break;
      }
      current = next;
    }

    return current || null;
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
      messages: Array.isArray(input.messages) ? input.messages : [],
      events: Array.isArray(input.events) ? input.events : [],
      artifacts: Array.isArray(input.artifacts) ? input.artifacts : [],
      hidden: Boolean(input.hidden),
      mergedInto: String(input.mergedInto || '').trim(),
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
        existing.messages = transcript.messages;
      }
      if (!existing.codexThreadId) {
        existing.codexThreadId = meta.id;
      }
      if (!existing.workdir) {
        existing.workdir = meta.cwd || existing.workdir;
      }
      if (meta.preview) {
        existing.preview = meta.preview;
      }
      if (
        preferredTitle &&
        (
          existing.source === 'imported'
          || existing.title === '新会话'
          || existing.title === '历史会话'
          || existing.title !== preferredTitle
        )
      ) {
        existing.title = preferredTitle;
      }
      existing.updatedAt = latestIso(existing.updatedAt, meta.lastWriteTime);
      existing.lastActivityAt = existing.updatedAt;
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

  attachSessionToThread(sessionId, threadId, options = {}) {
    const source = this.get(sessionId);
    const normalizedThreadId = String(threadId || '').trim();
    if (!source || !normalizedThreadId) {
      return source;
    }

    if (source.id === normalizedThreadId) {
      source.codexThreadId = normalizedThreadId;
      source.hidden = false;
      source.mergedInto = '';
      if (options.source) {
        source.source = options.source;
      }
      this.persist();
      return source;
    }

    let target = this.get(normalizedThreadId);
    if (!target) {
      target = normalizeSession({
        ...source,
        id: normalizedThreadId,
        codexThreadId: normalizedThreadId,
        hidden: false,
        mergedInto: '',
        currentRun: null,
      });
      if (options.source) {
        target.source = options.source;
      }
      this.sessions.set(target.id, target);
    }

    mergeSessionData(target, source, {
      preferredSource: options.source || (target.source === 'imported' || source.source === 'imported' ? 'imported' : 'web'),
      threadId: normalizedThreadId,
    });

    source.hidden = true;
    source.mergedInto = normalizedThreadId;
    source.codexThreadId = normalizedThreadId;
    source.status = 'idle';
    source.currentRun = null;

    this.persist();
    return target;
  }

  reconcileLinkedSessions() {
    const sessions = Array.from(this.sessions.values())
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());

    for (const session of sessions) {
      const threadId = String(session.codexThreadId || '').trim();
      if (!threadId || session.hidden || session.id === threadId) {
        continue;
      }

      this.attachSessionToThread(session.id, threadId, {
        source: 'imported',
      });
    }
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
    messages: normalizeMessages(raw?.messages),
    events: normalizeEvents(raw?.events),
    artifacts: normalizeArtifacts(raw?.artifacts),
    hidden: Boolean(raw?.hidden),
    mergedInto: String(raw?.mergedInto || '').trim(),
    currentRun: null,
  };

  if (session.status === 'running') {
    session.status = 'idle';
  }

  return session;
}

function mergeSessionData(target, source, options = {}) {
  target.source = options.preferredSource || target.source;
  target.codexThreadId = String(options.threadId || target.codexThreadId || source.codexThreadId || target.id).trim();
  target.hidden = false;
  target.mergedInto = '';
  target.workdir = target.workdir || source.workdir;
  target.title = pickBetterTitle(target.title, source.title, target.preview, source.preview);
  target.preview = pickLatestText(target.preview, source.preview, source.updatedAt, target.updatedAt);
  target.createdAt = earliestIso(target.createdAt, source.createdAt);
  target.updatedAt = latestIso(target.updatedAt, source.updatedAt, source.lastActivityAt);
  target.lastActivityAt = latestIso(target.lastActivityAt, source.lastActivityAt, source.updatedAt);
  target.lastReply = pickLatestText(target.lastReply, source.lastReply, target.updatedAt, source.updatedAt);
  target.lastError = pickLatestText(target.lastError, source.lastError, target.updatedAt, source.updatedAt);
  target.status = mergeStatus(target.status, source.status);
  target.messages = mergeMessages(target.messages, source.messages);
  target.events = mergeEvents(target.events, source.events, target.id);
  target.artifacts = mergeArtifacts(target.artifacts, source.artifacts, target.id);
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

  for (let index = 0; index < nextMessages.length; index += 1) {
    const current = currentMessages[index];
    const next = nextMessages[index];
    if (
      current?.createdAt !== next?.createdAt ||
      current?.role !== next?.role ||
      current?.text !== next?.text
    ) {
      return true;
    }
  }

  return false;
}

function latestIso(...values) {
  let bestValue = '';
  let bestTime = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized) {
      continue;
    }

    const time = new Date(normalized).getTime();
    if (Number.isNaN(time)) {
      continue;
    }

    if (time > bestTime) {
      bestTime = time;
      bestValue = normalized;
    }
  }

  return bestValue || nowIso();
}

function earliestIso(...values) {
  let bestValue = '';
  let bestTime = Number.POSITIVE_INFINITY;

  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized) {
      continue;
    }

    const time = new Date(normalized).getTime();
    if (Number.isNaN(time)) {
      continue;
    }

    if (time < bestTime) {
      bestTime = time;
      bestValue = normalized;
    }
  }

  return bestValue || nowIso();
}

function pickBetterTitle(currentTitle, nextTitle, currentPreview, nextPreview) {
  const current = String(currentTitle || '').trim();
  const next = String(nextTitle || '').trim();

  if (isPlaceholderTitle(current) && next) {
    return next;
  }

  if (isPlaceholderTitle(next)) {
    return current || next || '新会话';
  }

  if (nextPreview && !currentPreview) {
    return next || current || '新会话';
  }

  return current || next || '新会话';
}

function isPlaceholderTitle(value) {
  const normalized = String(value || '').trim();
  return !normalized || normalized === '新会话' || normalized === '历史会话';
}

function pickLatestText(currentText, nextText, currentAt, nextAt) {
  const current = String(currentText || '').trim();
  const next = String(nextText || '').trim();
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }

  return latestIso(currentAt, nextAt) === String(nextAt || '').trim() ? next : current;
}

function mergeStatus(left, right) {
  const priorities = new Map([
    ['running', 4],
    ['error', 3],
    ['stopped', 2],
    ['idle', 1],
  ]);

  const leftStatus = normalizeStatus(left);
  const rightStatus = normalizeStatus(right);
  return (priorities.get(rightStatus) || 0) > (priorities.get(leftStatus) || 0)
    ? rightStatus
    : leftStatus;
}

function mergeMessages(currentItems, nextItems) {
  const merged = [];

  for (const item of [...normalizeMessages(currentItems), ...normalizeMessages(nextItems)]) {
    if (merged.some((existing) => isSameMessage(existing, item))) {
      continue;
    }
    merged.push(item);
  }

  merged.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  return merged.slice(-400);
}

function isSameMessage(left, right) {
  if (!left || !right) {
    return false;
  }

  if (left.id && right.id && left.id === right.id) {
    return true;
  }

  if (left.role !== right.role || left.text !== right.text) {
    return false;
  }

  const leftTime = new Date(left.createdAt).getTime();
  const rightTime = new Date(right.createdAt).getTime();
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
    return false;
  }

  return Math.abs(leftTime - rightTime) <= 120000;
}

function mergeEvents(currentItems, nextItems, targetSessionId) {
  const merged = [];

  for (const item of [...normalizeEvents(currentItems), ...normalizeEvents(nextItems)]) {
    const normalized = {
      ...item,
      sessionId: targetSessionId,
    };

    if (merged.some((existing) => isSameEvent(existing, normalized))) {
      continue;
    }
    merged.push(normalized);
  }

  merged.sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
  return merged.slice(-400);
}

function isSameEvent(left, right) {
  if (!left || !right) {
    return false;
  }

  if (left.id && right.id && left.id === right.id) {
    return true;
  }

  return (
    left.type === right.type &&
    left.timestamp === right.timestamp &&
    JSON.stringify(left.payload || {}) === JSON.stringify(right.payload || {})
  );
}

function mergeArtifacts(currentItems, nextItems, targetSessionId) {
  const merged = [];

  for (const item of [...normalizeArtifacts(currentItems), ...normalizeArtifacts(nextItems)]) {
    const normalized = {
      ...item,
      sessionId: targetSessionId,
    };

    if (merged.some((existing) => existing.path === normalized.path || existing.id === normalized.id)) {
      continue;
    }
    merged.push(normalized);
  }

  merged.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  return merged.slice(-80);
}

function normalizeMessages(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, index) => ({
      id: String(item?.id || `msg-${index + 1}`),
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      text: String(item?.text || '').trim(),
      createdAt: String(item?.createdAt || item?.at || nowIso()),
      source: String(item?.source || 'web'),
      attachments: normalizeMessageAttachments(item?.attachments),
    }))
    .filter((item) => item.text);
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

function normalizeEvents(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item, index) => ({
    id: String(item?.id || `evt-${index + 1}`),
    type: String(item?.type || 'status'),
    sessionId: String(item?.sessionId || ''),
    timestamp: String(item?.timestamp || nowIso()),
    payload: item?.payload && typeof item.payload === 'object' ? item.payload : {},
  }));
}

function normalizeArtifacts(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
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
    .filter((item) => item.path);
}

function normalizeStatus(status) {
  const value = String(status || '').trim();
  if (['idle', 'running', 'error', 'stopped'].includes(value)) {
    return value;
  }
  return 'idle';
}
