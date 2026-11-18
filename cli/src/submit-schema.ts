// submission.yaml: write, parse and validate.
//
// INTERIM until #4 (schemas library, PR #26) merges: this mirrors schemas/submission.schema.json
// field for field. When it lands, replace parseSubmissionYaml with lib/schemas.ts parseDocument
// and the body of validateSubmission with `return validate("submission", doc)`.

export type Submission = {
  schema_version: 1;
  slug: string;
  round: number;
  repo: string;
  sha: string;
  deployment_url: string;
  claims_sha256: string;
  changelog: string;
};

export type ValidationResult = { valid: boolean; errors: string[] };

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FIELDS = ["schema_version", "slug", "round", "repo", "sha", "deployment_url", "claims_sha256", "changelog"] as const;

export function validateSubmission(doc: unknown): ValidationResult {
  const errors: string[] = [];
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { valid: false, errors: ["/: must be object"] };
  const d = doc as Record<string, unknown>;
  for (const k of Object.keys(d)) if (!(FIELDS as readonly string[]).includes(k)) errors.push(`/: unknown property '${k}'`);
  for (const k of FIELDS) if (!(k in d)) errors.push(`/: must have required property '${k}'`);
  const str = (k: string, re: RegExp | null) => {
    if (!(k in d)) return;
    if (typeof d[k] !== "string") errors.push(`/${k}: must be string`);
    else if (re && !re.test(d[k] as string)) errors.push(`/${k}: must match pattern "${re.source}"`);
  };
  if ("schema_version" in d && d.schema_version !== 1) errors.push("/schema_version: must be equal to constant 1");
  if ("round" in d && !(Number.isInteger(d.round) && (d.round as number) >= 1)) errors.push("/round: must be an integer >= 1");
  str("slug", SLUG_RE);
  str("repo", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  str("sha", /^[0-9a-f]{40}$/);
  str("deployment_url", /^https?:\/\/[^\s/]+/);
  str("claims_sha256", /^[0-9a-f]{64}$/);
  str("changelog", null);
  return { valid: errors.length === 0, errors };
}

/** Flat YAML mapping with JSON-quoted strings: valid YAML that any YAML 1.2 parser reads back identically. */
export function serializeSubmission(s: Submission): string {
  return FIELDS.map((k) => `${k}: ${typeof s[k] === "number" ? String(s[k]) : JSON.stringify(s[k])}`).join("\n") + "\n";
}

/**
 * Minimal parser for a flat mapping of scalars (what serializeSubmission writes, and hand-written
 * files like the #4 fixtures). Anything richer (nesting, block scalars, anchors) is rejected.
 */
export function parseSubmissionYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/\s+$/, "");
    if (line === "" || /^\s*#/.test(line) || line === "---") continue;
    const m = /^([a-z_][a-z0-9_]*):(?:\s+(.*))?$/.exec(line);
    if (!m) throw new Error(`submission.yaml line ${i + 1}: expected 'key: value' at the top level`);
    const [, key, rawValue = ""] = m;
    if (key in out) throw new Error(`submission.yaml line ${i + 1}: duplicate key '${key}'`);
    const v = rawValue.trim();
    let value: unknown;
    if (v.startsWith('"')) value = JSON.parse(v);
    else if (v.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(v)) throw new Error(`submission.yaml line ${i + 1}: bad single-quoted string`);
      value = v.slice(1, -1).replace(/''/g, "'");
    } else if (/^-?\d+$/.test(v)) value = Number(v);
    else if (v === "" || /^[|>&*!\[{]/.test(v) || / #/.test(v)) throw new Error(`submission.yaml line ${i + 1}: unsupported YAML value for '${key}'`);
    else if (v === "null" || v === "~" || v === "true" || v === "false") value = v === "true" ? true : v === "false" ? false : null;
    else value = v;
    out[key] = value;
  }
  return out;
}
