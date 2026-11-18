// Rubric loader: reads rubric/rubric-vN.yaml and validates it (schema + weights sum to 1).
import { join } from "node:path";
import { REPO_ROOT, assertValid, readDocument } from "./schemas.ts";
import type { Rubric } from "./schemas.ts";

export const RUBRIC_DIR = join(REPO_ROOT, "rubric");

export function rubricPath(version: number): string {
  return join(RUBRIC_DIR, `rubric-v${version}.yaml`);
}

export function loadRubric(pathOrVersion: string | number = 1): Rubric {
  const path = typeof pathOrVersion === "number" ? rubricPath(pathOrVersion) : pathOrVersion;
  const rubric = assertValid<Rubric>("rubric", readDocument(path), path);
  if (typeof pathOrVersion === "number" && rubric.version !== pathOrVersion) {
    throw new Error(`${path} declares version ${rubric.version}, expected ${pathOrVersion}`);
  }
  return rubric;
}

export function capMax(rubric: Rubric, id: "quality" | "integrity"): number {
  const cap = rubric.caps.find((c) => c.id === id);
  if (!cap) throw new Error(`rubric v${rubric.version} has no '${id}' cap`);
  return cap.max;
}
