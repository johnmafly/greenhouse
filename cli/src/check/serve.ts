// Local static server that behaves like Cloudflare Pages for a built site:
// directory index, `/path` -> `/path/` redirect, `/path` -> `path.html`, 404.html, and `_headers` rules.
import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { AddressInfo } from "node:net";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export interface HeaderRule {
  pattern: string;
  re: RegExp;
  headers: [string, string][];
}

/** Parse a Pages `_headers` file. Unsupported lines (detach `! Name`) are ignored. */
export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let cur: HeaderRule | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      let pattern = raw.trim();
      try {
        if (/^https?:\/\//.test(pattern)) pattern = new URL(pattern.replace(/\*/g, "__splat__")).pathname.replace(/__splat__/g, "*");
      } catch {
        /* keep as is */
      }
      const re = new RegExp(
        "^" +
          pattern
            .split(/(\*|:[A-Za-z_][A-Za-z0-9_]*)/)
            .map((p) => (p === "*" ? ".*" : p.startsWith(":") && p.length > 1 ? "[^/]+" : p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
            .join("") +
          "$",
      );
      cur = { pattern, re, headers: [] };
      rules.push(cur);
      continue;
    }
    const line = raw.trim();
    if (!cur || line.startsWith("!")) continue;
    const i = line.indexOf(":");
    if (i > 0) cur.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return rules;
}

export function headersFor(rules: HeaderRule[], path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rules) {
    if (!r.re.test(path)) continue;
    for (const [k, v] of r.headers) {
      const key = k.toLowerCase();
      out[key] = key in out ? `${out[key]}, ${v}` : v;
    }
  }
  return out;
}

export interface StaticServer {
  url: string;
  server: Server;
  close(): Promise<void>;
}

/** Serve `root` on 127.0.0.1 (random port unless given). */
export async function serveStatic(root: string, port = 0): Promise<StaticServer> {
  const headersFile = join(root, "_headers");
  const rules = existsSync(headersFile) ? parseHeaders(readFileSync(headersFile, "utf8")) : [];
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  const server = createServer((req, res) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const rel = normalize(path).replace(/^([/\\])+/, "");
    const abs = join(root, rel);
    if (abs !== root && !abs.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.writeHead(403).end();
      return;
    }
    const send = (status: number, file: string, urlPath: string) => {
      const body = readFileSync(file);
      const h: Record<string, string> = {
        "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        "content-length": String(body.length),
        ...headersFor(rules, urlPath),
      };
      res.writeHead(status, h);
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (path.endsWith("/")) {
      const idx = join(abs, "index.html");
      if (isFile(idx)) return send(200, idx, path);
    } else if (isFile(abs) && !abs.endsWith(sep + "_headers") && !abs.endsWith(sep + "_redirects")) {
      return send(200, abs, path);
    } else if (existsSync(abs) && statSync(abs).isDirectory() && isFile(join(abs, "index.html"))) {
      res.writeHead(308, { location: path + "/" }).end();
      return;
    } else if (isFile(abs + ".html")) {
      return send(200, abs + ".html", path);
    }
    const notFound = join(root, "404.html");
    if (isFile(notFound)) return send(404, notFound, path);
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
