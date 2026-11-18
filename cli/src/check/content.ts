// Package contract v2: the `content` map in greenhouse.yaml says where each required piece of
// content lives. Only `/`, `/.well-known/greenhouse.json` and a 404 page are fixed routes; the
// Chief designs the rest of the IA. Without a content map the check falls back to the v1 routes.
import { REQUIRED_ROUTES } from "./site.ts";

export const CONTENT_KEYS = ["how_it_works", "getting_started", "architecture", "integration", "comparison", "pricing", "signup"] as const;
export type ContentKey = (typeof CONTENT_KEYS)[number];

export interface ContentRef {
  key: ContentKey;
  /** Site path without the anchor, e.g. "/docs/start/". */
  path: string;
  /** Fragment id without "#", or null. */
  anchor: string | null;
  /** The value as written in greenhouse.yaml. */
  raw: string;
}

export interface ContentMap {
  /** Whether greenhouse.yaml has a `content` key at all. */
  present: boolean;
  /** Valid entries, in CONTENT_KEYS order. */
  refs: ContentRef[];
  /** Problems with the map (missing keys, bad paths, unknown keys). */
  errors: string[];
}

/** v1 equivalents of the content keys, used only for the signup start when there is no map. */
const V1_PATHS: Record<ContentKey, string> = {
  how_it_works: "/docs/how-it-works/",
  getting_started: "/docs/getting-started/",
  architecture: "/docs/architecture/",
  integration: "/docs/integration/",
  comparison: "/docs/comparison/",
  pricing: "/pricing/",
  signup: "/signup/",
};

// A site path: starts with one "/", no scheme or host, no query, no "..", no whitespace;
// optionally "#anchor".
const PATH_RE = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const ANCHOR_RE = /^[^\s#]+$/;

export function parseContentRef(key: ContentKey, value: unknown): { ref?: ContentRef; error?: string } {
  if (typeof value !== "string" || !value.trim()) return { error: `content.${key} must be a site path such as /docs/start/ or /#plans` };
  const raw = value.trim();
  const hash = raw.indexOf("#");
  const path = hash === -1 ? raw : raw.slice(0, hash);
  const anchor = hash === -1 ? null : raw.slice(hash + 1);
  if (!PATH_RE.test(path) || path.split("/").includes("..") || raw.length > 300)
    return { error: `content.${key}: ${JSON.stringify(raw)} is not a site path (start with /, no host, query or ..)` };
  if (anchor !== null && !ANCHOR_RE.test(anchor)) return { error: `content.${key}: ${JSON.stringify(raw)} has an empty or invalid #anchor` };
  return { ref: { key, path, anchor: anchor === null ? null : decodeURIComponent(anchor), raw } };
}

export function parseContentMap(doc: unknown): ContentMap {
  const content = doc && typeof doc === "object" ? (doc as Record<string, unknown>).content : undefined;
  if (content === undefined || content === null) return { present: false, refs: [], errors: [] };
  if (typeof content !== "object" || Array.isArray(content))
    return { present: true, refs: [], errors: ["greenhouse.yaml: content must be a mapping of the seven required keys to site paths"] };
  const map = content as Record<string, unknown>;
  const refs: ContentRef[] = [];
  const errors: string[] = [];
  for (const key of CONTENT_KEYS) {
    if (!(key in map)) {
      errors.push(`greenhouse.yaml: content.${key} is missing`);
      continue;
    }
    const r = parseContentRef(key, map[key]);
    if (r.ref) refs.push(r.ref);
    else errors.push(`greenhouse.yaml: ${r.error}`);
  }
  for (const key of Object.keys(map)) if (!(CONTENT_KEYS as readonly string[]).includes(key)) errors.push(`greenhouse.yaml: content.${key} is not a known key (${CONTENT_KEYS.join(", ")})`);
  return { present: true, refs, errors };
}

/** Routes the check starts from: "/" plus the content paths, or the v1 list without a map. */
export function startRoutes(map: ContentMap | null): { routes: string[]; fallback: boolean } {
  if (!map?.present) return { routes: [...REQUIRED_ROUTES], fallback: true };
  const routes = ["/"];
  for (const r of map.refs) if (!routes.includes(r.path)) routes.push(r.path);
  return { routes, fallback: false };
}

/** Where the mock signup starts (path plus optional #anchor). */
export function signupStart(map: ContentMap | null): string {
  if (!map?.present) return V1_PATHS.signup;
  return map.refs.find((r) => r.key === "signup")?.raw ?? V1_PATHS.signup;
}

/**
 * Content sections the no-JS gate reads: "/" plus each content entry, or the v1 routes as
 * whole pages without a map.
 */
export function contentSections(map: ContentMap | null): { label: string; path: string; anchor: string | null }[] {
  if (!map?.present) return REQUIRED_ROUTES.map((p) => ({ label: p, path: p, anchor: null }));
  return [{ label: "home", path: "/", anchor: null }, ...map.refs.map((r) => ({ label: r.key, path: r.path, anchor: r.anchor }))];
}
