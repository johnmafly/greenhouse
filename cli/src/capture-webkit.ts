// webkit-iphone evidence: the fold screenshots `greenhouse check` saves for every start route in
// Playwright WebKit with the iPhone 15 Pro profile (gate webkit-iphone, cli/src/check/webkit.ts,
// to <round-dir>/evidence/webkit-iphone/). capture copies them into the bundle under
// webkit-iphone/ so reviewers see each page as an iPhone renders it, hashed like every other file.
import { copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { routeFile } from "./check/webkit.ts";

export const WEBKIT_DIR = "webkit-iphone";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type WebkitShot = {
  /** Route the screenshot shows: from checks.json when it lists it, else matched against the captured routes. */
  route: string | null;
  /** Path inside the bundle. */
  path: string;
  /** The gate's problems for this route (empty when it rendered cleanly); null without checks.json. */
  problems: string[] | null;
};

export type WebkitEvidence = {
  source: "round_dir" | "evidence_dir";
  engine: "webkit";
  device: string | null;
  /** sha from checks.json, null without it. */
  checked_sha: string | null;
  /** The webkit-iphone gate's result from checks.json, null without it. */
  gate: { status: string; summary: string } | null;
  screenshots: WebkitShot[];
  notes: string[];
};

export type WebkitSource = { roundDir: string; evidenceDir?: undefined } | { evidenceDir: string; roundDir?: undefined };

type GateRoute = { path?: unknown; screenshot?: unknown; problems?: unknown };

/** The webkit-iphone gate from a checks.json, or null when the file or the gate is absent. */
async function readGate(checksFile: string): Promise<{ sha: string | null; gate: Record<string, unknown> } | null> {
  let doc: { sha?: unknown; gates?: unknown };
  try {
    doc = JSON.parse(await readFile(checksFile, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`cannot read ${checksFile}: ${(e as Error).message}`);
  }
  const gates = Array.isArray(doc.gates) ? (doc.gates as Record<string, unknown>[]) : [];
  const gate = gates.find((g) => g && g.id === "webkit-iphone");
  return gate ? { sha: typeof doc.sha === "string" ? doc.sha : null, gate } : null;
}

/**
 * Copy the webkit-iphone screenshots into <tmp>/webkit-iphone/ and describe them for the manifest.
 * With a round dir the screenshots come from <round-dir>/evidence/webkit-iphone/ and routes, problems
 * and the gate result from <round-dir>/checks.json; with an evidence dir (check run without
 * --round-dir) from <evidence-dir>/webkit-iphone/, routes matched against `routes`. No screenshots is
 * recorded with a note, not an error: the gate fails (and says why) when it could not take them.
 */
export async function collectWebkitEvidence(src: WebkitSource, tmp: string, routes: string[]): Promise<WebkitEvidence> {
  const shotDir = src.roundDir !== undefined ? join(src.roundDir, "evidence", WEBKIT_DIR) : join(src.evidenceDir, WEBKIT_DIR);
  const ev: WebkitEvidence = { source: src.roundDir !== undefined ? "round_dir" : "evidence_dir", engine: "webkit", device: null, checked_sha: null, gate: null, screenshots: [], notes: [] };

  const byFile = new Map<string, GateRoute>();
  if (src.roundDir !== undefined) {
    const found = await readGate(join(src.roundDir, "checks.json"));
    if (!found) ev.notes.push("no checks.json with a webkit-iphone gate; routes matched by file name");
    else {
      ev.checked_sha = found.sha;
      ev.gate = { status: String(found.gate.status), summary: String(found.gate.summary) };
      const details = (found.gate.details ?? {}) as { device?: unknown; routes?: unknown };
      if (typeof details.device === "string") ev.device = details.device;
      for (const r of Array.isArray(details.routes) ? (details.routes as GateRoute[]) : []) {
        if (typeof r.screenshot === "string") byFile.set(r.screenshot.replace(/^webkit-iphone\//, ""), r);
      }
    }
  }
  const byRouteFile = new Map(routes.map((r) => [`${routeFile(r)}.png`, r]));

  let names: string[];
  try {
    names = (await readdir(shotDir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    ev.notes.push(`no screenshots: ${WEBKIT_DIR}/ does not exist (the webkit-iphone gate did not run or could not save them)`);
    return ev;
  }
  const pngs: string[] = [];
  for (const name of names) {
    const st = await lstat(join(shotDir, name));
    if (!st.isFile() || !name.endsWith(".png")) {
      ev.notes.push(`ignored ${WEBKIT_DIR}/${name}: not a .png file`);
      continue;
    }
    const head = (await readFile(join(shotDir, name))).subarray(0, 8);
    if (!head.equals(PNG_SIGNATURE)) throw new Error(`${join(shotDir, name)} is not a PNG`);
    pngs.push(name);
  }
  if (pngs.length === 0) ev.notes.push(`no screenshots in ${WEBKIT_DIR}/`);
  if (pngs.length) await mkdir(join(tmp, WEBKIT_DIR), { recursive: true });
  for (const name of pngs) {
    await copyFile(join(shotDir, name), join(tmp, WEBKIT_DIR, name));
    const g = byFile.get(name);
    const route = typeof g?.path === "string" ? g.path : (byRouteFile.get(name) ?? null);
    const problems = g ? (Array.isArray(g.problems) ? g.problems.map(String) : []) : null;
    ev.screenshots.push({ route, path: `${WEBKIT_DIR}/${name}`, problems });
  }
  return ev;
}
