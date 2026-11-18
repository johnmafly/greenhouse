// claim-links gate: every external source_url in claims.yaml must resolve.
//
// Policy (build lead, 2026-11-18; written into docs/package-contract.md):
//   2xx/3xx after redirects                -> ok
//   401/403/429 ("refused automation")      -> warn only when every claim citing the URL has a
//                                             non-empty quote and `checked` within 30 days of the
//                                             check run; otherwise fail. 429 is retried once.
//   404/410/5xx/other 4xx, DNS error, timeout -> fail
//   more than 20% of the claim URLs refused -> the gate fails
// Each URL's status and class is recorded in details so judges can spot-check refused ones.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Gate } from "../lib/schemas.ts";
import { gate } from "./gates.ts";

export const CLAIM_LINKS_ID = "claim-links";
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
export const REFUSED_STATUSES = new Set([401, 403, 429]);
export const MAX_REFUSED_SHARE = 0.2;
export const MAX_CHECKED_AGE_DAYS = 30;

export type UrlClass = "ok" | "refused" | "broken";

export interface UrlResult {
  url: string;
  /** Final HTTP status, or an error label (`dns`, `timeout`, `network: …`). */
  status: number | string;
  class: UrlClass;
  /** Request that produced the status. */
  method: "HEAD" | "GET";
  /** Claim ids that cite this URL. */
  claims: string[];
  /** For refused URLs: whether every citing claim has a quote and a fresh `checked` date. */
  accepted?: boolean;
  note?: string;
}

export interface ClaimLinkOptions {
  /** When the check started; `checked` ages are measured from here. */
  now?: Date;
  timeoutMs?: number;
  /** Wait before the single 429 retry. */
  retryDelayMs?: number;
  concurrency?: number;
}

interface ClaimRef {
  id: string;
  url: string;
  quote: unknown;
  checked: unknown;
}

/** Reads source_url entries from claims.yaml without requiring the whole file to be schema-valid
 *  (package-files reports schema problems; this gate still checks every URL it can find). */
export function readClaimUrls(dir: string): { refs: ClaimRef[]; error?: string } {
  const file = join(dir, "claims.yaml");
  if (!existsSync(file)) return { refs: [], error: "claims.yaml is missing" };
  let doc: any;
  try {
    doc = parseYaml(readFileSync(file, "utf8"));
  } catch (e) {
    return { refs: [], error: `claims.yaml does not parse: ${(e as Error).message.split("\n")[0]}` };
  }
  if (!doc || !Array.isArray(doc.claims)) return { refs: [], error: "claims.yaml has no claims list" };
  const refs: ClaimRef[] = [];
  doc.claims.forEach((c: any, i: number) => {
    if (!c || typeof c.source_url !== "string" || !/^https?:\/\//.test(c.source_url)) return;
    refs.push({ id: typeof c.id === "string" ? c.id : `#${i + 1}`, url: c.source_url.trim(), quote: c.quote, checked: c.checked });
  });
  return { refs };
}

function errorLabel(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  const code = err?.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME") return "dns";
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "ETIMEDOUT") return "timeout";
  return `network: ${code ?? err?.cause?.message ?? err?.message ?? String(e)}`.slice(0, 200);
}

export function classifyStatus(status: number | string): UrlClass {
  if (typeof status === "string") return "broken";
  if (status >= 200 && status < 400) return "ok";
  if (REFUSED_STATUSES.has(status)) return "refused";
  return "broken";
}

async function request(url: string, method: "HEAD" | "GET", timeoutMs: number): Promise<number | string> {
  try {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent": BROWSER_USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  } catch (e) {
    return errorLabel(e);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HEAD, then GET when HEAD does not succeed; a 429 is retried once after a backoff. */
export async function probeUrl(url: string, opts: ClaimLinkOptions = {}): Promise<{ status: number | string; method: "HEAD" | "GET"; note?: string }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const head = await request(url, "HEAD", timeoutMs);
  if (classifyStatus(head) === "ok") return { status: head, method: "HEAD" };
  if (head === "dns") return { status: head, method: "HEAD" };
  let status = await request(url, "GET", timeoutMs);
  if (status === 429) {
    await sleep(opts.retryDelayMs ?? 3_000);
    status = await request(url, "GET", timeoutMs);
    return { status, method: "GET", note: "429 retried once" };
  }
  return { status, method: "GET" };
}

function fresh(checked: unknown, now: Date): boolean {
  const s = checked instanceof Date ? checked.toISOString().slice(0, 10) : typeof checked === "string" ? checked : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  // Whole days between the check run's UTC date and `checked`; one day of clock skew allowed ahead.
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.round((today - t) / 86_400_000);
  return days >= -1 && days <= MAX_CHECKED_AGE_DAYS;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function claimLinksGate(dir: string | null, opts: ClaimLinkOptions = {}): Promise<Gate> {
  const id = CLAIM_LINKS_ID;
  if (!dir) return gate(id, "fail", "cannot run: no clean checkout of the submitted sha");
  const { refs, error } = readClaimUrls(dir);
  if (error) return gate(id, "fail", `cannot run: ${error}`);
  const now = opts.now ?? new Date();

  const byUrl = new Map<string, ClaimRef[]>();
  for (const r of refs) {
    if (!byUrl.has(r.url)) byUrl.set(r.url, []);
    (byUrl.get(r.url) as ClaimRef[]).push(r);
  }
  const urls = [...byUrl.keys()].sort();
  if (urls.length === 0) return gate(id, "pass", "claims.yaml cites no external URLs", { urls: 0, ok: 0, refused: 0, broken: 0 });

  const results: UrlResult[] = await mapLimit(urls, opts.concurrency ?? 6, async (url) => {
    const probe = await probeUrl(url, opts);
    const cls = classifyStatus(probe.status);
    const claims = byUrl.get(url) as ClaimRef[];
    const r: UrlResult = { url, status: probe.status, class: cls, method: probe.method, claims: claims.map((c) => c.id) };
    if (cls === "refused") r.accepted = claims.every((c) => typeof c.quote === "string" && c.quote.trim().length > 0 && fresh(c.checked, now));
    if (probe.note) r.note = probe.note;
    return r;
  });

  const ok = results.filter((r) => r.class === "ok");
  const refused = results.filter((r) => r.class === "refused");
  const broken = results.filter((r) => r.class === "broken");
  const unaccepted = refused.filter((r) => !r.accepted);
  const share = refused.length / results.length;
  const metrics = {
    urls: results.length,
    ok: ok.length,
    refused: refused.length,
    broken: broken.length,
    refused_unaccepted: unaccepted.length,
    refused_share: Math.round(share * 1000) / 1000,
  };
  const details = { checked_against: now.toISOString().slice(0, 10), urls: results };

  const problems: string[] = [];
  if (broken.length) problems.push(`${broken.length} broken`);
  if (unaccepted.length) problems.push(`${unaccepted.length} refused automation without a quote and a \`checked\` date within ${MAX_CHECKED_AGE_DAYS} days`);
  if (share > MAX_REFUSED_SHARE) problems.push(`${refused.length}/${results.length} refused automation (over ${MAX_REFUSED_SHARE * 100}%)`);
  if (problems.length) return gate(id, "fail", `claim URLs: ${problems.join("; ")}`, metrics, details);
  if (refused.length)
    return gate(id, "warn", `${ok.length}/${results.length} claim URLs resolve; ${refused.length} refused automation (quoted and checked recently, spot-check them)`, metrics, details);
  return gate(id, "pass", `all ${results.length} claim URLs resolve`, metrics, details);
}
