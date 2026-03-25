import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  stripQuotes,
  toBoolean,
  toNumber,
  normalizeCodexSandbox,
  findCommandInPath,
} from '../../codex-web-console/lib/utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const consoleDir = path.dirname(__dirname);
const rootDir = path.dirname(consoleDir);

loadEnvFile(path.join(rootDir, '.env'));
loadEnvFile(path.join(consoleDir, '.env'), { override: true });

const runtimeDir = path.join(rootDir, 'runtime', 'web-resume-console');
const statePath = path.join(runtimeDir, 'sessions.json');
const lastMessageDir = path.join(runtimeDir, 'last-message');
const pushRuntimeDir = path.join(runtimeDir, 'push');
const publicDir = path.join(consoleDir, 'public');
const fallbackPublicDir = path.join(rootDir, 'codex-web-console', 'public');
const codexHome = path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex');

fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(lastMessageDir, { recursive: true });
fs.mkdirSync(pushRuntimeDir, { recursive: true });

const generatedToken = `resume-${crypto.randomBytes(8).toString('hex')}`;

export const config = {
  rootDir,
  consoleDir,
  publicDir,
  fallbackPublicDir,
  runtimeDir,
  statePath,
  lastMessageDir,
  pushRuntimeDir,
  pushDeviceStatePath: path.join(pushRuntimeDir, 'devices.json'),
  codexHome,
  host: process.env.WEB_RESUME_HOST || '0.0.0.0',
  port: toNumber(process.env.WEB_RESUME_PORT, 4632),
  accessToken: process.env.WEB_RESUME_TOKEN || generatedToken,
  generatedAccessToken: !(process.env.WEB_RESUME_TOKEN || ''),
  requestTimeoutMs: toNumber(process.env.WEB_RESUME_TIMEOUT_MS, 15 * 60 * 1000),
  webWorkdir: path.resolve(process.env.WEB_RESUME_WORKDIR || process.env.CODEX_WORKDIR || rootDir),
  codexWorkdir: path.resolve(process.env.CODEX_WORKDIR || rootDir),
  codexCliPath: process.env.CODEX_CLI_PATH || '',
  codexModel: process.env.CODEX_MODEL || '',
  codexSandbox: normalizeCodexSandbox(process.env.CODEX_SANDBOX || ''),
  codexBypassApprovals: toBoolean(process.env.CODEX_BYPASS_APPROVALS, false),
  codexSessionRoot: path.join(codexHome, 'sessions'),
  sessionIndexPath: path.join(codexHome, 'session_index.jsonl'),
  stateDbPath: path.join(codexHome, 'state_5.sqlite'),
  desktopThreadApprovalMode: 'never',
  desktopThreadModelProvider: process.env.CODEX_MODEL_PROVIDER || 'packycode',
  pushServiceEnabled: toBoolean(process.env.PUSH_SERVICE_ENABLED, true),
  pushDefaultEnabled: toBoolean(process.env.PUSH_DEFAULT_ENABLED, true),
  pushDefaultNotifyOnCompleted: toBoolean(process.env.PUSH_NOTIFY_ON_COMPLETED, true),
  pushDefaultNotifyOnError: toBoolean(process.env.PUSH_NOTIFY_ON_ERROR, true),
  apnsTeamId: String(process.env.APNS_TEAM_ID || '').trim(),
  apnsKeyId: String(process.env.APNS_KEY_ID || '').trim(),
  apnsBundleId: String(process.env.APNS_BUNDLE_ID || '').trim(),
  apnsPrivateKeyPath: resolveOptionalPath(process.env.APNS_PRIVATE_KEY_PATH || '', rootDir),
  apnsUseSandbox: toBoolean(process.env.APNS_USE_SANDBOX, true),
};

config.codexCommand = resolveCodexCommand(config.codexCliPath);
config.sqliteCommand = resolveSqliteCommand(process.env.SQLITE3_PATH || '');
config.desktopThreadCliVersion = process.env.CODEX_CLI_VERSION || readCodexCliVersion(config.codexHome);
config.desktopThreadSandboxPolicy = JSON.stringify({
  type: config.codexBypassApprovals
    ? 'danger-full-access'
    : (config.codexSandbox || 'workspace-write'),
});
config.allowedArtifactRoots = [
  config.runtimeDir,
  config.codexWorkdir,
];

function loadEnvFile(filePath, options = {}) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const index = line.indexOf('=');
    if (index <= 0) {
      continue;
    }

    const key = line.slice(0, index).trim();
    const value = stripQuotes(line.slice(index + 1).trim());
    if (options.override || !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function resolveCodexCommand(configuredPath) {
  if (configuredPath) {
    return path.resolve(configuredPath);
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

function resolveSqliteCommand(configuredPath) {
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  const candidates = process.platform === 'win32'
    ? ['sqlite3.exe', 'sqlite3']
    : ['sqlite3'];
  return findCommandInPath(candidates) || (process.platform === 'win32' ? 'sqlite3.exe' : 'sqlite3');
}

function readCodexCliVersion(codexHomePath) {
  const filePath = path.join(codexHomePath, 'version.json');
  if (!fs.existsSync(filePath)) {
    return '';
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return String(parsed?.cli_version || parsed?.version || '').trim();
  } catch {
    return '';
  }
}

function resolveOptionalPath(value, baseDir) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }

  return path.resolve(baseDir, normalized);
}
