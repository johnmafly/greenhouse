// Motion guardrails (contract v2, design-bar spec section 2), on the pinned Playwright Chromium:
//   reduced-motion: with prefers-reduced-motion: reduce, scrolling the home page runs no
//     transform/opacity animation longer than 200 ms and no scroll-linked animation, and all
//     content is visible once it is in view.
//   no-scroll-reveal (decision 0008, rule 2): with JavaScript on and the page not scrolled, no text
//     in <main> waits at opacity 0 or visibility hidden for a scroll to reveal it.
//   no-js-content: with JavaScript disabled, every required content section renders visible text
//     (nothing stuck at opacity 0 waiting for a scroll-reveal script).
import type { Browser, Page } from "playwright";
import type { Gate } from "../lib/schemas.ts";
import { gate } from "./gates.ts";

export const MAX_REDUCED_MOTION_MS = 200;
const VIEWPORT = { width: 1440, height: 900 };
const SCROLL_STEP = 700;
const MAX_STEPS = 40;
/** Wait after a scroll before sampling: anything still moving after this ran longer than 200 ms. */
const SETTLE_MS = 250;

interface TextScanArg {
  /** Element id to scope to (else <main>, else <body>). */
  anchor: string | null;
  /** Only elements that intersect the viewport. */
  viewportOnly: boolean;
  /** More selectors whose content is not counted (menus, dialogs, tab panels). */
  skip?: string;
}
interface TextScan {
  found: boolean;
  visibleChars: number;
  hidden: { selector: string; text: string; opacity: number; visibility: string }[];
}

/**
 * In the page: text-bearing elements that are laid out (have a box) but cannot be seen, because
 * their effective opacity (product over ancestors) is under 0.05 or they are visibility:hidden.
 * display:none content (closed tabs, later signup steps) has no box and is not counted.
 */
function scanText(arg: TextScanArg): TextScan {
  const sel = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const cls = [...el.classList].slice(0, 3).map((c) => `.${c}`).join("");
    const parent = el.parentElement ? el.parentElement.tagName.toLowerCase() + (el.parentElement.id ? `#${el.parentElement.id}` : "") + " > " : "";
    return parent + tag + cls;
  };
  let root: Element | null = null;
  if (arg.anchor) {
    root = document.getElementById(arg.anchor) ?? document.querySelector(`a[name="${CSS.escape(arg.anchor)}"]`);
    if (root && !(root.textContent ?? "").trim()) root = root.closest("section, article, main") ?? root.parentElement;
  } else root = document.querySelector("main") ?? document.body;
  if (!root) return { found: false, visibleChars: 0, hidden: [] };
  const skip = "script, style, noscript, template, svg, [aria-hidden='true'], [role='tooltip'], [hidden]" + (arg.skip ? `, ${arg.skip}` : "");
  let visibleChars = 0;
  const hidden: TextScan["hidden"] = [];
  const els = [root, ...root.querySelectorAll("*")];
  for (const el of els) {
    if (el.closest(skip)) continue;
    let own = "";
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent ?? "";
    own = own.replace(/\s+/g, " ").trim();
    if (!own) continue;
    const rects = el.getClientRects();
    if (rects.length === 0) continue;
    if (arg.viewportOnly) {
      const r = el.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
    }
    const style = getComputedStyle(el);
    let opacity = 1;
    for (let a: Element | null = el; a; a = a.parentElement) opacity *= Number(getComputedStyle(a).opacity);
    if (opacity < 0.05 || style.visibility !== "visible") {
      hidden.push({ selector: sel(el), text: own.slice(0, 80), opacity: Math.round(opacity * 100) / 100, visibility: style.visibility });
    } else visibleChars += own.length;
  }
  return { found: true, visibleChars, hidden };
}

interface AnimInfo {
  selector: string;
  kind: string;
  name: string;
  props: string[];
  duration_ms: number | "infinite";
  scroll_linked: boolean;
}

/** In the page: running animations that break reduced motion. */
function motionAnimations(maxMs: number): AnimInfo[] {
  const sel = (el: Element | null): string => {
    if (!el) return "(none)";
    const tag = el.tagName.toLowerCase();
    return el.id ? `${tag}#${el.id}` : tag + [...el.classList].slice(0, 3).map((c) => `.${c}`).join("");
  };
  const MOTION = new Set(["transform", "opacity", "translate", "scale", "rotate"]);
  const out: AnimInfo[] = [];
  for (const a of document.getAnimations()) {
    if (a.playState !== "running") continue;
    const eff = a.effect as KeyframeEffect | null;
    if (!eff) continue;
    const props = new Set<string>();
    try {
      for (const k of eff.getKeyframes()) for (const p of Object.keys(k)) if (!["offset", "easing", "composite", "computedOffset"].includes(p)) props.add(p);
    } catch {
      /* ignore */
    }
    const tp = (a as unknown as { transitionProperty?: string }).transitionProperty;
    if (tp) props.add(tp.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()));
    const scrollLinked = !!a.timeline && !(a.timeline instanceof DocumentTimeline);
    const active = eff.getComputedTiming().activeDuration;
    const ms = typeof active === "number" ? active : Number.POSITIVE_INFINITY;
    const motion = [...props].some((p) => MOTION.has(p));
    if (scrollLinked || (motion && ms > maxMs)) {
      out.push({
        selector: sel(eff.target as Element | null),
        kind: a.constructor.name,
        name: (a as unknown as { animationName?: string }).animationName ?? tp ?? a.id ?? "",
        props: [...props].sort(),
        duration_ms: Number.isFinite(ms) ? Math.round(ms) : "infinite",
        scroll_linked: scrollLinked,
      });
    }
  }
  return out;
}

/**
 * In the page: transform/opacity of elements in the viewport, compared with the previous call
 * (ids kept in a WeakMap on window). Catches JavaScript-driven motion that getAnimations() misses.
 * Returns the selectors whose values changed since the last snapshot.
 */
function motionSnapshot(): string[] {
  const w = window as unknown as { __ghIds?: WeakMap<Element, number>; __ghNext?: number; __ghSnap?: Map<number, string> };
  w.__ghIds ??= new WeakMap();
  w.__ghNext ??= 1;
  const prev = w.__ghSnap;
  const snap = new Map<number, string>();
  const changed: string[] = [];
  let n = 0;
  for (const el of document.body.querySelectorAll("*")) {
    if (n > 2000) break;
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= innerHeight || (r.width === 0 && r.height === 0)) continue;
    n++;
    let id = w.__ghIds.get(el);
    if (!id) w.__ghIds.set(el, (id = w.__ghNext++));
    const s = getComputedStyle(el);
    const v = `${s.transform}|${s.opacity}|${s.translate}|${s.scale}|${s.rotate}`;
    snap.set(id, v);
    if (prev?.has(id) && prev.get(id) !== v) {
      const tag = el.tagName.toLowerCase();
      changed.push(el.id ? `${tag}#${el.id}` : tag + [...el.classList].slice(0, 3).map((c) => `.${c}`).join(""));
    }
  }
  w.__ghSnap = snap;
  return changed;
}

async function scrollTo(page: Page, y: number): Promise<void> {
  await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" as ScrollBehavior }), y);
}

export async function reducedMotionGate(browser: Browser | null, base: string | null, why = "no site to check"): Promise<Gate> {
  const id = "reduced-motion";
  if (!base || !browser) return gate(id, "fail", `cannot run: ${why}`);
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: VIEWPORT });
  const page = await context.newPage();
  const animations = new Map<string, AnimInfo & { at_y: number }>();
  const jsMotion = new Map<string, number>();
  const scrollLinkedJs = new Map<string, number>();
  const hidden = new Map<string, TextScan["hidden"][number] & { at_y: number }>();
  let steps = 0;
  try {
    await page.goto(base, { waitUntil: "load", timeout: 30_000 });
    const reduce = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (!reduce) return gate(id, "fail", "cannot run: prefers-reduced-motion: reduce was not applied");
    await page.waitForTimeout(50);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const record = async (y: number) => {
      for (const a of await page.evaluate(motionAnimations, MAX_REDUCED_MOTION_MS)) {
        const k = `${a.selector}|${a.name}|${a.props.join(",")}`;
        if (!animations.has(k)) animations.set(k, { ...a, at_y: y });
      }
    };
    for (let y = 0; steps < MAX_STEPS; y = Math.min(y + SCROLL_STEP, Math.max(0, height - VIEWPORT.height))) {
      steps++;
      if (y > 0) await scrollTo(page, y);
      await page.waitForTimeout(30);
      await record(y);
      // Long-running motion (CSS or JavaScript): still changing 250 to 500 ms after the scroll.
      await page.waitForTimeout(SETTLE_MS);
      await record(y);
      await page.evaluate(motionSnapshot);
      await page.waitForTimeout(SETTLE_MS);
      for (const s of await page.evaluate(motionSnapshot)) if (!jsMotion.has(s)) jsMotion.set(s, y);
      // Scroll-linked motion: values that change on each of two small scrolls.
      await scrollTo(page, y + 80);
      await page.waitForTimeout(SETTLE_MS);
      const first = new Set(await page.evaluate(motionSnapshot));
      await scrollTo(page, y + 160);
      await page.waitForTimeout(SETTLE_MS);
      for (const s of await page.evaluate(motionSnapshot)) if (first.has(s) && !scrollLinkedJs.has(s)) scrollLinkedJs.set(s, y);
      await record(y);
      // Content in view must be visible.
      for (const h of (await page.evaluate(scanText, { anchor: null, viewportOnly: true })).hidden) if (!hidden.has(h.selector)) hidden.set(h.selector, { ...h, at_y: y });
      await scrollTo(page, y);
      if (y >= height - VIEWPORT.height) break;
    }
  } catch (e) {
    return gate(id, "fail", `cannot run: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    await context.close().catch(() => undefined);
  }
  // JavaScript motion already reported as a CSS/Web animation is not counted twice.
  const animated = new Set([...animations.values()].map((a) => a.selector));
  // An element that also moves while the page is still is time-driven motion, not scroll-linked.
  const js = [...jsMotion].filter(([s]) => !animated.has(s)).map(([selector, at_y]) => ({ selector, at_y }));
  const scrollJs = [...scrollLinkedJs].filter(([s]) => !animated.has(s) && !jsMotion.has(s)).map(([selector, at_y]) => ({ selector, at_y }));
  const anims = [...animations.values()];
  const metrics = {
    steps,
    long_animations: anims.filter((a) => !a.scroll_linked).length,
    scroll_linked: anims.filter((a) => a.scroll_linked).length + scrollJs.length,
    js_motion: js.length,
    hidden_text: hidden.size,
  };
  const details = { viewport: VIEWPORT, max_ms: MAX_REDUCED_MOTION_MS, animations: anims.slice(0, 30), scroll_linked_js: scrollJs.slice(0, 30), js_motion: js.slice(0, 30), hidden: [...hidden.values()].slice(0, 30) };
  const parts: string[] = [];
  if (metrics.long_animations) parts.push(`${metrics.long_animations} transform/opacity animation(s) longer than ${MAX_REDUCED_MOTION_MS} ms`);
  if (metrics.scroll_linked) parts.push(`${metrics.scroll_linked} scroll-linked animation(s)`);
  if (metrics.js_motion) parts.push(`${metrics.js_motion} element(s) still moving ${SETTLE_MS} ms after a scroll`);
  if (metrics.hidden_text) parts.push(`${metrics.hidden_text} text element(s) in view but invisible`);
  return parts.length
    ? gate(id, "fail", `with prefers-reduced-motion: reduce, the home page runs ${parts.join("; ")}`, metrics, details)
    : gate(id, "pass", `with prefers-reduced-motion: reduce, scrolling the home page (${steps} steps) runs no long or scroll-linked motion and all text in view is visible`, metrics);
}

export interface Section {
  label: string;
  path: string;
  anchor: string | null;
}

export async function noJsContentGate(browser: Browser | null, base: string | null, sections: Section[], why = "no site to check"): Promise<Gate> {
  const id = "no-js-content";
  if (!base || !browser) return gate(id, "fail", `cannot run: ${why}`);
  if (sections.length === 0) return gate(id, "fail", "cannot run: no content sections to read");
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: VIEWPORT });
  const page = await context.newPage();
  const results: { section: string; path: string; anchor: string | null; visible_chars: number; hidden: TextScan["hidden"]; problem?: string }[] = [];
  try {
    let loaded: string | null = null;
    for (const s of sections) {
      if (loaded !== s.path) {
        const res = await page.goto(new URL(s.path.replace(/^\//, ""), base).toString(), { waitUntil: "load", timeout: 30_000 });
        loaded = s.path;
        if (!res || res.status() >= 400) {
          results.push({ section: s.label, path: s.path, anchor: s.anchor, visible_chars: 0, hidden: [], problem: `HTTP ${res?.status() ?? "no response"}` });
          loaded = null;
          continue;
        }
      }
      const scan = await page.evaluate(scanText, { anchor: s.anchor, viewportOnly: false });
      const r = { section: s.label, path: s.path, anchor: s.anchor, visible_chars: scan.visibleChars, hidden: scan.hidden.slice(0, 10) };
      if (!scan.found) results.push({ ...r, problem: `#${s.anchor} not found without JavaScript` });
      else if (scan.hidden.length) results.push({ ...r, problem: `${scan.hidden.length} text element(s) invisible without JavaScript (opacity 0 or visibility hidden)` });
      else if (scan.visibleChars === 0) results.push({ ...r, problem: "no visible text without JavaScript" });
      else results.push(r);
    }
  } catch (e) {
    return gate(id, "fail", `cannot run: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    await context.close().catch(() => undefined);
  }
  const bad = results.filter((r) => r.problem);
  const metrics = { sections: results.length, failing: bad.length };
  return bad.length
    ? gate(id, "fail", `with JavaScript disabled, ${bad.length} of ${results.length} content sections hide text: ${bad.map((b) => `${b.section} (${b.problem})`).slice(0, 5).join("; ")}`, metrics, { sections: results })
    : gate(id, "pass", `with JavaScript disabled, all ${results.length} content sections render visible text`, metrics, { sections: results.map(({ hidden: _h, ...r }) => r) });
}

/** How long a page may run its entrance motion before no-scroll-reveal reads it. */
export const REVEAL_SETTLE_MS = 1500;
/** Interactive content that is hidden until opened, not until scrolled. */
const REVEAL_SKIP = "nav, header, dialog, [role='dialog'], [role='menu'], [role='tabpanel'], [popover], details:not([open])";

/**
 * no-scroll-reveal (decision 0008, rule 2): content is on the page when it loads. Loads each route
 * with JavaScript on at 1440x900, does not scroll, waits for entrance motion to settle, and fails
 * when text in <main> (else <body>) is laid out but invisible (effective opacity under 0.05 or
 * visibility hidden): a scroll-reveal that hides content until the reader scrolls to it.
 */
export async function noScrollRevealGate(browser: Browser | null, base: string | null, routes: readonly string[], why = "no site to check", settleMs = REVEAL_SETTLE_MS): Promise<Gate> {
  const id = "no-scroll-reveal";
  if (!base || !browser) return gate(id, "fail", `cannot run: ${why}`);
  const list = [...new Set(routes)].slice(0, 30);
  if (!list.length) return gate(id, "fail", "cannot run: no routes to load");
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const results: { path: string; visible_chars: number; hidden: TextScan["hidden"]; problem?: string }[] = [];
  try {
    for (const path of list) {
      const res = await page.goto(new URL(path.replace(/^\//, ""), base).toString(), { waitUntil: "load", timeout: 30_000 });
      if (!res || res.status() >= 400) {
        results.push({ path, visible_chars: 0, hidden: [], problem: `HTTP ${res?.status() ?? "no response"}` });
        continue;
      }
      await page.waitForTimeout(settleMs);
      const scan = await page.evaluate(scanText, { anchor: null, viewportOnly: false, skip: REVEAL_SKIP });
      const r = { path, visible_chars: scan.visibleChars, hidden: scan.hidden.slice(0, 10) };
      results.push(scan.hidden.length ? { ...r, problem: `${scan.hidden.length} text element(s) hidden until scrolled to (opacity 0 or visibility hidden)` } : r);
    }
  } catch (e) {
    return gate(id, "fail", `cannot run: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    await context.close().catch(() => undefined);
  }
  const bad = results.filter((r) => r.problem);
  const metrics = { pages: results.length, failing: bad.length, hidden_text: bad.reduce((n, b) => n + b.hidden.length, 0) };
  return bad.length
    ? gate(id, "fail", `without scrolling, ${bad.length} of ${results.length} pages hide text: ${bad.slice(0, 4).map((b) => `${b.path} (${b.problem})`).join("; ")}`, metrics, { pages: bad })
    : gate(id, "pass", `all text in <main> is visible on load, without scrolling, on ${results.length} pages`, metrics);
}
