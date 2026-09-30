# Agent 平台

JavaScript / Bun 模块。负责会话与 ACP 连接、用户权限交互、工作区文件、Skill 安装、MCP 浏览器工具和会话页面。受控浏览器由内置 CDP 控制器管理。

从仓库根目录运行 `bun modules/app/server/server.ts`。默认工作区始终为仓库根目录的 `workspace/`；可用 `MYOPENCODE_WORKSPACE` 覆盖。根目录 `launch.example.json` 展示模型、Agent、MCP 与 Skill 的配置格式。

RAG 服务位于 `../rag/`，动态建站服务位于 `../fastsite/`。平台尚未自动索引会话文件或调用 RAG；后续接入须在平台校验用户权限后传递租户范围。
