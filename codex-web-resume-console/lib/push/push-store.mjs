import fs from 'node:fs';
import path from 'node:path';
import {
  createId,
  nowIso,
  toBoolean,
} from '../../../codex-web-console/lib/utils.mjs';

export class PushStore {
  constructor(statePath) {
    this.statePath = statePath;
    this.devices = new Map();
    this.load();
  }

  load() {
    if (!fs.existsSync(this.statePath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.statePath, 'utf8');
      const data = JSON.parse(raw);
      const devices = Array.isArray(data?.devices) ? data.devices : [];
      for (const device of devices) {
        const normalized = normalizeDevice(device);
        this.devices.set(normalized.id, normalized);
      }
    } catch {
      this.devices.clear();
    }
  }

  persist() {
    const dirPath = path.dirname(this.statePath);
    fs.mkdirSync(dirPath, { recursive: true });
    const devices = this.getAll();
    fs.writeFileSync(this.statePath, JSON.stringify({ devices }, null, 2), 'utf8');
  }

  getAll() {
    return Array.from(this.devices.values())
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  getEnabledDevices() {
    return this.getAll().filter((device) => device.pushEnabled && !device.invalidatedAt);
  }

  getPublicDevices() {
    return this.getAll().map((device) => toPublicDevice(device));
  }

  findDevice(criteria = {}) {
    const normalizedDeviceId = String(criteria.deviceId || '').trim();
    const normalizedToken = normalizeDeviceToken(criteria.deviceToken);
    const normalizedId = String(criteria.id || '').trim();
    if (!normalizedDeviceId && !normalizedToken && !normalizedId) {
      return null;
    }

    for (const device of this.devices.values()) {
      if (normalizedId && device.id === normalizedId) {
        return device;
      }
      if (normalizedDeviceId && device.deviceId === normalizedDeviceId) {
        return device;
      }
      if (normalizedToken && device.deviceToken === normalizedToken) {
        return device;
      }
    }

    return null;
  }

  registerDevice(input = {}) {
    const normalizedToken = normalizeDeviceToken(input.deviceToken);
    if (!normalizedToken) {
      throw new Error('deviceToken 不能为空');
    }

    const normalizedDeviceId = String(input.deviceId || '').trim() || `ios-${normalizedToken.slice(0, 16)}`;
    const existing = this.findDevice({
      id: input.id,
      deviceId: normalizedDeviceId,
      deviceToken: normalizedToken,
    });
    const now = nowIso();
    const device = existing || normalizeDevice({
      id: createId('push'),
      platform: 'ios',
      createdAt: now,
    });

    device.platform = 'ios';
    device.deviceId = normalizedDeviceId;
    device.deviceToken = normalizedToken;
    device.deviceName = String(input.deviceName || device.deviceName || 'iPhone').trim() || 'iPhone';
    device.bundleId = String(input.bundleId || device.bundleId || '').trim();
    device.appVersion = String(input.appVersion || device.appVersion || '').trim();
    device.tailscaleIdentity = String(input.tailscaleIdentity || device.tailscaleIdentity || '').trim();
    device.pushEnabled = toBoolean(input.pushEnabled, device.pushEnabled);
    device.notifyOnCompleted = toBoolean(input.notifyOnCompleted, device.notifyOnCompleted);
    device.notifyOnError = toBoolean(input.notifyOnError, device.notifyOnError);
    device.environment = normalizeEnvironment(input.environment || device.environment);
    device.invalidatedAt = '';
    device.lastSeenAt = now;
    device.updatedAt = now;

    this.devices.set(device.id, device);
    this.persist();
    return device;
  }

  unregisterDevice(criteria = {}) {
    const device = this.findDevice(criteria);
    if (!device) {
      return false;
    }

    const removed = this.devices.delete(device.id);
    if (removed) {
      this.persist();
    }
    return removed;
  }

  markSendSuccess(criteria = {}) {
    const device = this.findDevice(criteria);
    if (!device) {
      return null;
    }

    device.lastSuccessAt = nowIso();
    device.lastError = '';
    device.lastErrorAt = '';
    device.updatedAt = device.lastSuccessAt;
    this.persist();
    return device;
  }

  markSendFailure(criteria = {}, errorText, options = {}) {
    const device = this.findDevice(criteria);
    if (!device) {
      return null;
    }

    const now = nowIso();
    device.lastError = String(errorText || '').trim();
    device.lastErrorAt = now;
    device.updatedAt = now;

    if (options.invalidate) {
      device.invalidatedAt = now;
      device.pushEnabled = false;
    }

    this.persist();
    return device;
  }
}

export function normalizeDeviceToken(value) {
  return String(value || '')
    .trim()
    .replace(/[<>\s-]+/g, '')
    .toLowerCase();
}

function normalizeDevice(raw) {
  const now = nowIso();
  return {
    id: String(raw?.id || createId('push')),
    platform: 'ios',
    deviceId: String(raw?.deviceId || '').trim(),
    deviceToken: normalizeDeviceToken(raw?.deviceToken),
    deviceName: String(raw?.deviceName || 'iPhone').trim() || 'iPhone',
    bundleId: String(raw?.bundleId || '').trim(),
    appVersion: String(raw?.appVersion || '').trim(),
    tailscaleIdentity: String(raw?.tailscaleIdentity || '').trim(),
    pushEnabled: toBoolean(raw?.pushEnabled, true),
    notifyOnCompleted: toBoolean(raw?.notifyOnCompleted, true),
    notifyOnError: toBoolean(raw?.notifyOnError, true),
    environment: normalizeEnvironment(raw?.environment),
    createdAt: String(raw?.createdAt || now),
    updatedAt: String(raw?.updatedAt || raw?.createdAt || now),
    lastSeenAt: String(raw?.lastSeenAt || raw?.updatedAt || raw?.createdAt || now),
    lastSuccessAt: String(raw?.lastSuccessAt || '').trim(),
    lastError: String(raw?.lastError || '').trim(),
    lastErrorAt: String(raw?.lastErrorAt || '').trim(),
    invalidatedAt: String(raw?.invalidatedAt || '').trim(),
  };
}

function toPublicDevice(device) {
  return {
    id: device.id,
    platform: device.platform,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    bundleId: device.bundleId,
    appVersion: device.appVersion,
    tailscaleIdentity: device.tailscaleIdentity,
    pushEnabled: device.pushEnabled,
    notifyOnCompleted: device.notifyOnCompleted,
    notifyOnError: device.notifyOnError,
    environment: device.environment,
    tokenMasked: maskDeviceToken(device.deviceToken),
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    lastSeenAt: device.lastSeenAt,
    lastSuccessAt: device.lastSuccessAt,
    lastError: device.lastError,
    lastErrorAt: device.lastErrorAt,
    invalidatedAt: device.invalidatedAt,
  };
}

function normalizeEnvironment(value) {
  return String(value || '').trim().toLowerCase() === 'production'
    ? 'production'
    : 'sandbox';
}

function maskDeviceToken(token) {
  const normalized = normalizeDeviceToken(token);
  if (!normalized) {
    return '';
  }
  if (normalized.length <= 12) {
    return normalized;
  }
  return `${normalized.slice(0, 6)}...${normalized.slice(-6)}`;
}
