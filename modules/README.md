# 服务边界

```text
浏览器 / Chrome 扩展
          │
          ▼
modules/app  (Bun, 127.0.0.1:4173)
   ├─ OpenCode ACP：会话、模型、工具调用与权限交互
   ├─ workspace/：文件、技能安装及会话数据
   ├─ Browser MCP：受控网页操作
   ├─ HTTP + 内部令牌 ──► modules/rag (FastAPI, 默认 127.0.0.1:4174)
   └─ URL / iframe ─────► modules/fastsite (FastAPI，独立部署)
```

Agent 平台是唯一面向会话用户的服务。RAG 与 Fastsite 独立启动、独立安装 Python 依赖；两者不读取 OpenCode 会话状态。平台调用 RAG 前须完成用户身份、租户与权限校验。当前 RAG API 已可独立索引和检索文档，平台到 RAG 的调用尚未接入；Fastsite 保留已有插件服务和部署方式。

## 本地命令

在仓库根目录：

- `bun install` 安装 Agent 平台依赖。
- `bun modules/app/server/server.ts` 启动 Agent 平台，默认端口 4173。
- `bun run typecheck` 与 `bun test` 验证 Agent 平台。
- RAG：进入 `modules/rag`，按其 README 建立独立虚拟环境并运行 Uvicorn。
- Fastsite：进入 `modules/fastsite`，按其 README 安装及部署。

`workspace/` 留在根目录，是 Agent 平台运行数据；不属于任何 Python 服务源码。部署时可分别扩缩容三个进程，生产环境需为 RAG 配置内部令牌并通过私有网络访问。
