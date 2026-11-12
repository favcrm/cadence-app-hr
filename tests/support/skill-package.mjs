// A local mirror of the hosted agent reader's skill package rules (agenticos-v2
// `tenant-board/app-skills.ts` `skillPackage`, AOS-561; native `parse_skill_manifest`). The real
// code is run separately by scripts/host-skills-check.mjs; this mirror lets CI refuse a bad
// package without the host repository.
export const CAPS = { manifest: 4096, file: 16384, package: 32768, files: 16 };
const TAG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ROOT_EXT = ["md", "txt", "json", "yaml", "yml", "csv", "css", "svg"];
const NESTED = { references: ["md", "txt"], scripts: ["py", "sh", "js", "mjs"] };
const leaf = (name, exts) => exts.some((e) => name.length > e.length + 1 && name.endsWith(`.${e}`));
const plain = (p) => p.split("/").every((s) => s !== "" && s !== "." && s !== ".." && !s.startsWith("."));
const size = (s) => new TextEncoder().encode(s).length;

export function memberOk(member) {
  if (!/^[\x20-\x7e]+$/.test(member) || member.includes("\\") || !plain(member)) return false;
  const parts = member.split("/");
  if (parts.length === 1) return leaf(parts[0], ROOT_EXT);
  return parts.length === 2 && Object.hasOwn(NESTED, parts[0]) && leaf(parts[1], NESTED[parts[0]]);
}

/** files: { "skills/<tag>/<member>": text }. Returns {ok:true} or {ok:false, reason}. */
export function skillPackage(files, tag) {
  if (!TAG.test(tag)) return { ok: false, reason: "tag" };
  const prefix = `skills/${tag}/`;
  const raw = files[`${prefix}skill.json`];
  if (raw === undefined) return { ok: false, reason: "manifest_missing" };
  if (size(raw) > CAPS.manifest) return { ok: false, reason: "manifest_too_large" };
  let m;
  try { m = JSON.parse(raw); } catch { return { ok: false, reason: "manifest_invalid" }; }
  if (!m || typeof m !== "object" || Array.isArray(m)) return { ok: false, reason: "manifest_not_object" };
  if (Object.keys(m).sort().join(",") !== "files,name,schema") return { ok: false, reason: "manifest_keys" };
  if (m.schema !== 1 || !/"schema"\s*:\s*1\s*[,}]/.test(raw)) return { ok: false, reason: "manifest_schema" };
  if (m.name !== tag) return { ok: false, reason: "manifest_name" };
  if (!Array.isArray(m.files) || m.files.length === 0) return { ok: false, reason: "files_empty" };
  if (m.files.length > CAPS.files) return { ok: false, reason: "files_too_many" };
  const declared = [];
  for (const f of m.files) {
    if (typeof f !== "string") return { ok: false, reason: "member_not_string" };
    if (f === "skill.json") return { ok: false, reason: "member_self" };
    if (!memberOk(f)) return { ok: false, reason: "member_grammar" };
    if (declared.includes(f)) return { ok: false, reason: "member_duplicate" };
    declared.push(f);
  }
  if (!declared.includes("SKILL.md")) return { ok: false, reason: "entry_missing" };
  const present = Object.keys(files).filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
  if (present.some((p) => p !== "skill.json" && !memberOk(p))) return { ok: false, reason: "present_grammar" };
  if (declared.some((f) => !present.includes(f))) return { ok: false, reason: "declared_missing" };
  if (present.some((p) => p !== "skill.json" && !declared.includes(p))) return { ok: false, reason: "present_undeclared" };
  let total = size(raw);
  for (const f of declared) {
    const n = size(files[prefix + f]);
    if (n > CAPS.file) return { ok: false, reason: "member_too_large" };
    total += n;
  }
  if (total > CAPS.package) return { ok: false, reason: "package_too_large" };
  return { ok: true, total };
}
