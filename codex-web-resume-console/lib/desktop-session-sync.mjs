import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export class DesktopSessionSync {
  constructor(config) {
    this.config = config;
  }

  sync(input = {}) {
    const record = buildThreadRecord(this.config, input);
    if (!record) {
      return false;
    }

    let changed = false;

    if (this.config.sessionIndexPath) {
      changed = upsertSessionIndex(this.config.sessionIndexPath, record) || changed;
    }

    if (this.config.stateDbPath && this.config.sqliteCommand) {
      changed = upsertThreadState(this.config, record) || changed;
    }

    return changed;
  }
}

function buildThreadRecord(config, input) {
  const native = input?.native || null;
  const session = input?.session || null;
  if (!native?.id || !native?.filePath) {
    return null;
  }

  const transcriptMessages = Array.isArray(input?.transcript?.messages) ? input.transcript.messages : [];
  const sessionMessages = Array.isArray(session?.messages) ? session.messages : [];
  const allMessages = sessionMessages.length ? sessionMessages : transcriptMessages;
  const firstUserMessage = findFirstUserMessage(allMessages) || native.preview || session?.title || '历史会话';
  const title = normalizeTitle(session?.title || firstUserMessage || native.preview || '历史会话');
  const updatedAtIso = String(
    session?.lastActivityAt
      || session?.updatedAt
      || native.lastWriteTime
      || native.timestamp
      || new Date().toISOString(),
  ).trim();
  const createdAtIso = String(
    session?.createdAt
      || native.timestamp
      || native.lastWriteTime
      || updatedAtIso,
  ).trim();

  return {
    id: native.id,
    rolloutPath: native.filePath,
    source: String(native.source || 'exec').trim() || 'exec',
    modelProvider: String(native.modelProvider || config.desktopThreadModelProvider || 'packycode').trim() || 'packycode',
    cwd: String(native.cwd || session?.workdir || config.webWorkdir || '').trim(),
    title,
    firstUserMessage: normalizeTitle(firstUserMessage),
    updatedAtIso,
    createdAtIso,
    updatedAtUnix: toUnixSeconds(updatedAtIso),
    createdAtUnix: toUnixSeconds(createdAtIso),
    sandboxPolicy: String(native.sandboxPolicy || config.desktopThreadSandboxPolicy).trim(),
    approvalMode: String(native.approvalMode || config.desktopThreadApprovalMode || 'never').trim() || 'never',
    cliVersion: String(native.cliVersion || config.desktopThreadCliVersion || '').trim(),
    memoryMode: 'enabled',
    model: String(native.model || config.codexModel || '').trim(),
    reasoningEffort: String(native.reasoningEffort || '').trim(),
  };
}

function upsertSessionIndex(filePath, record) {
  const entries = loadJsonlEntries(filePath);
  const nextEntry = {
    id: record.id,
    thread_name: record.title,
    updated_at: record.updatedAtIso,
  };

  let changed = true;
  const nextEntries = [];
  let replaced = false;

  for (const entry of entries) {
    if (entry?.id === record.id) {
      replaced = true;
      if (
        entry.thread_name === nextEntry.thread_name
        && entry.updated_at === nextEntry.updated_at
      ) {
        nextEntries.push(entry);
        changed = false;
      } else {
        nextEntries.push(nextEntry);
      }
      continue;
    }
    nextEntries.push(entry);
  }

  if (!replaced) {
    nextEntries.push(nextEntry);
  }

  if (!changed && replaced) {
    return false;
  }

  writeJsonlEntries(filePath, nextEntries);
  return true;
}

function loadJsonlEntries(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeJsonlEntries(filePath, entries) {
  const dirPath = path.dirname(filePath);
  fs.mkdirSync(dirPath, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
  fs.writeFileSync(tempPath, body ? `${body}\n` : '', 'utf8');
  fs.renameSync(tempPath, filePath);
}

function upsertThreadState(config, record) {
  const sql = [
    'PRAGMA busy_timeout = 2000;',
    `INSERT INTO threads (
      id,
      rollout_path,
      created_at,
      updated_at,
      source,
      model_provider,
      cwd,
      title,
      sandbox_policy,
      approval_mode,
      tokens_used,
      has_user_event,
      archived,
      cli_version,
      first_user_message,
      memory_mode,
      model,
      reasoning_effort
    ) VALUES (
      ${sqlLiteral(record.id)},
      ${sqlLiteral(record.rolloutPath)},
      ${record.createdAtUnix},
      ${record.updatedAtUnix},
      ${sqlLiteral(record.source)},
      ${sqlLiteral(record.modelProvider)},
      ${sqlLiteral(record.cwd)},
      ${sqlLiteral(record.title)},
      ${sqlLiteral(record.sandboxPolicy)},
      ${sqlLiteral(record.approvalMode)},
      0,
      1,
      0,
      ${sqlLiteral(record.cliVersion)},
      ${sqlLiteral(record.firstUserMessage)},
      ${sqlLiteral(record.memoryMode)},
      ${sqlLiteral(record.model)},
      ${sqlLiteral(record.reasoningEffort)}
    )
    ON CONFLICT(id) DO UPDATE SET
      rollout_path = excluded.rollout_path,
      updated_at = excluded.updated_at,
      source = excluded.source,
      model_provider = excluded.model_provider,
      cwd = excluded.cwd,
      title = excluded.title,
      sandbox_policy = excluded.sandbox_policy,
      approval_mode = excluded.approval_mode,
      has_user_event = 1,
      cli_version = excluded.cli_version,
      first_user_message = excluded.first_user_message,
      memory_mode = excluded.memory_mode,
      model = CASE
        WHEN excluded.model <> '' THEN excluded.model
        ELSE threads.model
      END,
      reasoning_effort = CASE
        WHEN excluded.reasoning_effort <> '' THEN excluded.reasoning_effort
        ELSE threads.reasoning_effort
      END;`,
  ].join('\n');

  const result = spawnSync(config.sqliteCommand, [config.stateDbPath, sql], {
    windowsHide: true,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const message = String(result.stderr || result.stdout || '').trim() || 'sqlite3 执行失败';
    throw new Error(message);
  }

  return true;
}

function findFirstUserMessage(messages) {
  for (const message of messages) {
    if (message?.role !== 'user') {
      continue;
    }
    const text = String(message?.text || '').trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function normalizeTitle(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '历史会话';
  }
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

function toUnixSeconds(value) {
  const timestamp = new Date(value || Date.now()).getTime();
  if (!Number.isFinite(timestamp)) {
    return Math.floor(Date.now() / 1000);
  }
  return Math.max(0, Math.floor(timestamp / 1000));
}

function sqlLiteral(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}
