# CodexRemote iOS 客户端

这是一个独立目录的 `SwiftUI + XcodeGen` iOS 客户端，用来连接电脑上的 `codex-web-resume-console` 服务。

## 目录说明

1. `project.yml`
   使用 XcodeGen 生成 iOS 工程。
2. `CodexRemote/`
   SwiftUI 源码、资源和推送 entitlement。

## 本地生成工程

```bash
brew install xcodegen
cd ios-app
xcodegen generate
```

生成后用 Xcode 打开：

```text
ios-app/CodexRemote.xcodeproj
```

## 当前能力

1. 配置服务器地址和访问令牌
2. 拉取会话列表
3. 查看单个会话详情
4. 发送消息和停止任务
5. 支持图片和文件附件发送，自动按后端协议转成 `dataBase64`
6. 消息里展示附件，图片和文本可在应用内预览，其他类型走系统外部打开
7. 前台通过 SSE 接收实时更新，并在断线后自动重连
8. 查看消息、事件、产物三个页签
9. 申请通知权限并把 APNs `deviceToken` 注册到后端
10. 点击通知后跳转到对应 `sessionId`

## GitHub 打包 IPA

工作流文件在：

[`build-ios-ipa.yml`](/H:/project_public/my-codex/telegram-codex-bot/.github/workflows/build-ios-ipa.yml)

当前 workflow 已改成：

1. 不需要证书
2. 不需要描述文件
3. 直接编译 `iphoneos` 产物
4. 手工封装成 `unsigned IPA`
5. 构建失败时自动生成静态 HTML 错误报告并推到 `gh-pages`

适合：

1. 越狱设备
2. 已安装 `AppSync Unified` 一类工具的设备
3. 你自己后续再本地重签名的场景

公开错误报告链接格式：

```text
https://bltbbb.github.io/codexapp/reports/<run_id>/
```

如果你要改 App 名称或 Bundle ID，请同步改：

1. `ios-app/project.yml`
2. `.github/workflows/build-ios-ipa.yml` 里的 `IOS_PROJECT_NAME` / `IOS_APP_NAME`

## 重要限制

这条 unsigned IPA 流程解决的是“打包和安装”，不是“苹果官方签名”。

需要明确：

1. 无证书打包不等于有合法推送 entitlement
2. APNs 在 unsigned / 非正规签名安装场景下通常不稳定，甚至可能不可用
3. 如果你后面发现本地通知没问题、远程推送不稳定，这通常不是客户端代码逻辑问题，而是签名和 entitlement 问题
4. 当前 workflow 会一并上传 `xcodebuild.log`，便于定位无签名编译失败原因
