"""The app-check assertion accepts only the hosted-only storage refusal."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / ".github/scripts/assert-app-check.py"
STORAGE = "app requires host contract 'app-storage' major 1 — this host supports none (unknown contract)"
INTEGRITY = (
    "screens/hr: screen package 'hr' failed integrity: manifest declaration: "
    "unknown variant `records.batch`, expected one of `records.list`, `records.show` at line 44 column 19"
)


def report(message, contracts=("app-storage",), ok=False):
    checks = [{"contract": "app-screens", "ok": True}] + [{"contract": c, "ok": False} for c in contracts]
    return {
        "ok": ok,
        "digest": "sha256:" + "0" * 64,
        "files": [{"path": "app.md"}],
        "compatibility": {"checks": checks},
        "refusal": None if message is None else {"code": "app_check_content", "message": message},
    }


def run(document):
    with tempfile.TemporaryDirectory(prefix="hr-app-check-") as directory:
        path = Path(directory) / "report.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        return subprocess.run([sys.executable, str(SCRIPT), str(path)], capture_output=True, text=True, timeout=10)


class AssertAppCheck(unittest.TestCase):
    def test_storage_refusal_alone_is_accepted(self):
        result = run(report("app is not installable — " + STORAGE))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("hosted-only", result.stdout)

    def test_a_passing_report_is_accepted(self):
        self.assertEqual(run(report(None, contracts=(), ok=True)).returncode, 0)

    def test_a_second_clause_beside_the_storage_refusal_is_refused(self):
        for message in (
            "app is not installable — " + INTEGRITY + "; " + STORAGE,
            "app is not installable — " + STORAGE + "; " + INTEGRITY,
        ):
            with self.subTest(message=message[:60]):
                result = run(report(message))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("unaccepted reason", result.stderr)

    def test_another_refusal_that_merely_mentions_app_storage_is_refused(self):
        result = run(report("app is not installable — the screen names app-storage in an unknown field"))
        self.assertNotEqual(result.returncode, 0)

    def test_another_failed_contract_is_refused(self):
        result = run(report("app is not installable — " + STORAGE, contracts=("app-storage", "screen-records")))
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
