// Product-site playbook gates (decision 0008, rule 2: the Mastra study), the mechanical part:
//   same-ctas: every page carries the same two calls to action, "Get a demo" plus "Quickstart" or
//     "Copy agent prompt", with the same targets everywhere.
//   menu-footer-parity: every page has a footer, and it links to every page the main menu links to
//     (the menu and the footer list the same products).
// The browser half (nothing hidden until scroll) is no-scroll-reveal in motion.ts; plain-text docs
// (llms.txt and a Markdown twin of every docs page) are the docs gate (decision 0006). The panel
// judges the rest: two-tone headlines, feature cards, real product screens, buyer pages.
import type { Gate } from "../lib/schemas.ts";
import { gate } from "./gates.ts";
import { visibleText } from "./html.ts";
import { elements } from "./mock.ts";
import { htmlPages, internalPath } from "./site.ts";
import type { Site } from "./site.ts";

export const PRIMARY_CTA = "get a demo";
export const SECONDARY_CTAS = ["quickstart", "copy agent prompt"];
const CTA_LABELS = [PRIMARY_CTA, ...SECONDARY_CTAS];

/** A link or button label, lower-cased, arrows and punctuation at either end dropped. */
export function ctaLabel(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

interface Control {
  tag: string;
  label: string;
  /** Same-origin path, absolute URL, or "(button)". */
  target: string;
}

const normTarget = (href: string, pageUrl: string, base: string): string => {
  const p = internalPath(href, pageUrl, base);
  if (p) {
    const q = p.split(/[?#]/)[0];
    return q.endsWith("/") || /\.[a-z0-9]+$/i.test(q) ? q : `${q}/`;
  }
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return href;
  }
};

/** Links and buttons in the given source range, with their labels and targets. */
function controls(src: string, els: ReturnType<typeof elements>["els"], from: number, to: number, pageUrl: string, base: string): Control[] {
  const out: Control[] = [];
  for (const e of els) {
    if (e.start < from || e.end > to) continue;
    if (e.name !== "a" && e.name !== "button") continue;
    const label = ctaLabel(visibleText(src.slice(e.start, e.end)) || e.attrs["aria-label"] || "");
    if (!label) continue;
    const target = e.name === "a" ? (e.attrs.href ? normTarget(e.attrs.href.trim(), pageUrl, base) : "(no href)") : "(button)";
    out.push({ tag: e.name, label, target });
  }
  return out;
}

export function sameCtasGate(site: Site | null, why = "no site to check"): Gate {
  const id = "same-ctas";
  if (!site) return gate(id, "fail", `cannot run: ${why}`);
  const pages = htmlPages(site);
  if (!pages.length) return gate(id, "fail", "cannot run: no HTML pages loaded");
  const rows = pages.map((p) => {
    const { src, els } = elements(p.body);
    const cs = controls(src, els, 0, src.length, p.url, site.base).filter((c) => CTA_LABELS.includes(c.label));
    const primary = cs.find((c) => c.label === PRIMARY_CTA) ?? null;
    const secondary = cs.find((c) => SECONDARY_CTAS.includes(c.label)) ?? null;
    return { path: p.path, primary: primary && { label: primary.label, target: primary.target }, secondary: secondary && { label: secondary.label, target: secondary.target } };
  });
  const problems: string[] = [];
  const missingPrimary = rows.filter((r) => !r.primary).map((r) => r.path);
  const missingSecondary = rows.filter((r) => !r.secondary).map((r) => r.path);
  if (missingPrimary.length) problems.push(`no "Get a demo" on ${missingPrimary.length} page(s): ${missingPrimary.slice(0, 5).join(", ")}`);
  if (missingSecondary.length) problems.push(`no "Quickstart" or "Copy agent prompt" on ${missingSecondary.length} page(s): ${missingSecondary.slice(0, 5).join(", ")}`);
  const distinct = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  const secLabels = distinct(rows.map((r) => r.secondary?.label));
  if (secLabels.length > 1) problems.push(`the second call to action differs between pages (${secLabels.join(" / ")})`);
  const pTargets = distinct(rows.map((r) => r.primary?.target));
  if (pTargets.length > 1) problems.push(`"Get a demo" goes to different places (${pTargets.slice(0, 4).join(", ")})`);
  const sTargets = distinct(rows.map((r) => r.secondary?.target));
  if (sTargets.length > 1) problems.push(`"${secLabels[0]}" goes to different places (${sTargets.slice(0, 4).join(", ")})`);
  const metrics = { pages: rows.length, with_both: rows.filter((r) => r.primary && r.secondary).length };
  const details = { pages: rows.slice(0, 100) };
  if (problems.length) return gate(id, "fail", problems.join("; "), metrics, details);
  return gate(id, "pass", `all ${rows.length} pages carry "Get a demo" (${pTargets[0]}) and "${secLabels[0]}" (${sTargets[0]})`, metrics, details);
}

/** The first <header> (else the first <nav>) and the last <footer> of a page, as source ranges. */
function regions(els: ReturnType<typeof elements>["els"]) {
  const header = els.find((e) => e.name === "header") ?? els.find((e) => e.name === "nav") ?? null;
  const footers = els.filter((e) => e.name === "footer");
  return { header, footer: footers.at(-1) ?? null };
}

export function menuFooterGate(site: Site | null, why = "no site to check"): Gate {
  const id = "menu-footer-parity";
  if (!site) return gate(id, "fail", `cannot run: ${why}`);
  const pages = htmlPages(site);
  if (!pages.length) return gate(id, "fail", "cannot run: no HTML pages loaded");
  const rows: { path: string; menu: number; footer: number; problem?: string; missing?: string[] }[] = [];
  for (const p of pages) {
    const { src, els } = elements(p.body);
    const { header, footer } = regions(els);
    if (!header) {
      rows.push({ path: p.path, menu: 0, footer: 0, problem: "no <header> or <nav> menu" });
      continue;
    }
    // Same-origin pages the menu links to; the home link and the calls to action are not products.
    const menu = controls(src, els, header.start, header.end, p.url, site.base).filter((c) => c.tag === "a" && c.target.startsWith("/") && c.target !== "/" && !CTA_LABELS.includes(c.label));
    if (!footer) {
      rows.push({ path: p.path, menu: menu.length, footer: 0, problem: "no <footer>" });
      continue;
    }
    const foot = new Set(controls(src, els, footer.start, footer.end, p.url, site.base).filter((c) => c.tag === "a").map((c) => c.target));
    const missing = [...new Set(menu.filter((c) => !foot.has(c.target)).map((c) => `${c.label} (${c.target})`))];
    rows.push({ path: p.path, menu: menu.length, footer: foot.size, ...(missing.length ? { problem: `the footer misses ${missing.length} menu link(s)`, missing } : {}) });
  }
  const bad = rows.filter((r) => r.problem);
  const metrics = { pages: rows.length, failing: bad.length };
  if (bad.length)
    return gate(
      id,
      "fail",
      `${bad.length} of ${rows.length} pages: ${bad
        .slice(0, 4)
        .map((b) => `${b.path} ${b.problem}${b.missing ? ` (${b.missing.slice(0, 4).join(", ")})` : ""}`)
        .join("; ")}`,
      metrics,
      { pages: bad.slice(0, 50) },
    );
  return gate(id, "pass", `on all ${rows.length} pages the footer links to every page the main menu lists`, metrics);
}
