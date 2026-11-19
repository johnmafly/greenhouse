// Runs every deterministic gate against one project and assembles checks.json.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Browser } from "playwright";
import { REPO_ROOT, assertValid, readDocument } from "../lib/schemas.ts";
import type { Checks, Gate, Submission } from "../lib/schemas.ts";
import { assetCacheGate } from "./assets.ts";
import { productVoiceGate } from "./voice.ts";
import { docsGate } from "./docs.ts";
import { axeGate, browserAvailable, launchBrowser, signupGate } from "./browser.ts";
import { cleanBuild, git, scanCorpus } from "./build.ts";
import { claimLinksGate } from "./claim-links.ts";
import { contentSections, signupStart, startRoutes } from "./content.ts";
import type { ClaimLinkOptions } from "./claim-links.ts";
import {
  canaryGate,
  deployedShaGate,
  gateError,
  linksGate,
  noindexGate,
  packageFilesGate,
  pageStructureGate,
  placeholderGate,
  readCanaries,
  readManifest,
  routesGate,
  secretsGate,
  specSamplesGate,
} from "./gates.ts";
import type { CorpusFile } from "./gates.ts";
import { readSiblings, templateLikenessGate, templateVisual, visualSignature } from "./likeness.ts";
import type { VisualInput } from "./likeness.ts";
import { browserRenderer, claimSweepGate, claimsGate, hiddenTextGate, pricingGate, reviewerInstructionGate, socialProofGate } from "./assisted.ts";
import type { ClaimsOptions, HiddenTextOptions, SweepOptions } from "./assisted.ts";
import type { Judge } from "./judge.ts";
import { greenhouseHome } from "./lock.ts";
import { lighthouseGate } from "./lighthouse.ts";
import type { LhRunner } from "./lighthouse.ts";
import { mockFiguresGate } from "./mock.ts";
import { noJsContentGate, noScrollRevealGate, reducedMotionGate } from "./motion.ts";
import { menuFooterGate, sameCtasGate } from "./playbook.ts";
import { serveStatic } from "./serve.ts";
import type { StaticServer } from "./serve.ts";
import { crawl, htmlPages, normalizeBase } from "./site.ts";
import type { Site } from "./site.ts";
import { webkitIphoneGate } from "./webkit.ts";

const require = createRequire(import.meta.url);

export interface CheckOptions {
  repo: string;
  url?: string;
  roundDir?: string;
  canaryFile?: string;
  /** Commit to check; defaults to the round's submission.yaml sha, else the repo's HEAD. */
  sha?: string;
  round?: number;
  lighthouseRuns?: number;
  lighthouseRoutes?: readonly string[];
  /** Test hook: replaces the real Lighthouse runner. */
  lighthouseRunner?: LhRunner;
  perfLockTimeoutMs?: number;
  /** Other projects' checks.json files, compared in template-likeness. */
  siblings?: string[];
  /** claim-links tuning (timeouts, 429 backoff); `now` defaults to the check start. */
  claimLinks?: ClaimLinkOptions;
  /** Evidence directory (webkit-iphone screenshots); default <round-dir>/evidence, else ~/.greenhouse/evidence/<slug>-<sha12>. */
  evidenceDir?: string;
  /** Progress lines (default: none). */
  log?: (line: string) => void;
  /** Run the assisted gates too (issue #12): two judges from different model families. */
  assisted?: AssistedOptions;
}

export interface AssistedOptions {
  judges: Judge[];
  /** Where claim sources are archived; default <round-dir>/sources, else ~/.greenhouse/archive/<slug>-<sha12>. */
  archiveDir?: string;
  claims?: Omit<ClaimsOptions, "archiveDir">;
  sweep?: SweepOptions;
  hiddenText?: HiddenTextOptions;
}

export class CheckUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckUsageError";
  }
}

function pkgVersion(name: string): string {
  try {
    return require(`${name}/package.json`).version;
  } catch {
    try {
      return JSON.parse(readFileSync(join(REPO_ROOT, "node_modules", name, "package.json"), "utf8")).version;
    } catch {
      return "unavailable";
    }
  }
}

export function toolVersions(): Record<string, string> {
  const out: Record<string, string> = {
    node: process.version,
    playwright: pkgVersion("playwright"),
    "axe-core": pkgVersion("axe-core"),
    lighthouse: pkgVersion("lighthouse"),
    "chrome-launcher": pkgVersion("chrome-launcher"),
  };
  try {
    const browsers = JSON.parse(readFileSync(join(REPO_ROOT, "node_modules", "playwright-core", "browsers.json"), "utf8"));
    const c = browsers.browsers.find((b: { name: string }) => b.name === "chromium");
    out.chromium = `${c.browserVersion} (playwright revision ${c.revision})`;
  } catch {
    out.chromium = "unavailable";
  }
  try {
    const browsers = JSON.parse(readFileSync(join(REPO_ROOT, "node_modules", "playwright-core", "browsers.json"), "utf8"));
    const w = browsers.browsers.find((b: { name: string }) => b.name === "webkit");
    out.webkit = `${w.browserVersion} (playwright revision ${w.revision})`;
  } catch {
    out.webkit = "unavailable";
  }
  const gitV = spawnSync("git", ["--version"], { encoding: "utf8" });
  out.git = gitV.status === 0 ? gitV.stdout.trim().replace(/^git version /, "") : "unavailable";
  const npmV = spawnSync("npm", ["--version"], { encoding: "utf8" });
  out.npm = npmV.status === 0 ? npmV.stdout.trim() : "unavailable";
  return out;
}

function cliVersion(): string {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
}

function roundFromDir(dir: string): number | undefined {
  const m = /(\d+)$/.exec(basename(resolve(dir)));
  return m && Number(m[1]) >= 1 ? Number(m[1]) : undefined;
}

export async function runCheck(opts: CheckOptions): Promise<Checks> {
  const log = opts.log ?? (() => undefined);
  const started_at = new Date().toISOString();
  const repo = resolve(opts.repo);
  if (!existsSync(repo)) throw new CheckUsageError(`--repo ${opts.repo} does not exist`);
  const top = git(["rev-parse", "--show-toplevel"], repo);
  if (!top.ok) throw new CheckUsageError(`--repo ${opts.repo} is not a git repository`);

  let submission: Submission | null = null;
  if (opts.roundDir) {
    const f = join(opts.roundDir, "submission.yaml");
    if (existsSync(f)) submission = assertValid<Submission>("submission", readDocument(f), f);
  }
  let sha = opts.sha ?? submission?.sha;
  if (!sha) {
    const head = git(["rev-parse", "HEAD"], repo);
    if (!head.ok) throw new CheckUsageError(`cannot read HEAD of ${opts.repo}: ${head.out}`);
    sha = head.out;
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new CheckUsageError(`not a full commit sha: ${sha}`);
  const url = opts.url ?? submission?.deployment_url;
  if (url && !/^https?:\/\//.test(url)) throw new CheckUsageError(`--url must be http(s): ${url}`);
  const round = opts.round ?? (opts.roundDir ? roundFromDir(opts.roundDir) : undefined) ?? 1;
  let canaries: string[] | null = null;
  let canaryError: string | undefined;
  if (opts.canaryFile) {
    try {
      canaries = readCanaries(opts.canaryFile);
    } catch (e) {
      canaryError = `cannot read --canary-file: ${(e as Error).message}`;
    }
  }

  const gates: Gate[] = [];
  const push = (g: Gate) => {
    gates.push(g);
    log(`${g.status.toUpperCase().padEnd(4)} ${g.id.padEnd(20)} ${g.summary}`);
  };
  /** Run one gate; a gate that throws is recorded as a failed gate instead of ending the run. */
  const guard = async <T extends Gate>(id: string, fn: () => T | Promise<T>, cls: Gate["class"] = "deterministic"): Promise<Gate> => {
    try {
      return await fn();
    } catch (e) {
      return gateError(id, e, cls);
    }
  };
  const step = async (id: string, fn: () => Gate | Promise<Gate>, cls?: Gate["class"]) => push(await guard(id, fn, cls));
  const dirty = git(["status", "--porcelain"], repo);
  if (!opts.sha && !submission && dirty.ok && dirty.out) log(`note: ${opts.repo} has uncommitted changes; check builds the committed sha ${sha.slice(0, 12)}`);

  const work = mkdtempSync(join(tmpdir(), "greenhouse-check-"));
  let server: StaticServer | null = null;
  let browser: Browser | null = null;
  try {
    log(`building ${sha.slice(0, 12)} from a clean checkout…`);
    const build = await cleanBuild(repo, sha, work);
    push(build.gate);
    await step("package-files", () => packageFilesGate(build.checkoutDir));
    await step("claim-links", () => claimLinksGate(build.checkoutDir, { now: new Date(started_at), ...opts.claimLinks }));
    // Contract v2 content map from the checked commit (falls back to the v1 routes without one).
    const content = readManifest(build.checkoutDir ?? repo).content;
    const start = startRoutes(content);
    if (start.fallback) log("note: greenhouse.yaml has no content map; using the v1 route list");
    const slug = build.manifest?.slug ?? submission?.slug ?? readManifest(repo).manifest?.slug ?? (basename(repo).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "") || "unknown");

    let base: string | null = null;
    let why = "no site to check";
    if (url) base = normalizeBase(url);
    else if (build.outputDir) {
      server = await serveStatic(build.outputDir);
      base = server.url;
      log(`serving ${build.manifest?.build.output}/ at ${base}`);
    } else why = "the build failed and no --url was given";

    await step("deployed-sha", () => deployedShaGate(base, sha, build.manifest?.slug ?? submission?.slug ?? null, why));
    let site: Site | null = null;
    if (base) {
      try {
        site = await crawl(base, start.routes);
      } catch (e) {
        why = `cannot crawl ${base}: ${(e as Error).message}`;
      }
    }
    await step("routes", () => routesGate(site, content, why));
    await step("links", () => linksGate(site, why));
    await step("page-structure", () => pageStructureGate(site, why));
    await step("placeholder", () => placeholderGate(site, why));
    await step("product-voice", () => productVoiceGate(site, why));
    await step("noindex", () => noindexGate(site, why));
    await step("spec-samples", () => specSamplesGate(build.checkoutDir, site, why));
    await step("docs", () => docsGate(site, build.checkoutDir, why));
    await step("mock-figures", () => mockFiguresGate(site, build.checkoutDir, why));
    await step("same-ctas", () => sameCtasGate(site, why));
    await step("menu-footer-parity", () => menuFooterGate(site, why));
    let browserWhy = why;
    const startBrowser = async (): Promise<Browser | null> => {
      if (!site) return null;
      const avail = await browserAvailable();
      if (!avail.ok) {
        browserWhy = `browser unavailable: ${avail.reason}`;
        return null;
      }
      try {
        return await launchBrowser();
      } catch (e) {
        browserWhy = `browser did not start: ${(e as Error).message.split("\n")[0]}`;
        return null;
      }
    };
    browser = await startBrowser();
    /** The browser, relaunched when an earlier gate's error left it disconnected (crashed or killed). */
    const liveBrowser = async (): Promise<Browser | null> => {
      if (browser && !browser.isConnected()) {
        log("note: the browser disconnected; relaunching it for the remaining gates");
        await browser.close().catch(() => undefined);
        browser = await startBrowser();
      }
      return browser;
    };

    const sib = readSiblings(opts.siblings ?? [], slug);
    let visual: VisualInput = { self: null, template: null, error: browserWhy };
    if (browser && base) {
      try {
        visual = { self: await visualSignature(browser, base), template: await templateVisual(browser) };
      } catch (e) {
        visual = { self: null, template: null, error: `screenshot failed: ${(e as Error).message.split("\n")[0]}` };
      }
    }
    await step("template-likeness", () => templateLikenessGate(site, why, sib.siblings, sib.errors, undefined, visual));

    const corpus: CorpusFile[] = scanCorpus(build.checkoutDir, build.outputDir);
    if (url && site) for (const p of site.pages.values()) if (p.body) corpus.push({ name: `deployed:${p.path}`, text: p.body });
    await step("secrets", () => secretsGate(corpus));
    await step("canary", () => canaryGate(canaries, corpus, canaryError));
    await step("asset-cache", () => assetCacheGate(site, why));
    const paths = site ? htmlPages(site).map((p) => p.path) : [];
    await step("axe", async () => axeGate(await liveBrowser(), site ? base : null, paths, browserWhy));
    await step("signup-flow", async () => signupGate(await liveBrowser(), site ? base : null, browserWhy, 12, signupStart(content)));
    await step("reduced-motion", async () => reducedMotionGate(await liveBrowser(), site ? base : null, browserWhy));
    await step("no-js-content", async () => noJsContentGate(await liveBrowser(), site ? base : null, contentSections(content), browserWhy));
    await step("no-scroll-reveal", async () => noScrollRevealGate(await liveBrowser(), site ? base : null, start.routes, browserWhy));
    const evidenceDir = opts.evidenceDir ?? (opts.roundDir ? join(opts.roundDir, "evidence") : join(greenhouseHome(), "evidence", `${slug}-${sha.slice(0, 12)}`));
    await step("webkit-iphone", async () => webkitIphoneGate(site ? base : null, start.routes, why, { evidenceDir, chromium: await liveBrowser() }));
    if (browser) {
      await browser.close().catch(() => undefined);
      browser = null;
    }
    if (site) log(`lighthouse: ${opts.lighthouseRuns ?? 5} runs per route under the perf lock…`);
    const lhAvail = opts.lighthouseRunner ? { ok: true } : site ? await browserAvailable() : { ok: false };
    await step("lighthouse", () =>
      lighthouseGate(
        site && lhAvail.ok ? base : null,
        opts.lighthouseRoutes ?? start.routes,
        { runs: opts.lighthouseRuns, runner: opts.lighthouseRunner, lockTimeoutMs: opts.perfLockTimeoutMs },
        site ? `browser unavailable: ${(lhAvail as { reason?: string }).reason ?? "unknown"}` : why,
      ),
    );

    if (opts.assisted) {
      const a = opts.assisted;
      log("assisted gates: two judges on what the mechanics cannot settle…");
      browser = await startBrowser();
      let ht: Awaited<ReturnType<typeof hiddenTextGate>>;
      try {
        ht = await hiddenTextGate(browser, site, start.routes, a.judges, a.hiddenText, site ? browserWhy : why);
      } catch (e) {
        ht = { gate: gateError("hidden-text", e, "assisted"), hidden: new Map() };
      }
      const archiveDir = a.archiveDir ?? (opts.roundDir ? join(opts.roundDir, "sources") : join(greenhouseHome(), "archive", `${slug}-${sha.slice(0, 12)}`));
      await step(
        "claims",
        async () => {
          const b = await liveBrowser();
          return claimsGate(build.checkoutDir, a.judges, { now: new Date(started_at), renderer: b ? browserRenderer(b) : null, ...a.claims, archiveDir });
        },
        "assisted",
      );
      await step("claim-sweep", () => claimSweepGate(site, build.checkoutDir, a.judges, a.sweep, why), "assisted");
      await step("pricing", () => pricingGate(site, build.checkoutDir, content, a.judges, why), "assisted");
      await step("social-proof", () => socialProofGate(site, build.checkoutDir, a.judges, why), "assisted");
      await step("reviewer-instruction", () => reviewerInstructionGate(site, a.judges, ht.hidden, why), "assisted");
      push(ht.gate);
      if (browser) {
        await browser.close().catch(() => undefined);
        browser = null;
      }
    }

    const checks: Checks = {
      schema_version: 1,
      slug,
      round,
      sha,
      deployment_url: base ?? "http://127.0.0.1/",
      cli_version: cliVersion(),
      tool_versions: toolVersions(),
      machine: hostname(),
      started_at,
      finished_at: new Date().toISOString(),
      gates,
      all_green: !gates.some((g) => g.status === "fail"),
    };
    return assertValid<Checks>("checks", checks, "checks.json");
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (server) await server.close();
    rmSync(work, { recursive: true, force: true });
  }
}
