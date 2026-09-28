# Stagehand 实验接入

当前浮窗操作使用 Stagehand 原生跨 frame locator 执行 `fill` 和 `click`，不再手算 iframe 坐标。`browser_observe` 同时返回浮窗范围内的原生 accessibility 结构 `structure`；动作列表仍由页面守卫生成，以保留文档身份、节点身份和遮挡检查。嵌套 iframe 的原生快照和点击在 Stagehand 4.1.0 的独立实验中仍有失败记录，当前不将嵌套控件列为可操作动作。

## 使用

启动 RealCode 后默认为 **普通模式**，可正常对话，不派发浏览器操作。
会话右上角的组合控件显示当前模式和 **切换** 按钮，点击即可在普通模式与受控模式之间切换。
服务端会启动专用 Chrome 并打开 RealCode；请在这个新窗口中展开网页预览，再让 Agent 操作。
受控模式下点击 **切换** 可返回正常对话：先在普通 Chrome 打开 RealCode，收到页面就绪回执后再关闭专用 Chrome。
进入受控模式也会等待新页面就绪，然后关闭发起切换的原页面；切换期间禁止重复点击。
普通 Chrome 对手动打开且已有导航历史的标签页可能拒绝 `window.close()`；此时旧页面停止事件连接并显示“请手动关闭”，不再保留可操作的旧会话界面。
目标页面未在 30 秒内确认就绪时切换失败，不主动关闭原页面。重新启动受控模式仍需先释放专用 profile，再重新打开。
旧扩展模式的入口和配对说明不再显示。

本版用于本机体验：服务端与 Chrome 运行在同一电脑。没有提供服务器远程接管任意用户浏览器的能力。
不需要在专用 Chrome 中手动安装 RealCode 扩展，Stagehand 自动加载随 SDK 发布的运行时。

## 实现

```text
OpenCode Agent
  → 原有 browser_observe / browser_act MCP 工具
  → 带内部令牌的 HTTP 命令入口
  → BrowserAutomationService 选择驱动
  → Stagehand SDK 4.1.0 → Stagehand Runtime → 浮窗 iframe
```

- 由 RealCode 当前模型决策；受控文档直接返回文本与可操作元素，Stagehand 负责向该文档派发真实鼠标和键盘输入。不另行调用 Stagehand 的模型接口。
- 观察只扫描当前浮窗文档，排除会话父页面及未验证的二级嵌套框架；不再对整页生成 Stagehand 快照。
- 页面初始化脚本保留目标节点引用并检查可见性、身份和遮挡；实际输入由 Stagehand 的页面鼠标与键盘接口执行。
- 动作绑定观察批次和文档身份；关闭浮窗、导航、替换节点或更换控制模式后旧动作不能沿用。
- 通过 Stagehand 初始化脚本复用现有浮窗导航规则，使链接优先在浮窗内打开。
- 会话的外部 iframe 不授予自动播放权限；受控浏览器和已加载新版 RealCode 扩展的普通浏览器会在嵌入文档及其播放器子框架首次播放 HTML5 视频时暂停，用户在视频内交互后可正常播放。
- 没有浮窗时，只允许打开该会话最近嵌入页的 fallbackUrl；已有回退标签页可继续控制。
- 浮窗 iframe 被站点策略拒绝或未提供可操作文档时，观察返回其 fallbackUrl；Agent 可用 `browser_open_tab` 在受控 Chrome 顶层页继续操作。真实站点仍可能要求验证码，需按返回页面状态处理。
- 关闭专用 Chrome 前通过 CDP 发送 `Browser.close`，让 Chrome 正常写入 profile 的退出状态；失败时才走 SDK 清理。
- 命令阶段和耗时走现有日志/SSE，正文和输入不写入运行日志。日志 scope 为 `stagehand`。
- 动作最长 15 秒；超时停止专用浏览器，避免旧命令在后台继续操作。执行期间禁止切换驱动。
- `executed` 表示输入已发送，不等于业务完成；Agent 必须根据返回状态确认结果。
- 链接点击返回 `needsObservation=true`，因为 iframe 导航可能晚于输入事件；下一次观察确认新文档。

## 已验证

```powershell
bun run typecheck
bun test
bun experiments/stagehand-v4/integration.ts
bun experiments/stagehand-v4/sina-smoke.ts
```

集成用例经过真正的 MCP stdio → HTTP → 驱动 → Chrome 扩展 → 跨域 iframe。
验证了观察、填写/搜索结果、旧批次拒绝、遮挡目标拒绝、`_blank` 留在 iframe 内导航，以及拒绝嵌入后的顶层搜索。
本机集成用例观察约 45 ms，填写/点击约 215–250 ms；新浪嵌入页的独立样本观察约 0.6–1.3 秒（含首次加载等待），点击约 0.3 秒。页面加载与模型推理时间会另行增加。

实验限制：仅支持当前文档和单层浮窗中的填写、点击，不提供任意脚本执行、嵌套框架操作、完整滚动或选择器工具。
站点拒绝 iframe 嵌入时需要使用顶层标签页回退；当前集成不会修改站点的安全响应头。
原版 SDK 的验证与已知问题见 `experiments/stagehand-v4/README.md`。
