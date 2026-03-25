import {
  formatError,
  truncateText,
} from '../../../codex-web-console/lib/utils.mjs';
import { ApnsClient, isApnsInvalidTokenReason } from './apns-client.mjs';
import { PushStore } from './push-store.mjs';

export class PushService {
  constructor(config) {
    this.config = config;
    this.store = new PushStore(config.pushDeviceStatePath);
    this.apnsClient = new ApnsClient(config);
  }

  getStatus() {
    const devices = this.store.getAll();
    const enabledDevices = devices.filter((device) => device.pushEnabled && !device.invalidatedAt);
    return {
      ...this.apnsClient.getStatus(),
      registrationDefaultEnabled: this.config.pushDefaultEnabled,
      defaultNotifyOnCompleted: this.config.pushDefaultNotifyOnCompleted,
      defaultNotifyOnError: this.config.pushDefaultNotifyOnError,
      deviceCount: devices.length,
      enabledDeviceCount: enabledDevices.length,
    };
  }

  listDevices() {
    return this.store.getPublicDevices();
  }

  registerDevice(input = {}) {
    const bundleId = String(input.bundleId || this.config.apnsBundleId || '').trim();
    if (!bundleId) {
      throw new Error('bundleId 不能为空');
    }

    if (this.config.apnsBundleId && bundleId !== this.config.apnsBundleId) {
      throw new Error('bundleId 与服务端配置不一致');
    }

    const device = this.store.registerDevice({
      deviceId: input.deviceId,
      deviceToken: input.deviceToken,
      deviceName: input.deviceName,
      bundleId,
      appVersion: input.appVersion,
      tailscaleIdentity: input.tailscaleIdentity,
      environment: input.environment || (this.config.apnsUseSandbox ? 'sandbox' : 'production'),
      pushEnabled: input.pushEnabled ?? this.config.pushDefaultEnabled,
      notifyOnCompleted: input.notifyOnCompleted ?? this.config.pushDefaultNotifyOnCompleted,
      notifyOnError: input.notifyOnError ?? this.config.pushDefaultNotifyOnError,
    });

    return this.store.getPublicDevices().find((item) => item.id === device.id) || null;
  }

  unregisterDevice(input = {}) {
    return this.store.unregisterDevice({
      id: input.id,
      deviceId: input.deviceId,
      deviceToken: input.deviceToken,
    });
  }

  async sendTestNotification(input = {}) {
    const device = this.store.findDevice({
      id: input.id,
      deviceId: input.deviceId,
      deviceToken: input.deviceToken,
    });
    if (!device) {
      throw new Error('设备不存在');
    }

    return this.sendToDevice(device, {
      title: String(input.title || '测试通知').trim() || '测试通知',
      subtitle: String(input.subtitle || 'Codex Resume Console').trim() || 'Codex Resume Console',
      body: String(input.body || '这是一条测试通知').trim() || '这是一条测试通知',
      sessionId: String(input.sessionId || '').trim(),
      runId: String(input.runId || '').trim(),
      status: 'test',
      threadId: String(input.threadId || '').trim(),
    });
  }

  async notifyRunFinished(input = {}) {
    const status = String(input.status || '').trim();
    if (!this.config.pushServiceEnabled) {
      return {
        attempted: false,
        reason: 'SERVICE_DISABLED',
      };
    }

    if (!['completed', 'error'].includes(status)) {
      return {
        attempted: false,
        reason: 'STATUS_SKIPPED',
      };
    }

    if (!this.apnsClient.isConfigured()) {
      return {
        attempted: false,
        reason: 'APNS_NOT_CONFIGURED',
      };
    }

    const devices = this.store.getEnabledDevices().filter((device) => {
      if (status === 'completed') {
        return device.notifyOnCompleted;
      }
      return device.notifyOnError;
    });

    if (!devices.length) {
      return {
        attempted: false,
        reason: 'NO_ENABLED_DEVICE',
      };
    }

    const notification = buildRunNotification(input);
    const results = [];

    for (const device of devices) {
      const result = await this.sendToDevice(device, notification);
      results.push({
        deviceId: device.deviceId,
        ok: result.ok,
        reason: result.reason,
        statusCode: result.statusCode,
      });
    }

    return {
      attempted: true,
      sent: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      results,
    };
  }

  async sendToDevice(device, notification) {
    try {
      const result = await this.apnsClient.sendAlert({
        deviceToken: device.deviceToken,
        bundleId: device.bundleId || this.config.apnsBundleId,
        title: notification.title,
        subtitle: notification.subtitle,
        body: notification.body,
        sessionId: notification.sessionId,
        runId: notification.runId,
        status: notification.status,
        threadId: notification.threadId,
      });

      if (result.ok) {
        this.store.markSendSuccess({ id: device.id });
        return result;
      }

      this.store.markSendFailure(
        { id: device.id },
        result.reason || `APNs 返回 ${result.statusCode}`,
        { invalidate: isApnsInvalidTokenReason(result.reason) },
      );
      return result;
    } catch (error) {
      this.store.markSendFailure({ id: device.id }, formatError(error));
      return {
        ok: false,
        statusCode: 0,
        reason: formatError(error),
      };
    }
  }
}

function buildRunNotification(input) {
  const session = input.session || {};
  const status = String(input.status || '').trim();
  const sessionTitle = truncateText(String(session.title || '会话').trim() || '会话', 48);

  if (status === 'error') {
    const errorText = buildSummaryText(input.errorText || session.lastError || '执行失败');
    return {
      title: '任务失败',
      subtitle: sessionTitle,
      body: errorText || '任务执行失败，请回到应用查看详情。',
      sessionId: String(session.id || '').trim(),
      runId: String(input.runId || '').trim(),
      status,
      threadId: String(session.id || '').trim(),
    };
  }

  const replySummary = buildSummaryText(input.reply || session.lastReply || session.preview || '');
  return {
    title: '任务已完成',
    subtitle: sessionTitle,
    body: replySummary || '任务执行完成，点按查看最新回复。',
    sessionId: String(session.id || '').trim(),
    runId: String(input.runId || '').trim(),
    status,
    threadId: String(session.id || '').trim(),
  };
}

function buildSummaryText(text) {
  const normalized = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  return truncateText(normalized, 120);
}
