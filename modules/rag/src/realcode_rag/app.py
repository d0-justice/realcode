"""Private document retrieval API. The Agent platform owns user authorization."""

from __future__ import annotations

import os
import secrets
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .store import DocumentStore


class DocumentInput(BaseModel):
    tenant_id: str = Field(min_length=1, max_length=128)
    document_id: str = Field(min_length=1, max_length=256)
    content: str = Field(min_length=1, max_length=1_000_000)


class SearchInput(BaseModel):
    tenant_id: str = Field(min_length=1, max_length=128)
    query: str = Field(min_length=1, max_length=1000)
    limit: int = Field(default=10, ge=1, le=50)


def create_app(db_path: Path | None = None, token: str | None = None) -> FastAPI:
    path = db_path or Path(os.getenv("REALCODE_RAG_DB", Path(__file__).parents[2] / "data" / "rag.db"))
    store = DocumentStore(path)
    expected_token = token if token is not None else os.getenv("REALCODE_RAG_TOKEN")
    api = FastAPI(title="RealCode RAG", version="0.1.0")

    def authorize(x_realcode_internal_token: str | None = Header(default=None)) -> None:
        if not expected_token:
            raise HTTPException(status_code=503, detail="internal token is not configured")
        if (
            x_realcode_internal_token is None
            or not secrets.compare_digest(x_realcode_internal_token, expected_token)
        ):
            raise HTTPException(status_code=401, detail="invalid internal token")

    @api.get("/healthz")
    def health() -> dict[str, str]:
        return {"status": "ok", "service": "rag", "retrieval": "keyword"}

    @api.put("/v1/collections/{collection_id}/documents", dependencies=[Depends(authorize)])
    def upsert(collection_id: str, item: DocumentInput) -> dict[str, str]:
        store.upsert(item.tenant_id, collection_id, item.document_id, item.content)
        return {"document_id": item.document_id, "status": "indexed"}

    @api.delete("/v1/collections/{collection_id}/documents/{document_id}", dependencies=[Depends(authorize)])
    def delete(collection_id: str, document_id: str, tenant_id: str) -> dict[str, bool]:
        return {"deleted": store.delete(tenant_id, collection_id, document_id)}

    @api.post("/v1/collections/{collection_id}/search", dependencies=[Depends(authorize)])
    def search(collection_id: str, item: SearchInput) -> dict[str, object]:
        return {"matches": store.search(item.tenant_id, collection_id, item.query, item.limit)}

    return api


app = create_app()
