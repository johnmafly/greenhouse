// Minimal, safe Markdown to HTML for ruling.md. Every piece of source text is HTML-escaped first;
// only the constructs below produce markup, so a ruling can never inject HTML or script.
// Supported: ATX headings, paragraphs, bullet and numbered lists (one level), fenced code,
// block quotes, horizontal rules, `code`, **bold**, *italic* / _italic_, [text](https://...) links.

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function safeHref(url: string): string | null {
  return /^(https?:\/\/|\/|#|mailto:)/i.test(url) ? url : null;
}

/** Inline markup on raw (unescaped) text. */
export function inline(src: string): string {
  // Split out code spans first so their content is never formatted.
  const parts = src.split(/(`[^`]+`)/);
  return parts
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      let out = "";
      const linkRe = /\[([^\]]+)\]\(([^)\s]+)\)/g;
      let last = 0;
      for (let m; (m = linkRe.exec(part)); ) {
        out += emphasis(escapeHtml(part.slice(last, m.index)));
        const href = safeHref(m[2]);
        const text = emphasis(escapeHtml(m[1]));
        out += href ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${text}</a>` : text;
        last = m.index + m[0].length;
      }
      return out + emphasis(escapeHtml(part.slice(last)));
    })
    .join("");
}

function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?=\S)(.+?)(?<=\S)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?=\S)(.+?)(?<=\S)_(?![_\w])/g, "$1<em>$2</em>");
}

export function renderMarkdown(md: string, opts: { headingOffset?: number } = {}): string {
  const off = opts.headingOffset ?? 0;
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${renderMarkdown(quote.join("\n"), opts)}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^(```|~~~)\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      flushAll();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith(fence[1]); i++) body.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      flushList();
      quote.push(line.replace(/^\s*>\s?/, ""));
      continue;
    }
    flushQuote();
    if (/^\s*$/.test(line)) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flushAll();
      const level = Math.min(6, h[1].length + off);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      out.push("<hr>");
      continue;
    }
    const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const tag = li[1] ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(li[3]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += " " + line.trim();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushAll();
  return out.join("\n");
}
