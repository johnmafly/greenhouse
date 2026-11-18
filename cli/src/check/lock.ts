// Machine-wide performance lock (~/.greenhouse/perf.lock) so no other bot's work skews
// Lighthouse measurements. Exclusive-create file holding the owner's pid; a lock whose pid is
// gone on this host is stale and taken over.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { dirname, join } from "node:path";

export function greenhouseHome(): string {
  return process.env.GREENHOUSE_HOME || join(homedir(), ".greenhouse");
}

export function perfLockPath(): string {
  return join(greenhouseHome(), "perf.lock");
}

export interface LockHandle {
  path: string;
  waitedMs: number;
  release(): void;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class LockTimeoutError extends Error {
  constructor(path: string, ms: number, owner: string) {
    super(`timed out after ${Math.round(ms / 1000)}s waiting for ${path} (held by ${owner})`);
    this.name = "LockTimeoutError";
  }
}

export async function acquireLock(path = perfLockPath(), timeoutMs = 30 * 60_000, pollMs = 500, label = "greenhouse check"): Promise<LockHandle> {
  mkdirSync(dirname(path), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), label, since: new Date().toISOString() }) + "\n");
      closeSync(fd);
      let released = false;
      return {
        path,
        waitedMs: Date.now() - start,
        release() {
          if (released) return;
          released = true;
          try {
            const cur = JSON.parse(readFileSync(path, "utf8"));
            if (cur.pid === process.pid && cur.host === hostname()) rmSync(path, { force: true });
          } catch {
            /* already gone */
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let owner = "unknown";
    try {
      const cur = JSON.parse(readFileSync(path, "utf8"));
      owner = `pid ${cur.pid} on ${cur.host}${cur.label ? ` (${cur.label})` : ""}`;
      if (cur.host === hostname() && typeof cur.pid === "number" && !alive(cur.pid)) {
        rmSync(path, { force: true });
        continue;
      }
    } catch {
      // Unreadable lock: another process may be mid-write. Treat it as held.
    }
    if (Date.now() - start >= timeoutMs) throw new LockTimeoutError(path, Date.now() - start, owner);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
