"""Packaging rules added for 0.2.0: skill packages and the per-table storage options.

Each case fails if the rule it names is removed. Run: python3 -m unittest discover -s tests/unit
"""
import importlib.util
import sys
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("package_app", ROOT / "scripts" / "package_app.py")
pa = importlib.util.module_from_spec(spec)
sys.modules["package_app"] = pa
spec.loader.exec_module(pa)


def pkg(**overrides):
    manifest = {"schema": 1, "name": "demo-skill", "files": ["SKILL.md", "references/notes.md"]}
    files = {
        "skills/demo-skill/skill.json": json.dumps(manifest).encode(),
        "skills/demo-skill/SKILL.md": b"---\nname: demo-skill\ndescription: demo\n---\n",
        "skills/demo-skill/references/notes.md": b"notes",
    }
    for key, value in overrides.items():
        path = f"skills/demo-skill/{key}"
        if value is None:
            files.pop(path, None)
        else:
            files[path] = value if isinstance(value, bytes) else value.encode()
    return list(files.items())


class SkillPackages(unittest.TestCase):
    def refuses(self, contents, needle):
        with self.assertRaises(pa.PackageError) as raised:
            pa.check_skills(contents, "t")
        self.assertIn(needle, str(raised.exception))

    def test_a_good_package_passes(self):
        pa.check_skills(pkg(), "t")

    def test_the_manifest_is_closed_and_names_its_directory(self):
        self.refuses(pkg(**{"skill.json": json.dumps({"schema": 1, "name": "other", "files": ["SKILL.md"]})}), "directory name")
        self.refuses(pkg(**{"skill.json": json.dumps({"schema": 1, "name": "demo-skill", "files": ["SKILL.md"], "x": 1})}), "exactly")
        self.refuses(pkg(**{"skill.json": '{"schema": 1.0, "name": "demo-skill", "files": ["SKILL.md"]}'}), "integer 1")
        self.refuses(pkg(**{"skill.json": None}), "no skill.json")

    def test_declared_equals_present_in_both_directions(self):
        self.refuses(pkg(**{"references/notes.md": None}), "missing from the bundle")
        self.refuses(pkg(**{"references/extra.md": "x"}), "does not declare")

    def test_members_follow_the_grammar_and_caps(self):
        self.refuses(pkg(**{"skill.json": json.dumps({"schema": 1, "name": "demo-skill", "files": ["SKILL.md", "../x.md"]})}), "not a package member")
        self.refuses(pkg(**{"skill.json": json.dumps({"schema": 1, "name": "demo-skill", "files": ["references/notes.md"]})}), "does not declare SKILL.md")
        self.refuses(pkg(**{"SKILL.md": b"x" * 16385}), "over 16384")
        self.assertFalse(pa.skill_path_ok("skills/demo-skill/.hidden.md"))
        self.assertFalse(pa.skill_path_ok("skills/Demo/SKILL.md"))
        self.assertFalse(pa.skill_path_ok("skills/demo-skill/a/b/c.md"))
        self.assertFalse(pa.skill_path_ok("skills/demo-skill/references/a.py"))
        self.assertTrue(pa.skill_path_ok("skills/demo-skill/scripts/run.py"))

    def test_the_real_skills_pass(self):
        contents = [(rel, (ROOT / "app" / rel).read_bytes()) for rel in pa.bundle_files(ROOT / "app") if rel.startswith("skills/")]
        self.assertTrue(contents)
        pa.check_skills(contents, "app")


class TableOptions(unittest.TestCase):
    model = {"employees": {"columns": {"name": {"type": "text"}}}, "notes": {"columns": {"body": {"type": "text"}, "n": {"type": "integer"}}}}

    def refuses(self, tables, needle):
        with self.assertRaises(pa.PackageError) as raised:
            pa._check_table_options(tables, "employees", self.model, "t")
        self.assertIn(needle, str(raised.exception))

    def test_valid_options_pass(self):
        pa._check_table_options({"employees": {"read_role": "owner"}, "notes": {"search_columns": ["body"], "append_only": True, "read_role": "owner"}}, "employees", self.model, "t")

    def test_each_rule_refuses(self):
        self.refuses({"ghost": {"read_role": "owner"}}, "no migration creates")
        self.refuses({"notes": {"read_role": "member"}}, "owner")
        self.refuses({"notes": {"unknown": 1}}, "closed")
        self.refuses({"notes": {"search_columns": ["n"]}}, "text or JSON")
        self.refuses({"notes": {"search_columns": ["missing"]}}, "text or JSON")
        self.refuses({"employees": {"search_columns": ["name"]}}, "top level")
        self.refuses({"notes": {"write_schema": {"banana": 1}}}, "unsupported")

    def test_the_real_descriptor_declares_every_table_owner_only(self):
        doc = json.loads((ROOT / "app/app-storage.json").read_text())
        self.assertTrue(doc["tables"])
        for name, options in doc["tables"].items():
            self.assertEqual(options["read_role"], "owner", name)


if __name__ == "__main__":
    unittest.main()
