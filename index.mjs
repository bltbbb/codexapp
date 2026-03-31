import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ptyPackage from 'node-pty';

const { spawn: spawnPty } = ptyPackage;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '.env');

loadEnvFile(envPath);

const config = {
  telegramToken: getRequiredEnv('TG_BOT_TOKEN'),
  allowedChatId: String(getRequiredEnv('TG_ALLOWED_CHAT_ID')),
  pollTimeoutSeconds: toNumber(process.env.TG_POLL_TIMEOUT_SECONDS, 20),
  repollDelayMs: toNumber(process.env.TG_REPOLL_DELAY_MS, 1500),
  telegramProxyUrl: process.env.TG_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || '',
  telegramUseShortPoll: toBoolean(process.env.TG_USE_SHORT_POLL, Boolean(process.env.TG_PROXY_URL)),
  askApiKey: process.env.OPENAI_API_KEY || '',
  askBaseUrl: trimTrailingSlash(process.env.OPENAI_BASE_URL || ''),
  askModel: process.env.OPENAI_MODEL || 'gpt-5.4',
  askProxyUrl:
    process.env.OPENAI_PROXY_URL ||
    process.env.TG_PROXY_URL ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    '',
  codexEnabled: toBoolean(process.env.ENABLE_CODEX, true),
  codexWorkdir: path.resolve(process.env.CODEX_WORKDIR || process.cwd()),
  codexSandbox: normalizeCodexSandbox(process.env.CODEX_SANDBOX || ''),
  codexModel: process.env.CODEX_MODEL || '',
  codexCliPath: process.env.CODEX_CLI_PATH || '',
  codexBypassApprovals: toBoolean(process.env.CODEX_BYPASS_APPROVALS, false),
};

const runtimeDir = path.join(__dirname, 'runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
const offsetStatePath = path.join(runtimeDir, 'telegram-offset.json');
const botPidPath = path.join(runtimeDir, 'bot.pid');
const codeSessionStatePath = path.join(runtimeDir, 'code-session.json');
const codeProgressUpdateIntervalMs = 1500;
const codeProgressHeartbeatMs = 10000;
const codeProgressMessageMaxLength = 3500;
const codeProgressStatusHistoryLimit = 2;
const codeSessionHistoryTurnLimit = 12;
const codeSessionHistoryCharLimit = 12000;
const codexSessionRoot = path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex', 'sessions');

const state = {
  offset: loadSavedOffset(),
  runningTask: null,
  lastTask: null,
  bootAt: new Date().toISOString(),
  mode: 'ask',
  codeSession: loadSavedCodeSession(),
  lastSessionChoices: [],
  lastAskUsage: null,
};

const helpText = [
  '可用命令：',
  '/start - 查看启动信息',
  '/help - 查看帮助',
  '/status - 查看机器人状态',
  '/ask 你的问题 - 调用问答模式',
  '/codex 你的任务 - 单次调用本机 Codex CLI',
  '/mode code - 进入持续 code 模式',
  '/mode ask - 退出持续 code 模式并回到 ask',
  '/mode status - 查看当前模式与 code 会话状态',
  '/mode exit - 关闭持续 code 会话',
  '/new - 新建一个 TG code 会话',
  '/sessions [N] - 查看最近会话',
  '/use <编号|thread_id> - 切换到某个历史会话',
  '',
  '模式说明：',
  '1. 默认是 ask 模式，普通文本直接走问答。',
  '2. 进入 code 模式后，普通文本会走 TG 会话续聊。',
  '3. code 模式已接入 exec resume：首条消息创建 thread，后续消息会继续同一个 Codex 会话。',
  '4. /new 会清空当前 TG code 会话上下文并重新开始。',
  '',
  '安全说明：',
  '1. 只接受白名单 chat_id。',
  '2. 不开放任意 shell。',
  '3. 只有 /codex 或 code 模式才会真正调用本机 Codex。',
].join('\n');

async function main() {
  writeBotPidFile();
  await initializeTelegramOffset();
  console.log(`[boot] Telegram Codex Bot 已启动，工作目录：${config.codexWorkdir}`);

  process.on('SIGINT', async () => {
    console.log('[boot] 收到 SIGINT，准备退出');
    await destroyCodeSession('SIGINT');
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('[boot] 收到 SIGTERM，准备退出');
    await destroyCodeSession('SIGTERM');
    process.exit(0);
  });

  process.on('exit', () => {
    clearBotPidFile();
  });

  while (true) {
    try {
      const updates = await getUpdates(state.offset, getTelegramPollTimeoutSeconds());
      for (const update of updates) {
        state.offset = update.update_id + 1;
        saveOffset(state.offset);
        await handleUpdate(update);
      }
    } catch (error) {
      console.error(`[poll] ${formatError(error)}`);
      await sleep(config.repollDelayMs);
    }
  }
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message || !message.chat || !message.text) {
    return;
  }

  const chatId = String(message.chat.id);
  if (chatId !== config.allowedChatId) {
    console.warn(`[auth] 拒绝 chat_id=${chatId}`);
    return;
  }

  const text = message.text.trim();
  const [command, ...restParts] = text.split(/\s+/);
  const rest = restParts.join(' ').trim();
  try {
    if (text === '/start') {
      await sendMessage(chatId, `机器人在线。\n启动时间：${state.bootAt}\n工作目录：${config.codexWorkdir}\n当前模式：${getModeLabel(state.mode)}`);
      return;
    }

    if (text === '/help') {
      await sendMessage(chatId, helpText);
      return;
    }

    if (text === '/status') {
      await sendMessage(chatId, buildStatusText());
      return;
    }

    if (text === '/new') {
      await handleNewSessionCommand(chatId);
      return;
    }

    if (command === '/sessions') {
      await handleSessionsCommand(chatId, rest);
      return;
    }

    if (command === '/use') {
      await handleUseSessionCommand(chatId, rest);
      return;
    }

    if (text === '/approve' || text === '/deny') {
      await handleApprovalCommand(chatId, text);
      return;
    }

    if (command === '/mode') {
      await handleModeCommand(chatId, restParts);
      return;
    }

    if (command === '/ask') {
      if (!rest) {
        await sendMessage(chatId, '用法：/ask 你的问题');
        return;
      }
      await runExclusiveTask(chatId, 'ask', async () => {
        const answer = await askModel(rest);
        await sendLongMessage(chatId, answer);
      });
      return;
    }

    if (command === '/codex' || command === '/codex_task') {
      if (!rest) {
        await sendMessage(chatId, `用法：${command} 你的任务`);
        return;
      }
      if (!config.codexEnabled) {
        await sendMessage(chatId, '当前未启用本机 Codex CLI。请在 .env 中将 ENABLE_CODEX=true。');
        return;
      }

      await runExclusiveTask(chatId, 'codex', async () => {
        await sendMessage(chatId, '处理中...');
        const result = await runCodex(rest, { wrapped: command === '/codex_task' });
        const sentArtifactPaths = new Set();
        if (result.text) {
          await sendLongMessage(chatId, result.text);
        }
        if (result.artifacts.length) {
          await sendMessage(chatId, `检测到 ${result.artifacts.length} 个产物文件，开始回传。`);
          for (const artifact of result.artifacts) {
            await sendArtifact(chatId, artifact);
            sentArtifactPaths.add(path.resolve(artifact));
          }
        }
        await sendInlineArtifactsFromText(chatId, result.text, sentArtifactPaths);
        if (!result.text && !result.artifacts.length) {
          await sendMessage(chatId, 'Codex 已执行完成，但没有返回文本或文件。');
        }
      });
      return;
    }

    if (state.mode === 'code') {
      if (!config.codexEnabled) {
        await sendMessage(chatId, '当前未启用本机 Codex CLI。请先在 .env 中开启 ENABLE_CODEX=true。');
        return;
      }

      await runExclusiveTask(chatId, 'code', async () => {
        const reply = await sendToCodeSession(chatId, text);
        if (reply) {
          await sendLongMessage(chatId, reply);
          await sendInlineArtifactsFromText(chatId, reply);
        }
      });
      return;
    }

    if (text.startsWith('/')) {
      await sendMessage(chatId, '未识别命令。当前是 ask 模式，可用 /mode code 进入持续 coding 会话。');
      return;
    }

    await runExclusiveTask(chatId, 'ask', async () => {
      const answer = await askModel(text);
      await sendLongMessage(chatId, answer);
    });
  } catch (error) {
    console.error(`[update] 处理消息失败 chat_id=${chatId} text=${truncateText(text, 80)} error=${formatError(error)}`);
    await sendMessage(chatId, `命令处理失败：${formatError(error)}`);
  }
}

async function initializeTelegramOffset() {
  if (state.offset > 0) {
    return;
  }

  const data = await invokeTelegramJson('getUpdates', {
    offset: 0,
    timeout: 0,
    allowed_updates: ['message'],
  });

  if (!data.ok) {
    throw new Error(`初始化 Telegram offset 失败：${JSON.stringify(data)}`);
  }

  const updates = Array.isArray(data.result) ? data.result : [];
  if (!updates.length) {
    return;
  }

  state.offset = updates[updates.length - 1].update_id + 1;
  saveOffset(state.offset);
}

function loadSavedCodeSession() {
  try {
    if (!fs.existsSync(codeSessionStatePath)) {
      return null;
    }

    const raw = fs.readFileSync(codeSessionStatePath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') {
      return null;
    }

    return {
      id: String(data.id || createLocalSessionId()),
      codexThreadId: String(data.codexThreadId || '').trim(),
      startedAt: String(data.startedAt || new Date().toISOString()),
      workdir: String(data.workdir || config.codexWorkdir),
      model: String(data.model || '').trim(),
      ready: true,
      pending: null,
      lastOutputAt: String(data.lastOutputAt || ''),
      lastReply: String(data.lastReply || ''),
      lastReplyAt: String(data.lastReplyAt || ''),
      lastError: String(data.lastError || ''),
      lastApprovalPrompt: '',
      tokenUsage: normalizeCodeSessionTokenUsage(data.tokenUsage),
      turns: Array.isArray(data.turns)
        ? data.turns
            .map((item) => ({
              role: item?.role === 'assistant' ? 'assistant' : 'user',
              text: String(item?.text || '').trim(),
              at: String(item?.at || ''),
            }))
            .filter((item) => item.text)
        : [],
    };
  } catch (error) {
    console.warn(`[session] 读取 TG code 会话失败：${formatError(error)}`);
    return null;
  }
}

function saveCodeSessionState(session = state.codeSession) {
  try {
    if (!session) {
      if (fs.existsSync(codeSessionStatePath)) {
        fs.unlinkSync(codeSessionStatePath);
      }
      return;
    }

    fs.writeFileSync(
      codeSessionStatePath,
      JSON.stringify(
        {
          id: session.id,
          codexThreadId: session.codexThreadId || '',
          startedAt: session.startedAt,
          workdir: session.workdir,
          model: session.model || '',
          lastOutputAt: session.lastOutputAt,
          lastReply: session.lastReply,
          lastReplyAt: session.lastReplyAt,
          lastError: session.lastError,
          tokenUsage: normalizeCodeSessionTokenUsage(session.tokenUsage),
          turns: Array.isArray(session.turns) ? session.turns : [],
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (error) {
    console.warn(`[session] 保存 TG code 会话失败：${formatError(error)}`);
  }
}

function createLocalSessionId() {
  return `tg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function listRecentCodexSessions(limit = 8, cwdFilter = '') {
  if (!fs.existsSync(codexSessionRoot)) {
    return [];
  }

  const normalizedFilter = normalizeSessionCwd(cwdFilter);
  const files = walkSessionFiles(codexSessionRoot)
    .sort((left, right) => right.lastWriteTimeMs - left.lastWriteTimeMs);

  const results = [];
  for (const file of files) {
    const meta = parseCodexSessionFile(file.fullPath);
    if (!meta?.id) {
      continue;
    }
    if (normalizedFilter && normalizeSessionCwd(meta.cwd) !== normalizedFilter) {
      continue;
    }
    results.push({
      id: meta.id,
      cwd: meta.cwd || config.codexWorkdir,
      timestamp: meta.timestamp || '',
      preview: meta.preview || '',
      lastWriteTime: new Date(file.lastWriteTimeMs).toISOString(),
      filePath: file.fullPath,
    });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

function resolveSessionSelector(selector) {
  if (/^\d+$/.test(selector)) {
    const index = Number(selector) - 1;
    return state.lastSessionChoices[index] || '';
  }
  return selector;
}

function findCodexSessionById(sessionId) {
  if (!sessionId || !fs.existsSync(codexSessionRoot)) {
    return null;
  }

  const files = walkSessionFiles(codexSessionRoot)
    .sort((left, right) => right.lastWriteTimeMs - left.lastWriteTimeMs);
  for (const file of files) {
    const meta = parseCodexSessionFile(file.fullPath);
    if (meta?.id === sessionId) {
      return meta;
    }
  }
  return null;
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
        });
      }
    }
  }
  return results;
}

function parseCodexSessionFile(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    let id = '';
    let cwd = '';
    let timestamp = '';
    let model = '';
    let preview = '';
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
        continue;
      }

      if (entry.type === 'turn_context') {
        model = String(entry.payload?.model || '').trim() || model;
        continue;
      }

      if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
        const usage = normalizeCodeSessionTokenUsage(entry.payload?.info, entry.timestamp);
        if (usage) {
          tokenUsage = usage;
        }
        continue;
      }

      if (!preview && entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
        preview = compactSessionPreview(entry.payload?.message || '');
        continue;
      }

      if (!preview && entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'user') {
        const text = extractSessionResponseItemText(entry.payload);
        preview = compactSessionPreview(text);
      }
    }

    if (!id) {
      return null;
    }

    return {
      id,
      cwd: cwd || config.codexWorkdir,
      timestamp,
      model,
      preview,
      tokenUsage,
      filePath,
    };
  } catch {
    return null;
  }
}

function extractSessionResponseItemText(payload) {
  const contents = Array.isArray(payload?.content) ? payload.content : [];
  return contents
    .filter((item) => item?.type === 'input_text' || item?.type === 'output_text')
    .map((item) => String(item.text || '').trim())
    .filter(Boolean)
    .join('\n');
}

function compactSessionPreview(text) {
  const usefulText = extractUsefulSessionPreview(text);
  const normalized = String(usefulText || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  return truncateText(normalized, 80);
}

function extractUsefulSessionPreview(text) {
  const normalized = String(text || '').replace(/\r/g, '');
  if (!normalized) {
    return '';
  }

  const requestBody = extractLastSessionRequestBody(normalized);
  if (requestBody) {
    return requestBody;
  }

  const cleanedText = stripSessionPreviewNoise(normalized);
  return findFirstUsefulSessionLine(cleanedText);
}

function extractLastSessionRequestBody(text) {
  const headerPattern = /(^|\n)#{1,6}\s*My request(?: for Codex)?\s*:\s*\n/gi;
  let lastHeader = null;

  for (const match of text.matchAll(headerPattern)) {
    lastHeader = {
      bodyStart: match.index + match[0].length,
    };
  }

  if (!lastHeader) {
    return '';
  }

  const trailingText = text.slice(lastHeader.bodyStart);
  const nextSectionIndex = trailingText.search(/\n#{1,6}\s+[^\n]+:\s*\n/);
  const requestSection = nextSectionIndex >= 0 ? trailingText.slice(0, nextSectionIndex) : trailingText;
  return findFirstUsefulSessionLine(requestSection);
}

function stripSessionPreviewNoise(text) {
  return String(text || '')
    .replace(
      /^#\s*AGENTS\.md instructions[\s\S]*?(?=(?:\n#{1,6}\s*Context from my IDE setup\s*:)|(?:\n#{1,6}\s*My request(?: for Codex)?\s*:)|$)/i,
      '',
    )
    .replace(/^<environment_context>[\s\S]*?<\/environment_context>\s*/i, '')
    .trim();
}

function findFirstUsefulSessionLine(text) {
  const ignoredPatterns = [
    /^#\s*AGENTS\.md instructions\b/i,
    /^#{1,6}\s*Context from my IDE setup\b/i,
    /^#{1,6}\s*Active file\b/i,
    /^#{1,6}\s*Active selection\b/i,
    /^#{1,6}\s*Open tabs\b/i,
    /^#{1,6}\s*My request(?: for Codex)?\b/i,
    /^<INSTRUCTIONS>$/i,
    /^<\/INSTRUCTIONS>$/i,
    /^<environment_context>$/i,
    /^<\/environment_context>$/i,
    /^<[^>]+>$/i,
    /^```/,
  ];

  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (ignoredPatterns.some((pattern) => pattern.test(line))) {
      continue;
    }

    return line;
  }

  return '';
}

function normalizeSessionCwd(cwd) {
  return String(cwd || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

async function handleNewSessionCommand(chatId) {
  if (!config.codexEnabled) {
    await sendMessage(chatId, '当前未启用本机 Codex CLI。请先在 .env 中开启 ENABLE_CODEX=true。');
    return;
  }

  await runExclusiveTask(chatId, 'new-session', async () => {
    await destroyCodeSession('new');
    const session = await ensureCodeSession({ forceNew: true });
    state.mode = 'code';
    await sendMessage(
      chatId,
      [
        '已创建新的 TG code 会话。',
        `本地会话 ID：${session.id}`,
        `工作目录：${session.workdir}`,
        '后续普通文本会基于这个新会话继续。',
      ].join('\n'),
    );
  });
}

async function handleSessionsCommand(chatId, arg) {
  const limit = Math.min(20, Math.max(1, toNumber(arg, 8)));
  const sessions = listRecentCodexSessions(limit, config.codexWorkdir);
  state.lastSessionChoices = sessions.map((item) => item.id);

  if (!sessions.length) {
    await sendMessage(chatId, '当前工作目录下没有找到可恢复的 Codex 历史会话。');
    return;
  }

  const lines = ['# 最近会话'];
  for (let index = 0; index < sessions.length; index += 1) {
    const item = sessions[index];
    lines.push(
      [
        `${index + 1}. ${item.preview || '无标题'}`,
        `会话：\`${item.id}\``,
        `时间：${item.timestamp || item.lastWriteTime}`,
        `目录：\`${item.cwd}\``,
      ].join('\n'),
    );
    if (index < sessions.length - 1) {
      lines.push('');
    }
  }

  lines.push('');
  lines.push('可用 `/use 编号` 或 `/use thread_id` 切换。');
  await sendLongMessage(chatId, lines.join('\n'));
}

async function handleUseSessionCommand(chatId, selector) {
  const normalized = String(selector || '').trim();
  if (!normalized) {
    await sendMessage(chatId, '用法：/use <编号|thread_id>');
    return;
  }

  const currentSession = state.codeSession;
  if (currentSession?.pending) {
    await sendMessage(chatId, '当前会话还有任务在执行，暂时不能切换。');
    return;
  }

  const targetId = resolveSessionSelector(normalized);
  if (!targetId) {
    await sendMessage(chatId, '没有找到对应会话。先执行 `/sessions` 再按编号切换，或直接传 thread_id。');
    return;
  }

  const meta = findCodexSessionById(targetId);
  const cwd = meta?.cwd || config.codexWorkdir;
  state.codeSession = {
    id: createLocalSessionId(),
    codexThreadId: targetId,
    startedAt: meta?.timestamp || new Date().toISOString(),
    workdir: cwd,
    model: meta?.model || '',
    ready: true,
    pending: null,
    lastOutputAt: '',
    lastReply: '',
    lastReplyAt: '',
    lastError: '',
    lastApprovalPrompt: '',
    tokenUsage: normalizeCodeSessionTokenUsage(meta?.tokenUsage),
    turns: [],
  };
  state.mode = 'code';
  saveCodeSessionState(state.codeSession);

  await sendMessage(
    chatId,
    [
      '已切换到历史会话。',
      `本地会话 ID：${state.codeSession.id}`,
      `Codex Thread：${targetId}`,
      `工作目录：${cwd}`,
      '后续普通文本会继续这个 thread。',
    ].join('\n'),
  );
}

async function handleModeCommand(chatId, args) {
  const subcommand = String(args[0] || '').toLowerCase();

  if (!subcommand || subcommand === 'status') {
    await sendMessage(chatId, buildModeStatusText());
    return;
  }

  if (subcommand === 'code') {
    if (!config.codexEnabled) {
      await sendMessage(chatId, '当前未启用本机 Codex CLI。请在 .env 中将 ENABLE_CODEX=true。');
      return;
    }

    if (state.mode === 'code' && state.codeSession?.ready) {
      await sendMessage(chatId, buildModeStatusText());
      return;
    }

    await runExclusiveTask(chatId, 'mode', async () => {
      await sendMessage(chatId, '正在进入 code 模式...');
      const session = await ensureCodeSession();
      state.mode = 'code';
      await sendMessage(
        chatId,
        [
          '已进入 code 模式。',
          session.codexThreadId ? '后续普通文本会通过 Codex thread 继续会话。' : '下一条消息会先创建新的 Codex thread。',
          `本地会话 ID：${session.id}`,
          `Codex Thread：${session.codexThreadId || '尚未创建'}`,
          `工作目录：${session.workdir}`,
        ].join('\n'),
      );
    });
    return;
  }

  if (subcommand === 'ask' || subcommand === 'exit') {
    await runExclusiveTask(chatId, 'mode', async () => {
      await destroyCodeSession(`mode:${subcommand}`);
      state.mode = 'ask';
      await sendMessage(chatId, '已切换到 ask 模式。持续 code 会话已关闭。');
    });
    return;
  }

  await sendMessage(chatId, '用法：/mode code | /mode ask | /mode status | /mode exit');
}

async function handleApprovalCommand(chatId, command) {
  await sendMessage(
    chatId,
    [
      `${command} 当前不可用。`,
      '原因：虽然本机 Codex CLI 已支持 exec resume，但当前 TG 机器人还没接入 app-server 审批交互。',
      '现阶段 TG 模式已使用 exec / exec resume 续聊，但暂不支持远程审批。',
    ].join('\n'),
  );
}

async function runExclusiveTask(chatId, type, handler) {
  if (state.runningTask) {
    await sendMessage(
      chatId,
      `当前已有任务正在执行：${state.runningTask.type}，开始时间 ${state.runningTask.startedAt}。请稍后再试。`,
    );
    return;
  }

  const task = {
    id: `${Date.now()}`,
    type,
    startedAt: new Date().toISOString(),
  };
  state.runningTask = task;

  try {
    await handler();
    state.lastTask = {
      ...task,
      status: 'success',
      finishedAt: new Date().toISOString(),
    };
  } catch (error) {
    state.lastTask = {
      ...task,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: formatError(error),
    };
    await sendMessage(chatId, `任务失败：${formatError(error)}`);
  } finally {
    state.runningTask = null;
  }
}

function buildStatusText() {
  const lines = [
    '机器人状态：在线',
    `启动时间：${state.bootAt}`,
    `当前模式：${getModeLabel(state.mode)}`,
    `Codex 工作目录：${config.codexWorkdir}`,
    `Codex CLI：${resolveCodexCommand()}`,
    `Codex 沙箱：${config.codexSandbox || '继承本机配置'}`,
    `Codex 审批：${config.codexBypassApprovals ? '完全跳过' : '按 CLI 默认配置'}`,
    `Ask 当前模型：${state.lastAskUsage?.model || config.askModel}`,
    `Ask 最近 Token：${formatTokenBucketSummary(state.lastAskUsage)}`,
    `Telegram 轮询：${config.telegramUseShortPoll ? '短轮询' : '长轮询'}`,
  ];

  appendCodeSessionStatus(lines, true);

  if (state.runningTask) {
    lines.push(`当前任务：${state.runningTask.type}`);
    lines.push(`任务开始：${state.runningTask.startedAt}`);
  } else {
    lines.push('当前任务：空闲');
  }

  if (state.lastTask) {
    lines.push(`上次任务：${state.lastTask.type}`);
    lines.push(`上次结果：${state.lastTask.status}`);
    lines.push(`完成时间：${state.lastTask.finishedAt}`);
    if (state.lastTask.error) {
      lines.push(`错误信息：${state.lastTask.error}`);
    }
  }

  return lines.join('\n');
}

function buildModeStatusText() {
  const lines = [
    `当前模式：${getModeLabel(state.mode)}`,
    `Codex 工作目录：${config.codexWorkdir}`,
    `Codex CLI：${resolveCodexCommand()}`,
    `Codex 审批：${config.codexBypassApprovals ? '完全跳过' : '按 CLI 默认配置'}`,
  ];

  appendCodeSessionStatus(lines, false);
  return lines.join('\n');
}

function appendCodeSessionStatus(lines, withTaskDetails) {
  const session = state.codeSession;
  if (!session) {
    lines.push('持续 code 会话：未启动');
    return;
  }

  refreshCodeSessionRuntimeState(session);

  lines.push(`持续 code 会话：${session.ready ? '已就绪' : '初始化中'}`);
  lines.push('会话类型：TG + Codex exec/resume');
  lines.push(`本地会话 ID：${session.id}`);
  lines.push(`Codex Thread：${session.codexThreadId || '尚未创建'}`);
  lines.push(`当前模型：${session.model || config.codexModel || config.askModel}`);
  lines.push(`上下文 Token：${formatCodeSessionWindowSummary(session.tokenUsage)}`);
  if (session.tokenUsage?.last) {
    lines.push(`最近一轮 Token：${formatTokenBucketSummary(session.tokenUsage.last)}`);
  }
  lines.push(`会话启动时间：${session.startedAt}`);
  lines.push(`会话轮次：${Math.ceil((session.turns?.length || 0) / 2)}`);
  lines.push(`最近输出时间：${session.lastOutputAt || '暂无'}`);

  if (session.pending) {
    lines.push(`会话执行中：是（开始于 ${session.pending.startedAt}）`);
    if (session.pending.lastStatusSummary) {
      lines.push(`当前进度：${session.pending.lastStatusSummary}`);
    }
  } else {
    lines.push('会话执行中：否');
  }

  lines.push('远程审批：当前不支持');

  if (session.lastReplyAt) {
    lines.push(`最近回复时间：${session.lastReplyAt}`);
  }

  if (session.lastReply) {
    lines.push(`最近回复摘要：${truncateText(session.lastReply.replace(/\s+/g, ' '), withTaskDetails ? 120 : 200)}`);
  }

  if (session.lastError) {
    lines.push(`会话错误：${session.lastError}`);
  }

  if (session.lastApprovalPrompt) {
    lines.push(`审批摘要：${truncateText(session.lastApprovalPrompt.replace(/\s+/g, ' '), withTaskDetails ? 120 : 200)}`);
  }
}

function getModeLabel(mode) {
  return mode === 'code' ? 'code' : 'ask';
}

async function askModel(prompt) {
  if (!config.askApiKey) {
    throw new Error('缺少 OPENAI_API_KEY，普通消息 ask 模式不可用。');
  }

  if (!config.askBaseUrl) {
    throw new Error('缺少 OPENAI_BASE_URL，普通消息 ask 模式不可用。');
  }

  const body = {
    model: config.askModel,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: prompt,
          },
        ],
      },
    ],
  };

  const data = await invokeJsonApi({
    url: `${config.askBaseUrl}/responses`,
    apiKey: config.askApiKey,
    proxyUrl: config.askProxyUrl,
    body,
    timeoutSec: 90,
  });

  state.lastAskUsage = extractAskUsage(data);

  const text = extractResponseText(data).trim();
  if (!text) {
    throw new Error('ask 模式没有返回可读文本。');
  }
  return text;
}

async function ensureCodeSession(options = {}) {
  const forceNew = options.forceNew === true;
  if (state.codeSession && !forceNew) {
    return state.codeSession;
  }

  if (!config.codexEnabled) {
    throw new Error('当前未启用本机 Codex CLI。');
  }

  const session = {
    id: createLocalSessionId(),
    codexThreadId: '',
    startedAt: new Date().toISOString(),
    workdir: config.codexWorkdir,
    model: config.codexModel || '',
    ready: true,
    pending: null,
    lastOutputAt: '',
    lastReply: '',
    lastReplyAt: '',
    lastError: '',
    lastApprovalPrompt: '',
    tokenUsage: null,
    turns: [],
  };

  state.codeSession = session;
  saveCodeSessionState(session);
  return session;
}

function handleCodeSessionStdout(session, chunk) {
  session.lastOutputAt = new Date().toISOString();
  // proto 事件是一行一个 JSON；像 exec_command_end 这类事件可能非常长，
  // 这里不能截断未处理缓冲区，否则会把一整条 JSON 从中间切断。
  session.stdoutBuffer += chunk;

  while (true) {
    const lineBreakIndex = session.stdoutBuffer.indexOf('\n');
    if (lineBreakIndex < 0) {
      break;
    }

    const line = session.stdoutBuffer.slice(0, lineBreakIndex).trim();
    session.stdoutBuffer = session.stdoutBuffer.slice(lineBreakIndex + 1);
    if (!line) {
      continue;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      console.warn(
        `[code-proto] 解析 stdout 失败：${formatError(error)}\n${truncateText(line, 2000)}`,
      );
      continue;
    }

    handleCodeSessionEvent(session, event);
  }
}

function handleCodeSessionStderr(session, chunk) {
  session.lastOutputAt = new Date().toISOString();
  session.stderrBuffer = appendLimitedText(session.stderrBuffer, chunk, 250000);
}

function handleCodeSessionEvent(session, event) {
  const msg = event?.msg;
  if (!msg || typeof msg.type !== 'string') {
    return;
  }

  const pending = session.pending;
  if (msg.type === 'session_configured') {
    session.model = msg.model || session.model;
    if (!session.ready) {
      session.ready = true;
      clearTimeout(session.readyTimer);
      session.readyResolve(session);
    }
    return;
  }

  if (!pending || event.id !== pending.opId) {
    return;
  }

  if (msg.type === 'exec_approval_request' || msg.type === 'patch_approval_request') {
    session.awaitingApproval = true;
    session.lastApprovalPrompt = formatProtoApprovalSummary(msg);
    pending.awaitingApproval = true;
    pending.approvalKind = msg.type === 'patch_approval_request' ? 'patch' : 'exec';
    pending.approvalRequestId = msg.call_id || msg.id || '';
    pending.lastStatusSummary = '等待审批';
    pending.lastActivityAt = new Date().toISOString();
    pushPendingStatus(pending, session.lastApprovalPrompt || '检测到审批请求');
    schedulePendingProgressUpdate(session, pending, true);

    if (!pending.approvalNoticeSent) {
      pending.approvalNoticeSent = true;
      void sendMessage(
        config.allowedChatId,
        session.lastApprovalPrompt
          ? `检测到命令审批。\n${session.lastApprovalPrompt}\n可发送 /approve 批准，或发送 /deny 拒绝。`
          : '检测到命令审批。\n可发送 /approve 批准，或发送 /deny 拒绝。',
      ).catch((error) => {
        console.error(`[code] 审批提示发送失败：${formatError(error)}`);
      });
    }
    return;
  }

  if (msg.type === 'agent_message_delta') {
    pending.reply += msg.delta || '';
    pending.lastStatusSummary = '生成回复中';
    pending.lastActivityAt = new Date().toISOString();
    schedulePendingProgressUpdate(session, pending, false);
    return;
  }

  if (msg.type === 'agent_message') {
    pending.lastAgentMessage = msg.message || '';
    if (pending.lastAgentMessage) {
      pending.lastStatusSummary = '整理回复中';
      pending.lastActivityAt = new Date().toISOString();
      schedulePendingProgressUpdate(session, pending, true);
    }
    return;
  }

  if (msg.type === 'stream_error') {
    pending.lastStreamError = msg.message || '';
    session.lastError = msg.message || '';
    pending.lastStatusSummary = pending.lastStreamError || '流式输出异常';
    pending.lastActivityAt = new Date().toISOString();
    schedulePendingProgressUpdate(session, pending, true);
    return;
  }

  if (msg.type === 'error') {
    pending.lastError = msg.message || 'proto 返回错误';
    pending.lastStatusSummary = pending.lastError;
    pending.lastActivityAt = new Date().toISOString();
    schedulePendingProgressUpdate(session, pending, true);
    return;
  }

  const progressSummary = formatProtoProgressSummary(msg);
  if (progressSummary) {
    pending.lastStatusSummary = progressSummary;
    pending.lastActivityAt = new Date().toISOString();
    pushPendingStatus(pending, progressSummary);
    schedulePendingProgressUpdate(session, pending, false);
  }

  if (msg.type !== 'task_complete') {
    return;
  }

  clearTimeout(pending.timeoutTimer);
  clearInterval(pending.progressHeartbeatTimer);
  clearTimeout(pending.progressTimer);
  session.pending = null;
  session.awaitingApproval = false;
  session.lastApprovalPrompt = '';

  const reply =
    normalizeProtoReply(msg.last_agent_message || pending.lastAgentMessage || pending.reply) ||
    '';

  if (!reply && pending.lastError) {
    void finalizePendingProgressMessage(pending, pending.lastError);
    pending.reject(new Error(pending.lastError));
    return;
  }

  const normalizedReply = reply || 'Codex 已执行完成，但没有返回可读文本。';
  session.lastReply = normalizedReply;
  session.lastReplyAt = new Date().toISOString();
  void finalizePendingProgressMessage(pending, '已完成');
  pending.resolve(normalizedReply);
}

function handleCodeSessionExit(session, exitCode, signal) {
  clearTimeout(session.readyTimer);

  if (session.pending) {
    const pending = session.pending;
    session.pending = null;
    clearTimeout(pending.timeoutTimer);
    clearInterval(pending.progressHeartbeatTimer);
    clearTimeout(pending.progressTimer);
    void finalizePendingProgressMessage(
      pending,
      `持续 code 会话已退出（exit=${exitCode}, signal=${signal ?? 'null'}）`,
    );
    pending.reject(new Error(`持续 code 会话已退出（exit=${exitCode}, signal=${signal ?? 'null'}）`));
  }

  if (!session.ready && session.readyReject) {
    session.readyReject(new Error(`持续 code 会话启动失败（exit=${exitCode}, signal=${signal ?? 'null'}）`));
  }

  session.lastError = `持续 code 会话已退出（exit=${exitCode}, signal=${signal ?? 'null'}）`;

  if (state.codeSession === session) {
    state.codeSession = null;
    if (state.mode === 'code') {
      state.mode = 'ask';
    }
  }
}

async function destroyCodeSession(reason = '') {
  const session = state.codeSession;
  if (!session) {
    return;
  }

  state.codeSession = null;

  if (session.pending) {
    const pending = session.pending;
    session.pending = null;
    clearTimeout(pending.timeoutTimer);
    clearInterval(pending.progressHeartbeatTimer);
    clearTimeout(pending.progressTimer);
    void finalizePendingProgressMessage(
      pending,
      `TG code 会话已关闭${reason ? `：${reason}` : ''}`,
    );
    try {
      pending.proc?.kill();
    } catch {}
    pending.reject(new Error(`TG code 会话已关闭${reason ? `：${reason}` : ''}`));
  }

  saveCodeSessionState(null);
}

async function sendToCodeSession(_chatId, prompt) {
  const session = await ensureCodeSession();

  if (session.pending) {
    throw new Error('当前持续 code 会话仍在执行上一条消息，请稍后再试。');
  }

  return await new Promise((resolve, reject) => {
    session.pending = {
      chatId: _chatId,
      prompt,
      reply: '',
      lastAgentMessage: '',
      lastError: '',
      lastStreamError: '',
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      lastStatusSummary: '已收到任务',
      statusHistory: [],
      progressMessageId: 0,
      progressLastText: '',
      progressLastSentAt: 0,
      progressNeedsForce: false,
      progressTimer: null,
      progressHeartbeatTimer: null,
      progressSyncPromise: null,
      stdoutBuffer: '',
      stdoutText: '',
      stderrText: '',
      proc: null,
      exitCode: null,
      threadId: '',
      lastMessagePath: '',
      timeoutTimer: setTimeout(() => {
        if (!session.pending) {
          return;
        }
        const fallback = normalizeProtoReply(session.pending.lastAgentMessage || session.pending.reply);
        const message = fallback || 'TG code 会话执行超时，未拿到完整回复。可发送 /mode status 查看当前状态。';
        session.lastReply = message;
        session.lastReplyAt = new Date().toISOString();
        session.lastError = 'TG code 会话执行超时';
        const timedOutPending = session.pending;
        session.pending = null;
        clearInterval(timedOutPending.progressHeartbeatTimer);
        clearTimeout(timedOutPending.progressTimer);
        try {
          timedOutPending.proc?.kill();
        } catch {}
        void finalizePendingProgressMessage(timedOutPending, '等待超时，已结束本次执行。');
        saveCodeSessionState(session);
        timedOutPending.resolve(message);
      }, 15 * 60 * 1000),
      resolve,
      reject,
    };

    const pending = session.pending;
    pushPendingStatus(pending, pending.lastStatusSummary);
    pending.progressHeartbeatTimer = setInterval(() => {
      if (session.pending === pending) {
        schedulePendingProgressUpdate(session, pending, true);
      }
    }, codeProgressHeartbeatMs);

    schedulePendingProgressUpdate(session, pending, true);
    void runCodeSessionTurn(session, pending).catch((error) => {
      if (session.pending !== pending) {
        return;
      }
      clearTimeout(pending.timeoutTimer);
      clearInterval(pending.progressHeartbeatTimer);
      clearTimeout(pending.progressTimer);
      session.pending = null;
      session.lastError = formatError(error);
      session.lastOutputAt = new Date().toISOString();
      saveCodeSessionState(session);
      void finalizePendingProgressMessage(pending, session.lastError || '执行失败');
      reject(error);
    });
  });
}

async function runCodeSessionTurn(session, pending) {
  const prompt = buildCodeSessionExecPrompt(session, pending.prompt);
  const lastMessagePath = path.join(runtimeDir, `code-session-last-message-${Date.now()}.txt`);
  pending.lastMessagePath = lastMessagePath;

  const args = buildCodexExecArgs(prompt, {
    cwd: session.workdir,
    lastMessagePath,
    threadId: session.codexThreadId || '',
  });

  const proc = spawnCodexCommand(args, {
    cwd: session.workdir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pending.proc = proc;

  proc.stdout.on('data', (chunk) => {
    handleExecJsonStdout(session, pending, chunk.toString('utf8'));
  });

  proc.stderr.on('data', (chunk) => {
    session.lastOutputAt = new Date().toISOString();
    pending.lastActivityAt = session.lastOutputAt;
    pending.stderrText = appendLimitedText(pending.stderrText, chunk.toString('utf8'), 120000);
  });

  const exitCode = await new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', (code) => resolve(code ?? 0));
  });

  pending.exitCode = Number(exitCode ?? 0);
  clearTimeout(pending.timeoutTimer);
  clearInterval(pending.progressHeartbeatTimer);
  clearTimeout(pending.progressTimer);

  if (session.pending !== pending) {
    return;
  }

  session.pending = null;
  session.lastOutputAt = new Date().toISOString();

  const lastMessage = fs.existsSync(lastMessagePath) ? fs.readFileSync(lastMessagePath, 'utf8').trim() : '';
  const reply =
    normalizeCodexReply(lastMessage, pending.prompt) ||
    normalizeProtoReply(pending.lastAgentMessage || pending.reply) ||
    extractCodexTextFromStdout(pending.stdoutText || '') ||
    '';

  if (pending.exitCode !== 0) {
    const errorText = [
      `Codex 执行失败（exit=${pending.exitCode}）`,
      normalizeProtoReply(pending.stderrText || ''),
    ]
      .filter(Boolean)
      .join('\n');
    session.lastError = errorText || `Codex 执行失败（exit=${pending.exitCode}）`;
    saveCodeSessionState(session);
    await finalizePendingProgressMessage(pending, session.lastError);
    pending.reject(new Error(session.lastError));
    return;
  }

  const normalizedReply = reply || 'Codex 已执行完成，但没有返回可读文本。';
  if (pending.threadId) {
    session.codexThreadId = pending.threadId;
  }
  appendCodeSessionTurn(session, 'user', pending.prompt);
  appendCodeSessionTurn(session, 'assistant', normalizedReply);
  refreshCodeSessionRuntimeState(session);
  session.lastReply = normalizedReply;
  session.lastReplyAt = new Date().toISOString();
  session.lastError = '';
  saveCodeSessionState(session);
  await finalizePendingProgressMessage(pending, '已完成');
  pending.resolve(normalizedReply);
}

function buildCodeSessionExecPrompt(session, prompt) {
  return String(prompt || '').replace(/\r/g, '').trim();
}

function buildCodeSessionHistoryText(session) {
  const turns = Array.isArray(session.turns) ? session.turns.slice(-codeSessionHistoryTurnLimit) : [];
  if (!turns.length) {
    return '';
  }

  const blocks = [];
  let totalLength = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const role = turn.role === 'assistant' ? '助手' : '用户';
    const text = String(turn.text || '').trim();
    if (!text) {
      continue;
    }
    const block = `[${role}]\n${text}`;
    if (totalLength + block.length > codeSessionHistoryCharLimit) {
      break;
    }
    totalLength += block.length;
    blocks.unshift(block);
  }
  return blocks.join('\n\n');
}

function appendCodeSessionTurn(session, role, text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return;
  }

  session.turns = Array.isArray(session.turns) ? session.turns : [];
  session.turns.push({
    role: role === 'assistant' ? 'assistant' : 'user',
    text: normalized,
    at: new Date().toISOString(),
  });

  if (session.turns.length > codeSessionHistoryTurnLimit * 2) {
    session.turns.splice(0, session.turns.length - codeSessionHistoryTurnLimit * 2);
  }
}

function buildCodexExecArgs(prompt, options = {}) {
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

  if (isResume) {
    args.push(threadId);
  }
  args.push(prompt);
  return args;
}

function spawnCodexCommand(args, options = {}) {
  if (process.platform !== 'win32') {
    return spawnProcess(resolveCodexCommand(), args, {
      cwd: options.cwd || config.codexWorkdir,
      env: process.env,
      stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    });
  }

  const encodedArgs = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
  const codexCommand = escapePowerShellSingleQuoted(resolveCodexCommand());
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$argsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedArgs}')) | ConvertFrom-Json`,
    `& '${codexCommand}' @argsJson`,
    `exit $LASTEXITCODE`,
  ].join('; ');

  return spawnProcess('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: options.cwd || config.codexWorkdir,
    env: process.env,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
}

function handleExecJsonStdout(session, pending, chunk) {
  session.lastOutputAt = new Date().toISOString();
  pending.lastActivityAt = session.lastOutputAt;
  pending.stdoutBuffer += chunk;
  pending.stdoutText = appendLimitedText(pending.stdoutText, chunk, 120000);

  while (true) {
    const lineBreakIndex = pending.stdoutBuffer.indexOf('\n');
    if (lineBreakIndex < 0) {
      break;
    }

    const line = pending.stdoutBuffer.slice(0, lineBreakIndex).trim();
    pending.stdoutBuffer = pending.stdoutBuffer.slice(lineBreakIndex + 1);
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

    if (summary.model) {
      session.model = summary.model;
    }
    if (summary.tokenUsage) {
      session.tokenUsage = summary.tokenUsage;
    }
    if (summary.threadId) {
      pending.threadId = summary.threadId;
    }
    if (summary.output) {
      pending.stderrText = appendLimitedText(pending.stderrText, `${summary.output}\n`, 120000);
    }
    if (summary.reply) {
      pending.lastAgentMessage = summary.reply;
      pending.lastStatusSummary = '整理回复中';
    } else if (summary.status) {
      pending.lastStatusSummary = summary.status;
      pushPendingStatus(pending, summary.status);
    }
    schedulePendingProgressUpdate(session, pending, Boolean(summary.force));
  }
}

function summarizeExecJsonEvent(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  if (event.model) {
    return {
      model: String(event.model || '').trim(),
      status: `已连接 Codex（${event.model}）`,
      force: true,
    };
  }

  if (event.type === 'token_count') {
    const tokenUsage = normalizeCodeSessionTokenUsage(event.info, event.timestamp);
    if (!tokenUsage) {
      return null;
    }
    return {
      tokenUsage,
    };
  }

  if (event.type === 'thread.started') {
    return {
      threadId: String(event.thread_id || '').trim(),
      status: '已创建会话',
      force: true,
    };
  }

  if (event.type === 'turn.started') {
    return {
      status: '开始处理',
      force: true,
    };
  }

  if (event.type === 'error') {
    return {
      status: String(event.message || '执行失败'),
      force: true,
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
      force: true,
    };
  }

  if (item.type === 'command_execution') {
    const command = String(item.command || '').trim();
    const shortCommand = truncateText(command.replace(/\s+/g, ' '), 120);
    if (event.type === 'item.started') {
      return {
        status: shortCommand ? `执行命令：${shortCommand}` : '开始执行命令',
        force: true,
      };
    }

    if (event.type === 'item.completed') {
      const exitCode = item.exit_code;
      const suffix = exitCode === undefined || exitCode === null ? '' : `（exit=${exitCode}）`;
      return {
        status: shortCommand ? `命令执行完成${suffix}：${shortCommand}` : `命令执行完成${suffix}`,
        output: normalizeProtoReply(item.aggregated_output || ''),
        force: true,
      };
    }
  }

  return null;
}

function pushPendingStatus(pending, text) {
  const normalized = normalizeProtoReply(text);
  if (!normalized) {
    return;
  }

  const compact = normalized.replace(/\s+/g, ' ');
  const lastItem = pending.statusHistory[pending.statusHistory.length - 1] || '';
  if (lastItem === compact) {
    return;
  }

  pending.statusHistory.push(compact);
  if (pending.statusHistory.length > codeProgressStatusHistoryLimit) {
    pending.statusHistory.splice(0, pending.statusHistory.length - codeProgressStatusHistoryLimit);
  }
}

function schedulePendingProgressUpdate(session, pending, force) {
  if (!pending || session.pending !== pending) {
    return;
  }

  pending.progressNeedsForce = pending.progressNeedsForce || force;
  if (pending.progressTimer) {
    return;
  }

  const elapsed = Date.now() - (pending.progressLastSentAt || 0);
  const delay = force ? 0 : Math.max(0, codeProgressUpdateIntervalMs - elapsed);
  pending.progressTimer = setTimeout(() => {
    pending.progressTimer = null;
    const needForce = pending.progressNeedsForce;
    pending.progressNeedsForce = false;
    void syncPendingProgressMessage(session, pending, needForce).catch((error) => {
      console.error(`[code] 更新进度消息失败：${formatError(error)}`);
    });
  }, delay);
}

async function syncPendingProgressMessage(session, pending, force = false) {
  return queuePendingProgressMessage(pending, async () => {
    if (!pending || session.pending !== pending) {
      return;
    }

    const text = buildPendingProgressText(pending);
    if (!text) {
      return;
    }

    if (!force && text === pending.progressLastText) {
      return;
    }

    let messageId = pending.progressMessageId;
    if (!messageId) {
      const result = await sendMessage(pending.chatId, text);
      messageId = Number(result?.message_id || 0);
      pending.progressMessageId = messageId;
    } else {
      try {
        await editMessage(pending.chatId, messageId, text);
      } catch (error) {
        if (isTelegramMessageNotModified(error)) {
          pending.progressLastSentAt = Date.now();
          pending.progressLastText = text;
          return;
        }
        console.warn(`[code] 编辑进度消息失败：${formatError(error)}`);
        return;
      }
    }

    pending.progressLastSentAt = Date.now();
    pending.progressLastText = text;
  });
}

function queuePendingProgressMessage(pending, task) {
  if (!pending) {
    return Promise.resolve();
  }

  const previous = pending.progressSyncPromise || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(task);

  pending.progressSyncPromise = current.finally(() => {
    if (pending.progressSyncPromise === current) {
      pending.progressSyncPromise = null;
    }
  });

  return pending.progressSyncPromise;
}

async function finalizePendingProgressMessage(pending, statusText) {
  if (!pending?.chatId) {
    return;
  }

  return queuePendingProgressMessage(pending, async () => {
    const text = buildPendingProgressText(pending, {
      finalStatus: statusText,
    });
    if (!text) {
      return;
    }

    if (!pending.progressMessageId) {
      const result = await sendMessage(pending.chatId, text);
      pending.progressMessageId = Number(result?.message_id || 0);
      pending.progressLastText = text;
      pending.progressLastSentAt = Date.now();
      return;
    }

    try {
      await editMessage(pending.chatId, pending.progressMessageId, text);
      pending.progressLastText = text;
      pending.progressLastSentAt = Date.now();
    } catch (error) {
      if (!isTelegramMessageNotModified(error)) {
        console.warn(`[code] 结束进度消息更新失败：${formatError(error)}`);
      }
    }
  });
}

function buildPendingProgressText(pending, options = {}) {
  const finalStatus = normalizeProtoReply(options.finalStatus || '');
  const status = finalStatus || pending.lastStatusSummary || (pending.awaitingApproval ? '等待审批' : '执行中');
  const elapsed = formatElapsedDuration(pending.startedAt, pending.lastActivityAt || new Date().toISOString());
  const lines = [
    finalStatus ? '# Codex' : '# Codex 处理中',
    `状态：${status}`,
    `耗时：${elapsed}`,
  ];

  const header = lines.join('\n');
  return truncateText(header, codeProgressMessageMaxLength);
}

function formatProtoProgressSummary(msg) {
  if (!msg || typeof msg.type !== 'string') {
    return '';
  }

  if (msg.type === 'exec_command_begin') {
    const command = summarizeCommandForStatus(Array.isArray(msg.command) ? msg.command.join(' ') : '');
    return command ? `执行：${command}` : '开始执行命令';
  }

  if (msg.type === 'exec_command_end') {
    const command = summarizeCommandForStatus(Array.isArray(msg.command) ? msg.command.join(' ') : '');
    const exitCode = msg.exit_code ?? msg.exitCode;
    const suffix = exitCode === undefined || exitCode === null ? '' : `（exit=${exitCode}）`;
    return command ? `完成${suffix}：${command}` : `命令执行完成${suffix}`;
  }

  if (msg.type === 'patch_apply_begin') {
    return '正在应用补丁';
  }

  if (msg.type === 'patch_apply_end') {
    return '补丁应用完成';
  }

  return '';
}

function buildProtoTurnPayload(session, opId, prompt) {
  return {
    id: opId,
    op: {
      type: 'user_turn',
      cwd: session.workdir,
      approval_policy: config.codexBypassApprovals ? 'never' : 'on-request',
      sandbox_policy: {
        mode: resolveProtoSandboxMode(),
      },
      model: config.codexModel || session.model || config.askModel,
      effort: 'medium',
      summary: 'auto',
      items: [
        {
          type: 'text',
          text: prompt,
        },
      ],
    },
  };
}

function resolveProtoSandboxMode() {
  if (config.codexBypassApprovals) {
    return 'danger-full-access';
  }

  if (config.codexSandbox === 'read-only' || config.codexSandbox === 'danger-full-access') {
    return config.codexSandbox;
  }

  return 'workspace-write';
}

function writeCodeSessionJson(session, payload) {
  session.proc.stdin.write(`${JSON.stringify(payload)}\n`);
}

function createProtoEventId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatProtoApprovalSummary(msg) {
  if (msg.type === 'exec_approval_request') {
    const command = Array.isArray(msg.command) ? msg.command.join(' ') : '';
    const cwd = msg.cwd ? `目录：${msg.cwd}` : '';
    return [command ? `命令：${command}` : '', cwd].filter(Boolean).join('\n');
  }

  return '检测到补丁审批请求';
}

function normalizeProtoReply(text) {
  return String(text || '').replace(/\r/g, '').trim();
}

function summarizeCommandForStatus(command) {
  let text = String(command || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }

  text = text.replace(/^"([^"]*[\\/])?([^"\\/]+)"\s+-Command\s+(.+)$/i, (_match, _dir, exe, script) => {
    const cleanedScript = String(script || '').replace(/^['"]|['"]$/g, '');
    return `${exe} ${cleanedScript}`;
  });
  text = text.replace(/^"?(pwsh(?:\.exe)?|powershell(?:\.exe)?)"?\s+-Command\s+(.+)$/i, (_match, exe, script) => {
    const cleanedScript = String(script || '').replace(/^['"]|['"]$/g, '');
    return `${exe} ${cleanedScript}`;
  });
  text = text.replace(/"([^"]*[\\/])?([^"\\/]+)"/g, '"$2"');
  text = text.replace(/\b([A-Za-z]:)?(?:[^\\/\s"]+[\\/])+([^\\/\s"]+\.(?:exe|cmd|bat|ps1))\b/gi, '$2');

  return truncateText(text, 64);
}

function formatElapsedDuration(startAt, endAt) {
  const start = new Date(startAt || '').getTime();
  const end = new Date(endAt || '').getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return '刚刚';
  }

  const totalSeconds = Math.max(1, Math.round((end - start) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}秒`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes}分${seconds}秒` : `${minutes}分`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}小时${restMinutes}分` : `${hours}小时`;
}

function escapePowerShellSingleQuoted(text) {
  return String(text || '').replace(/'/g, "''");
}

function buildCodeSessionPrompt(prompt) {
  const normalizedPrompt = String(prompt || '').replace(/\r/g, '').trim();
  if (!normalizedPrompt) {
    return '';
  }

  return normalizedPrompt;
}

function extractCodeReplyText(raw, prompt) {
  const blocks = extractCodeReplyBlocks(raw, prompt);
  return blocks.length ? trimTrailingActivityLines(normalizeReplyFormatting(blocks[blocks.length - 1])) : '';
}

function extractCodeReplyBlocks(raw, prompt) {
  const plain = stripTerminalControl(raw);
  const lines = plain
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .filter((line) => Boolean(line.trim()));

  const newUiReplies = extractNewUiReplyBlocks(lines, prompt);
  if (newUiReplies.length) {
    return newUiReplies;
  }

  const filteredLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (isCodexUiLine(trimmed)) {
      continue;
    }
    if (prompt && (trimmed === prompt || prompt.includes(trimmed))) {
      continue;
    }
    if (isCodexNoiseLine(trimmed)) {
      continue;
    }
    filteredLines.push(trimmed);
  }

  if (!filteredLines.length) {
    return [];
  }

  const block = collectLastReplyBlock(filteredLines);
  const normalized = dedupeAdjacentLines(
    block
      .map((line) => line.replace(/^•\s*/, '').trim())
      .filter(Boolean),
  );

  const reply = normalized.join('\n').trim();
  return reply ? [reply] : [];
}

function extractNewUiReplyBlocks(lines, prompt) {
  const promptAnchorIndex = findPromptAnchorIndex(lines, prompt);

  const searchStartIndex = promptAnchorIndex >= 0 ? promptAnchorIndex + 1 : 0;
  const blocks = [];

  for (let index = searchStartIndex; index < lines.length; index += 1) {
    if (lines[index].trim().toLowerCase() !== 'codex') {
      continue;
    }

    const block = [];
    for (let innerIndex = index + 1; innerIndex < lines.length; innerIndex += 1) {
      const trimmed = lines[innerIndex].trim();
      if (!trimmed) {
        if (block.length) {
          break;
        }
        continue;
      }
      if (
        trimmed.toLowerCase() === 'user' ||
        trimmed.toLowerCase() === 'codex' ||
        /^working \(\d+s/i.test(trimmed) ||
        isCodexActivityLine(trimmed) ||
        /^▌\s+/.test(trimmed) ||
        /tokens used/i.test(trimmed) ||
        trimmed.includes('Ctrl+T transcript') ||
        trimmed.includes('Ctrl+C quit')
      ) {
        break;
      }
      block.push(trimmed);
    }

    const normalized = dedupeAdjacentLines(
      block.filter((line) => {
        if (!line) {
          return false;
        }
        if (prompt && (line === prompt || prompt.includes(line))) {
          return false;
        }
        return true;
      }),
    ).join('\n').trim();

    if (normalized && !isInvalidReplyBlock(normalized)) {
      blocks.push(normalized);
    }
  }

  if (!blocks.length) {
    return [];
  }

  const finalBlocks = blocks.filter((block) => !isLikelyProgressReply(block));
  return collapseReplyBlocks(dedupeAdjacentLines(finalBlocks.length ? finalBlocks : blocks));
}

function findPromptAnchorIndex(lines, prompt) {
  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt) {
    return -1;
  }

  return findLastIndex(lines, (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return false;
    }
    return (
      trimmed === normalizedPrompt ||
      normalizedPrompt.includes(trimmed) ||
      trimmed.includes(normalizedPrompt)
    );
  });
}

function collectLastReplyBlock(lines) {
  const lastBulletIndex = findLastIndex(lines, (line) => /^•\s+/.test(line) && !/Working \(/.test(line));
  if (lastBulletIndex >= 0) {
    const block = [];
    for (let index = lastBulletIndex; index < lines.length; index += 1) {
      const line = lines[index];
      if (index > lastBulletIndex && (isCodexUiLine(line) || /^◦\s+Working/.test(line))) {
        break;
      }
      if (index > lastBulletIndex && /^›\s+/.test(line)) {
        break;
      }
      block.push(line);
    }
    return block;
  }

  return lines.slice(-8);
}

function dedupeAdjacentLines(lines) {
  const results = [];
  for (const line of lines) {
    if (!line) {
      continue;
    }
    if (results[results.length - 1] === line) {
      continue;
    }
    results.push(line);
  }
  return results;
}

function collapseReplyBlocks(blocks) {
  const results = [];
  for (const block of blocks) {
    if (!block) {
      continue;
    }

    if (!results.length) {
      results.push(block);
      continue;
    }

    const lastBlock = results[results.length - 1];
    if (block === lastBlock) {
      continue;
    }

    if (block.includes(lastBlock) || lastBlock.includes(block)) {
      results[results.length - 1] = block.length >= lastBlock.length ? block : lastBlock;
      continue;
    }

    results.push(block);
  }
  return results;
}

function normalizeReplyFormatting(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trimEnd());

  const normalized = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '-' && index + 1 < lines.length) {
      const nextLine = lines[index + 1].trim();
      if (nextLine && nextLine !== '-') {
        normalized.push(`- ${nextLine}`);
        index += 1;
        continue;
      }
    }
    normalized.push(lines[index]);
  }

  return normalized
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function canFinalizePendingResponse(pending, reply = '') {
  if (!pending) {
    return false;
  }

  if (isCodeSessionScreenReady(pending.latestScreen)) {
    return true;
  }

  const replyChangedAt = Number(pending.lastExtractedReplyChangedAt || 0);
  if (reply && replyChangedAt && Date.now() - replyChangedAt >= 15000) {
    return true;
  }

  const changedAt = Number(pending.latestScreenChangedAt || 0);
  if (!changedAt) {
    return false;
  }

  return Date.now() - changedAt >= 12000;
}

function trimTrailingActivityLines(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trimEnd());

  while (lines.length && isCodexActivityLine(lines[lines.length - 1].trim())) {
    lines.pop();
  }

  return lines.join('\n').trim();
}

function isInvalidReplyBlock(block) {
  const normalized = String(block || '').trim();
  if (!normalized) {
    return true;
  }

  return (
    normalized === 'user' ||
    /^user\b/i.test(normalized) ||
    normalized.includes('Ctrl+T transcript') ||
    normalized.includes('Ctrl+C quit') ||
    normalized.includes('⏎ send') ||
    /Working \(\d+s/i.test(normalized) ||
    normalized.includes('@filename') ||
    /^W(?:Wo|Wor|Work)/.test(normalized)
  );
}

function isCodeSessionScreenReady(text) {
  const plain = takeSessionStateText(String(text || ''));
  return isCodeSessionReady(plain, compactText(plain));
}

function isSessionActivelyWorking(text) {
  const normalized = takeSessionStateText(String(text || ''));
  if (!normalized) {
    return false;
  }

  return (
    /\(\d+s\s*[•·]\s*Esc to interrupt\)/i.test(normalized) ||
    /\b(?:Clarifying|Considering|Exploring|Checking|Addressing|Balancing|Thinking|Planning|Reading|Summarizing)\b[\s\S]{0,80}\(\d+s/i.test(normalized)
  );
}

function isCodexUiLine(line) {
  return (
    /^[╭╰│]/.test(line) ||
    /^OpenAI Codex/.test(line) ||
    /^Tip: /.test(line) ||
    /^⚠ /.test(line) ||
    /^Set `web_search`/.test(line) ||
    /^gpt-[\w.-]+.*·/.test(line) ||
    /^›\s+/.test(line) ||
    /^◦\s+Working/.test(line) ||
    /^•\s+Working/.test(line) ||
    /^model:\s*/.test(line) ||
    /^directory:\s*/.test(line)
  );
}

function isCodexNoiseLine(line) {
  return (
    line === 'it.' ||
    line === '>' ||
    /^W(?:o|or|ork|orki|orkin|orking)?\d*$/.test(line) ||
    /^[A-Za-z0-9]{1,3}$/.test(line) ||
    /^[•◦]$/.test(line)
  );
}

function isCodexActivityLine(line) {
  const normalized = String(line || '').trim();
  if (!normalized) {
    return false;
  }

  return (
    /\(\d+s\s*[•·]\s*Esc to interrupt\)$/i.test(normalized) ||
    /^(?:Clarifying|Considering|Exploring|Checking|Addressing|Balancing|Thinking|Planning|Reading|Summarizing|Narrowing|Finalizing|Making)\b[\s\S]*\(\d+s/i.test(normalized)
  );
}

function appendCodeDebugLog(pending, event, payload = {}) {
  if (!pending?.debugLogPath) {
    return;
  }

  const entry = {
    time: new Date().toISOString(),
    event,
    ...Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [key, summarizeDebugValue(value)]),
    ),
  };

  try {
    fs.appendFileSync(pending.debugLogPath, `${JSON.stringify(entry, null, 0)}\n`, 'utf8');
  } catch {
    // ignore
  }
}

function summarizeDebugValue(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.replace(/\s+$/g, '').trim();
  if (normalized.length <= 800) {
    return normalized;
  }

  return `${normalized.slice(0, 800)}...[truncated ${normalized.length - 800} chars]`;
}

function stripTerminalControl(text) {
  return String(text || '')
    .replace(/\x1B\][^\u0007]*\u0007/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ');
}

function findLastIndex(list, predicate) {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (predicate(list[index], index)) {
      return index;
    }
  }
  return -1;
}

function appendLimitedText(current, extra, maxLength) {
  const next = `${current}${extra}`;
  if (next.length <= maxLength) {
    return next;
  }
  return next.slice(next.length - maxLength);
}

function compactText(text) {
  return String(text || '').replace(/\s+/g, '').toLowerCase();
}

function takeRecentScreenText(text, maxLength = 12000) {
  const normalized = String(text || '');
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(normalized.length - maxLength);
}

function takeSessionStateText(text, maxLength = 2500, maxLines = 48) {
  const recent = takeRecentScreenText(text, maxLength);
  const lines = recent.split('\n');
  if (lines.length <= maxLines) {
    return recent;
  }
  return lines.slice(lines.length - maxLines).join('\n');
}

function isLikelyProgressReply(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return false;
  }

  if (normalized.includes('\n')) {
    return false;
  }

  if (normalized.length > 80) {
    return false;
  }

  return (
    /^(我先|先|我先来|文件很多，我|我先查看|我先读取|我先整理)/.test(normalized) ||
    normalized.includes('给你一个清单') ||
    normalized.includes('方便你看') ||
    normalized.includes('我先看') ||
    normalized.includes('我先列') ||
    normalized.includes('先查看')
  );
}

function parseApprovalState(plain, compact = compactText(plain)) {
  const awaitingApproval =
    (
      compact.includes('allowcommand?') ||
      compact.includes('codexwantstorun') ||
      compact.includes('approveandrunthecommand')
    ) &&
    (
      compact.includes('yesalwaysno,providefeedback') ||
      compact.includes('approveandrunthecommand')
    );

  if (!awaitingApproval) {
    return {
      awaitingApproval: false,
      summary: '',
    };
  }

  const commandMatch = plain.match(/Codex wants to run\s+([\s\S]*?)(?:需要我|Allow command\?|Yes\s+Always\s+No, provide feedback|Approve and run the command)/i);
  const summary = commandMatch
    ? commandMatch[1].replace(/\s+/g, ' ').trim()
    : '检测到待审批命令';

  return {
    awaitingApproval: true,
    summary,
  };
}

async function runCodex(prompt, options = {}) {
  const wrapped = Boolean(options.wrapped);
  const taskId = `${Date.now()}`;
  const taskOutputDir = wrapped ? path.join(runtimeDir, `task-${taskId}`) : '';
  if (wrapped) {
    fs.mkdirSync(taskOutputDir, { recursive: true });
  }

  const lastMessagePath = path.join(runtimeDir, `codex-last-message-${Date.now()}.txt`);
  const args = ['exec', '--cd', config.codexWorkdir, '--skip-git-repo-check', '--output-last-message', lastMessagePath];

  if (config.codexBypassApprovals) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (config.codexSandbox === 'workspace-write') {
    args.push('--sandbox', 'workspace-write');
  } else if (config.codexSandbox === 'read-only') {
    args.push('--sandbox', config.codexSandbox);
  } else if (config.codexSandbox === 'danger-full-access') {
    args.push('--sandbox', 'danger-full-access');
  }

  if (config.codexModel) {
    args.push('--model', config.codexModel);
  }

  args.push(wrapped ? buildCodexPrompt(prompt, taskOutputDir) : prompt);

  const result = await runCodexCommand(args, {
    cwd: config.codexWorkdir,
    timeoutMs: 15 * 60 * 1000,
  });
  const lastMessage = fs.existsSync(lastMessagePath) ? fs.readFileSync(lastMessagePath, 'utf8').trim() : '';
  const parsed = parseCodexArtifacts(lastMessage);
  const parts = [];

  if (parsed.text) {
    parts.push(parsed.text);
  }

  const stdout = result.stdout.trim();
  if (!parsed.text && stdout) {
    parts.push(extractCodexTextFromStdout(stdout));
  }

  const stderr = result.stderr.trim();
  if (!parsed.text && stderr) {
    parts.push(`stderr：\n${stderr}`);
  }

  if (!parts.length) {
    parts.push('');
  }

  const artifactPaths = wrapped ? collectArtifacts(taskOutputDir, parsed.artifactPaths) : [];
  const text = wrapped
    ? normalizeCodexReply(parts.filter(Boolean).join('\n\n'), prompt)
    : parts.filter(Boolean).join('\n\n').trim();

  return {
    text,
    artifacts: artifactPaths,
  };
}

async function getUpdates(offset, timeoutSeconds) {
  const payload = {
    offset,
    timeout: timeoutSeconds,
    allowed_updates: ['message'],
  };

  try {
    const data = await invokeTelegramJson('getUpdates', payload);
    if (!data.ok) {
      throw new Error(`Telegram getUpdates 失败：${JSON.stringify(data)}`);
    }
    return data.result || [];
  } catch (error) {
    const firstError = formatError(error);
    await sleep(1000);
    const fallbackData = await invokeTelegramJson('getUpdates', { ...payload, timeout: 0 });
    if (!fallbackData.ok) {
      throw new Error(`Telegram getUpdates 重试失败。首次错误：${firstError}；重试响应：${JSON.stringify(fallbackData)}`);
    }
    return fallbackData.result || [];
  }
}

async function sendMessage(chatId, text, options = {}) {
  const rawText = String(text || '');
  if (options.plainTextOnly) {
    const plainText = buildTelegramPlainTextFallback(rawText, options);
    const data = await invokeTelegramJson('sendMessage', {
      chat_id: chatId,
      text: plainText,
      disable_web_page_preview: true,
    });
    if (!data.ok) {
      throw new Error(`Telegram sendMessage 失败：${JSON.stringify(data)}`);
    }
    return data.result || null;
  }

  const html = options.alreadyFormatted ? rawText : renderTelegramHtml(rawText);

  try {
    const data = await invokeTelegramJson('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (!data.ok) {
      throw new Error(`Telegram sendMessage 失败：${JSON.stringify(data)}`);
    }
    return data.result || null;
  } catch (error) {
    console.warn(`[tg] HTML 发送失败，降级为纯文本：${formatError(error)}`);
    const fallbackText = buildTelegramPlainTextFallback(rawText, options);
    const fallbackData = await invokeTelegramJson('sendMessage', {
      chat_id: chatId,
      text: fallbackText,
      disable_web_page_preview: true,
    });
    if (!fallbackData.ok) {
      throw new Error(`Telegram sendMessage 失败：${JSON.stringify(fallbackData)}`);
    }
    return fallbackData.result || null;
  }
}

async function editMessage(chatId, messageId, text, options = {}) {
  const rawText = String(text || '');
  if (options.plainTextOnly) {
    const plainText = buildTelegramPlainTextFallback(rawText, options);
    const data = await invokeTelegramJson('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: plainText,
      disable_web_page_preview: true,
    });
    if (!data.ok) {
      throw new Error(`Telegram editMessageText 失败：${JSON.stringify(data)}`);
    }
    return data.result || null;
  }

  const html = options.alreadyFormatted ? rawText : renderTelegramHtml(rawText);

  try {
    const data = await invokeTelegramJson('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (!data.ok) {
      throw new Error(`Telegram editMessageText 失败：${JSON.stringify(data)}`);
    }
    return data.result || null;
  } catch (error) {
    console.warn(`[tg] HTML 编辑失败，降级为纯文本：${formatError(error)}`);
    const fallbackText = buildTelegramPlainTextFallback(rawText, options);
    const fallbackData = await invokeTelegramJson('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: fallbackText,
      disable_web_page_preview: true,
    });
    if (!fallbackData.ok) {
      throw new Error(`Telegram editMessageText 失败：${JSON.stringify(fallbackData)}`);
    }
    return fallbackData.result || null;
  }
}

async function sendLongMessage(chatId, text) {
  const chunks = renderTelegramHtmlChunks(text, 3500);
  for (const chunk of chunks) {
    await sendMessage(chatId, chunk, { alreadyFormatted: true });
  }
}

async function sendPhoto(chatId, filePath, caption = '') {
  const data = await invokeTelegramForm('sendPhoto', {
    chat_id: String(chatId),
    caption,
    photo: path.resolve(filePath),
  });
  if (!data.ok) {
    throw new Error(`Telegram sendPhoto 失败：${JSON.stringify(data)}`);
  }
}

async function sendDocument(chatId, filePath, caption = '') {
  const data = await invokeTelegramForm('sendDocument', {
    chat_id: String(chatId),
    caption,
    document: path.resolve(filePath),
  });
  if (!data.ok) {
    throw new Error(`Telegram sendDocument 失败：${JSON.stringify(data)}`);
  }
}

async function sendArtifact(chatId, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    await sendPhoto(chatId, filePath, path.basename(filePath));
    return;
  }
  await sendDocument(chatId, filePath, path.basename(filePath));
}

async function sendInlineArtifactsFromText(chatId, text, sentPaths = new Set()) {
  const artifactPaths = extractLocalArtifactPathsFromText(text);
  for (const filePath of artifactPaths) {
    const normalizedPath = path.resolve(filePath);
    if (sentPaths.has(normalizedPath)) {
      continue;
    }

    try {
      await sendArtifact(chatId, normalizedPath);
      sentPaths.add(normalizedPath);
    } catch (error) {
      console.warn(`[tg] 自动回传文件失败 path=${normalizedPath} error=${formatError(error)}`);
    }
  }
}

function extractLocalArtifactPathsFromText(text) {
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
    '.pdf',
    '.txt',
    '.md',
    '.zip',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
  ]);

  const results = new Set();
  const normalized = String(text || '').replace(/\r/g, '');
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
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        results.add(resolved);
      }
    } catch {}
  }

  return Array.from(results).slice(0, 10);
}

async function invokeTelegramJson(method, payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const result = await runCommand('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(__dirname, 'telegram-request.ps1'),
    '-Method',
    method,
    '-Token',
    config.telegramToken,
    '-JsonBase64',
    encodedPayload,
    '-ProxyUrl',
    getProxyUrl(),
  ], {
    cwd: __dirname,
    timeoutMs: Math.max(Number(payload.timeout || 0) * 1000 + 75000, 90000),
  });

  return parsePowerShellJson(result.stdout, method);
}

async function invokeTelegramForm(method, fields) {
  const encodedFields = Buffer.from(JSON.stringify(fields), 'utf8').toString('base64');
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(__dirname, 'telegram-request.ps1'),
    '-Method',
    method,
    '-Token',
    config.telegramToken,
    '-JsonBase64',
    encodedFields,
    '-ProxyUrl',
    getProxyUrl(),
  ];

  if (fields.photo) {
    args.push('-PhotoPath', fields.photo);
  }
  if (fields.document) {
    args.push('-DocumentPath', fields.document);
  }

  const result = await runCommand('powershell', args, {
    cwd: __dirname,
    timeoutMs: 90000,
  });

  return parsePowerShellJson(result.stdout, method);
}

async function invokeJsonApi({ url, apiKey, proxyUrl, body, timeoutSec }) {
  const encodedBody = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(__dirname, 'json-api-request.ps1'),
    '-Url',
    url,
    '-ApiKey',
    apiKey,
    '-JsonBase64',
    encodedBody,
    '-TimeoutSec',
    String(timeoutSec),
  ];

  if (proxyUrl) {
    args.push('-ProxyUrl', proxyUrl);
  }

  const result = await runCommand('powershell', args, {
    cwd: __dirname,
    timeoutMs: timeoutSec * 1000 + 30000,
  });

  return parsePowerShellJson(result.stdout, 'json-api');
}

function parsePowerShellJson(stdout, method) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`Telegram ${method} 返回为空`);
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Telegram ${method} 返回的 JSON 无法解析：${trimmed}`);
  }
}

function extractResponseText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text;
  }

  if (!Array.isArray(data.output)) {
    return '';
  }

  const texts = [];
  for (const item of data.output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        texts.push(part.text);
      }
    }
  }
  return texts.join('\n').trim();
}

function extractAskUsage(data) {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const usage = data.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const normalized = normalizeTokenBucket({
    inputTokens: usage.input_tokens ?? usage.inputTokens,
    cachedInputTokens:
      usage.input_tokens_details?.cached_tokens ??
      usage.inputTokensDetails?.cachedTokens ??
      usage.cached_input_tokens ??
      usage.cachedInputTokens,
    outputTokens: usage.output_tokens ?? usage.outputTokens,
    reasoningOutputTokens:
      usage.output_tokens_details?.reasoning_tokens ??
      usage.outputTokensDetails?.reasoningTokens ??
      usage.reasoning_output_tokens ??
      usage.reasoningOutputTokens,
    totalTokens: usage.total_tokens ?? usage.totalTokens,
  });

  if (!normalized) {
    return null;
  }

  return {
    ...normalized,
    model: String(data.model || config.askModel).trim() || config.askModel,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeCodeSessionTokenUsage(value, updatedAt = '') {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const total = normalizeTokenBucket(value.total_token_usage || value.totalTokenUsage || value.total);
  const last = normalizeTokenBucket(value.last_token_usage || value.lastTokenUsage || value.last);
  const modelContextWindow = toNumber(value.model_context_window ?? value.modelContextWindow, null);
  const normalizedUpdatedAt = String(value.updatedAt || updatedAt || '').trim();

  if (!total && !last && modelContextWindow == null) {
    return null;
  }

  return {
    total,
    last,
    modelContextWindow,
    updatedAt: normalizedUpdatedAt,
  };
}

function normalizeTokenBucket(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const inputTokens = toNumber(value.input_tokens ?? value.inputTokens, null);
  const cachedInputTokens = toNumber(value.cached_input_tokens ?? value.cachedInputTokens, null);
  const outputTokens = toNumber(value.output_tokens ?? value.outputTokens, null);
  const reasoningOutputTokens = toNumber(value.reasoning_output_tokens ?? value.reasoningOutputTokens, null);
  const totalTokens = toNumber(value.total_tokens ?? value.totalTokens, null);

  if (
    inputTokens == null &&
    cachedInputTokens == null &&
    outputTokens == null &&
    reasoningOutputTokens == null &&
    totalTokens == null
  ) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function refreshCodeSessionRuntimeState(session) {
  if (!session?.codexThreadId) {
    return;
  }

  const meta = findCodexSessionById(session.codexThreadId);
  if (!meta) {
    return;
  }

  if (meta.model) {
    session.model = meta.model;
  }
  if (meta.tokenUsage) {
    session.tokenUsage = meta.tokenUsage;
  }
}

function formatCodeSessionWindowSummary(tokenUsage) {
  const normalized = normalizeCodeSessionTokenUsage(tokenUsage);
  const total = normalized?.total;
  if (total?.totalTokens == null) {
    return normalized?.modelContextWindow ? `上下文窗口 ${formatTokenNumber(normalized.modelContextWindow)}，暂无累计值` : '暂无';
  }

  if (normalized?.modelContextWindow) {
    const windowSize = normalized.modelContextWindow;
    const used = total.totalTokens;
    const remaining = Math.max(0, windowSize - used);
    const percent = windowSize > 0 ? ((used / windowSize) * 100).toFixed(1) : '0.0';
    return `${formatTokenNumber(used)} / ${formatTokenNumber(windowSize)}（${percent}% 已用，剩余 ${formatTokenNumber(remaining)}）`;
  }

  return formatTokenBucketSummary(total);
}

function formatTokenBucketSummary(bucket) {
  const normalized = normalizeTokenBucket(bucket);
  if (!normalized) {
    return '暂无';
  }

  const parts = [];
  if (normalized.totalTokens != null) {
    parts.push(`总计 ${formatTokenNumber(normalized.totalTokens)}`);
  }

  const details = [];
  if (normalized.inputTokens != null) {
    details.push(`输入 ${formatTokenNumber(normalized.inputTokens)}`);
  }
  if (normalized.cachedInputTokens != null) {
    details.push(`缓存 ${formatTokenNumber(normalized.cachedInputTokens)}`);
  }
  if (normalized.outputTokens != null) {
    details.push(`输出 ${formatTokenNumber(normalized.outputTokens)}`);
  }
  if (normalized.reasoningOutputTokens != null) {
    details.push(`推理 ${formatTokenNumber(normalized.reasoningOutputTokens)}`);
  }

  if (!parts.length && details.length) {
    return details.join('，');
  }
  if (!details.length) {
    return parts.join('');
  }
  return `${parts.join('')}（${details.join('，')}）`;
}

function formatTokenNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString('zh-CN') : '0';
}

async function runCommand(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd: options.cwd || process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) {
        return;
      }
      child.kill();
      reject(new Error(`命令执行超时：${command} ${args.join(' ')}`));
    }, options.timeoutMs || 60000);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      finished = true;
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(new Error(`命令执行失败，退出码 ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

function splitText(text, maxLength) {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + line + '\n').length > maxLength && current) {
      chunks.push(current.trimEnd());
      current = '';
    }
    current += `${line}\n`;
  }

  if (current.trim()) {
    chunks.push(current.trimEnd());
  }

  return chunks;
}

function renderTelegramHtmlChunks(text, maxLength) {
  const blocks = parseTelegramBlocks(normalizeTelegramDisplayText(text));
  const chunks = [];

  for (const block of blocks) {
    if (block.type === 'code') {
      const codeChunks = splitText(block.content, Math.max(200, maxLength - 32));
      for (const codeChunk of codeChunks) {
        chunks.push(`<pre>${escapeTelegramHtml(codeChunk)}</pre>`);
      }
      continue;
    }

    const textChunks = splitText(block.content, Math.max(200, maxLength - 64));
    for (const textChunk of textChunks) {
      const html = renderTelegramHtml(textChunk);
      if (html) {
        chunks.push(html);
      }
    }
  }

  return chunks.length ? chunks : [renderTelegramHtml(normalizeTelegramDisplayText(String(text || '')))];
}

function parseTelegramBlocks(text) {
  const normalized = String(text || '').replace(/\r/g, '');
  const blocks = [];
  const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;

  for (const match of normalized.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      blocks.push({
        type: 'text',
        content: normalized.slice(lastIndex, index),
      });
    }

    blocks.push({
      type: 'code',
      language: String(match[1] || '').trim(),
      content: String(match[2] || '').replace(/\n$/, ''),
    });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < normalized.length) {
    blocks.push({
      type: 'text',
      content: normalized.slice(lastIndex),
    });
  }

  return blocks.length ? blocks : [{ type: 'text', content: normalized }];
}

function renderTelegramHtml(text) {
  const normalized = normalizeTelegramDisplayText(text);
  if (!normalized) {
    return '';
  }

  const parts = [];
  for (const block of parseTelegramBlocks(normalized)) {
    if (block.type === 'code') {
      parts.push(`<pre>${escapeTelegramHtml(block.content)}</pre>`);
      continue;
    }

    const html = renderTelegramTextHtml(block.content);
    if (html) {
      parts.push(html);
    }
  }

  return parts.join('\n\n');
}

function renderTelegramTextHtml(text) {
  const normalized = String(text || '');
  if (!normalized) {
    return '';
  }

  const renderedLines = normalized.split('\n').map((line) => {
    const headingMatch = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (headingMatch) {
      return `<b>${renderTelegramInlineHtml(headingMatch[1])}</b>`;
    }

    const labelMatch = line.match(/^([^\s][^：\n]{1,12}：)(.*)$/);
    if (labelMatch && labelMatch[2].trim()) {
      return `<b>${escapeTelegramHtml(labelMatch[1])}</b>${renderTelegramInlineHtml(labelMatch[2])}`;
    }

    return renderTelegramInlineHtml(line);
  });

  return renderedLines.join('\n');
}

function normalizeTelegramDisplayText(text) {
  const normalized = String(text || '').replace(/\r/g, '');
  if (!normalized) {
    return '';
  }

  const result = [];
  const lines = normalized.split('\n');
  for (const line of lines) {
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (!bulletMatch) {
      result.push(line);
      continue;
    }

    const prefix = bulletMatch[1] || '';
    const content = normalizeTelegramBulletContent(bulletMatch[2] || '');
    result.push(`${prefix}• ${content}`);
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeTelegramBulletContent(text) {
  const normalized = String(text || '').trim();
  const wrappedCodeMatch = normalized.match(/^`([^`\n]+)`$/);
  if (!wrappedCodeMatch) {
    return normalized;
  }

  const value = wrappedCodeMatch[1];
  if (isPlainTelegramListItem(value)) {
    return value;
  }

  return normalized;
}

function isPlainTelegramListItem(text) {
  return /^[\p{L}\p{N}._@-]+$/u.test(String(text || ''));
}

function renderTelegramInlineHtml(text) {
  const normalized = String(text || '');
  if (!normalized) {
    return '';
  }

  let html = '';
  let cursor = 0;
  const pattern = /`([^`\n]+)`/g;
  for (const match of normalized.matchAll(pattern)) {
    const index = match.index ?? 0;
    html += escapeTelegramHtml(normalized.slice(cursor, index));
    html += `<code>${escapeTelegramHtml(match[1])}</code>`;
    cursor = index + match[0].length;
  }

  html += escapeTelegramHtml(normalized.slice(cursor));
  return html;
}

function escapeTelegramHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildTelegramPlainTextFallback(text, options = {}) {
  const rawText = sanitizeTelegramText(text);
  if (!rawText) {
    return '';
  }

  if (!options.alreadyFormatted) {
    return normalizeTelegramDisplayText(rawText);
  }

  return String(rawText)
    .replace(/<pre>/g, '```\n')
    .replace(/<\/pre>/g, '\n```')
    .replace(/<code>/g, '`')
    .replace(/<\/code>/g, '`')
    .replace(/<b>/g, '')
    .replace(/<\/b>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function sanitizeTelegramText(text) {
  return String(text || '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function loadSavedOffset() {
  try {
    if (!fs.existsSync(offsetStatePath)) {
      return 0;
    }
    const raw = fs.readFileSync(offsetStatePath, 'utf8');
    const data = JSON.parse(raw);
    const value = Number(data?.offset);
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch (error) {
    console.warn(`[boot] 读取 offset 失败：${formatError(error)}`);
    return 0;
  }
}

function saveOffset(offset) {
  try {
    fs.writeFileSync(offsetStatePath, JSON.stringify({ offset }), 'utf8');
  } catch (error) {
    console.warn(`[poll] 保存 offset 失败：${formatError(error)}`);
  }
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = stripQuotes(value);
    }
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function getProxyUrl() {
  return config.telegramProxyUrl;
}

function getTelegramPollTimeoutSeconds() {
  return config.telegramUseShortPoll ? 0 : config.pollTimeoutSeconds;
}

function getRequiredEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`缺少环境变量：${key}`);
  }
  return value;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function trimTrailingSlash(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function normalizeCodexSandbox(value) {
  if (!value) {
    return '';
  }
  const allowedValues = new Set(['read-only', 'workspace-write', 'danger-full-access']);
  if (!allowedValues.has(value)) {
    throw new Error(`不支持的 CODEX_SANDBOX：${value}。仅允许空值、read-only、workspace-write 或 danger-full-access。`);
  }
  return value;
}

function resolveCodexCommand() {
  if (config.codexCliPath) {
    return path.resolve(config.codexCliPath);
  }

  const candidates = process.platform === 'win32'
    ? ['codex.cmd', 'codex.exe', 'codex']
    : ['codex'];

  const resolved = findCommandInPath(candidates);
  if (resolved) {
    return resolved;
  }

  return process.platform === 'win32' ? 'codex.cmd' : 'codex';
}

function findCommandInPath(commandNames) {
  const pathEnv = process.env.PATH || '';
  const directories = pathEnv
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);

  for (const commandName of commandNames) {
    if (path.isAbsolute(commandName) && fs.existsSync(commandName)) {
      return commandName;
    }

    for (const directory of directories) {
      const fullPath = path.join(directory, commandName);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return '';
}

async function runCodexCommand(args, options = {}) {
  if (process.platform !== 'win32') {
    return await runCommand(resolveCodexCommand(), args, options);
  }

  const encodedArgs = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
  const codexCommand = escapePowerShellSingleQuoted(resolveCodexCommand());
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$argsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedArgs}')) | ConvertFrom-Json`,
    `& '${codexCommand}' @argsJson`,
    `exit $LASTEXITCODE`,
  ].join('; ');

  return await runCommand('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], options);
}

function buildCodexPrompt(userPrompt, taskOutputDir) {
  const helperScript = path.join(__dirname, 'google-codex.ps1');
  return [
    '你正在处理来自 Telegram 的远程任务。',
    '执行要求：',
    '1. 直接完成用户任务，不要复述本说明，不要先说“收到”或“我将开始”。',
    '2. 默认使用中文回复，回复尽量简洁；如果用户明确要求一句话，就只回复那一句。',
    '3. 如果任务需要产出图片、截图或其他文件，请将文件保存到下面目录：',
    taskOutputDir,
    '4. 如果需要浏览器截图，可优先使用下面这个本地脚本：',
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${helperScript}" -OutputPath "<输出文件绝对路径>" -SearchUrl "<目标URL>" -WaitMilliseconds 8000`,
    '5. 如果你生成了需要回传到 Telegram 的文件，请在最终回复末尾单独输出一行：',
    'TELEGRAM_ARTIFACTS: 绝对路径1|绝对路径2',
    '6. 如果没有文件需要回传，不要输出 TELEGRAM_ARTIFACTS 这一行。',
    '',
    '用户任务：',
    userPrompt,
  ].join('\n');
}

function extractCodexTextFromStdout(stdout) {
  const marker = /\n\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s+codex\s*\n/i;
  const match = stdout.match(marker);
  if (!match || match.index == null) {
    return stdout.trim();
  }

  const text = stdout.slice(match.index + match[0].length);
  const cleaned = text.replace(/\n\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s+tokens used:[\s\S]*$/i, '').trim();
  return cleaned || stdout.trim();
}

function normalizeCodexReply(text, userPrompt) {
  let normalized = (text || '').trim();

  normalized = normalized.replace(
    /收到，我会按远程任务方式处理，并(?:严格)?遵守你的规范：[\s\S]*?(?:请把具体任务内容发给我，我马上开始。|请直接发我具体任务内容[\s\S]*?(?:我收到后会先分析，再给出最小且精准的处理方案。)?)\s*/g,
    '',
  );

  normalized = normalized.replace(
    /-\s*\*?\*?(?:仅使用中文沟通|语言)\*?\*?[\s\S]*?(?:-\s*\*?\*?(?:当前环境是只读沙箱，我会先做分析，涉及修改时明确说明限制|提交)\*?\*?[^\n]*)(?:\n|$)/g,
    '',
  );

  normalized = normalized.trim();

  const simpleReplyMatch = userPrompt.match(/^\s*回复一句[:：]\s*(.+?)\s*$/s);
  if (simpleReplyMatch) {
    const expected = simpleReplyMatch[1].trim();
    if (
      !normalized ||
      /^(好的[。！!]?)|(收到[。！!]?)|(可以[。！!]?)$/.test(normalized) ||
      /收到，我会按远程任务方式处理/.test(normalized) ||
      /请(?:直接发我|把)具体任务内容/.test(normalized)
    ) {
      return expected;
    }
  }

  return normalized;
}

function parseCodexArtifacts(text) {
  if (!text) {
    return { text: '', artifactPaths: [] };
  }

  const lines = text.split('\n');
  const artifactLineIndex = lines.findIndex((line) => line.startsWith('TELEGRAM_ARTIFACTS:'));
  if (artifactLineIndex < 0) {
    return { text: text.trim(), artifactPaths: [] };
  }

  const artifactLine = lines[artifactLineIndex];
  const rawPaths = artifactLine.slice('TELEGRAM_ARTIFACTS:'.length).trim();
  const artifactPaths = rawPaths
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);

  lines.splice(artifactLineIndex, 1);
  return {
    text: lines.join('\n').trim(),
    artifactPaths,
  };
}

function collectArtifacts(taskOutputDir, reportedPaths) {
  const normalized = new Set();

  for (const filePath of reportedPaths) {
    const resolved = path.resolve(filePath);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      normalized.add(resolved);
    }
  }

  if (fs.existsSync(taskOutputDir)) {
    for (const entry of fs.readdirSync(taskOutputDir)) {
      const filePath = path.join(taskOutputDir, entry);
      if (fs.statSync(filePath).isFile()) {
        normalized.add(filePath);
      }
    }
  }

  return Array.from(normalized);
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function takeTailText(text, maxLength) {
  const normalized = String(text || '');
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const retained = Math.max(1, maxLength - 10);
  return `...[前略]\n${normalized.slice(normalized.length - retained)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTelegramMessageNotModified(error) {
  return String(error?.message || error || '').includes('message is not modified');
}

function writeBotPidFile() {
  try {
    fs.writeFileSync(botPidPath, JSON.stringify({
      pid: process.pid,
      startedAt: state.bootAt,
      workdir: config.codexWorkdir,
    }), 'utf8');
  } catch (error) {
    console.warn(`[boot] 写入 bot pid 失败：${formatError(error)}`);
  }
}

function clearBotPidFile() {
  try {
    if (!fs.existsSync(botPidPath)) {
      return;
    }

    const raw = fs.readFileSync(botPidPath, 'utf8');
    const data = JSON.parse(raw);
    if (Number(data?.pid) !== process.pid) {
      return;
    }

    fs.unlinkSync(botPidPath);
  } catch {}
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

main().catch((error) => {
  console.error(`[fatal] ${formatError(error)}`);
  process.exit(1);
});
