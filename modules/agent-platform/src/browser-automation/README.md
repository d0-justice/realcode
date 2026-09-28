# 浏览器自动化架构

浏览器自动化按“状态识别、状态事件、操作”分为三层：

1. Chrome 扩展通过 CDP 读取当前控制面的可见文本、控件状态和动态操作空间。
2. 扩展在 WebSocket 上发送命令阶段事件与最新页面状态，服务端记录时序并缓存最后状态。
3. Agent 使用 `browser_observe` 获取带指纹的操作空间，使用 `browser_act` 按 `actionId + fingerprint` 执行操作。操作完成后会直接返回新的页面状态。

常规循环不使用截图，也不依赖长期有效的 CSS selector。截图只保留为用户明确要求的视觉诊断工具。

## 数据流

```text
Agent / MCP
  browser_observe | browser_act
             │ HTTP（单次工具调用）
             ▼
BrowserBridge
             │ WebSocket（长连接事件流）
             ▼
Chrome 扩展命令队列
             │ CDP
             ▼
页面特征观察 → 操作前校验 → 原生输入 → 有界稳定等待 → 操作后观察
```

WebSocket 上的业务消息包括：

- `command_event`：`accepted`、`executing`、`completed`、`failed`。
- `page_state`：带单调递增序号的最新结构化页面状态。
- `result`：完成对应请求，包含扩展端开始时间、结束时间和耗时。

扩展严格串行执行命令，防止超时重试与旧命令同时操作页面。服务端命令仍有独立超时边界；扩展发生 CDP 超时后会释放调试连接，让下次操作重新建立干净会话。
