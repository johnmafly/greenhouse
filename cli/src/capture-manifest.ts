// Evidence bundle manifest: per-file sha256 and a bundle hash.
//
// bundle_hash = sha256 of the canonical JSON (keys sorted recursively, no whitespace)
// of manifest.json with the bundle_hash field removed. It therefore covers every
// file's hash and size plus all capture metadata (url, routes, statuses, versions).
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const MANIFEST_FILE = "manifest.json";

export type FileEntry = { path: string; sha256: string; bytes: number };
export type Manifest = { bundle_hash?: string; files: FileEntry[]; [key: string]: unknown };

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with object keys sorted at every level and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function computeBundleHash(manifest: Manifest): string {
  const { bundle_hash: _omit, ...rest } = manifest;
  return sha256(canonicalJson(rest));
}

/** Every regular file under dir except manifest.json, as POSIX paths sorted bytewise. */
export async function listBundleFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile()) {
        const rel = relative(dir, p).split(sep).join("/");
        if (rel !== MANIFEST_FILE) out.push(rel);
      } else throw new Error(`unsupported entry in bundle (not a file or directory): ${p}`);
    }
  }
  await walk(dir);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function hashFiles(dir: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  for (const path of await listBundleFiles(dir)) {
    const buf = await readFile(join(dir, path));
    files.push({ path, sha256: sha256(buf), bytes: buf.byteLength });
  }
  return files;
}

/** Hash every file in dir and return the metadata plus files and bundle_hash. */
export async function buildManifest(dir: string, meta: Record<string, unknown>): Promise<Manifest> {
  const manifest: Manifest = { ...meta, files: await hashFiles(dir) };
  manifest.bundle_hash = computeBundleHash(manifest);
  return manifest;
}

export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export type VerifyResult = { ok: boolean; errors: string[]; bundle_hash?: string };

/** Recompute every file hash and the bundle hash; report any mismatch, missing or extra file. */
export async function verifyBundle(dir: string): Promise<VerifyResult> {
  const errors: string[] = [];
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, MANIFEST_FILE), "utf8"));
  } catch (e) {
    return { ok: false, errors: [`cannot read ${MANIFEST_FILE}: ${(e as Error).message}`] };
  }
  if (!Array.isArray(manifest.files)) return { ok: false, errors: ["manifest has no files[]"] };
  const actual = new Map((await hashFiles(dir)).map((f) => [f.path, f]));
  const listed = new Set<string>();
  for (const f of manifest.files) {
    listed.add(f.path);
    const a = actual.get(f.path);
    if (!a) errors.push(`missing file: ${f.path}`);
    else if (a.sha256 !== f.sha256) errors.push(`sha256 mismatch: ${f.path}`);
    else if (a.bytes !== f.bytes) errors.push(`size mismatch: ${f.path}`);
  }
  for (const p of actual.keys()) if (!listed.has(p)) errors.push(`file not in manifest: ${p}`);
  const expected = computeBundleHash(manifest);
  if (manifest.bundle_hash !== expected) errors.push(`bundle_hash mismatch: manifest says ${manifest.bundle_hash}, computed ${expected}`);
  return { ok: errors.length === 0, errors, bundle_hash: manifest.bundle_hash };
}

/** True when p (or its nearest existing ancestor) is inside a git checkout. */
export async function insideGitCheckout(p: string): Promise<string | null> {
  let d = p;
  for (;;) {
    try {
      await stat(join(d, ".git"));
      return d;
    } catch {}
    const parent = join(d, "..");
    if (parent === d) return null;
    d = parent;
  }
}
