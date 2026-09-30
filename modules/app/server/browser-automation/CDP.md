# 受控浏览器（Chrome CDP）

RealCode 的受控模式启动独立 Chrome profile，使用 Chrome DevTools Protocol（CDP）连接本机调试端口。它不依赖 Stagehand、Playwright 或需要用户安装的扩展。

## 数据流

```text
OpenCode → realcode-browser MCP → BrowserAutomationService → CdpController
                                                    ↓
                                  Chrome CDP WebSocket → 会话页/浮窗 iframe
                                                    ↓
                                         页面守卫与站点 hook
```

- `cdp-client.ts` 负责单个 WebSocket 上的 CDP 命令、事件和跨进程 iframe session。
- `cdp-controller.ts` 负责浏览器生命周期、浮窗优先控制、站点工具、观察和真实输入。
- `page-guards.js` 在文档创建时注入，返回短文本、动作列表和文档指纹，并在动作前校验节点身份、可见性和遮挡。
- `site-hooks/bilibili-site-hook.js` 是 RealCode 编写的 Bilibili 站点适配器，不代表站点官方 WebMCP。

默认观察不生成 accessibility 快照。需要诊断结构时传 `includeStructure: true`。页面或 iframe 无法提供可操作文档时，返回 `new-tab-fallback` 和原始地址。

受控 Chrome 使用 `workspace/.realcode/cdp/profile` 保存登录状态。普通模式继续使用用户自己的 Chrome，不连接 CDP。服务停止或切换模式时，向受控实例发送 `Browser.close`。


|  |  |
|---|---|
| 工具定义 | 为每个明确的用户任务定义名称、用途说明、输入 JSON Schema 和执行函数，例如“搜索视频”。 |
| 状态识别 | 识别首页、结果页、视频页、验证码页等状态；只提供当前可用的工具。 |
| 状态事件 | 页面导航、结果加载、登录状态变化时，更新可用工具并通知调用方；WebMCP 提供 `toolchange` 机制。 |
| 操作与结果 | 执行操作后返回简短、结构化的结果，例如视频标题和 ID；区分“已发起跳转”和“已到达目标页”。 |
| 生命周期 | 页面或组件离开时撤销工具，处理中断时取消操作，避免调用过期页面上的工具。 |
| 权限与安全 | 限制工具可见的来源；对购买、删除等重要操作保留用户确认；把页面内容视为不可信输入。 |
| 验证 | 分别测试正常结果、页面尚未加载、导航中、验证码、DOM 改版和 iframe 场景。 |
