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

const state = {
  offset: loadSavedOffset(),
  runningTask: null,
  lastTask: null,
  bootAt: new Date().toISOString(),
  mode: 'ask',
  codeSession: null,
};

const helpText = [
  '可用命令：',
  '/start - 查看启动信息',
  '/help - 查看帮助',
  '/status - 查看机器人状态',
  '/ask 你的问题 - 调用问答模式',
  '/codex 你的任务 - 单次调用本机 Codex CLI',
  '/approve - 批准当前 code 会话里的待执行命令',
  '/deny - 拒绝当前 code 会话里的待执行命令',
  '/mode code - 进入持续 code 模式',
  '/mode ask - 退出持续 code 模式并回到 ask',
  '/mode status - 查看当前模式与 code 会话状态',
  '/mode exit - 关闭持续 code 会话',
  '',
  '模式说明：',
  '1. 默认是 ask 模式，普通文本直接走问答。',
  '2. 进入 code 模式后，普通文本会发送到同一个 Codex CLI 持续会话。',
  '3. code 模式下，未识别的 /xxx 也会原样发给 Codex。',
  '',
  '安全说明：',
  '1. 只接受白名单 chat_id。',
  '2. 不开放任意 shell。',
  '3. 只有 /codex 或 code 模式才会真正调用本机 Codex。',
].join('\n');

async function main() {
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
      if (result.text) {
        await sendLongMessage(chatId, result.text);
      }
      if (result.artifacts.length) {
        await sendMessage(chatId, `检测到 ${result.artifacts.length} 个产物文件，开始回传。`);
        for (const artifact of result.artifacts) {
          await sendArtifact(chatId, artifact);
        }
      }
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
      await ensureCodeSession();
      state.mode = 'code';
      await sendMessage(
        chatId,
        [
          '已进入 code 模式。',
          '后续普通文本会发给同一个 Codex 持续会话。',
          `工作目录：${config.codexWorkdir}`,
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
  const session = state.codeSession;
  if (!session || !session.ready) {
    await sendMessage(chatId, '当前没有可操作的持续 code 会话。');
    return;
  }

  if (!session.awaitingApproval) {
    await sendMessage(chatId, '当前没有待审批命令。');
    return;
  }

  if (command === '/approve') {
    session.awaitingApproval = false;
    session.lastApprovalPrompt = '';
    if (session.pending) {
      session.pending.awaitingApproval = false;
    }
    session.pty.write('\r');
    await sendMessage(chatId, '已批准当前命令，Codex 继续执行中。');
    return;
  }

  session.awaitingApproval = false;
  session.lastApprovalPrompt = '';
  if (session.pending) {
    session.pending.awaitingApproval = false;
  }
  session.pty.write('\u0003');
  await sendMessage(chatId, '已拒绝当前命令，并中断本次执行。');
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
    `Ask 模型：${config.askModel}`,
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

  lines.push(`持续 code 会话：${session.ready ? '已连接' : '启动中'}`);
  lines.push(`会话启动时间：${session.startedAt}`);
  lines.push(`最近输出时间：${session.lastOutputAt || '暂无'}`);

  if (session.pending) {
    lines.push(`会话执行中：是（开始于 ${session.pending.startedAt}）`);
  } else {
    lines.push('会话执行中：否');
  }

  lines.push(`待审批命令：${session.awaitingApproval ? '是' : '否'}`);

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

  const text = extractResponseText(data).trim();
  if (!text) {
    throw new Error('ask 模式没有返回可读文本。');
  }
  return text;
}

async function ensureCodeSession() {
  if (state.codeSession?.readyPromise) {
    return await state.codeSession.readyPromise;
  }

  if (!config.codexEnabled) {
    throw new Error('当前未启用本机 Codex CLI。');
  }

  const args = [];
  if (config.codexBypassApprovals) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  if (config.codexModel) {
    args.push('--model', config.codexModel);
  }
  if (!config.codexBypassApprovals && config.codexSandbox) {
    args.push('--sandbox', config.codexSandbox);
  }
  args.push('--cd', config.codexWorkdir);

  const session = {
    id: `${Date.now()}`,
    startedAt: new Date().toISOString(),
    workdir: config.codexWorkdir,
    ready: false,
    readyPromise: null,
    readyResolve: null,
    readyReject: null,
    readyTimer: null,
    closing: false,
    autoTrusted: false,
    autoApiKeySelected: false,
    awaitingApproval: false,
    rawBuffer: '',
    pending: null,
    lastOutputAt: '',
    lastReply: '',
    lastReplyAt: '',
    lastError: '',
    lastApprovalPrompt: '',
    pty: spawnPty(resolveCodexCommand(), args, {
      name: 'xterm-color',
      cols: 140,
      rows: 40,
      cwd: __dirname,
      env: process.env,
    }),
  };

  session.readyPromise = new Promise((resolve, reject) => {
    session.readyResolve = resolve;
    session.readyReject = reject;
  });

  session.readyTimer = setTimeout(() => {
    if (session.ready) {
      return;
    }
    session.lastError = '持续 code 会话启动超时';
    session.readyReject(new Error('持续 code 会话启动超时，请检查本机 Codex CLI 是否可在当前终端正常打开。'));
    if (state.codeSession === session) {
      void destroyCodeSession('ready-timeout');
    }
  }, 45_000);

  session.pty.onData((chunk) => {
    handleCodeSessionData(session, chunk);
  });

  session.pty.onExit(({ exitCode, signal }) => {
    handleCodeSessionExit(session, exitCode, signal);
  });

  state.codeSession = session;
  return await session.readyPromise;
}

function handleCodeSessionData(session, chunk) {
  session.lastOutputAt = new Date().toISOString();
  session.rawBuffer = appendLimitedText(session.rawBuffer, chunk, 250000);

  const plainFull = stripTerminalControl(session.rawBuffer);
  const plain = takeSessionStateText(plainFull);
  const compact = compactText(plain);

  if (session.pending) {
    session.pending.raw = appendLimitedText(session.pending.raw, chunk, 250000);
    if (session.pending.latestScreen !== plain) {
      session.pending.latestScreenChangedAt = Date.now();
    }
    session.pending.latestScreen = plain;
  }

  if (!session.autoTrusted && plain.includes('Do you trust the contents of this directory?')) {
    session.autoTrusted = true;
    session.pty.write('\r');
  }

  if (
    !session.autoApiKeySelected &&
    compact.includes('signinwithchatgpt') &&
    compact.includes('continueusingapikey')
  ) {
    session.autoApiKeySelected = true;
    session.pty.write('\u001b[B');
    session.pty.write('\r');
  }

  if (!session.ready && isCodeSessionReady(plain, compact)) {
    session.ready = true;
    clearTimeout(session.readyTimer);
    session.readyResolve(session);
  }

  const approvalState = parseApprovalState(plain, compact);
  session.awaitingApproval = approvalState.awaitingApproval;
  if (approvalState.summary) {
    session.lastApprovalPrompt = approvalState.summary;
  }

  if (session.pending) {
    session.pending.awaitingApproval = approvalState.awaitingApproval;
    if (approvalState.awaitingApproval) {
      clearTimeout(session.pending.idleTimer);
      session.pending.idleTimer = null;
      if (!session.pending.approvalNoticeSent) {
        session.pending.approvalNoticeSent = true;
        void sendMessage(
          config.allowedChatId,
          approvalState.summary
            ? `检测到命令审批。\n命令：${approvalState.summary}\n可发送 /approve 批准，或发送 /deny 拒绝。`
            : '检测到命令审批。\n可发送 /approve 批准，或发送 /deny 拒绝。',
        ).catch((error) => {
          console.error(`[code] 审批提示发送失败：${formatError(error)}`);
        });
      }
    } else {
      schedulePendingFinalize(session);
    }
  }
}

function handleCodeSessionExit(session, exitCode, signal) {
  clearTimeout(session.readyTimer);

  if (session.pending) {
    const pending = session.pending;
    session.pending = null;
    clearTimeout(pending.idleTimer);
    clearTimeout(pending.timeoutTimer);
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

function isCodeSessionReady(plain, compact = compactText(plain)) {
  const oldUiReady = plain.includes('OpenAI Codex') && /gpt-[\w.-]+.*·/.test(plain) && /›\s+/.test(plain);
  const newUiReady =
    compact.includes('youareusingopenaicodex') &&
    (
      compact.includes('togetstarted,describeatask') ||
      compact.includes('/status-showcurrentsessionconfigurationandtokenusage') ||
      compact.includes('ctrlttranscript')
    );

  return oldUiReady || newUiReady;
}

function schedulePendingFinalize(session) {
  if (!session.pending) {
    return;
  }

  const pending = session.pending;
  const extractedReply = extractCodeReplyText(pending.raw, pending.prompt);
  const progressReply = isLikelyProgressReply(extractedReply);
  clearTimeout(pending.idleTimer);
  pending.idleTimer = null;

  if (isSessionActivelyWorking(pending.latestScreen)) {
    appendCodeDebugLog(pending, 'schedule-wait-working', {
      extractedReply,
      latestScreen: pending.latestScreen,
    });
    pending.idleTimer = setTimeout(() => {
      finalizePendingResponse(session);
    }, 2500);
    return;
  }

  if (extractedReply) {
    if (pending.lastExtractedReply !== extractedReply) {
      pending.lastExtractedReplyChangedAt = Date.now();
    }
    pending.lastExtractedReply = extractedReply;

    if (progressReply) {
      if (!pending.progressDetectedAt) {
        pending.progressDetectedAt = new Date().toISOString();
      }
      appendCodeDebugLog(pending, 'schedule-wait-progress', {
        extractedReply,
        latestScreen: pending.latestScreen,
      });
      pending.idleTimer = setTimeout(() => {
        finalizePendingResponse(session);
      }, 2500);
      return;
    }

    pending.progressDetectedAt = '';
    appendCodeDebugLog(pending, 'schedule-finalize', {
      extractedReply,
      latestScreen: pending.latestScreen,
    });
    pending.idleTimer = setTimeout(() => {
      finalizePendingResponse(session);
    }, 7000);
    return;
  }

  appendCodeDebugLog(pending, 'schedule-no-reply-yet', {
    latestScreen: pending.latestScreen,
  });
  pending.idleTimer = setTimeout(() => {
    finalizePendingResponse(session);
  }, 4000);
}

function finalizePendingResponse(session) {
  const pending = session.pending;
  if (!pending) {
    return;
  }

  clearTimeout(pending.idleTimer);
  pending.idleTimer = null;

  const reply = extractCodeReplyText(pending.raw, pending.prompt);
  const canFinalize = canFinalizePendingResponse(pending, reply);

  if (isSessionActivelyWorking(pending.latestScreen) && !canFinalize) {
    appendCodeDebugLog(pending, 'finalize-still-working', {
      latestScreen: pending.latestScreen,
    });
    pending.idleTimer = setTimeout(() => {
      finalizePendingResponse(session);
    }, 2500);
    return;
  }
  if (isLikelyProgressReply(reply)) {
    appendCodeDebugLog(pending, 'finalize-progress-reply', {
      extractedReply: reply,
      latestScreen: pending.latestScreen,
    });
    pending.idleTimer = setTimeout(() => {
      finalizePendingResponse(session);
    }, 2500);
    return;
  }

  if (!canFinalize) {
    appendCodeDebugLog(pending, 'finalize-not-stable', {
      extractedReply: reply,
      latestScreen: pending.latestScreen,
      latestScreenChangedAt: pending.latestScreenChangedAt,
      lastExtractedReplyChangedAt: pending.lastExtractedReplyChangedAt,
    });
    pending.idleTimer = setTimeout(() => {
      finalizePendingResponse(session);
    }, 2500);
    return;
  }

  clearTimeout(pending.timeoutTimer);
  session.pending = null;
  const normalizedReply = reply || 'Codex 已收到这条消息，但暂时没有抓到可读回复。可发送 /mode status 查看会话状态。';
  appendCodeDebugLog(pending, 'finalize-resolve', {
    reply: normalizedReply,
    latestScreen: pending.latestScreen,
  });

  if (normalizedReply) {
    session.lastReply = normalizedReply;
    session.lastReplyAt = new Date().toISOString();
  }
  pending.resolve(normalizedReply);
}

async function destroyCodeSession(reason = '') {
  const session = state.codeSession;
  if (!session) {
    return;
  }

  state.codeSession = null;
  session.closing = true;
  clearTimeout(session.readyTimer);

  if (session.pending) {
    const pending = session.pending;
    session.pending = null;
    clearTimeout(pending.idleTimer);
    clearTimeout(pending.timeoutTimer);
    pending.reject(new Error(`持续 code 会话已关闭${reason ? `：${reason}` : ''}`));
  }

  try {
    session.pty.kill();
  } catch (error) {
    console.warn(`[code] 关闭会话失败：${formatError(error)}`);
  }
}

async function sendToCodeSession(_chatId, prompt) {
  const session = await ensureCodeSession();

  if (session.pending) {
    throw new Error('当前持续 code 会话仍在执行上一条消息，请稍后再试。');
  }

  return await new Promise((resolve, reject) => {
    session.pending = {
      prompt,
      raw: '',
      latestScreen: '',
      latestScreenChangedAt: Date.now(),
      startedAt: new Date().toISOString(),
      awaitingApproval: false,
      approvalNoticeSent: false,
      lastExtractedReply: '',
      lastExtractedReplyChangedAt: 0,
      progressDetectedAt: '',
      debugLogPath: path.join(runtimeDir, `code-debug-${Date.now()}.log`),
      idleTimer: null,
      timeoutTimer: setTimeout(() => {
        if (!session.pending) {
          return;
        }
        const fallback = extractCodeReplyText(session.pending.raw, session.pending.prompt);
        const message = fallback && !isLikelyProgressReply(fallback)
          ? fallback
          : '持续 code 会话执行超时，未抓到完整回复。可发送 /mode status 查看当前状态。';
        session.lastReply = message;
        session.lastReplyAt = new Date().toISOString();
        const timedOutPending = session.pending;
        session.pending = null;
        clearTimeout(timedOutPending.idleTimer);
        timedOutPending.resolve(message);
      }, 15 * 60 * 1000),
      resolve,
      reject,
    };
    appendCodeDebugLog(session.pending, 'pending-created', {
      prompt,
    });

    const normalizedPrompt = buildCodeSessionPrompt(prompt);
    session.pty.write(normalizedPrompt);
    session.pty.write('\r');
  });
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

async function sendMessage(chatId, text) {
  const data = await invokeTelegramJson('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
  if (!data.ok) {
    throw new Error(`Telegram sendMessage 失败：${JSON.stringify(data)}`);
  }
}

async function sendLongMessage(chatId, text) {
  const chunks = splitText(text, 3500);
  for (const chunk of chunks) {
    await sendMessage(chatId, chunk);
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
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$argsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedArgs}')) | ConvertFrom-Json`,
    `& 'codex.cmd' @argsJson`,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
