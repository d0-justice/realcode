from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from fastapi.testclient import TestClient

from realcode_rag.app import create_app


class RagApiTests(TestCase):
    def test_health_auth_and_document_flow(self):
        with TemporaryDirectory() as directory:
            client = TestClient(create_app(Path(directory) / "rag.db", token="test-secret"))
            self.assertEqual(client.get("/healthz").json()["status"], "ok")
            path = "/v1/collections/notes/documents"
            document = {"tenant_id": "team-a", "document_id": "one", "content": "alpha beta"}
            self.assertEqual(client.put(path, json=document).status_code, 401)
            headers = {"X-RealCode-Internal-Token": "test-secret"}
            self.assertEqual(client.put(path, json=document, headers=headers).status_code, 200)
            search = "/v1/collections/notes/search"
            payload = {"tenant_id": "team-a", "query": "alpha"}
            response = client.post(search, json=payload, headers=headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["matches"][0]["document_id"], "one")
            payload["tenant_id"] = "team-b"
            self.assertEqual(client.post(search, json=payload, headers=headers).json()["matches"], [])
            self.assertTrue(client.delete(f"{path}/one?tenant_id=team-a", headers=headers).json()["deleted"])
            payload["tenant_id"] = "team-a"
            self.assertEqual(client.post(search, json=payload, headers=headers).json()["matches"], [])

    def test_missing_service_token_fails_closed(self):
        with TemporaryDirectory() as directory:
            client = TestClient(create_app(Path(directory) / "rag.db", token=""))
            response = client.post("/v1/collections/notes/search", json={"tenant_id": "a", "query": "x"})
            self.assertEqual(response.status_code, 503)
