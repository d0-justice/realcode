# RealCode RAG

独立的 Python + FastAPI 检索服务。当前提供按租户隔离的文档写入、删除和 SQLite FTS5 关键词检索；Agent 平台负责用户身份与权限判断，再向本服务传递 tenant_id。当前版本没有向量检索、重排或答案生成，API 中的 score 是 FTS5 BM25 分数。

## 本地启动

需要 Python 3.11+。在本目录中运行：

```powershell
py -3.12 -m venv .venv
.venv/Scripts/python.exe -m pip install -e .
$env:REALCODE_RAG_TOKEN = "replace-with-a-local-secret"
.venv/Scripts/python.exe -m uvicorn realcode_rag.app:app --host 127.0.0.1 --port 4174
```

默认数据库位于本模块的 `data/rag.db`；可用 `REALCODE_RAG_DB` 指定其他路径。必须设置 `REALCODE_RAG_TOKEN`，否则写入和检索接口返回 503；除 `/healthz` 外的接口须带 `X-RealCode-Internal-Token`。当前 Agent 平台尚未自动调用该服务，接入时必须先在平台完成会话用户的授权校验。

## API

- `PUT /v1/collections/{collection_id}/documents`：JSON 包含 `tenant_id`、`document_id`、`content`。
- `POST /v1/collections/{collection_id}/search`：JSON 包含 `tenant_id`、`query`、可选 `limit`。
- `DELETE /v1/collections/{collection_id}/documents/{document_id}?tenant_id=...`。
- `GET /healthz`。

运行测试：`.venv/Scripts/python.exe -m unittest discover -s tests`。
