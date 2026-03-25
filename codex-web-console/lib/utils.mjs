import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function toBoolean(value, fallback = false) {
  if (value == null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeCodexSandbox(value) {
  if (!value) {
    return '';
  }

  const normalized = String(value).trim();
  const allowedValues = new Set(['read-only', 'workspace-write', 'danger-full-access']);
  if (!allowedValues.has(normalized)) {
    throw new Error(`不支持的沙箱配置：${value}`);
  }
  return normalized;
}

export function truncateText(text, maxLength) {
  const normalized = String(text || '');
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function compactText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isSubPath(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  if (parent === child) {
    return true;
  }
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = new Map([
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.webp', 'image/webp'],
    ['.gif', 'image/gif'],
    ['.bmp', 'image/bmp'],
    ['.svg', 'image/svg+xml'],
    ['.pdf', 'application/pdf'],
    ['.txt', 'text/plain; charset=utf-8'],
    ['.md', 'text/markdown; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.log', 'text/plain; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.csv', 'text/csv; charset=utf-8'],
    ['.zip', 'application/zip'],
    ['.doc', 'application/msword'],
    ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['.xls', 'application/vnd.ms-excel'],
    ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['.ppt', 'application/vnd.ms-powerpoint'],
    ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ]);
  return map.get(ext) || 'application/octet-stream';
}

export function guessArtifactKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
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

export function parseArtifactEnvelope(text, marker = 'WEB_ARTIFACTS:') {
  const normalized = String(text || '').replace(/\r/g, '');
  if (!normalized) {
    return { text: '', artifactPaths: [] };
  }

  const lines = normalized.split('\n');
  const markerIndex = lines.findIndex((line) => line.startsWith(marker));
  if (markerIndex < 0) {
    return { text: normalized.trim(), artifactPaths: [] };
  }

  const raw = lines[markerIndex].slice(marker.length).trim();
  const artifactPaths = raw
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);

  lines.splice(markerIndex, 1);
  return {
    text: lines.join('\n').trim(),
    artifactPaths,
  };
}

export function extractLocalArtifactPathsFromText(text) {
  if (!text) {
    return [];
  }

  const allowedExtensions = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.gif',
    '.bmp',
    '.svg',
    '.pdf',
    '.txt',
    '.md',
    '.json',
    '.log',
    '.csv',
    '.zip',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
  ]);

  const results = new Set();
  const normalized = String(text).replace(/\r/g, '');
  const candidates = [];

  for (const match of normalized.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    candidates.push(String(match[1] || '').trim());
  }

  for (const match of normalized.matchAll(/[A-Za-z]:\\[^\r\n]*/g)) {
    candidates.push(String(match[0] || '').trim());
  }

  for (let candidate of candidates) {
    candidate = candidate
      .replace(/^["'`(<\[]+/, '')
      .replace(/["'`>)\].,，。；;:：]+$/, '')
      .trim();

    if (!/^[A-Za-z]:\\/.test(candidate)) {
      continue;
    }

    const ext = path.extname(candidate).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      continue;
    }

    const resolved = path.resolve(candidate);
    if (fileExists(resolved)) {
      try {
        if (fs.statSync(resolved).isFile()) {
          results.add(resolved);
        }
      } catch {}
    }
  }

  return Array.from(results).slice(0, 12);
}

export function buildSessionTitle(text, fallback = '新会话') {
  const compact = compactText(text);
  return compact ? truncateText(compact, 36) : fallback;
}

export function escapePowerShellSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''");
}

export function findCommandInPath(commandNames) {
  const pathEnv = process.env.PATH || '';
  const directories = pathEnv
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);

  for (const commandName of commandNames) {
    if (path.isAbsolute(commandName) && fileExists(commandName)) {
      return commandName;
    }

    for (const directory of directories) {
      const fullPath = path.join(directory, commandName);
      if (fileExists(fullPath)) {
        return fullPath;
      }
    }
  }

  return '';
}

export function extractMessageTextFromResponseItem(payload) {
  const contentItems = Array.isArray(payload?.content) ? payload.content : [];
  return contentItems
    .filter((item) => item?.type === 'input_text' || item?.type === 'output_text')
    .map((item) => String(item.text || '').trim())
    .filter(Boolean)
    .join('\n');
}
