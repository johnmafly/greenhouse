// submission.yaml: write, parse and validate, using the #4 schema library (cli/src/lib/schemas.ts).
// This module only adds the writer and keeps the names submit and path-guard already import.
import { loadSchema, parseDocument, validate } from "./lib/schemas.ts";
import type { Submission, ValidationResult } from "./lib/schemas.ts";

export type { Submission, ValidationResult };

const SCHEMA = loadSchema("submission") as { properties: { slug: { pattern: string } } };
export const SLUG_RE = new RegExp(SCHEMA.properties.slug.pattern);
const FIELDS = ["schema_version", "slug", "round", "repo", "sha", "deployment_url", "claims_sha256", "changelog"] as const;

/** Validate against schemas/submission.schema.json. */
export function validateSubmission(doc: unknown): ValidationResult {
  return validate("submission", doc);
}

/** Flat YAML mapping with JSON-quoted strings: valid YAML that any YAML 1.2 parser reads back identically. */
export function serializeSubmission(s: Submission): string {
  return FIELDS.map((k) => `${k}: ${typeof s[k] === "number" ? String(s[k]) : JSON.stringify(s[k])}`).join("\n") + "\n";
}

/** Parse submission.yaml (YAML 1.2 core schema). Throws on invalid YAML or a non-mapping document. */
export function parseSubmissionYaml(text: string): Record<string, unknown> {
  const doc = parseDocument(text, "submission.yaml");
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error("submission.yaml must be a YAML mapping");
  return doc as Record<string, unknown>;
}
