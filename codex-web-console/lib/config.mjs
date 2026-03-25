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
} from './utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const consoleDir = path.dirname(__dirname);
const rootDir = path.dirname(consoleDir);

loadEnvFile(path.join(rootDir, '.env'));
loadEnvFile(path.join(consoleDir, '.env'), { override: true });

const runtimeDir = path.join(rootDir, 'runtime');
const webStatePath = path.join(runtimeDir, 'web-sessions.json');
const lastMessageDir = path.join(runtimeDir, 'web-last-message');
const publicDir = path.join(consoleDir, 'public');

fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(lastMessageDir, { recursive: true });

const generatedToken = `local-${crypto.randomBytes(8).toString('hex')}`;

export const config = {
  rootDir,
  consoleDir,
  publicDir,
  runtimeDir,
  webStatePath,
  lastMessageDir,
  host: process.env.WEB_CODEX_HOST || '127.0.0.1',
  port: toNumber(process.env.WEB_CODEX_PORT, 4631),
  accessToken: process.env.WEB_CODEX_TOKEN || generatedToken,
  generatedAccessToken: !(process.env.WEB_CODEX_TOKEN || ''),
  requestTimeoutMs: toNumber(process.env.WEB_CODEX_TIMEOUT_MS, 15 * 60 * 1000),
  webWorkdir: path.resolve(process.env.WEB_CODEX_WORKDIR || rootDir),
  codexWorkdir: path.resolve(process.env.CODEX_WORKDIR || rootDir),
  codexCliPath: process.env.CODEX_CLI_PATH || '',
  codexModel: process.env.CODEX_MODEL || '',
  codexSandbox: normalizeCodexSandbox(process.env.CODEX_SANDBOX || ''),
  codexBypassApprovals: toBoolean(process.env.CODEX_BYPASS_APPROVALS, false),
  codexSessionRoot: path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex', 'sessions'),
};

config.codexCommand = resolveCodexCommand(config.codexCliPath);
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
