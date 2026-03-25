# Web Codex Console

这是面向手机使用的最小版 Web 管理端，独立于 Telegram 机器人运行。

当前版本已覆盖：

1. 查看最近 Codex 会话和本地 Web 会话
2. 新建会话
3. 导入历史 `thread` 并继续续聊
4. 通过 SSE 实时查看状态、异常和最终回复
5. 展示图片、文本、文档等产物
6. 停止当前任务

## 启动

在仓库根目录执行：

```powershell
node codex-web-console/server.mjs
```

或：

```powershell
npm run start:web
```

## 关键环境变量

```text
WEB_CODEX_HOST=127.0.0.1
WEB_CODEX_PORT=4631
WEB_CODEX_TOKEN=自定义访问令牌
WEB_CODEX_TIMEOUT_MS=900000
```

如果没有设置 `WEB_CODEX_TOKEN`，服务启动时会在控制台打印一个临时令牌。

## 安全边界

1. 默认只监听 `127.0.0.1`
2. 所有 `/api/*` 接口都要求访问令牌
3. 不提供任意 shell 接口
4. 文件下载只允许已登记的产物，且路径必须位于 `runtime/` 或 `CODEX_WORKDIR` 下
