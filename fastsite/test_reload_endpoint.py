from __future__ import annotations

import json
import runpy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


MODULE = runpy.run_path(str(Path(__file__).parent / "src" / "fastsite" / "reload_endpoint.py"))
ReloadEndpointConfig = MODULE["ReloadEndpointConfig"]
authorized = MODULE["authorized"]
reload_command = MODULE["reload_command"]
run_reload = MODULE["run_reload"]


def config(root: Path) -> ReloadEndpointConfig:
    return ReloadEndpointConfig(
        token="x" * 32,
        extensions_dir=root / "plugins",
        pid_file=root / "fastsite.pid",
        status_url="http://127.0.0.1:3003",
        lock_file=root / "reload.lock",
        request_timeout_seconds=120,
        reload_timeout_seconds=90,
    )


class ReloadEndpointTest(unittest.TestCase):
    def test_requires_an_exact_long_bearer_token(self) -> None:
        token = "x" * 32
        self.assertTrue(authorized(f"Bearer {token}", token))
        self.assertFalse(authorized("Bearer wrong", token))
        self.assertFalse(authorized(f"Bearer {token}", "short"))

    def test_calls_existing_reload_cli_with_current_boot_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            self.assertEqual(
                reload_command(config(root), "old-worker"),
                [
                    sys.executable,
                    "-m",
                    "fastsite.cli",
                    "reload",
                    "--extensions-dir",
                    str(root / "plugins"),
                    "--pid-file",
                    str(root / "fastsite.pid"),
                    "--status-url",
                    "http://127.0.0.1:3003",
                    "--timeout-seconds",
                    "90",
                    "--previous-boot-id",
                    "old-worker",
                ],
            )

    def test_returns_original_cli_result(self) -> None:
        completed = subprocess.CompletedProcess([], 0, json.dumps({"ok": True, "phase": "ready"}), "")
        fake_fcntl = Mock()
        fake_fcntl.LOCK_EX = 1
        fake_fcntl.LOCK_NB = 2
        fake_fcntl.LOCK_UN = 8
        run_reload.__globals__["fcntl"] = fake_fcntl
        with tempfile.TemporaryDirectory() as temporary_directory, patch("subprocess.run", return_value=completed):
            self.assertEqual(run_reload(config(Path(temporary_directory)), "old-worker"), (200, {"ok": True, "phase": "ready"}))


if __name__ == "__main__":
    unittest.main()
