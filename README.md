# RealCode

一个独立的 OpenCode ACP 会话实验台。

## 启动

需要 Bun 1.3+。项目依赖固定 `opencode-ai@1.18.31`。

```bash
cd realcode
bun install
bun run start
```

打开 `http://127.0.0.1:4173`。页面会自动连接 OpenCode，并载入最近会话；没有历史会话时自动新建。左侧可切换、重命名和删除会话，底部可发送消息、切换模型、模式与当前模型支持的推理强度，并附加文件或图片。回复支持 Markdown、思考折叠、工具详情和安全 iframe 预览；`workspace/user/` 下的 HTML 可通过 `<iframe src="user/文件名.html"></iframe>` 预览。顶部“资源与事件”可展开右侧面板：文件管理可浏览 `workspace/` 文件树、预览、上传、新建、重命名、删除、下载或引用文件到聊天；面板还展示会话上下文和原始 ACP 事件。服务端只监听本机回环地址。选择 Big Pickle 时图片按钮会禁用，因为该模型不接受图片输入。

### Chrome 浏览器控制

RealCode 内置 Browser MCP Server，并通过 `realcode-browser-extension/` 中的 Chrome 扩展控制用户明确选择的标签页及其中可访问的 iframe。无需安装本地助手程序。

1. 在 `chrome://extensions` 开启开发者模式，加载 `realcode/realcode-browser-extension/`。
2. 安装时接受 Chrome 显示的网页访问权限；安装完成后无需再次授权。
3. 扩展会自动识别当前 RealCode 标签页，并从同源接口取得配对令牌。
4. 新建或重新载入会话后，OpenCode 可以调用页面读取、点击、填写、选择、滚动、截图、导航以及自动打开或切换标签页等 Browser MCP 工具。

配对令牌由扩展自动获取，只用于扩展 WebSocket；RealCode 为 MCP 子进程使用独立的进程内密钥。服务端命令只能操作扩展识别或用户明确选择的 RealCode 标签页，密码框内容不会进入页面快照。

默认模型与本机 Codex 当前配置一致，为 `openai/gpt-5.6-sol`。首次启动会在 `workspace/.opencode/opencode.json` 写入该模型，不会覆盖已有工作区配置；可通过 `MYOPENCODE_DEFAULT_MODEL` 指定其他默认模型。OpenCode 必须单独登录 OpenAI：在本目录运行 `bunx opencode auth login -p openai -m "ChatGPT Pro/Plus (browser)"` 并完成浏览器授权，或使用 OpenCode 支持的 API Key 方式。Codex 的 `auth.json` 登录令牌不会被复制进本项目。

### Python 环境

在 `realcode/` 目录运行 `py -3.12 -m venv workspace/.venv`，即可为工作区创建独立 Python 环境。启动 OpenCode 时，服务会将该环境的 `Scripts`（Windows）或 `bin` 目录放在 OpenCode 进程的 `PATH` 首位，并设置 `VIRTUAL_ENV`；聊天中的 `python`、`pip` 命令默认使用它。无需手动激活虚拟环境。安装依赖可运行 `workspace/.venv/Scripts/python.exe -m pip install 包名`（Windows）；环境位于忽略提交的 `workspace/` 下。创建或替换环境后重启 RealCode 服务，使 OpenCode 进程读取新的环境变量。


可选环境变量：

| 变量 | 用途 |
| --- | --- |
| `MYOPENCODE_PORT` | 页面端口，默认 `4173` |
| `MYOPENCODE_DEFAULT_MODEL` | 无 `launch.json` 且工作区未配置时使用的模型，默认 `openai/gpt-5.6-sol` |
| `MYOPENCODE_WORKSPACE` | OpenCode 工作区，默认本项目的 `workspace/` |
| `OPENCODE_BIN` | 自定义 OpenCode 可执行文件；默认使用本项目安装的 1.18.31 |
| `MYOPENCODE_USE_GLOBAL_CONFIG` | 设为 `1` 时加载用户全局 OpenCode 插件及配置；默认隔离全局配置，仍可使用用户数据目录中的认证信息 |
| `MYOPENCODE_LAUNCH_CONFIG` | 指定平台风格的启动配置 JSON，默认 `launch.json` |
