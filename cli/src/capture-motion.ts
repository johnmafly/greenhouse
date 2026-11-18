// Motion evidence for greenhouse capture (design bar v2, section 4).
// Reviewers cannot judge motion from stills, so for the home page and the signup start, at
// desktop and phone, capture records a steady top-to-bottom scroll video (webm) and a
// 12-frame strip PNG (evenly spaced scroll positions, composed into one grid image for
// reviewers whose model reads images, not video), plus one reduced-motion strip of the home
// page at desktop. Motion contexts emulate prefers-reduced-motion: no-preference, unlike the
// stills, which are captured with reduce.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";

export type ViewportName = "desktop" | "mobile";
export type ViewportSpec = { width: number; height: number; deviceScaleFactor: number; isMobile: boolean; hasTouch: boolean };
export type MotionKind = "scroll_video" | "frame_strip" | "frame_strip_reduced_motion";

/** A page motion is captured for; roles says why (home, signup, or both when they share a path). */
export type MotionTarget = { page: string; roles: ("home" | "signup")[] };

export type MotionTiming = {
  /** Video: still at the top before scrolling. */
  holdTopMs: number;
  /** Video: steady scroll from top to bottom. */
  scrollMs: number;
  /** Video: still at the bottom after scrolling. */
  holdBottomMs: number;
  /** Video: one scroll step every stepMs (scrollMs / stepMs steps). */
  stepMs: number;
  /** Strip: wait at each position so scroll-linked animation settles before the screenshot. */
  settleMs: number;
  /** Strip: frames per strip, top and bottom included. */
  frames: number;
};

export const DEFAULT_MOTION_TIMING: MotionTiming = { holdTopMs: 1000, scrollMs: 11_000, holdBottomMs: 1500, stepMs: 50, settleMs: 600, frames: 12 };

/** Grid layout per viewport: desktop frames at half scale in 4x3, phone frames at CSS size in 6x2. */
export const STRIP_LAYOUT: Record<ViewportName, { columns: number; frame_scale: number }> = {
  desktop: { columns: 4, frame_scale: 0.5 },
  mobile: { columns: 6, frame_scale: 1 },
};

export type MotionEntry = {
  kind: MotionKind;
  path: string;
  page: string;
  roles: ("home" | "signup")[];
  url: string;
  final_url: string;
  status: number | null;
  viewport: ViewportName;
  viewport_size: { width: number; height: number };
  reduced_motion: boolean;
  /** Frames in a strip; null for a video (Playwright records about 25 fps). */
  frames: number | null;
  /** Video: length of the recording. Strip: wall time spent capturing its frames. */
  duration_ms: number;
  /** Document height when the capture finished, in CSS px. */
  page_height: number;
  scroll?: { steps: number; step_ms: number; hold_top_ms: number; scroll_ms: number; hold_bottom_ms: number };
  scroll_positions?: number[];
  settle_ms?: number;
  layout?: { columns: number; rows: number; frame_scale: number; frame_size: { width: number; height: number } };
};

export function pageSlug(page: string): string {
  return page.replace(/[?#].*$/, "").split("/").filter(Boolean).join("-").replace(/[^a-zA-Z0-9._-]/g, "_") || "home";
}

/** Home "/" and the signup start, deduplicated by path (anchors dropped). */
export function motionTargets(signupPath: string): MotionTarget[] {
  const signup = signupPath.replace(/#.*$/, "") || "/";
  if (signup === "/") return [{ page: "/", roles: ["home", "signup"] }];
  return [
    { page: "/", roles: ["home"] },
    { page: signup, roles: ["signup"] },
  ];
}

/** Evenly spaced scroll offsets from 0 to max inclusive. */
export function stripPositions(max: number, frames: number): number[] {
  if (frames < 2) return [0];
  return Array.from({ length: frames }, (_, i) => Math.round((i * Math.max(0, max)) / (frames - 1)));
}

type Ctx = {
  browser: Browser;
  base: URL;
  tmp: string;
  viewports: Record<ViewportName, ViewportSpec>;
  headers: Record<string, string>;
  timing: MotionTiming;
  timeoutMs: number;
};

function contextOptions(ctx: Ctx, vp: ViewportName, reduced: boolean): BrowserContextOptions {
  const v = ctx.viewports[vp];
  return {
    viewport: { width: v.width, height: v.height },
    deviceScaleFactor: v.deviceScaleFactor,
    isMobile: v.isMobile,
    hasTouch: v.hasTouch,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: reduced ? "reduce" : "no-preference",
    extraHTTPHeaders: ctx.headers,
  };
}

async function open(page: Page, url: string, timeoutMs: number): Promise<number | null> {
  const resp = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  return resp?.status() ?? null;
}

const pageHeight = (page: Page) => page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));

async function recordScroll(ctx: Ctx, target: MotionTarget, vp: ViewportName): Promise<MotionEntry> {
  const v = ctx.viewports[vp];
  const videoDir = await mkdtemp(join(tmpdir(), "gh-video-"));
  const t = ctx.timing;
  const steps = Math.max(1, Math.round(t.scrollMs / t.stepMs));
  let context: BrowserContext | null = null;
  try {
    context = await ctx.browser.newContext({ ...contextOptions(ctx, vp, false), recordVideo: { dir: videoDir, size: { width: v.width, height: v.height } } });
    const page = await context.newPage();
    const started = Date.now();
    const url = new URL(target.page, ctx.base).toString();
    const status = await open(page, url, ctx.timeoutMs);
    // Deterministic steady scroll: step i lands at i/steps of the (live) scroll range at start + i*stepMs.
    await page.evaluate(
      async ({ steps, stepMs, holdTopMs, holdBottomMs }) => {
        const max = () => Math.max(0, Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0) - window.innerHeight);
        const sleepUntil = (t: number) => new Promise((r) => setTimeout(r, Math.max(0, t - performance.now())));
        window.scrollTo({ top: 0, behavior: "instant" });
        await sleepUntil(performance.now() + holdTopMs);
        const t0 = performance.now();
        for (let i = 1; i <= steps; i++) {
          await sleepUntil(t0 + i * stepMs);
          window.scrollTo({ top: Math.round((i / steps) * max()), behavior: "instant" });
        }
        await sleepUntil(performance.now() + holdBottomMs);
      },
      { steps, stepMs: t.stepMs, holdTopMs: t.holdTopMs, holdBottomMs: t.holdBottomMs },
    );
    const height = await pageHeight(page);
    const finalUrl = page.url();
    const video = page.video();
    await page.close();
    const duration = Date.now() - started;
    const rel = `motion/${pageSlug(target.page)}-${vp}-scroll.webm`;
    if (!video) throw new Error("Playwright did not record a video");
    await video.saveAs(join(ctx.tmp, rel));
    return {
      kind: "scroll_video",
      path: rel,
      page: target.page,
      roles: target.roles,
      url,
      final_url: finalUrl,
      status,
      viewport: vp,
      viewport_size: { width: v.width, height: v.height },
      reduced_motion: false,
      frames: null,
      duration_ms: duration,
      page_height: height,
      scroll: { steps, step_ms: t.stepMs, hold_top_ms: t.holdTopMs, scroll_ms: steps * t.stepMs, hold_bottom_ms: t.holdBottomMs },
    };
  } finally {
    await context?.close().catch(() => {});
    await rm(videoDir, { recursive: true, force: true });
  }
}

type Frames = { shots: Buffer[]; positions: number[]; status: number | null; url: string; finalUrl: string; height: number; ms: number };

async function captureFrames(ctx: Ctx, target: MotionTarget, vp: ViewportName, reduced: boolean): Promise<Frames> {
  const context = await ctx.browser.newContext(contextOptions(ctx, vp, reduced));
  try {
    const page = await context.newPage();
    const started = Date.now();
    const url = new URL(target.page, ctx.base).toString();
    const status = await open(page, url, ctx.timeoutMs);
    const n = ctx.timing.frames;
    const shots: Buffer[] = [];
    const positions: number[] = [];
    await page.waitForTimeout(ctx.timing.settleMs);
    for (let i = 0; i < n; i++) {
      // Scroll there in small steps (like a reader), against the live range, then let it settle.
      await page.evaluate(
        async ({ i, n }) => {
          const max = Math.max(0, Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0) - window.innerHeight);
          const target = n < 2 ? 0 : Math.round((i * max) / (n - 1));
          const step = Math.max(40, Math.round(window.innerHeight / 4));
          for (let y = window.scrollY; Math.abs(target - y) > step; ) {
            y += target > y ? step : -step;
            window.scrollTo({ top: y, behavior: "instant" });
            await new Promise((r) => setTimeout(r, 16));
          }
          window.scrollTo({ top: target, behavior: "instant" });
          return target;
        },
        { i, n },
      );
      await page.waitForTimeout(ctx.timing.settleMs);
      shots.push(await page.screenshot({ scale: "css", caret: "hide" }));
      positions.push(Math.round(await page.evaluate(() => window.scrollY)));
    }
    return { shots, positions, status, url, finalUrl: page.url(), height: await pageHeight(page), ms: Date.now() - started };
  } finally {
    await context.close();
  }
}

/** Compose frames into one PNG with a header and a label per frame, rendered in the browser. */
async function composeStrip(browser: Browser, frames: Frames, vp: ViewportSpec, layout: { columns: number; frame_scale: number }, title: string): Promise<{ png: Buffer; rows: number; frame: { width: number; height: number } }> {
  const fw = Math.round(vp.width * layout.frame_scale);
  const fh = Math.round(vp.height * layout.frame_scale);
  const rows = Math.ceil(frames.shots.length / layout.columns);
  const gap = 10;
  const width = layout.columns * fw + (layout.columns + 1) * gap;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const cells = frames.shots
    .map((s, i) => `<figure><img width="${fw}" height="${fh}" src="data:image/png;base64,${s.toString("base64")}"><figcaption>${i + 1}/${frames.shots.length} &middot; y=${frames.positions[i]}px</figcaption></figure>`)
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#1b1b1f;color:#f2f2f2;font:600 18px/1.3 -apple-system,system-ui,sans-serif}
header{padding:${gap}px ${gap}px 0}main{display:grid;grid-template-columns:repeat(${layout.columns},${fw}px);gap:${gap}px;padding:${gap}px}
figure{margin:0}img{display:block;outline:1px solid #555}figcaption{padding-top:4px;font-size:15px;color:#cfcfd4}
</style></head><body><header>${esc(title)}</header><main>${cells}</main></body></html>`;
  const context = await browser.newContext({ viewport: { width, height: 400 }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => Promise.all(Array.from(document.images).map((i) => i.decode())));
    return { png: await page.screenshot({ fullPage: true }), rows, frame: { width: fw, height: fh } };
  } finally {
    await context.close();
  }
}

async function frameStrip(ctx: Ctx, target: MotionTarget, vp: ViewportName, reduced: boolean): Promise<MotionEntry> {
  const frames = await captureFrames(ctx, target, vp, reduced);
  const v = ctx.viewports[vp];
  const layout = STRIP_LAYOUT[vp];
  const title = `${frames.finalUrl}  ·  ${vp} ${v.width}x${v.height}  ·  prefers-reduced-motion: ${reduced ? "reduce" : "no-preference"}  ·  ${frames.shots.length} frames, top to bottom, ${ctx.timing.settleMs} ms settle  ·  page ${frames.height}px tall`;
  const { png, rows, frame } = await composeStrip(ctx.browser, frames, v, layout, title);
  const rel = `motion/${pageSlug(target.page)}-${vp}-strip${reduced ? "-reduced-motion" : ""}.png`;
  await writeFile(join(ctx.tmp, rel), png);
  return {
    kind: reduced ? "frame_strip_reduced_motion" : "frame_strip",
    path: rel,
    page: target.page,
    roles: target.roles,
    url: frames.url,
    final_url: frames.finalUrl,
    status: frames.status,
    viewport: vp,
    viewport_size: { width: v.width, height: v.height },
    reduced_motion: reduced,
    frames: frames.shots.length,
    duration_ms: frames.ms,
    page_height: frames.height,
    scroll_positions: frames.positions,
    settle_ms: ctx.timing.settleMs,
    layout: { columns: layout.columns, rows, frame_scale: layout.frame_scale, frame_size: frame },
  };
}

/**
 * Capture every motion artifact into <tmp>/motion. Jobs for one page run in parallel (each in
 * its own browser context), pages one after another. Entries come back in a stable order.
 */
export async function captureMotion(opts: {
  browser: Browser;
  base: URL;
  tmp: string;
  targets: MotionTarget[];
  viewports: Record<ViewportName, ViewportSpec>;
  headers: Record<string, string>;
  timing?: Partial<MotionTiming>;
  timeoutMs: number;
  log: (msg: string) => void;
}): Promise<MotionEntry[]> {
  const ctx: Ctx = { ...opts, timing: { ...DEFAULT_MOTION_TIMING, ...opts.timing } };
  await mkdir(join(opts.tmp, "motion"), { recursive: true });
  const entries: MotionEntry[] = [];
  for (const target of opts.targets) {
    const jobs: (() => Promise<MotionEntry>)[] = [];
    for (const vp of ["desktop", "mobile"] as const) {
      jobs.push(() => recordScroll(ctx, target, vp));
      jobs.push(() => frameStrip(ctx, target, vp, false));
    }
    if (target.roles.includes("home")) jobs.push(() => frameStrip(ctx, target, "desktop", true));
    const started = Date.now();
    try {
      entries.push(...(await Promise.all(jobs.map((j) => j()))));
    } catch (e) {
      throw new Error(`motion capture of ${target.page} failed: ${(e as Error).message.split("\n")[0]}`);
    }
    opts.log(`captured motion for ${target.page} (${target.roles.join("+")}) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  return entries;
}
