# RealCode Browser Bridge

一个无需本地助手进程的 Chrome Manifest V3 扩展。它通过 WebSocket 接收 RealCode 的受控浏览器命令，并在用户明确选择的标签页中执行操作。

## 当前能力

- 选择并记住当前标签页
- 首次连接时自动识别与 WebSocket 地址同源的 RealCode 标签页
- 默认自动连接，失败或断线后每 10 秒重试；用户主动断开后停止重试
- 安装时统一申请网页及跨域 iframe 权限
- 原子读取顶层页面和可访问 iframe 的可见文本、控件状态与动态操作空间
- 通过稳定节点身份、页面指纹和操作前校验执行点击、填写、选择与滚动
- 操作后进行有界稳定等待并直接返回新页面状态
- 命令严格串行，持续推送命令阶段和结构化页面状态
- 自动打开新标签页，或按地址、标题切换到已打开的标签页
- 导航和当前可视区域截图
- 会话页中直接嵌入的视频默认暂停；用户在嵌入页内操作后可自行播放
- 通过配对令牌连接 RealCode WebSocket
- 工具方法白名单、危险协议拦截、密码值脱敏

## 本地安装

1. 打开 `chrome://extensions`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录 `modules/agent-platform/browser-extension`。
5. 打开需要控制的页面，点击扩展图标。
6. 接受安装权限后，扩展会自动识别 RealCode 标签页并完成配对。

更新本目录的扩展代码后，在 `chrome://extensions` 点击该扩展的“重新加载”，再刷新 RealCode 会话页，使新的视频暂停脚本生效。

“连接 RealCode”使用 RealCode 已提供的 WebSocket 端点。扩展会在识别到的 RealCode 页面中调用同源配对接口，无需用户填写令牌。未启动 RealCode 时，本地“测试读取”仍可使用已选择的标签页。

## WebSocket 协议

默认地址：`ws://127.0.0.1:4173/browser-extension`

扩展连接后发送：

```json
{
  "type": "hello",
  "protocol": "realcode-browser-bridge/3",
  "clientId": "持久化的随机客户端 ID",
  "token": "扩展从 RealCode 同源接口自动取得的配对令牌",
  "extensionVersion": "0.5.0"
}
```

服务端发送命令：

```json
{
  "type": "command",
  "id": "cmd_01",
  "method": "browser.observe",
  "args": {}
}
```

扩展在执行过程中发送 `command_event` 和 `page_state`，并最终返回结果：

```json
{
  "type": "result",
  "id": "cmd_01",
  "ok": true,
  "result": {}
}
```

失败结果包含 `{ "code": "COMMAND_FAILED", "message": "..." }`。

## 工具方法

| 方法 | 主要参数 | 说明 |
| --- | --- | --- |
| `browser.observe` | `frameId?`, `maxActions?`, `maxTextLength?` | 读取页面特征和动态操作空间，不截屏 |
| `browser.act` | `actionId`, `fingerprint`, `frameId?`, `text?` | 校验并执行操作，返回操作后的页面状态 |
| `browser.screenshot` | 无 | 仅用于明确的视觉诊断 |
| `browser.openTab` | `url` | 没有展开预览时打开观察结果提供的回退地址 |

`browser.observe` 返回带 `fingerprint` 的操作空间。后续操作必须把同一次观察中的 `actionId`、`fingerprint` 和 `frameId` 传给 `browser.act`。页面发生变化时旧指纹会失效，Agent 需要重新观察。

## 安全边界

- Chrome 在安装扩展时统一展示所有网站访问权限，用户接受安装后无需再次授权。
- 服务端命令只能操作用户在扩展中明确选择的标签页。
- 只接受协议白名单中的命令。
- 导航限制为 HTTP 和 HTTPS。
- 快照不返回密码框内容。
- 配对令牌不会输出到页面、日志或命令响应。
- 生产环境应使用 `wss://`、短期配对令牌、服务端用户绑定和命令审计。

## 目录

```text
modules/agent-platform/browser-extension/
├── manifest.json
├── README.md
└── src/
    ├── background/
    │   ├── service-worker.js
    │   └── storage.js
    ├── browser-automation/
    │   ├── action-executor.js
    │   ├── controller.js
    │   ├── link-navigation.js
    │   └── page-observer.js
    ├── popup/
    │   ├── popup.css
    │   ├── popup.html
    │   └── popup.js
    └── shared/
        └── protocol.js
```
