// HTML for every board route. Pure string building: every value from an input file goes through
// esc() (or the Markdown renderer, which escapes), and no page loads anything from another origin.
import { escapeHtml as esc, renderMarkdown } from "./markdown.ts";
import {
  costPerPoint, isOpen, lastGain, latestScore, nextAction, pointsPerRound, roundsUsed, scoredRounds, spendKnown, spendUsd,
} from "./data.ts";
import type { BoardData, JudgeTestStatus, ProjectData, RoundData } from "./data.ts";
import type { Gate, Rubric, Severity } from "../../cli/src/lib/schemas.ts";

export const SWEEP_STALE_HOURS = 36;

export interface BuildInfo {
  sha: string | null;
  builtAt: string;
  cliVersion: string;
  node: string;
  /** Public base URL of the evidence store, or null while it is private. */
  evidenceBase: string | null;
}

export interface RenderContext {
  data: BoardData;
  build: BuildInfo;
  /** rubric by version, for dimension names and weights. */
  rubrics: Map<number, Rubric>;
}

// ---- Small helpers ----

const fmt = (n: number, d = 2) => n.toFixed(d);
const signed = (n: number, d = 2) => (n > 0 ? "+" : n < 0 ? "\u2212" : "\u00b1") + Math.abs(n).toFixed(d);
const usd = (n: number) => "$" + (n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(n % 1 ? 2 : 0));
const shortSha = (s: string) => s.slice(0, 7);
const pad2 = (n: number) => String(n).padStart(2, "0");

export function hoursSince(iso: string, nowIso: string): number {
  return (Date.parse(nowIso) - Date.parse(iso)) / 36e5;
}

export function ageText(hours: number): string {
  if (!(hours >= 0)) return "in the future";
  if (hours < 1) return "under an hour ago";
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function dateText(iso: string): string {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

const SHORT: Record<string, string> = {
  conviction: "Conviction",
  docs_buildability: "Docs",
  site_craft: "Craft",
  distinctness: "Distinct",
  comparison_honesty: "Comparison",
  pricing_oss: "Pricing",
  evidence_truth: "Evidence",
  signup_value: "Signup",
};

function dimName(ctx: RenderContext, version: number, id: string): string {
  return ctx.rubrics.get(version)?.dimensions.find((d) => d.id === id)?.name ?? id;
}

const STATUS_LABEL: Record<string, string> = {
  idea: "Idea", seed: "Seed", building: "Building", "in-review": "In review", revise: "Revising",
  "owner-review": "Owner review", graduated: "Graduated", paused: "Paused", killed: "Stopped",
};

function chip(text: string, kind = ""): string {
  return `<span class="chip${kind ? " chip-" + kind : ""}">${esc(text)}</span>`;
}

function statusChip(status: string): string {
  const kind = status === "graduated" ? "good" : status === "killed" ? "bad" : status === "paused" ? "warn" : "";
  return chip(STATUS_LABEL[status] ?? status, kind);
}

function provisionalChip(): string {
  return `<span class="chip chip-prov" title="The judge has not passed validation tests 1 to 5 yet; no score can graduate.">Provisional</span>`;
}

function gateKind(status: Gate["status"]): string {
  return status === "pass" ? "good" : status === "fail" ? "bad" : status === "warn" ? "warn" : "";
}

function gateCounts(gates: Gate[]): string {
  const c = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const g of gates) c[g.status]++;
  const parts: string[] = [];
  if (c.fail) parts.push(`<span class="t-bad">${c.fail} fail</span>`);
  if (c.warn) parts.push(`<span class="t-warn">${c.warn} warn</span>`);
  parts.push(`<span class="t-good">${c.pass} pass</span>`);
  if (c.skip) parts.push(`<span class="t-muted">${c.skip} skip</span>`);
  return parts.join(" <span class=\"sep\">/</span> ");
}

// ---- SVG ----

/** Round-by-round composite line, with the 9.0 graduation bar. */
export function trendSvg(p: ProjectData, opts: { w: number; h: number; labels?: boolean }): string {
  const s = scoredRounds(p);
  const { w, h } = opts;
  const padX = opts.labels ? 28 : 6;
  const padY = opts.labels ? 18 : 6;
  const values = s.map((r) => r.score.composite);
  const lo = Math.max(0, Math.min(6, ...values.map((v) => Math.floor(v - 0.5))));
  const hi = 10;
  const y = (v: number) => padY + (h - 2 * padY) * (1 - (v - lo) / (hi - lo));
  const n = Math.max(values.length, opts.labels ? Math.max(p.intake.budget.rounds, 2) : 2);
  const x = (i: number) => padX + ((w - 2 * padX) * i) / Math.max(1, n - 1);
  const bar = y(9);
  const parts: string[] = [];
  parts.push(`<line class="svg-bar" x1="${padX}" x2="${w - padX}" y1="${bar.toFixed(1)}" y2="${bar.toFixed(1)}"/>`);
  if (opts.labels) {
    parts.push(`<text class="svg-label" x="${w - padX}" y="${(bar - 5).toFixed(1)}" text-anchor="end">graduation 9.0</text>`);
    for (const v of [lo, hi]) parts.push(`<text class="svg-axis" x="${padX - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`);
    for (let i = 0; i < n; i++) {
      parts.push(`<text class="svg-axis" x="${x(i).toFixed(1)}" y="${h - 2}" text-anchor="middle">${pad2(i + 1)}</text>`);
    }
  }
  if (values.length === 0) {
    parts.push(`<line class="svg-empty" x1="${padX}" x2="${w - padX}" y1="${(h - padY).toFixed(1)}" y2="${(h - padY).toFixed(1)}"/>`);
  } else {
    const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    if (values.length > 1) {
      parts.push(`<polygon class="svg-area" points="${x(0).toFixed(1)},${(h - padY).toFixed(1)} ${pts.join(" ")} ${x(values.length - 1).toFixed(1)},${(h - padY).toFixed(1)}"/>`);
      parts.push(`<polyline class="svg-line" points="${pts.join(" ")}"/>`);
    }
    values.forEach((v, i) => {
      const last = i === values.length - 1;
      parts.push(`<circle class="svg-dot${last ? " svg-dot-last" : ""}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${last ? 3.5 : 2.5}"><title>Round ${pad2(s[i].round)}: ${fmt(v)}</title></circle>`);
      if (opts.labels) parts.push(`<text class="svg-value" x="${x(i).toFixed(1)}" y="${(y(v) - 9).toFixed(1)}" text-anchor="middle">${fmt(v)}</text>`);
    });
  }
  const label = values.length
    ? `Composite by round: ${values.map((v, i) => `round ${s[i].round} ${fmt(v)}`).join(", ")}`
    : "No scored rounds yet";
  return `<svg class="trend${opts.labels ? " trend-lg" : ""}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">${parts.join("")}</svg>`;
}

/** 0 to 10 meter with the 9.0 bar. */
function meterSvg(value: number | null, w = 150): string {
  const h = 10;
  const x = (v: number) => (w * v) / 10;
  const fill = value === null ? "" : `<rect class="meter-fill${value >= 9 ? " meter-good" : ""}" x="0" y="2" width="${x(value).toFixed(1)}" height="6" rx="3"/>`;
  return `<svg class="meter" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><rect class="meter-track" x="0" y="2" width="${w}" height="6" rx="3"/>${fill}<line class="meter-bar" x1="${x(9)}" x2="${x(9)}" y1="0" y2="${h}"/></svg>`;
}

/** Eight small columns, one per dimension median, with the 8.0 floor. */
function dimsSvg(ctx: RenderContext, medians: Record<string, number> | null, version: number): string {
  const rubric = ctx.rubrics.get(version) ?? [...ctx.rubrics.values()][0];
  const ids = rubric ? rubric.dimensions.map((d) => d.id) : Object.keys(medians ?? {});
  const colW = 14, gap = 5, h = 34;
  const w = ids.length * (colW + gap) - gap;
  // Columns start at 5 (the rubric's "competent template output") so 8 vs 9 is visible.
  const y = (v: number) => h - h * Math.max(0.08, (Math.min(10, v) - 5) / 5);
  const cols = ids.map((id, i) => {
    const v = medians?.[id];
    const x = i * (colW + gap);
    const title = `${dimName(ctx, version, id)}: ${v === undefined ? "not scored" : fmt(v, 1)}`;
    if (v === undefined) return `<rect class="dim-empty" x="${x}" y="${h - 2}" width="${colW}" height="2"><title>${esc(title)}</title></rect>`;
    const cls = v < 8 ? "dim-low" : v >= 9 ? "dim-high" : "dim-mid";
    return `<rect class="${cls}" x="${x}" y="${y(v).toFixed(1)}" width="${colW}" height="${(h - y(v)).toFixed(1)}" rx="2"><title>${esc(title)}</title></rect>`;
  });
  const floor = `<line class="dim-floor" x1="0" x2="${w}" y1="${y(8).toFixed(1)}" y2="${y(8).toFixed(1)}"/>`;
  return `<svg class="dims" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Dimension medians">${cols.join("")}${floor}</svg>`;
}

function pips(used: number, budget: number): string {
  const n = Math.max(used, budget);
  const items: string[] = [];
  for (let i = 0; i < n; i++) items.push(`<span class="pip${i < used ? (i >= budget ? " pip-over" : " pip-on") : ""}"></span>`);
  return `<span class="pips" aria-hidden="true">${items.join("")}</span>`;
}

const LOGO = `<svg class="logo" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><path class="logo-house" d="M4 14 16 4l12 10v14H4z"/><path class="logo-stem" d="M16 27V15"/><path class="logo-leaf" d="M16 19c-5 0-7-3-7-7 4 0 7 2 7 7z"/><path class="logo-leaf" d="M16 16c0-4 2.5-6.5 7-6.5 0 4.5-2.5 6.5-7 6.5z"/></svg>`;

// ---- Layout ----

export interface Page {
  path: string;
  title: string;
  nav: "board" | "judge" | "ops" | "none";
  body: string;
  description?: string;
}

function healthStrip(ctx: RenderContext): string {
  const { sweep, judge } = ctx.data;
  const passed = judge.tests.filter((t) => t.id <= 5 && t.status === "pass").length;
  let sweepHtml: string;
  if (!sweep) {
    sweepHtml = `<a class="health health-stale" href="/ops/"><span class="dot"></span>Sweep: none recorded yet</a>`;
  } else {
    const hrs = hoursSince(sweep.last_sweep_at, ctx.build.builtAt);
    const stale = !(hrs <= SWEEP_STALE_HOURS);
    sweepHtml = `<a class="health ${stale ? "health-stale" : "health-fresh"}" href="/ops/" data-sweep-at="${esc(sweep.last_sweep_at)}"><span class="dot"></span>Sweep: <span data-sweep-age>${esc(ageText(hrs))}</span></a>`;
  }
  const judgeHtml = judge.validated
    ? `<a class="health health-fresh" href="/judge/"><span class="dot"></span>Judge validated</a>`
    : `<a class="health health-prov" href="/judge/"><span class="dot"></span>Judge provisional: ${passed} of 5 tests passed</a>`;
  return `<div class="strip">${sweepHtml}${judgeHtml}</div>`;
}

export function layout(ctx: RenderContext, page: Page, scriptTag: string): string {
  const navItem = (key: Page["nav"], href: string, label: string) =>
    `<a href="${href}"${page.nav === key ? ' aria-current="page"' : ""}>${label}</a>`;
  const b = ctx.build;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<meta name="description" content="${esc(page.description ?? "Greenhouse: funded open-source ideas, judged blind from seed to graduation.")}">
<title>${esc(page.title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/board.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="wrap top-inner">
    <a class="brand" href="/">${LOGO}<span>Greenhouse</span></a>
    <nav class="nav" aria-label="Board">${navItem("board", "/", "Leaderboard")}${navItem("judge", "/judge/", "Judge")}${navItem("ops", "/ops/", "Ops")}</nav>
  </div>
  <div class="wrap">${healthStrip(ctx)}</div>
</header>
<main id="main" class="wrap">
${page.body}
</main>
<footer class="foot wrap">
  <p>Built ${esc(dateText(b.builtAt))} from <a href="https://github.com/johnmafly/greenhouse">johnmafly/greenhouse</a> at ${b.sha ? `<a href="https://github.com/johnmafly/greenhouse/commit/${esc(b.sha)}"><code>${esc(shortSha(b.sha))}</code></a>` : "an unknown commit"}. Everything here is computed from files in Git; the board keeps no state of its own.</p>
  <p class="t-muted">Not indexed by search engines until the owner publishes. Scores are provisional until the judge passes validation.</p>
</footer>
${scriptTag}
</body>
</html>
`;
}

/**
 * The one inline script: re-checks sweep freshness against the viewer's clock, so the board
 * turns red when the sweep stops even though nothing has been rebuilt. The page is correct
 * without it (state as of the build).
 */
export const INLINE_SCRIPT = `(function(){var L=${SWEEP_STALE_HOURS};function a(h){if(!(h>=0))return"in the future";if(h<1)return"under an hour ago";if(h<48)return Math.round(h)+" h ago";return Math.round(h/24)+" days ago"}var n=Date.now(),e=document.querySelectorAll("[data-sweep-at]");for(var i=0;i<e.length;i++){var h=(n-Date.parse(e[i].getAttribute("data-sweep-at")))/36e5,s=!(h<=L),c=e[i].classList;c.toggle("health-stale",s);c.toggle("health-fresh",!s);c.toggle("card-stale",s&&c.contains("card"));var t=e[i].querySelectorAll("[data-sweep-age]");for(var j=0;j<t.length;j++)t[j].textContent=a(h);var v=e[i].querySelectorAll("[data-sweep-verdict]");for(var k=0;k<v.length;k++)v[k].textContent=s?"Stale: the Mac mini or the sweep Loop may be down.":"Healthy."}})();`;

// ---- Leaderboard ----

export function sortProjects(projects: ProjectData[]): ProjectData[] {
  return [...projects].sort((a, b) => {
    const sa = latestScore(a)?.composite ?? -1;
    const sb = latestScore(b)?.composite ?? -1;
    return sb - sa || a.intake.name.localeCompare(b.intake.name);
  });
}

function projectRow(ctx: RenderContext, p: ProjectData, rank: number): string {
  const s = latestScore(p);
  const i = p.intake;
  const used = roundsUsed(p);
  const last = p.rounds[p.rounds.length - 1];
  const gates = [...p.rounds].reverse().find((r) => r.checks)?.checks?.gates ?? null;
  const ppr = pointsPerRound(p);
  const gain = lastGain(p);
  const cpp = costPerPoint(p);
  const na = nextAction(p);
  const href = `/projects/${encodeURIComponent(i.slug)}/`;
  const scoreBlock = s
    ? `<div class="score-num">${fmt(s.composite)}${s.caps_applied.length ? `<span class="cap" title="${esc(s.caps_applied.map((c) => `${c.reason} caps at ${c.max}`).join("; "))}">capped</span>` : ""}</div>
        ${meterSvg(s.composite)}
        <div class="score-sub">${gain === null ? "first scored round" : `<span class="${gain >= 0 ? "t-good" : "t-bad"}">${signed(gain)}</span> last round`}</div>`
    : `<div class="score-num score-none">&ndash;</div>${meterSvg(null)}<div class="score-sub">${last ? `round ${esc(last.name)} in judging` : "awaiting first round"}</div>`;
  return `<li class="row">
    <div class="rank">${pad2(rank)}</div>
    <div class="who">
      <h2><a href="${href}">${esc(i.name)}</a></h2>
      <div class="chips">${statusChip(i.status)}${s?.provisional ? provisionalChip() : ""}${s?.graduation_eligible ? chip("Meets the bar", "good") : ""}</div>
      <p class="links">${i.deployment_url ? `<a href="${esc(i.deployment_url)}" rel="noopener">${esc(i.deployment_url.replace(/^https?:\/\//, ""))}</a>` : `<span class="t-muted">not deployed yet</span>`}<span class="sep">/</span><a href="https://github.com/${esc(i.repo)}" rel="noopener">repo</a></p>
    </div>
    <div class="score">${scoreBlock}</div>
    <div class="trend-cell">${trendSvg(p, { w: 168, h: 46 })}${s ? dimsSvg(ctx, s.dimension_medians, s.rubric_version) : `<p class="t-muted small">No dimension scores yet</p>`}</div>
    <dl class="facts">
      <div><dt>Rounds</dt><dd>${pips(used, i.budget.rounds)} <span class="num">${used} of ${i.budget.rounds}</span></dd></div>
      <div><dt>Spend</dt><dd><span class="num">${spendKnown(p) ? usd(spendUsd(p)) : "$0"}</span> of ${usd(i.budget.model_spend_usd)}</dd></div>
      <div><dt>Gates</dt><dd>${gates ? gateCounts(gates) : `<span class="t-muted">not run</span>`}</dd></div>
      <div><dt>Momentum</dt><dd>${ppr === null ? `<span class="t-muted">needs 2 rounds</span>` : `<span class="num">${signed(ppr)}</span>/round${cpp === null ? "" : ` <span class="t-muted">${usd(cpp)}/pt</span>`}`}</dd></div>
    </dl>
    <p class="next next-${na.owner}"><span class="next-label">Next</span>${esc(na.text)}</p>
  </li>`;
}

export function leaderboardPage(ctx: RenderContext): Page {
  const projects = sortProjects(ctx.data.projects);
  const all = ctx.data.projects;
  const judged = all.reduce((n, p) => n + scoredRounds(p).length, 0);
  const open = all.reduce((n, p) => n + p.rounds.filter(isOpen).length, 0);
  const graduated = all.filter((p) => p.intake.status === "graduated").length;
  const body = `
<section class="hero">
  <p class="eyebrow">Leaderboard</p>
  <h1>From seed to graduation, judged blind.</h1>
  <p class="lede">Each project is a funded open-source idea built by its Chief. A panel of models from different families scores every round without seeing earlier rulings. The bar: <strong>9.0</strong> composite, no dimension under <strong>8.0</strong>, every gate green, then the owner's cold read.</p>
  <dl class="stats">
    <div><dt>Projects</dt><dd>${all.length}</dd></div>
    <div><dt>Rounds judged</dt><dd>${judged}</dd></div>
    <div><dt>Open rounds</dt><dd>${open}</dd></div>
    <div><dt>Graduated</dt><dd>${graduated}</dd></div>
  </dl>
</section>
${projects.length ? `<ol class="board" aria-label="Projects by current score">${projects.map((p, i) => projectRow(ctx, p, i + 1)).join("\n")}</ol>` : `<p class="empty">No projects yet. A project appears here once its intake is merged into portfolio/.</p>`}
<p class="legend t-muted small">Sorted by current composite; projects without a score follow. The line shows the composite by round against the 9.0 bar; the columns show the latest dimension medians against the 8.0 floor. Momentum is composite points gained per round since round 01, and spend per point gained.</p>`;
  return { path: "index.html", title: "Greenhouse leaderboard", nav: "board", body };
}

// ---- Project page ----

const SEV_ORDER: Severity[] = ["must", "should", "could"];
const SEV_LABEL: Record<Severity, string> = { must: "Must change", should: "Should change", could: "Could change" };

function evidenceHtml(ctx: RenderContext, p: ProjectData, r: RoundData): string {
  const hash = r.checks?.bundle_hash ?? r.score?.inputs.bundle_hash ?? null;
  if (!hash) return `<p class="t-muted small">No evidence bundle recorded for this round.</p>`;
  const base = ctx.build.evidenceBase;
  if (base) {
    const href = `${base.replace(/\/$/, "")}/${encodeURIComponent(p.intake.slug)}/${r.name}/bundles/${hash}.json`;
    return `<p class="small">Evidence bundle <a href="${esc(href)}" rel="noopener"><code>${esc(hash.slice(0, 16))}&hellip;</code></a> (manifest with every screenshot's hash).</p>`;
  }
  return `<p class="small">Evidence bundle <code class="hash" title="${esc(hash)}">${esc(hash.slice(0, 16))}&hellip;</code>. Screenshots are kept in the private evidence store, addressed by this hash; they are linked here once a public route exists.</p>`;
}

function findingsHtml(ctx: RenderContext, r: RoundData): string {
  const all = r.reviews.flatMap((rf) => rf.review.findings.map((f) => ({ f, who: rf.review.reviewer })));
  if (!all.length) return `<p class="t-muted small">${r.reviews.length ? "No findings." : "Reviews not in yet."}</p>`;
  const version = r.score?.rubric_version ?? r.reviews[0]?.review.rubric_version ?? 1;
  return SEV_ORDER.filter((sev) => all.some((x) => x.f.severity === sev))
    .map((sev) => {
      const items = all
        .filter((x) => x.f.severity === sev)
        .map(({ f, who }) => `<li class="finding">
          <div class="finding-head">${chip(SEV_LABEL[sev], sev === "must" ? "bad" : sev === "should" ? "warn" : "")}<span class="t-muted small">${esc(dimName(ctx, version, f.dimension))} &middot; ${esc(who.model)}</span></div>
          <p class="finding-title">${esc(f.title)}</p>
          <p class="finding-detail">${esc(f.detail)}</p>
          ${f.evidence.length ? `<p class="small t-muted">Evidence: ${f.evidence.map((e) => `<code>${esc(e)}</code>`).join(" ")}</p>` : ""}
        </li>`)
        .join("");
      return `<ul class="findings">${items}</ul>`;
    })
    .join("");
}

function roundSection(ctx: RenderContext, p: ProjectData, r: RoundData): string {
  const s = r.score;
  const sub = r.submission;
  const version = s?.rubric_version ?? 1;
  const head = `<header class="round-head">
      <h2 id="round-${r.name}">Round ${esc(r.name)}</h2>
      <div class="chips">${s ? chip(fmt(s.composite), s.composite >= 9 ? "good" : "") : chip(isOpen(r) ? "Open" : "Pending")}${s?.provisional ? provisionalChip() : ""}${s?.caps_applied.map((c) => chip(`${c.reason} \u2264 ${c.max}`, "bad")).join("") ?? ""}</div>
      <p class="small t-muted">Commit <a href="https://github.com/${esc(sub.repo)}/commit/${esc(sub.sha)}" rel="noopener"><code>${esc(shortSha(sub.sha))}</code></a>${s ? ` &middot; decided ${esc(dateText(s.decided_at))}` : ""}${s?.cost_usd != null ? ` &middot; ${usd(s.cost_usd)}` : ""}</p>
    </header>`;
  const changelog = `<div class="block"><h3>What changed</h3><p>${esc(sub.changelog)}</p></div>`;
  const gates = r.checks
    ? `<div class="block"><h3>Gates</h3><ul class="gates">${r.checks.gates
        .map((g) => `<li>${chip(g.status, gateKind(g.status))}<code>${esc(g.id)}</code><span>${esc(g.summary)}</span></li>`)
        .join("")}</ul></div>`
    : `<div class="block"><h3>Gates</h3><p class="t-muted small">Not run yet.</p></div>`;
  const dims = s
    ? `<div class="block"><h3>Score</h3><table class="dimtable"><thead><tr><th>Dimension</th><th class="n">Weight</th><th class="n">Median</th><th></th></tr></thead><tbody>${Object.entries(s.dimension_medians)
        .map(([id, v]) => {
          const w = ctx.rubrics.get(version)?.dimensions.find((d) => d.id === id)?.weight;
          return `<tr><td>${esc(dimName(ctx, version, id))}</td><td class="n t-muted">${w === undefined ? "" : Math.round(w * 100) + "%"}</td><td class="n num${v < 8 ? " t-bad" : ""}">${fmt(v, 1)}</td><td class="barcell">${meterSvg(v, 110)}</td></tr>`;
        })
        .join("")}</tbody><tfoot><tr><td>Composite${s.caps_applied.length ? ` (raw ${fmt(s.composite_raw)}, capped)` : ""}</td><td></td><td class="n num">${fmt(s.composite)}</td><td></td></tr></tfoot></table>
      <p class="small t-muted">Panel: ${s.panel.map((m) => `${esc(m.model)} <span class="num">${fmt(s.reviewer_composites[m.id] ?? NaN)}</span>`).join(" &middot; ")}. Brief ${esc(s.brief_version)}, rubric v${s.rubric_version}.</p></div>`
    : "";
  const ruling = r.ruling
    ? `<div class="block ruling"><h3>Ruling</h3><div class="prose">${renderMarkdown(r.ruling, { headingOffset: 2 })}</div></div>`
    : `<div class="block ruling"><h3>Ruling</h3><p class="t-muted small">${s ? "Scored; the ruling is being written." : "Pending."}</p></div>`;
  return `<section class="round">${head}<div class="round-grid"><div>${changelog}${gates}${dims}</div><div>${ruling}<div class="block"><h3>Findings</h3>${findingsHtml(ctx, r)}</div><div class="block"><h3>Evidence</h3>${evidenceHtml(ctx, p, r)}</div></div></div></section>`;
}

export function projectPage(ctx: RenderContext, p: ProjectData): Page {
  const i = p.intake;
  const s = latestScore(p);
  const na = nextAction(p);
  const intro = i.intent.length > 420 ? i.intent.slice(0, i.intent.lastIndexOf(" ", 400)) + "\u2026" : i.intent;
  const body = `
<nav class="crumbs small"><a href="/">Leaderboard</a> <span class="sep">/</span> ${esc(i.name)}</nav>
<section class="hero hero-project">
  <div class="chips">${statusChip(i.status)}${s?.provisional ? provisionalChip() : ""}</div>
  <h1>${esc(i.name)}</h1>
  <p class="lede">${esc(intro)}</p>
  <p class="links">${i.deployment_url ? `<a class="btn" href="${esc(i.deployment_url)}" rel="noopener">Live site</a>` : ""}<a class="btn btn-ghost" href="https://github.com/${esc(i.repo)}" rel="noopener">${esc(i.repo)}</a><span class="t-muted small">Chief: ${esc(i.chief.name)}</span></p>
</section>
<section class="panel-grid">
  <div class="card">
    <h2 class="card-title">Score by round</h2>
    ${trendSvg(p, { w: 520, h: 180, labels: true })}
  </div>
  <dl class="card facts facts-col">
    <div><dt>Current score</dt><dd class="big num">${s ? fmt(s.composite) : "&ndash;"}</dd></div>
    <div><dt>Rounds</dt><dd>${pips(roundsUsed(p), i.budget.rounds)} <span class="num">${roundsUsed(p)} of ${i.budget.rounds}</span></dd></div>
    <div><dt>Model spend</dt><dd><span class="num">${usd(spendUsd(p))}</span> of ${usd(i.budget.model_spend_usd)}</dd></div>
    <div><dt>Time cap</dt><dd>${i.budget.time_cap_days} days</dd></div>
    <div><dt>Next</dt><dd>${esc(na.text)}</dd></div>
  </dl>
</section>
${p.rounds.length
    ? [...p.rounds].reverse().map((r) => roundSection(ctx, p, r)).join("\n")
    : `<section class="round round-empty"><h2>Awaiting first round</h2><p>${esc(i.name)} has no judged rounds yet. The Chief builds the package, runs <code>greenhouse check</code> until every deterministic gate passes, then opens a round with <code>greenhouse submit</code>. The first ruling appears here.</p></section>`}
<section class="card intake">
  <h2 class="card-title">Intake</h2>
  <details><summary>Buyer</summary><p>${esc(i.buyer)}</p></details>
  <details><summary>Open-source model</summary><p>${esc(i.open_source_model)}</p></details>
  <details><summary>Locked assumptions (${i.locked_assumptions.length})</summary><ul>${i.locked_assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></details>
  <details><summary>Not in this build (${i.non_goals.length})</summary><ul>${i.non_goals.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></details>
  <p class="small t-muted">Exposure: ${i.exposure.public ? "public" : "private"}, ${i.exposure.indexable ? "indexable" : "noindex"}, ${i.exposure.real_signups ? "real signups" : "mock signup"}, ${i.exposure.outreach ? "outreach on" : "no outreach"}. Intake approved by the owner: ${esc(i.approved_by_owner ?? "not yet")}.</p>
</section>`;
  return {
    path: `projects/${i.slug}/index.html`,
    title: `${i.name}: Greenhouse`,
    nav: "board",
    body,
    description: `${i.name} on the Greenhouse board.`,
  };
}

// ---- Judge report card ----

const TEST_LABEL: Record<JudgeTestStatus, string> = { "not-run": "Not yet run", running: "Running", pass: "Pass", fail: "Fail" };

export function judgePage(ctx: RenderContext): Page {
  const { judge, rubricVersion } = ctx.data;
  const rubric = rubricVersion !== null ? ctx.rubrics.get(rubricVersion) : undefined;
  const briefs = [...new Set(ctx.data.projects.flatMap((p) => scoredRounds(p).map((r) => r.score.brief_version)))];
  const passed = judge.tests.filter((t) => t.id <= 5 && t.status === "pass").length;
  const body = `
<section class="hero">
  <p class="eyebrow">Judge report card</p>
  <h1>${judge.validated ? "The judge is validated." : "The judge is provisional."}</h1>
  <p class="lede">${judge.validated
    ? "Tests 1 to 5 pass, so scores can graduate a project. Test 6, the owner's live acceptance, keeps running."
    : `Every score is marked provisional and none can graduate until tests 1 to 5 pass. ${passed} of 5 pass today; the tests start in phase 2.`}</p>
</section>
<ol class="tests">
${judge.tests
  .map((t) => `<li class="test test-${t.status}">
    <span class="test-num">${t.id}</span>
    <div><h2>${esc(t.name)}</h2><p>${esc(t.what)}</p>${t.summary ? `<p class="small">${esc(t.summary)}</p>` : ""}</div>
    <div class="test-status">${chip(TEST_LABEL[t.status], t.status === "pass" ? "good" : t.status === "fail" ? "bad" : t.status === "running" ? "warn" : "")}<span class="small t-muted">${t.last_run ? esc(dateText(t.last_run)) : t.id === 6 ? "never stops" : "phase 2"}</span></div>
  </li>`)
  .join("\n")}
</ol>
<section class="card">
  <h2 class="card-title">Versions in force</h2>
  <dl class="kv">
    <div><dt>Rubric</dt><dd>${rubric ? `v${rubric.version}: ${rubric.dimensions.length} dimensions, weights ${rubric.dimensions.map((d) => `${SHORT[d.id] ?? d.name} ${Math.round(d.weight * 100)}%`).join(", ")}` : "none"}</dd></div>
    <div><dt>Graduation bar</dt><dd>${rubric ? `composite &ge; ${rubric.graduation.composite_min}, every median &ge; ${rubric.graduation.dimension_median_min}, every reviewer &ge; ${rubric.graduation.reviewer_composite_min}, gates green, then the owner's cold read` : "&ndash;"}</dd></div>
    <div><dt>Caps</dt><dd>${rubric ? rubric.caps.map((c) => `${esc(c.id)} &le; ${c.max}`).join(", ") : "&ndash;"}</dd></div>
    <div><dt>Panel</dt><dd>${rubric ? `${rubric.panel.reviewers} reviewers from at least ${rubric.panel.min_families} model families${rubric.panel.exclude_family_of_chiefs ? ", none from the Chiefs' family" : ""}` : "&ndash;"}</dd></div>
    <div><dt>Reviewer brief</dt><dd>${briefs.length ? briefs.map(esc).join(", ") : "none used yet"}</dd></div>
    <div><dt>Schemas</dt><dd>schema_version 1 (intake, submission, checks, review, score)</dd></div>
    <div><dt>CLI</dt><dd>greenhouse ${esc(ctx.build.cliVersion)}</dd></div>
  </dl>
</section>`;
  return { path: "judge/index.html", title: "Judge report card: Greenhouse", nav: "judge", body };
}

// ---- Ops ----

export function opsPage(ctx: RenderContext): Page {
  const { sweep } = ctx.data;
  const b = ctx.build;
  const month = b.builtAt.slice(0, 7);
  const openRounds = ctx.data.projects.flatMap((p) => p.rounds.filter(isOpen).map((r) => ({ p, r })));
  const rulings = ctx.data.projects
    .flatMap((p) => scoredRounds(p).filter((r) => r.ruling !== null).map((r) => ({ p, r })))
    .sort((a, c) => Date.parse(c.r.score.decided_at) - Date.parse(a.r.score.decided_at));
  const monthCost = ctx.data.projects
    .flatMap((p) => scoredRounds(p))
    .filter((r) => r.score.decided_at.startsWith(month))
    .reduce((n, r) => n + (r.score.cost_usd ?? 0), 0);
  let sweepCard: string;
  if (!sweep) {
    sweepCard = `<div class="card card-stale"><h2 class="card-title">Daily sweep</h2><p class="big">Never</p><p>No sweep has written <code>ops/sweep.json</code> yet. The board stays red until the daily sweep Loop records its first run.</p></div>`;
  } else {
    const hrs = hoursSince(sweep.last_sweep_at, b.builtAt);
    const stale = !(hrs <= SWEEP_STALE_HOURS);
    sweepCard = `<div class="card ${stale ? "card-stale" : "card-fresh"}" data-sweep-at="${esc(sweep.last_sweep_at)}"><h2 class="card-title">Daily sweep</h2><p class="big" data-sweep-age>${esc(ageText(hrs))}</p><p>Last sweep ${esc(dateText(sweep.last_sweep_at))}. <span data-sweep-verdict>${stale ? "Stale: the Mac mini or the sweep Loop may be down." : "Healthy."}</span> Turns red after ${SWEEP_STALE_HOURS} hours.</p>${sweep.summary ? `<p class="small t-muted">${esc(sweep.summary)}</p>` : ""}</div>`;
  }
  const body = `
<section class="hero">
  <p class="eyebrow">Ops</p>
  <h1>Is Greenhouse running?</h1>
  <p class="lede">The daily sweep writes a timestamp to Git. If it is older than ${SWEEP_STALE_HOURS} hours this page and the strip at the top turn red, so a stopped Mac mini shows up here with no other monitoring.</p>
</section>
<section class="panel-grid">
  ${sweepCard}
  <dl class="card facts facts-col">
    <div><dt>Open rounds</dt><dd class="big num">${openRounds.length}</dd></div>
    <div><dt>Last ruling</dt><dd>${rulings[0] ? `<a href="/projects/${encodeURIComponent(rulings[0].p.intake.slug)}/#round-${rulings[0].r.name}">${esc(rulings[0].p.intake.name)} round ${rulings[0].r.name}</a>, ${esc(dateText(rulings[0].r.score.decided_at))}` : "none yet"}</dd></div>
    <div><dt>Judging spend, ${esc(month)}</dt><dd class="num">${usd(monthCost)}</dd></div>
  </dl>
</section>
<section class="card">
  <h2 class="card-title">Open rounds</h2>
  ${openRounds.length
    ? `<table class="list"><thead><tr><th>Project</th><th>Round</th><th>Commit</th><th>Stage</th></tr></thead><tbody>${openRounds
        .map(({ p, r }) => `<tr><td><a href="/projects/${encodeURIComponent(p.intake.slug)}/">${esc(p.intake.name)}</a></td><td class="num">${r.name}</td><td><code>${esc(shortSha(r.submission.sha))}</code></td><td>${!r.checks ? "gates" : !r.score ? "panel" : "ruling"}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="t-muted">None. Every submitted round has a ruling.</p>`}
</section>
<section class="card">
  <h2 class="card-title">This build</h2>
  <dl class="kv">
    <div><dt>Commit</dt><dd>${b.sha ? `<code>${esc(b.sha)}</code>` : "unknown"}</dd></div>
    <div><dt>Built</dt><dd>${esc(dateText(b.builtAt))}</dd></div>
    <div><dt>Toolchain</dt><dd>Node ${esc(b.node)}, greenhouse ${esc(b.cliVersion)}, rubric v${ctx.data.rubricVersion ?? "&ndash;"}</dd></div>
    <div><dt>Machine-readable</dt><dd><a href="/.well-known/greenhouse.json"><code>/.well-known/greenhouse.json</code></a></dd></div>
  </dl>
</section>`;
  return { path: "ops/index.html", title: "Ops: Greenhouse", nav: "ops", body };
}

export function notFoundPage(): Page {
  return {
    path: "404.html",
    title: "Not found: Greenhouse",
    nav: "none",
    body: `<section class="hero hero-404"><p class="eyebrow">404</p><h1>Nothing grows here.</h1><p class="lede">This page does not exist. Projects live under <code>/projects/&lt;slug&gt;/</code>.</p><p class="links"><a class="btn" href="/">Leaderboard</a><a class="btn btn-ghost" href="/judge/">Judge</a><a class="btn btn-ghost" href="/ops/">Ops</a></p></section>`,
  };
}
