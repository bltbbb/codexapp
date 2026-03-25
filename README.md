# Telegram 控制本机 Codex

这是一个独立于前端业务代码的本机桥接脚本，用于把 Telegram Bot 消息转发到本机能力：

- 普通文本消息：走 `ask` 问答模式
- `/codex`：显式调用本机 `codex exec`
- 任务产物回传：Codex 生成图片或文件后，机器人自动发回 Telegram

## 目录说明

- `index.mjs`：Telegram 主脚本，使用长轮询，不需要公网入站端口
- `google-codex.ps1`：可供 Codex 调用的浏览器截图辅助脚本
- `json-api-request.ps1`：ask 模式的 HTTP 请求脚本
- `.env.example`：环境变量模板

## 使用步骤

1. 在 Telegram 里通过 `@BotFather` 创建机器人，拿到 `TG_BOT_TOKEN`
2. 给机器人发一条消息
3. 用浏览器访问下面地址，拿到你的 `chat_id`

```text
https://api.telegram.org/bot<你的TG_BOT_TOKEN>/getUpdates
```

4. 复制 `.env.example` 为同目录下的 `.env`
5. 填写 `.env` 中的 `TG_BOT_TOKEN`、`TG_ALLOWED_CHAT_ID`
6. 填写 ask 模式需要的 `OPENAI_API_KEY`、`OPENAI_BASE_URL`
7. 如果你的 Telegram 或 ask 访问依赖代理，再填写 `TG_PROXY_URL`、`OPENAI_PROXY_URL`
8. 启动脚本

```powershell
node scripts/telegram-codex-bot/index.mjs
```

如果你当前启动终端里没有 `HTTPS_PROXY/HTTP_PROXY`，推荐直接在 `.env` 中配置：

```text
TG_PROXY_URL=http://127.0.0.1:7890
```

如果你走本地代理，建议同时开启短轮询：

```text
TG_USE_SHORT_POLL=true
```

这样 Telegram 不会长时间挂住一个代理连接，稳定性通常更好。

普通文本消息默认走 ask 模式，因此还需要：

```text
OPENAI_API_KEY=你的密钥
OPENAI_BASE_URL=你的接口根地址
OPENAI_MODEL=gpt-5.4
```

## Web 管理端

仓库里新增了独立目录 [codex-web-console](h:/project_public/my-codex/telegram-codex-bot/codex-web-console/README.md#L1)，用于手机端管理 Codex 会话。

启动方式：

```powershell
npm run start:web
```

默认监听 `127.0.0.1:4631`，建议配合 `WEB_CODEX_TOKEN` 使用，再通过局域网或 Tailscale 访问。

## 推荐配置

默认配置：

- `ENABLE_CODEX=true`
- `CODEX_SANDBOX=`，表示继承本机 `~/.codex/config.toml`

如果你想覆盖本机默认沙箱，可以改成：

```text
CODEX_SANDBOX=read-only
```

或：

```text
CODEX_SANDBOX=workspace-write
```

建议你优先继承本机配置，只在远程场景下明确覆盖。

## 可用命令

### `/start`

查看机器人是否在线。

### `/help`

查看全部命令和安全说明。

### `/status`

查看当前任务、上一次任务结果、Codex 工作目录。

### 直接发送普通文本

示例：

```text
总结一下当前目录是做什么的
```

```text
回复一句：机器人现在工作正常
```

收到后，机器人会走 ask 模式，不调用本机 Codex。

### `/ask`

示例：

```text
/ask 用一句话介绍当前项目
```

它和直接发送普通文本等价，只是显式指定走 ask。

### `/codex`

示例：

```text
/codex 使用浏览器打开 Google，搜索 codex，然后截图发给我
```

只有这类命令才会真正调用本机 Codex。

## 重要限制

### 1. 是否能完成桌面/浏览器任务，取决于 Codex 当前环境能力

当前桥接层只负责把任务转给本机 Codex。真正能不能完成“打开浏览器、截图、保存文件”，取决于：

- 本机 `Codex CLI` 当前可用的工具能力
- 本机网络能否访问目标站点
- Windows 当前桌面会话是否可交互
- 任务是否允许使用本地 shell

### 2. 浏览器截图辅助脚本是可选工具

仓库里保留了 [google-codex.ps1](h:/project_public/my-codex/telegram-codex-bot/google-codex.ps1#L1)，Codex 在需要时可以调用它完成“打开 URL + 截整屏”。

如果你后面要做更稳定的浏览器自动化，建议升级为 `Playwright` 版本。

### 3. Google 在当前网络环境下可能不可达

这种情况下，Codex 任务本身就会失败，或者需要你改成其他站点。

## 安全建议

- 机器人只绑定你自己的 `chat_id`
- 不要把 Bot 拉进群
- 优先继承你本机已经验证过的 Codex 配置
- 优先使用白名单命令，而不是开放通用执行入口
- 让机器人运行在专用 Windows 账号下更稳妥

## 后续可扩展方向

- 接入 `Playwright`，把浏览器自动化从“整屏截图”升级为“页面级操作”
- 增加任务队列和执行日志
- 给高风险命令加二次确认，例如 `/approve <任务ID>`
