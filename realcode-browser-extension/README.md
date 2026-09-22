# RealCode Browser Bridge

一个无需本地助手进程的 Chrome Manifest V3 扩展。它通过 WebSocket 接收 RealCode 的受控浏览器命令，并在用户明确选择的标签页中执行操作。

## 当前能力

- 选择并记住当前标签页
- 首次连接时自动识别与 WebSocket 地址同源的 RealCode 标签页
- 默认自动连接，失败或断线后每 10 秒重试；用户主动断开后停止重试
- 安装时统一申请网页及跨域 iframe 权限
- 读取顶层页面和可访问 iframe 的文本、表单与交互元素
- 点击元素、填写输入框、选择下拉项、滚动页面
- 自动打开新标签页，或按地址、标题切换到已打开的标签页
- 导航和当前可视区域截图
- 通过配对令牌连接 RealCode WebSocket
- 工具方法白名单、危险协议拦截、密码值脱敏

## 本地安装

1. 打开 `chrome://extensions`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录 `realcode-browser-extension`。
5. 打开需要控制的页面，点击扩展图标。
6. 接受安装权限后，扩展会自动识别 RealCode 标签页并完成配对。

“连接 RealCode”使用 RealCode 已提供的 WebSocket 端点。扩展会在识别到的 RealCode 页面中调用同源配对接口，无需用户填写令牌。未启动 RealCode 时，本地“测试读取”仍可使用已选择的标签页。

## WebSocket 协议

默认地址：`ws://127.0.0.1:4173/browser-extension`

扩展连接后发送：

```json
{
  "type": "hello",
  "protocol": "realcode-browser-bridge/2",
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
  "method": "browser.snapshot",
  "args": {}
}
```

扩展返回结果：

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
| `browser.snapshot` | `frameId?`, `maxElements?`, `maxTextLength?` | 读取页面和 iframe |
| `browser.click` | `selector`, `frameId?` | 点击元素 |
| `browser.fill` | `selector`, `value`, `frameId?` | 填写文本框 |
| `browser.select` | `selector`, `value`, `frameId?` | 选择下拉项 |
| `browser.scroll` | `x?`, `y?`, `frameId?` | 滚动页面 |
| `browser.screenshot` | 无 | 截取当前可视区域 |
| `browser.navigate` | `url` | 导航至 HTTP(S) 地址 |
| `browser.openTab` | `url` | 打开新标签页并将控制目标切换过去 |
| `browser.switchTab` | `urlContains?`, `titleContains?` | 自动切换到匹配的已打开标签页 |
| `browser.wait` | `milliseconds` | 最多等待 30 秒 |

`browser.snapshot` 返回的元素包含 `selector` 和所在 `frameId`。后续点击或填写时应同时传回这两个值。

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
realcode-browser-extension/
├── manifest.json
├── README.md
└── src/
    ├── background/
    │   ├── browser-tools.js
    │   ├── service-worker.js
    │   └── storage.js
    ├── popup/
    │   ├── popup.css
    │   ├── popup.html
    │   └── popup.js
    └── shared/
        └── protocol.js
```
