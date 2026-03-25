# Codex Web Resume Console

这是一个和现有 `codex-web-console` 完全隔离的稳定版实验项目。

目标不是继续围绕 `app-server thread` 打补丁，而是改用 `codex exec / exec resume --json` 做真正可恢复的 Web 会话。

## 当前范围

当前版本先覆盖最小可用链路：

1. 新建本地 Web 会话
2. 列出本地会话和原生 Codex 历史
3. 对已有 `codexThreadId` 使用 `exec resume`
4. 通过 SSE 推送状态、回复、产物
5. 展示和下载产物文件
6. 支持 iOS 设备注册 APNs，并在任务完成或失败时发送通知

## 和旧版的关系

1. 不替换现有 `codex-web-console`
2. 运行时状态单独存到 `runtime/web-resume-console/`
3. 默认端口单独使用 `4632`
4. 当前前端入口使用新目录自己的 `public/app.js` 和 `public/index.html`
5. 样式、图标等未改动资源暂时回退复用现有 `codex-web-console/public`

## 启动

```powershell
node codex-web-resume-console/server.mjs
```

或：

```powershell
npm run start:web:resume
```

## 环境变量

```text
WEB_RESUME_HOST=127.0.0.1
WEB_RESUME_PORT=4632
WEB_RESUME_TOKEN=自定义访问令牌
WEB_RESUME_TIMEOUT_MS=900000
WEB_RESUME_WORKDIR=工作目录
PUSH_SERVICE_ENABLED=true
PUSH_DEFAULT_ENABLED=true
PUSH_NOTIFY_ON_COMPLETED=true
PUSH_NOTIFY_ON_ERROR=true
APNS_TEAM_ID=苹果开发者团队ID
APNS_KEY_ID=APNs Key ID
APNS_BUNDLE_ID=iOS应用Bundle ID
APNS_PRIVATE_KEY_PATH=AuthKey_xxx.p8 文件路径
APNS_USE_SANDBOX=true
```

## 推送目录

推送逻辑已独立放在 `lib/push/`：

1. `push-store.mjs`：保存已注册 iOS 设备
2. `apns-client.mjs`：负责签名并调用 APNs
3. `push-service.mjs`：对外提供注册、测试和任务完成通知

设备状态会单独写入：

```text
runtime/web-resume-console/push/devices.json
```

## 推送接口

当前后端新增了这些接口：

1. `GET /api/push/status`
2. `GET /api/push/devices`
3. `POST /api/push/register`
4. `POST /api/push/unregister`
5. `POST /api/push/test`

`/api/push/register` 请求体示例：

```json
{
  "deviceId": "iphone-15-pro",
  "deviceToken": "APNS_DEVICE_TOKEN",
  "deviceName": "我的iPhone",
  "bundleId": "com.example.codex",
  "appVersion": "1.0.0",
  "tailscaleIdentity": "iphone.tailnet-name.ts.net",
  "pushEnabled": true,
  "notifyOnCompleted": true,
  "notifyOnError": true
}
```
