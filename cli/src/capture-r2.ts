// Upload an evidence bundle to a private R2 bucket through the Cloudflare API.
// Keys are content-addressed: <prefix>/sha256/<hash> for every file and for manifest.json,
// plus <prefix>/bundles/<bundle_hash>.json (the manifest) so a bundle can be found by its hash.
// The token is read from CLOUDFLARE_API_TOKEN only and never printed or written anywhere.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MANIFEST_FILE, sha256, type Manifest } from "./capture-manifest.ts";

const API = "https://api.cloudflare.com/client/v4";

export type R2Target = { bucket: string; prefix: string };
export type UploadedObject = { key: string; path: string; bytes: number };
type FetchFn = typeof fetch;

/** "<bucket>/<prefix>" -> {bucket, prefix}; prefix may be empty. */
export function parseR2Target(spec: string): R2Target {
  const m = /^([a-z0-9][a-z0-9-]{1,61}[a-z0-9])(?:\/(.*))?$/.exec(spec);
  if (!m) throw new Error(`--r2 must be <bucket>/<prefix> with a valid bucket name, got '${spec}'`);
  const prefix = (m[2] ?? "").replace(/^\/+|\/+$/g, "");
  if (prefix.split("/").some((s) => s === "." || s === "..")) throw new Error("--r2 prefix must not contain . or .. segments");
  return { bucket: m[1], prefix };
}

export function objectKey(prefix: string, rest: string): string {
  return prefix ? `${prefix}/${rest}` : rest;
}

export function contentType(path: string): string {
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webm")) return "video/webm";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "application/octet-stream";
}

async function cfJson(res: Response, what: string): Promise<any> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok || !body?.success) {
    const errs = (body?.errors ?? []).map((e: any) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`${what} failed (HTTP ${res.status})${errs ? `: ${errs}` : ""}`);
  }
  return body.result;
}

/** CLOUDFLARE_ACCOUNT_ID, else the token's only account. */
export async function resolveAccountId(token: string, env: NodeJS.ProcessEnv, fetchFn: FetchFn): Promise<string> {
  if (env.CLOUDFLARE_ACCOUNT_ID) return env.CLOUDFLARE_ACCOUNT_ID;
  const res = await fetchFn(`${API}/accounts`, { headers: { Authorization: `Bearer ${token}` } });
  const accounts = (await cfJson(res, "list accounts")) as { id: string }[];
  if (accounts.length !== 1) throw new Error(`token sees ${accounts.length} accounts; set CLOUDFLARE_ACCOUNT_ID`);
  return accounts[0].id;
}

export async function uploadBundle(
  dir: string,
  manifest: Manifest,
  target: R2Target,
  opts: { env?: NodeJS.ProcessEnv; fetchFn?: FetchFn } = {},
): Promise<{ bucket: string; objects: UploadedObject[] }> {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchFn ?? fetch;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set in the environment");
  const account = await resolveAccountId(token, env, fetchFn);
  const base = `${API}/accounts/${account}/r2/buckets/${encodeURIComponent(target.bucket)}/objects/`;
  const manifestBytes = await readFile(join(dir, MANIFEST_FILE));
  const manifestHash = sha256(manifestBytes);

  const plan: { key: string; path: string; body: Buffer<ArrayBuffer> }[] = [];
  for (const f of manifest.files) {
    const body = await readFile(join(dir, f.path));
    if (sha256(body) !== f.sha256) throw new Error(`refusing upload: ${f.path} changed since the manifest was written`);
    plan.push({ key: objectKey(target.prefix, `sha256/${f.sha256}`), path: f.path, body });
  }
  plan.push({ key: objectKey(target.prefix, `sha256/${manifestHash}`), path: MANIFEST_FILE, body: manifestBytes });
  plan.push({ key: objectKey(target.prefix, `bundles/${manifest.bundle_hash}.json`), path: MANIFEST_FILE, body: manifestBytes });

  const objects: UploadedObject[] = [];
  for (const o of plan) {
    const url = base + o.key.split("/").map(encodeURIComponent).join("/");
    const res = await fetchFn(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType(o.path) },
      body: o.body,
    });
    await cfJson(res, `upload ${o.key}`);
    objects.push({ key: o.key, path: o.path, bytes: o.body.byteLength });
  }
  return { bucket: target.bucket, objects };
}
