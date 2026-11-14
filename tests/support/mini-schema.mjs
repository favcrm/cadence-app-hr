// A small evaluator for the JSON Schema keywords the write schemas use: type (including integer), enum, const,
// minimum/maximum, minLength/maxLength, properties, required, additionalProperties, items, minItems/maxItems,
// allOf, anyOf, not and if/then. The host's real validator is run by scripts/host-schema-check.mjs over the same
// cases; this one lets CI check the rules without the host repository.
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const isType = (t, v) => (t === "integer" ? Number.isInteger(v) : typeOf(v) === t);
export function valid(schema, value) {
  if (schema === true) return true;
  if (schema === false) return false;
  if (schema.type !== undefined && !isType(schema.type, value)) return false;
  if (schema.enum !== undefined && !schema.enum.includes(value)) return false;
  if ("const" in schema && schema.const !== value) return false;
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength) return false;
    if (schema.maxLength !== undefined && length > schema.maxLength) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items !== undefined && !value.every((item) => valid(schema.items, item))) return false;
  }
  if (typeOf(value) === "object") {
    for (const k of schema.required ?? []) if (!(k in value)) return false;
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in value && !valid(s, value[k])) return false;
    if (schema.additionalProperties !== undefined) {
      for (const k of Object.keys(value)) if (!(k in (schema.properties ?? {})) && !valid(schema.additionalProperties, value[k])) return false;
    }
  }
  for (const s of schema.allOf ?? []) if (!valid(s, value)) return false;
  if (schema.anyOf !== undefined && !schema.anyOf.some((s) => valid(s, value))) return false;
  if (schema.not !== undefined && valid(schema.not, value)) return false;
  if (schema.if !== undefined) {
    if (valid(schema.if, value)) { if (schema.then !== undefined && !valid(schema.then, value)) return false; }
    else if (schema.else !== undefined && !valid(schema.else, value)) return false;
  }
  return true;
}
