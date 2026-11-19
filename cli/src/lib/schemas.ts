// JSON Schemas (draft 2020-12) for every Greenhouse file, and helpers to parse and validate them.
// Other modules import from here: validate(), assertValid(), readDocument(), and the document types.
import { readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction, ErrorObject } from "ajv";
import { parse as parseYaml } from "yaml";

// ajv-formats is CommonJS with a default export; require() gives the plugin function with correct types.
const addFormats: typeof import("ajv-formats").default = createRequire(import.meta.url)("ajv-formats");

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const SCHEMAS_DIR = join(REPO_ROOT, "schemas");

export const SCHEMA_NAMES = ["intake", "claims", "submission", "checks", "review", "score", "rubric"] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

// ---- Document types (field names match the schemas exactly) ----

export type ProjectStatus =
  | "idea" | "seed" | "building" | "in-review" | "revise" | "owner-review" | "graduated" | "paused" | "killed";

export interface Intake {
  schema_version: 1;
  slug: string;
  name: string;
  status: ProjectStatus;
  chief: { reason_id: string; name: string };
  repo: string;
  deployment_url: string | null;
  intent: string;
  buyer: string;
  open_source_model: string;
  locked_assumptions: string[];
  non_goals: string[];
  budget: { rounds: number; model_spend_usd: number; time_cap_days: number };
  exposure: { public: boolean; indexable: boolean; real_signups: boolean; outreach: boolean };
  sources: string[];
  approved_by_owner: string | null;
}

export interface Claim {
  id: string;
  claim: string;
  where: string[];
  source_url: string;
  quote: string;
  checked: string;
}
export interface Claims { claims: Claim[] }

export interface Submission {
  schema_version: 1;
  slug: string;
  round: number;
  repo: string;
  sha: string;
  deployment_url: string;
  claims_sha256: string;
  changelog: string;
}

export type GateClass = "deterministic" | "assisted";
export type GateStatus = "pass" | "warn" | "fail" | "skip";
export interface Gate {
  id: string;
  class: GateClass;
  status: GateStatus;
  summary: string;
  metrics?: Record<string, number | string | boolean | null>;
  details?: unknown;
}
export interface Checks {
  schema_version: 1;
  slug: string;
  round: number;
  sha: string;
  deployment_url: string;
  cli_version: string;
  tool_versions: Record<string, string>;
  machine: string;
  started_at: string;
  finished_at: string;
  gates: Gate[];
  all_green: boolean;
  bundle_hash?: string;
}

export type Severity = "must" | "should" | "could";
export interface Finding {
  id: string;
  dimension: string;
  severity: Severity;
  title: string;
  detail: string;
  evidence: string[];
  /** Decision 0008: the owner rule this finding is a miss of; always severity "must". */
  rule?: OwnerRule;
}
export type OwnerRule = "vision_first" | "playbook";
export interface Review {
  schema_version: 1;
  reviewer: { id: string; model: string; family: string; brief_version: string };
  rubric_version: number;
  bundle_hash: string;
  scores: Record<string, number>;
  findings: Finding[];
  flags: { invented_social_proof: boolean; reviewer_instruction: boolean; template_structure: boolean; hedged_vision?: boolean };
}
export interface MustFix {
  rule: OwnerRule;
  dimension: string;
  title: string;
  reviewers: string[];
  finding_ids: string[];
}

export interface Score {
  schema_version: 1;
  slug: string;
  round: number;
  sha: string;
  rubric_version: number;
  brief_version: string;
  provisional: boolean;
  panel: { id: string; model: string; family: string }[];
  dimension_medians: Record<string, number>;
  reviewer_composites: Record<string, number>;
  composite_raw: number;
  caps_applied: { reason: string; max: number }[];
  composite: number;
  must_fix?: MustFix[];
  gates_green: boolean;
  graduation_eligible: boolean;
  inputs: { checks_sha256: string; reviews_sha256: Record<string, string>; bundle_hash: string };
  cost_usd: number | null;
  decided_at: string;
}

export type CapId = "quality" | "sameness" | "integrity";
export interface RubricDimension { id: string; name: string; weight: number; nine?: string }
export interface Rubric {
  version: number;
  scale: { min: number; max: number; anchors?: Record<string, string> };
  dimensions: RubricDimension[];
  composite?: string;
  caps: { id: CapId; when?: string; max: number; report_to_owner?: boolean }[];
  graduation: {
    composite_min: number;
    dimension_median_min: number;
    /** Dimensions that must reach focus_median_min (rubric v3: the five design-led ones). */
    focus_dimensions?: string[];
    focus_median_min?: number;
    reviewer_composite_min: number;
    [k: string]: unknown;
  };
  panel: { reviewers: number; min_families: number; exclude_family_of_chiefs?: boolean; add_reviewer_when_dimension_spread_over?: number };
  [k: string]: unknown;
}

// ---- Validation ----

export interface ValidationResult { valid: boolean; errors: string[] }

let ajv: Ajv2020 | undefined;
const compiled = new Map<SchemaName, ValidateFunction>();

export function schemaPath(name: SchemaName): string {
  return join(SCHEMAS_DIR, `${name}.schema.json`);
}

export function loadSchema(name: SchemaName): Record<string, unknown> {
  return JSON.parse(readFileSync(schemaPath(name), "utf8"));
}

function validator(name: SchemaName): ValidateFunction {
  let fn = compiled.get(name);
  if (fn === undefined) {
    if (!ajv) {
      // useDefaults fills schema defaults (e.g. intake budget.rounds = 6) into the validated object.
      ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: true });
      addFormats(ajv);
    }
    const compiledFn: ValidateFunction = ajv.compile(loadSchema(name));
    compiled.set(name, compiledFn);
    return compiledFn;
  }
  return fn;
}

function formatError(e: ErrorObject): string {
  const at = e.instancePath || "/";
  if (e.keyword === "additionalProperties") return `${at}: unknown property '${(e.params as { additionalProperty: string }).additionalProperty}'`;
  if (e.keyword === "enum") return `${at}: must be one of ${(e.params as { allowedValues: unknown[] }).allowedValues.map((v) => JSON.stringify(v)).join(", ")}`;
  return `${at}: ${e.message}`;
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
}

// Rules JSON Schema cannot express. Runs only after the schema itself passed.
function semanticErrors(name: SchemaName, doc: any): string[] {
  const errors: string[] = [];
  if (name === "claims") {
    for (const d of duplicates(doc.claims.map((c: Claim) => c.id))) errors.push(`/claims: duplicate claim id '${d}'`);
  } else if (name === "checks") {
    for (const d of duplicates(doc.gates.map((g: Gate) => g.id))) errors.push(`/gates: duplicate gate id '${d}'`);
    const anyFail = doc.gates.some((g: Gate) => g.status === "fail");
    if (doc.all_green === anyFail) errors.push(`/all_green: must be ${!anyFail} (true exactly when no gate has status 'fail')`);
    if (Date.parse(doc.finished_at) < Date.parse(doc.started_at)) errors.push(`/finished_at: is before started_at`);
  } else if (name === "review") {
    for (const d of duplicates(doc.findings.map((f: Finding) => f.id))) errors.push(`/findings: duplicate finding id '${d}'`);
    doc.findings.forEach((f: Finding, i: number) => {
      if (!(f.dimension in doc.scores)) errors.push(`/findings/${i}/dimension: '${f.dimension}' is not a scored dimension`);
    });
  } else if (name === "rubric") {
    for (const d of duplicates(doc.dimensions.map((x: RubricDimension) => x.id))) errors.push(`/dimensions: duplicate dimension id '${d}'`);
    for (const d of duplicates(doc.caps.map((x: { id: string }) => x.id))) errors.push(`/caps: duplicate cap id '${d}'`);
    const sum = doc.dimensions.reduce((s: number, x: RubricDimension) => s + x.weight, 0);
    if (Math.abs(sum - 1) > 1e-9) errors.push(`/dimensions: weights sum to ${sum}, must sum to 1`);
    if (doc.scale.min >= doc.scale.max) errors.push(`/scale: min must be below max`);
    const ids = new Set(doc.dimensions.map((x: RubricDimension) => x.id));
    for (const f of doc.graduation.focus_dimensions ?? []) if (!ids.has(f)) errors.push(`/graduation/focus_dimensions: '${f}' is not a dimension`);
  }
  return errors;
}

/** Validate a parsed document. Fills schema defaults into `doc` (it is mutated). */
export function validate(name: SchemaName, doc: unknown): ValidationResult {
  const fn = validator(name);
  if (!fn(doc)) return { valid: false, errors: (fn.errors ?? []).map(formatError) };
  const errors = semanticErrors(name, doc);
  return { valid: errors.length === 0, errors };
}

export class ValidationError extends Error {
  errors: string[];
  constructor(label: string, errors: string[]) {
    super(`${label} is invalid:\n  ${errors.join("\n  ")}`);
    this.name = "ValidationError";
    this.errors = errors;
  }
}

/** Validate and return the document typed, or throw ValidationError. */
export function assertValid<T>(name: SchemaName, doc: unknown, label: string = name): T {
  const r = validate(name, doc);
  if (!r.valid) throw new ValidationError(label, r.errors);
  return doc as T;
}

// ---- Files ----

/** Parse JSON (.json) or YAML (anything else). YAML uses the 1.2 core schema, so dates stay strings. */
export function parseDocument(text: string, filename: string): unknown {
  if (extname(filename).toLowerCase() === ".json") return JSON.parse(text);
  return parseYaml(text);
}

export function readDocument(path: string): unknown {
  return parseDocument(readFileSync(path, "utf8"), path);
}

/** Infer which schema applies from a Greenhouse file name, or undefined. */
export function inferSchema(path: string): SchemaName | undefined {
  const base = basename(path).toLowerCase();
  const stem = base.replace(/\.(ya?ml|json)$/, "");
  if (basename(dirname(path)) === "reviews" && base.endsWith(".json")) return "review";
  if (/^rubric-v\d+$/.test(stem)) return "rubric";
  const bySuffix = stem.replace(/\.schema$/, "");
  if (bySuffix !== stem) return undefined; // a schema file itself
  return (SCHEMA_NAMES as readonly string[]).includes(stem) ? (stem as SchemaName) : undefined;
}

/** Read, parse and validate a file. Throws on unreadable or unparseable files. */
export function validateFile(path: string, name?: SchemaName): ValidationResult & { schema: SchemaName } {
  const schema = name ?? inferSchema(path);
  if (!schema) throw new Error(`cannot tell which schema applies to ${path}; pass --schema <${SCHEMA_NAMES.join("|")}>`);
  return { schema, ...validate(schema, readDocument(path)) };
}
