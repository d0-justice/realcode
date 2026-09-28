"""Tenant-scoped SQLite full-text index used by the first RAG service slice."""

from __future__ import annotations

import re
from contextlib import closing
import sqlite3
from pathlib import Path


class DocumentStore:
    def __init__(self, path: Path) -> None:
        self.path = path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as db, db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS documents (
                    id INTEGER PRIMARY KEY,
                    tenant_id TEXT NOT NULL,
                    collection_id TEXT NOT NULL,
                    document_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    UNIQUE (tenant_id, collection_id, document_id)
                )
            """)
            db.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
                    content, content='documents', content_rowid='id'
                )
            """)
            db.executescript("""
                CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
                    INSERT INTO search_index(rowid, content) VALUES (new.id, new.content);
                END;
                CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
                    INSERT INTO search_index(search_index, rowid, content)
                    VALUES ('delete', old.id, old.content);
                END;
                CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
                    INSERT INTO search_index(search_index, rowid, content)
                    VALUES ('delete', old.id, old.content);
                    INSERT INTO search_index(rowid, content) VALUES (new.id, new.content);
                END;
            """)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5)
        db.execute("PRAGMA busy_timeout = 5000")
        return db

    def upsert(self, tenant_id: str, collection_id: str, document_id: str, content: str) -> None:
        with closing(self._connect()) as db, db:
            db.execute("""
                INSERT INTO documents (tenant_id, collection_id, document_id, content)
                VALUES (?, ?, ?, ?)
                ON CONFLICT (tenant_id, collection_id, document_id)
                DO UPDATE SET content = excluded.content
            """, (tenant_id, collection_id, document_id, content))

    def delete(self, tenant_id: str, collection_id: str, document_id: str) -> bool:
        with closing(self._connect()) as db, db:
            cursor = db.execute("""
                DELETE FROM documents
                WHERE tenant_id = ? AND collection_id = ? AND document_id = ?
            """, (tenant_id, collection_id, document_id))
            return cursor.rowcount > 0

    def search(self, tenant_id: str, collection_id: str, query: str, limit: int) -> list[dict[str, object]]:
        terms = re.findall(r"[^\W_]+", query, flags=re.UNICODE)
        if not terms:
            return []
        expression = " AND ".join('"' + term.replace('"', '""') + '"' for term in terms[:20])
        with closing(self._connect()) as db, db:
            rows = db.execute("""
                SELECT d.document_id, d.content, bm25(search_index) AS score
                FROM search_index
                JOIN documents AS d ON d.id = search_index.rowid
                WHERE search_index MATCH ?
                  AND d.tenant_id = ?
                  AND d.collection_id = ?
                ORDER BY score
                LIMIT ?
            """, (expression, tenant_id, collection_id, limit)).fetchall()
        return [{"document_id": row[0], "content": row[1], "score": row[2]} for row in rows]
