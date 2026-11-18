// Placeholder board build; replaced by the board issue. Writes board/dist/index.html.
// Static files in board/public (including _headers, which sends X-Robots-Tag: noindex on
// Cloudflare Pages, see docs/decisions/0001) are copied into board/dist as-is.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
mkdirSync("board/dist", { recursive: true });
cpSync("board/public", "board/dist", { recursive: true });
writeFileSync("board/dist/index.html", "<!doctype html><title>Greenhouse</title><h1>Greenhouse board</h1><p>Coming soon.</p>\n");
console.log("board/dist/index.html written");
