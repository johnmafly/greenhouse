// Routes for greenhouse capture from greenhouse.yaml's content map (package contract v2).
// Only "/", /.well-known/greenhouse.json and a 404 are fixed routes; every other page the
// capture visits comes from `content:`, which says where each required piece of content lives.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** Required content keys, in the order capture visits their pages. */
export const CONTENT_KEYS = [
  "how_it_works",
  "getting_started",
  "architecture",
  "integration",
  "comparison",
  "pricing",
  "signup",
] as const;
export type ContentKey = (typeof CONTENT_KEYS)[number];
export type ContentMap = Record<ContentKey, string>;

/** One content key a page serves; target keeps the #anchor as written. */
export type ContentServe = { key: ContentKey; target: string };
export type ContentRoutes = { routes: string[]; serves: Map<string, ContentServe[]> };

/** "/pricing/#plans" -> "/pricing/" (query kept, anchor dropped). */
export function stripAnchor(target: string): string {
  const i = target.indexOf("#");
  return i === -1 ? target : target.slice(0, i);
}

/**
 * Validate the `content:` value of greenhouse.yaml. Returns null when the document has no
 * content map (the caller falls back to the v1 route list); throws on a malformed one.
 */
export function parseContentMap(doc: unknown, source = "greenhouse.yaml"): ContentMap | null {
  if (doc === null || doc === undefined) return null;
  if (typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${source}: top level must be a mapping`);
  if (!("content" in doc)) return null;
  const content = (doc as { content: unknown }).content;
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    throw new Error(`${source}: content must be a mapping of ${CONTENT_KEYS.join(", ")} to site paths`);
  }
  const c = content as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of Object.keys(c)) if (!(CONTENT_KEYS as readonly string[]).includes(k)) errors.push(`unknown key content.${k}`);
  for (const k of CONTENT_KEYS) {
    const v = c[k];
    if (v === undefined) errors.push(`content.${k} is missing`);
    else if (typeof v !== "string") errors.push(`content.${k} must be a string site path`);
    else if (!v.startsWith("/") || v.startsWith("//")) errors.push(`content.${k} must be a site path starting with '/' (got '${v}')`);
    else if (/\s/.test(v)) errors.push(`content.${k} must not contain whitespace (got '${v}')`);
  }
  if (errors.length) throw new Error(`${source}: malformed content map: ${errors.join("; ")}`);
  return Object.fromEntries(CONTENT_KEYS.map((k) => [k, c[k] as string])) as ContentMap;
}

/** "/" first, then each distinct anchor-less path in CONTENT_KEYS order; and what each page serves. */
export function routesFromContentMap(map: ContentMap): ContentRoutes {
  const routes = ["/"];
  const serves = new Map<string, ContentServe[]>([["/", []]]);
  for (const key of CONTENT_KEYS) {
    const target = map[key];
    const path = stripAnchor(target) || "/";
    if (!serves.has(path)) {
      routes.push(path);
      serves.set(path, []);
    }
    serves.get(path)!.push({ key, target });
  }
  return { routes, serves };
}

/** Read greenhouse.yaml (a file, or a project checkout that holds one): its content map or null, and the parsed document. */
export async function loadContentMap(fileOrDir: string): Promise<{ file: string; map: ContentMap | null; doc: unknown }> {
  let file = fileOrDir;
  try {
    if ((await stat(fileOrDir)).isDirectory()) file = join(fileOrDir, "greenhouse.yaml");
  } catch (e) {
    throw new Error(`--greenhouse-yaml ${fileOrDir}: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "no such file or directory" : (e as Error).message}`);
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    throw new Error(`cannot read ${file}: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : (e as Error).message}`);
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new Error(`${file}: invalid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  return { file, map: parseContentMap(doc, file), doc };
}
