// Placeholder board build; replaced by the board issue. Writes board/dist/index.html.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("board/dist", { recursive: true });
writeFileSync("board/dist/index.html", "<!doctype html><title>Greenhouse</title><h1>Greenhouse board</h1><p>Coming soon.</p>\n");
console.log("board/dist/index.html written");
