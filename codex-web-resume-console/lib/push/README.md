# Push Modules

这个目录专门存放 iOS 推送相关逻辑，避免和会话、SSE、产物管理耦合。

1. `push-store.mjs`
   负责设备注册信息的本地持久化。
2. `apns-client.mjs`
   负责生成 APNs JWT，并请求苹果推送网关。
3. `push-service.mjs`
   负责把后端事件转换成可发送的推送通知。
