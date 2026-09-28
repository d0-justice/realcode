from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from realcode_rag.store import DocumentStore


class DocumentStoreTests(TestCase):
    def test_upsert_search_and_tenant_isolation(self):
        with TemporaryDirectory() as directory:
            store = DocumentStore(Path(directory) / "rag.db")
            store.upsert("tenant-a", "notes", "one", "alpha beta")
            store.upsert("tenant-b", "notes", "two", "alpha secret")
            self.assertEqual(
                [item["document_id"] for item in store.search("tenant-a", "notes", "alpha", 10)],
                ["one"],
            )
            store.upsert("tenant-a", "notes", "one", "gamma")
            self.assertEqual(store.search("tenant-a", "notes", "alpha", 10), [])
            self.assertEqual(store.search("tenant-a", "notes", "gamma", 10)[0]["document_id"], "one")
            self.assertTrue(store.delete("tenant-a", "notes", "one"))
            self.assertEqual(store.search("tenant-a", "notes", "gamma", 10), [])
