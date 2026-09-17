# FenixAgent 会话页面功能移植清单

来源以 `web/components/ACPMain.tsx`、`web/components/ChatInterface.tsx`、`web/components/chat/`、`web/components/ai-elements/message.tsx` 的当前实现为准。RealCode 是独立项目，功能需要接到本项目的 OpenCode ACP 服务；单独复制 JSX 无法工作。

| 功能 | FenixAgent 来源 | RealCode 状态 |
| --- | --- | --- |
| 侧栏、会话列表、新建/切换/恢复 | `ACPMain.tsx`, `ChatHeader.tsx` | 已移植；自动进入最近会话与历史消息经过浏览器验证 |
| 会话重命名、删除、时间分组 | `ACPMain.tsx`, `session-grouping.ts` | 已移植；删除使用 OpenCode CLI 兜底，重命名存于本项目元数据 |
| 用户/助手消息、流式更新、刷新后恢复 | `ChatView.tsx`, `MessageBubble.tsx` | 已移植并经过浏览器验证 |
| 长用户消息折叠、图片缩略图与放大 | `MessageBubble.tsx` | 已移植；图片流尚未实测 |
| 系统上下文块独立展示 | `SystemMessage.tsx`, `strip-html-tags.ts` | 已移植切分与折叠展示 |
| 新消息跟随与返回底部按钮 | `ai-elements/conversation.tsx` | 已移植 |
| Markdown、代码高亮、引用链接 | `ai-elements/message.tsx`, `CitationLink.tsx` | Markdown、代码高亮与普通链接已移植；引用预览未移植 |
| iframe 安全渲染、展开和尺寸切换 | `ai-elements/message.tsx`, `escaped-iframe.ts` | 已移植独立/内嵌 iframe 与 `user/` 工作区页面；真实模型独立 iframe、展开和本地文件路由已验证 |
| 思考过程折叠与流式状态 | `MessageBubble.tsx`, `ai-elements/reasoning.tsx` | 已移植并经过浏览器验证 |
| 工具调用分组、状态、输入输出、文件预览 | `ToolCallGroup.tsx`, `ToolCallRow.tsx`, `narrators/` | 已移植分组、常见工具叙述与详情；真实 Read 调用、文件预览 API 已验证，全部专用叙述器未逐个复刻 |
| 右侧文件管理 | `ArtifactsPanel.tsx`, `FileTreeTab.tsx`, `PreviewTab.tsx` | 已接入本地工作区文件树、预览、上传、新建、重命名、删除、下载及引用到聊天；Files 之外的平台 Sites/Tasks/Views 仍依赖 FenixAgent 服务 |
| 权限请求与反馈 | `PermissionPanel.tsx` | 基础已移植，未触发真实权限请求验收 |
| 提问面板 | `QuestionPanel.tsx` | ACP elicitation 表单已移植；当前 OpenCode 未提供 question 工具，无法端到端触发 |
| 模式和模型选择、token 使用量 | `ChatComposer.tsx`, `ContextPanel.tsx` | 已移植；模式切换和 token 使用量已验收 |
| 命令菜单、停止生成 | `CommandMenu.tsx`, `ChatComposer.tsx` | 已移植；命令菜单经过浏览器验收，停止待实测 |
| 文件选择、图片附件、拖拽/粘贴图片 | `FilePickerPanel.tsx`, `ChatComposer.tsx`, `useDragUpload.ts` | 本机上传/预览 API 与图片选择经过验证；Big Pickle 实测拒绝图片，已禁用该模型的图片按钮；其他模型及拖拽/粘贴待实测 |
| 待办列表、子 Agent、任务活动 | `TodoPanel.tsx`, `SubAgentPanel.tsx`, `PeriTaskList.tsx` | ACP 计划与 TodoWrite 待办已移植；子 Agent 工具可显示嵌套输出；平台 Peri Task 未移植 |
| 上下文统计、模型、token、工具与更改文件 | `ContextPanel.tsx` | 已移植到“事件详情”侧栏并经过浏览器验收 |
| 会话错误、加载状态、断线恢复 | `ChatInterface.tsx`, `ChatView.tsx` | 已移植；进程意外退出后的重连待验收 |
| 知识库引用预览、Hindsight 卡片 | `CitationLink.tsx`, `HindsightToolCard.tsx` | Hindsight 工具卡样式已移植，需连接 Hindsight MCP 才有数据；知识库引用预览依赖 FenixAgent 知识库服务，独立项目目前无数据源 |
| 只读嵌入模式、平台 Peri Task 面板 | `ACPMain.tsx`, `PeriTaskList.tsx` | 依赖 FenixAgent 页面嵌入与平台任务投影；当前用 ACP 计划显示 OpenCode 可提供的任务数据 |

验证标准：每项需要经过 OpenCode ACP 实际会话、浏览器渲染、刷新或切换会话后的恢复测试。FenixAgent 的平台专属功能（例如 Peri Task）没有对应的 OpenCode ACP 数据源；独立项目可展示 ACP 计划，但不能把它等同于 FenixAgent 的平台任务。
