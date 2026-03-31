import fs from 'node:fs';
import path from 'node:path';
import {
  truncateText,
  compactText,
  extractMessageTextFromResponseItem,
} from './utils.mjs';

const sessionMetaCache = new Map();
const transcriptCache = new Map();

export function listRecentCodexSessions(rootDir, options = {}) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }

  const limit = Number.isFinite(options.limit) ? options.limit : 20;
  const normalizedFilter = normalizeSessionCwd(options.cwdFilter || '');
  const files = walkSessionFiles(rootDir)
    .sort((left, right) => right.lastWriteTimeMs - left.lastWriteTimeMs);

  const results = [];
  for (const file of files) {
    const meta = parseCodexSessionFile(file.fullPath, file);
    if (!meta?.id) {
      continue;
    }
    if (normalizedFilter && normalizeSessionCwd(meta.cwd) !== normalizedFilter) {
      continue;
    }

    results.push({
      ...meta,
      lastWriteTime: new Date(file.lastWriteTimeMs).toISOString(),
      filePath: file.fullPath,
    });

    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

export function findCodexSessionById(rootDir, sessionId) {
  if (!rootDir || !sessionId || !fs.existsSync(rootDir)) {
    return null;
  }

  const files = walkSessionFiles(rootDir)
    .sort((left, right) => right.lastWriteTimeMs - left.lastWriteTimeMs);

  for (const file of files) {
    const meta = parseCodexSessionFile(file.fullPath, file);
    if (meta?.id === sessionId) {
      return {
        ...meta,
        lastWriteTime: new Date(file.lastWriteTimeMs).toISOString(),
        filePath: file.fullPath,
      };
    }
  }

  return null;
}

export function loadCodexSessionTranscript(filePath, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { messages: [] };
  }

  const hasMessageLimit = Number.isFinite(options.messageLimit) && options.messageLimit > 0;
  const stat = fs.statSync(filePath);
  const cacheKey = buildFileCacheKey(filePath, stat);
  const cached = transcriptCache.get(filePath);
  if (cached?.cacheKey === cacheKey) {
    return {
      messages: hasMessageLimit ? cached.messages.slice(-options.messageLimit) : cached.messages,
    };
  }

  const messages = [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== 'response_item') {
      continue;
    }

    const payload = entry.payload;
    if (payload?.type !== 'message') {
      continue;
    }

    const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : '';
    if (!role) {
      continue;
    }

    const text = extractMessageTextFromResponseItem(payload);
    if (!text) {
      continue;
    }

    messages.push({
      id: `native-${messages.length + 1}`,
      role,
      text,
      createdAt: String(entry.timestamp || payload.timestamp || '').trim() || new Date().toISOString(),
      source: 'codex',
    });
  }

  transcriptCache.set(filePath, {
    cacheKey,
    messages,
  });

  return {
    messages: hasMessageLimit ? messages.slice(-options.messageLimit) : messages,
  };
}

function walkSessionFiles(rootDir) {
  const results = [];
  const stack = [rootDir];

  while (stack.length) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) {
      continue;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const stat = fs.statSync(fullPath);
        results.push({
          fullPath,
          lastWriteTimeMs: stat.mtimeMs,
          size: stat.size,
        });
      }
    }
  }

  return results;
}

function parseCodexSessionFile(filePath, fileInfo = null) {
  try {
    const stat = fileInfo
      ? { mtimeMs: fileInfo.lastWriteTimeMs, size: fileInfo.size ?? 0 }
      : fs.statSync(filePath);
    const cacheKey = buildFileCacheKey(filePath, stat);
    const cached = sessionMetaCache.get(filePath);
    if (cached?.cacheKey === cacheKey) {
      return cached.value;
    }

    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    let id = '';
    let cwd = '';
    let timestamp = '';
    let preview = '';
    let lastUserTimestamp = '';
    let source = '';
    let modelProvider = '';
    let cliVersion = '';
    let model = '';
    let reasoningEffort = '';
    let tokenUsage = null;

    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type === 'session_meta') {
        id = String(entry.payload?.id || '').trim() || id;
        cwd = String(entry.payload?.cwd || '').trim() || cwd;
        timestamp = String(entry.payload?.timestamp || entry.timestamp || '').trim() || timestamp;
        source = String(entry.payload?.source || '').trim() || source;
        modelProvider = String(entry.payload?.model_provider || '').trim() || modelProvider;
        cliVersion = String(entry.payload?.cli_version || '').trim() || cliVersion;
        continue;
      }

      if (entry.type === 'turn_context') {
        model = String(entry.payload?.model || '').trim() || model;
        reasoningEffort = String(entry.payload?.effort || '').trim() || reasoningEffort;
        continue;
      }

      if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
        const normalizedTokenUsage = normalizeTokenUsageInfo(entry.payload?.info, entry.timestamp);
        if (normalizedTokenUsage) {
          tokenUsage = normalizedTokenUsage;
        }
        continue;
      }

      if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
        const candidate = compactPreview(extractUsefulPreview(entry.payload?.message || ''));
        const candidateTimestamp = String(entry.timestamp || '').trim();
        if (candidate && shouldUseLatestPreview(candidateTimestamp, lastUserTimestamp)) {
          preview = candidate;
          lastUserTimestamp = candidateTimestamp;
        }
        continue;
      }

      if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'user') {
        const candidate = compactPreview(extractUsefulPreview(extractMessageTextFromResponseItem(entry.payload)));
        const candidateTimestamp = String(entry.timestamp || entry.payload?.timestamp || '').trim();
        if (candidate && shouldUseLatestPreview(candidateTimestamp, lastUserTimestamp)) {
          preview = candidate;
          lastUserTimestamp = candidateTimestamp;
        }
      }
    }

    if (!id) {
      return null;
    }

    const value = {
      id,
      cwd,
      timestamp,
      preview,
      source,
      modelProvider,
      cliVersion,
      model,
      reasoningEffort,
      tokenUsage,
    };
    sessionMetaCache.set(filePath, { cacheKey, value });
    return value;
  } catch {
    return null;
  }
}

function buildFileCacheKey(filePath, stat) {
  const mtimeMs = Number(stat?.mtimeMs || 0);
  const size = Number(stat?.size || 0);
  return `${filePath}:${mtimeMs}:${size}`;
}

function normalizeTokenUsageInfo(info, timestamp = '') {
  if (!info || typeof info !== 'object') {
    return null;
  }

  const total = normalizeTokenBreakdown(info.total_token_usage);
  const last = normalizeTokenBreakdown(info.last_token_usage);
  const modelContextWindow = toSafeInteger(info.model_context_window);
  const contextTokens = total?.totalTokens ?? 0;
  const remainingTokens = modelContextWindow > 0
    ? Math.max(modelContextWindow - contextTokens, 0)
    : null;
  const contextUsagePercent = modelContextWindow > 0
    ? roundToSingleDecimal((contextTokens / modelContextWindow) * 100)
    : null;

  if (!total && !last && !modelContextWindow) {
    return null;
  }

  return {
    updatedAt: String(timestamp || '').trim(),
    modelContextWindow: modelContextWindow || null,
    contextTokens: contextTokens || 0,
    remainingTokens,
    contextUsagePercent,
    total,
    last,
  };
}

function normalizeTokenBreakdown(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const normalized = {
    inputTokens: toSafeInteger(input.input_tokens),
    cachedInputTokens: toSafeInteger(input.cached_input_tokens),
    outputTokens: toSafeInteger(input.output_tokens),
    reasoningOutputTokens: toSafeInteger(input.reasoning_output_tokens),
    totalTokens: toSafeInteger(input.total_tokens),
  };

  const hasValue = Object.values(normalized).some((value) => value > 0);
  return hasValue ? normalized : null;
}

function toSafeInteger(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return 0;
  }
  return Math.floor(normalized);
}

function roundToSingleDecimal(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return null;
  }
  return Math.round(normalized * 10) / 10;
}

function shouldUseLatestPreview(candidateTimestamp, currentTimestamp) {
  const candidate = String(candidateTimestamp || '').trim();
  const current = String(currentTimestamp || '').trim();

  if (!candidate) {
    return !current;
  }

  if (!current) {
    return true;
  }

  const candidateTime = new Date(candidate).getTime();
  const currentTime = new Date(current).getTime();
  if (Number.isNaN(candidateTime) || Number.isNaN(currentTime)) {
    return true;
  }

  return candidateTime >= currentTime;
}

function compactPreview(text) {
  return truncateText(compactText(text), 100);
}

function extractUsefulPreview(text) {
  const normalized = String(text || '').replace(/\r/g, '').trim();
  if (!normalized) {
    return '';
  }

  const lower = normalized.toLowerCase();
  if (
    lower.includes('agents.md instructions') &&
    !lower.includes('my request for codex') &&
    !lower.includes('我的请求')
  ) {
    return '';
  }

  const explicitRequest = extractExplicitRequest(normalized);
  if (explicitRequest) {
    return explicitRequest;
  }

  const cleanedLines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isInstructionNoise(line));

  if (!cleanedLines.length) {
    return '';
  }

  const usefulLine = cleanedLines.find((line) => isLikelyTaskLine(line))
    || cleanedLines.find((line) => line.length >= 8)
    || cleanedLines[0];

  return usefulLine;
}

function extractExplicitRequest(text) {
  const patterns = [
    /## My request for Codex:\s*([\s\S]+)$/i,
    /我的请求[：:]\s*([\s\S]+)$/i,
    /请求[：:]\s*([\s\S]+)$/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }

    const body = String(match[1] || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !isInstructionNoise(line));

    if (body.length) {
      return body[0];
    }
  }

  return '';
}

function isInstructionNoise(line) {
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
    /^open tabs:/i,
    /^language/i,
    /^1\.\s*只允许使用中文回答/,
    /^2\.\s*中文优先/,
    /^3\.\s*中文注释/,
    /^4\.\s*中文思维/,
  ];

  if (patterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  return (
    lower.includes('agents.md instructions') ||
    lower.includes('environment_context') ||
    lower.includes('current_date') ||
    lower.includes('timezone') ||
    lower.includes('collaboration mode') ||
    lower.includes('core values') ||
    lower.includes('interaction style') ||
    lower.includes('final answer instructions') ||
    lower.includes('intermediary updates') ||
    lower.includes('context from my ide setup')
  );
}

function isLikelyTaskLine(line) {
  const normalized = String(line || '').trim();
  return (
    normalized.length >= 6 &&
    !normalized.startsWith('#') &&
    !normalized.includes('AGENTS.md') &&
    !normalized.includes('INSTRUCTIONS') &&
    !normalized.includes('environment_context')
  );
}

function normalizeSessionCwd(value) {
  return String(value || '').replace(/\//g, '\\').toLowerCase();
}
