// A small evaluator for the JSON Schema keywords the write schemas use: type, enum, const,
// properties, required, allOf, if/then. The host's real validator is run by scripts/host-schema-check.mjs
// over the same cases; this one lets CI check the rules without the host repository.
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
export function valid(schema, value) {
  if (schema === true) return true;
  if (schema === false) return false;
  if (schema.type !== undefined && typeOf(value) !== schema.type) return false;
  if (schema.enum !== undefined && !schema.enum.includes(value)) return false;
  if ("const" in schema && schema.const !== value) return false;
  if (typeOf(value) === "object") {
    for (const k of schema.required ?? []) if (!(k in value)) return false;
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in value && !valid(s, value[k])) return false;
  }
  for (const s of schema.allOf ?? []) if (!valid(s, value)) return false;
  if (schema.if !== undefined) {
    if (valid(schema.if, value)) { if (schema.then !== undefined && !valid(schema.then, value)) return false; }
    else if (schema.else !== undefined && !valid(schema.else, value)) return false;
  }
  return true;
}
