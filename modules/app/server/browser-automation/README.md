# 浏览器控制

受控模式由 `CdpController` 启动独立 Chrome，并通过本机 CDP WebSocket 控制会话页和展开预览 iframe。`BrowserAutomationService` 为 Agent 的 Browser MCP 工具串行派发命令，记录开始、完成、失败事件，并缓存最近一次页面状态。

页面控制分两种来源：

1. 站点通过 `document.modelContext.registerTool` 提供原生 WebMCP 工具。驱动监听 Chrome 的 `WebMCP.toolsAdded` 等事件，并使用 `WebMCP.invokeTool` 调用工具。
2. RealCode 为已适配的站点注入 hook。目前 `site-hooks/bilibili-site-hook.js` 根据首页、搜索结果页、视频页、加载中和验证码状态动态注册 `realcode.bilibili.*` WebMCP 工具。浏览器通过 `toolchange` 反映注册变化，CDP 控制器转发增减事件。工具结果标记为 `third-party-hook`，与站点工具区分。

Bilibili hook 提供搜索、列出视频、打开已列出的结果、读取视频信息，以及 `playVideo` 和 `pauseVideo` 两个播放器工具。`realcode.bilibili.searchAndPlay` 是跨页面任务工具：搜索、等待结果页、打开第一条视频、等待视频页、确认播放器已开始播放，然后返回视频信息；任一步失败均返回错误，不把 `navigation_started` 当作任务完成。单步导航操作仍分别返回 `navigation_started`，到达目标页后读取返回 `arrived`。页面导航、结果加载及登录状态变化会通过 `browser_site_state` 事件上报。离开页面或状态失效时撤销工具，执行中的导航可由 WebMCP 取消信号中断。工具仅向 RealCode 会话来源暴露；页面标题等站点数据按不可信内容处理。

Agent 侧 Browser MCP 的 `tools/list` 直接列出当前页面的 WebMCP 工具，沿用原始名称，例如 `realcode.bilibili.searchVideos`；只有当前页面没有站点工具时才列出通用浏览器工具。页面工具变化时，服务端发送 `notifications/tools/list_changed`，OpenCode 会重新读取列表。Agent 调用该工具时，MCP 服务校验它仍在当前页面，再转发到 `WebMCP.invokeTool`。不再向 Agent 暴露 `browser_site` 中转工具。

没有适配器的页面仍可使用 `browser_observe` 和 `browser_act`。观察结果包含短文本、可用操作、文档指纹；操作前会校验当前文档和目标节点，并通过 CDP 原生输入执行。默认不生成截图。页面无法嵌入时，观察结果会提供新标签页回退地址。

展开预览 iframe 声明 `allow="tools"`，以允许跨域页面注册 WebMCP 工具。站点自己的 Permissions Policy 仍可限制工具注册。

具体实现和运行环境见 [CDP.md](CDP.md)。
