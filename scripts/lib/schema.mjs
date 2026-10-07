// A small JSON Schema subset validator: type, enum, required, properties,
// additionalProperties:false, items, minItems, minLength, pattern, minimum, maximum.
// Enough for the worker contracts in schemas/; no dependency needed.

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeOk = (want, v) => {
  const t = typeOf(v);
  return want === t || (want === 'number' && t === 'integer');
};

export function validate(schema, value, at = '$') {
  const errors = [];
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => typeOk(t, value))) {
      // Nothing below a wrong type is checked, so say what the right one holds (seen live: an array
      // `suiteChanges`, then its missing keys, then their missing `why`, took three fix dispatches).
      const keys = schema.required?.length ? ` with ${schema.required.map((k) => `"${k}"`).join(', ')}` : '';
      errors.push(`${at}: expected ${types.join('|')}${keys}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: must be one of ${schema.enum.join(', ')} (got ${JSON.stringify(value)})`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (key in value) continue;
      const want = schema.properties?.[key]?.type;
      errors.push(`${at}: missing "${key}"${want ? ` (${[].concat(want).join('|')})` : ''}`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validate(sub, value[key], `${at}.${key}`));
    }
    if (schema.additionalProperties === false) {
      const allowed = Object.keys(schema.properties ?? {});
      for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${at}: unexpected "${key}" (allowed: ${allowed.join(', ')})`);
    }
  }
  return errors;
}

// Worker output is "one fenced ```json block, then ≤5 lines of prose".
// Accept pure JSON too; otherwise take the last ```json block.
export function extractJson(text) {
  const trimmed = String(text).trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const blocks = [...trimmed.matchAll(/```json\s*\n([\s\S]*?)\n\s*```/g)];
  if (!blocks.length) throw new Error('no ```json block found in the agent output');
  return JSON.parse(blocks.at(-1)[1]);
}
