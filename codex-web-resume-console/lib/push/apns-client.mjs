import fs from 'node:fs';
import https from 'node:https';
import crypto from 'node:crypto';
import { formatError } from '../../../codex-web-console/lib/utils.mjs';
import { normalizeDeviceToken } from './push-store.mjs';

const APNS_PRODUCTION_HOST = 'api.push.apple.com';
const APNS_SANDBOX_HOST = 'api.sandbox.push.apple.com';

export class ApnsClient {
  constructor(config) {
    this.config = config;
    this.cachedProviderToken = '';
    this.cachedProviderTokenExpiresAt = 0;
    this.cachedPrivateKey = '';
  }

  isConfigured() {
    return Boolean(
      this.config.pushServiceEnabled
      && this.config.apnsTeamId
      && this.config.apnsKeyId
      && this.config.apnsBundleId
      && this.config.apnsPrivateKeyPath
      && fs.existsSync(this.config.apnsPrivateKeyPath),
    );
  }

  getStatus() {
    return {
      serviceEnabled: this.config.pushServiceEnabled,
      configured: this.isConfigured(),
      environment: this.config.apnsUseSandbox ? 'sandbox' : 'production',
      bundleId: this.config.apnsBundleId,
      keyPathExists: Boolean(this.config.apnsPrivateKeyPath && fs.existsSync(this.config.apnsPrivateKeyPath)),
    };
  }

  async sendAlert(input = {}) {
    if (!this.isConfigured()) {
      return {
        ok: false,
        statusCode: 0,
        reason: 'APNS_NOT_CONFIGURED',
      };
    }

    const deviceToken = normalizeDeviceToken(input.deviceToken);
    if (!deviceToken) {
      return {
        ok: false,
        statusCode: 0,
        reason: 'DEVICE_TOKEN_EMPTY',
      };
    }

    const body = JSON.stringify(buildApnsPayload(input));
    const providerToken = this.getProviderToken();
    const hostname = this.config.apnsUseSandbox ? APNS_SANDBOX_HOST : APNS_PRODUCTION_HOST;

    return new Promise((resolve, reject) => {
      const request = https.request({
        hostname,
        port: 443,
        path: `/3/device/${deviceToken}`,
        method: 'POST',
        headers: {
          authorization: `bearer ${providerToken}`,
          'apns-topic': String(input.bundleId || this.config.apnsBundleId || '').trim(),
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        timeout: 15000,
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => {
          chunks.push(chunk);
        });
        response.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8').trim();
          const payload = parseJson(responseBody);
          const statusCode = Number(response.statusCode || 0);
          resolve({
            ok: statusCode >= 200 && statusCode < 300,
            statusCode,
            apnsId: String(response.headers['apns-id'] || '').trim(),
            reason: String(payload?.reason || '').trim(),
            timestamp: String(payload?.timestamp || '').trim(),
            body: responseBody,
          });
        });
      });

      request.on('timeout', () => {
        request.destroy(new Error('APNs 请求超时'));
      });

      request.on('error', (error) => {
        reject(new Error(`APNs 请求失败：${formatError(error)}`));
      });

      request.write(body);
      request.end();
    });
  }

  getProviderToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedProviderToken && now < this.cachedProviderTokenExpiresAt) {
      return this.cachedProviderToken;
    }

    const header = base64UrlEncodeJson({
      alg: 'ES256',
      kid: this.config.apnsKeyId,
    });
    const claims = base64UrlEncodeJson({
      iss: this.config.apnsTeamId,
      iat: now,
    });
    const unsignedToken = `${header}.${claims}`;
    const signature = crypto.sign('sha256', Buffer.from(unsignedToken), {
      key: this.getPrivateKey(),
      dsaEncoding: 'ieee-p1363',
    });

    this.cachedProviderToken = `${unsignedToken}.${toBase64Url(signature)}`;
    this.cachedProviderTokenExpiresAt = now + (50 * 60);
    return this.cachedProviderToken;
  }

  getPrivateKey() {
    if (this.cachedPrivateKey) {
      return this.cachedPrivateKey;
    }

    this.cachedPrivateKey = fs.readFileSync(this.config.apnsPrivateKeyPath, 'utf8');
    return this.cachedPrivateKey;
  }
}

export function isApnsInvalidTokenReason(reason) {
  return new Set([
    'BadDeviceToken',
    'DeviceTokenNotForTopic',
    'Unregistered',
  ]).has(String(reason || '').trim());
}

function buildApnsPayload(input) {
  const payload = {
    aps: {
      sound: input.sound === '' ? undefined : (input.sound || 'default'),
      alert: {
        title: String(input.title || '').trim(),
        subtitle: String(input.subtitle || '').trim() || undefined,
        body: String(input.body || '').trim(),
      },
      'thread-id': String(input.threadId || '').trim() || undefined,
    },
    sessionId: String(input.sessionId || '').trim(),
    runId: String(input.runId || '').trim(),
    status: String(input.status || '').trim(),
    source: 'codex-web-resume-console',
  };

  return cleanupPayload(payload);
}

function cleanupPayload(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanupPayload(item)).filter((item) => item !== undefined);
  }

  if (!value || typeof value !== 'object') {
    return value === undefined ? undefined : value;
  }

  const next = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = cleanupPayload(item);
    if (normalized === undefined || normalized === '') {
      continue;
    }
    next[key] = normalized;
  }
  return next;
}

function base64UrlEncodeJson(value) {
  return toBase64Url(Buffer.from(JSON.stringify(value), 'utf8'));
}

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function parseJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
