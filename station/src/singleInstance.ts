// A Station UI puts its controlling terminal's stdin into raw mode and owns it.
// A second UI on the SAME tty — typically a stale `bun --hot` orphan that
// outlived its launching shell (reparented to PID 1 yet still attached to the
// tty: Ctrl-C is swallowed by `exitOnCtrlC: false` and nothing handles
// SIGHUP/SIGTERM, so the old UI never exits) — means two processes read one
// stdin. Each `read()` pulls a slice, so a multi-byte sequence gets torn
// between the two readers: kitty CSI-u keys like Shift+Enter (`\x1b[13;2u`)
// arrive split and never reach the focused pane, while single-byte keys (plain
// Enter `\r`) still land. Reaping rival UIs on this tty before we claim stdin
// keeps the invariant the runtime depends on: exactly one Station UI per
// terminal.

import { execFileSync } from "node:child_process";

export type ProcEntry = { pid: number; tty: string; command: string };

function isBunExecutable(command: string): boolean {
  const exe = command.trimStart().split(/\s+/, 1)[0] ?? "";
  return exe === "bun" || exe.endsWith("/bun");
}

/**
 * Rival Station UIs: another process (never self) on the same controlling tty
 * whose command runs the `bun` executable on `src/main.tsx`. The `bash -c`
 * launcher whose argv merely mentions `src/main.tsx` is excluded by the bun
 * check — and it exits on its own once the bun child it waits on is gone.
 */
export function selectRivalStationUiPids(
  processes: readonly ProcEntry[],
  self: number,
  myTty: string,
): number[] {
  return processes
    .filter(
      (p) =>
        p.pid !== self &&
        p.tty === myTty &&
        isBunExecutable(p.command) &&
        p.command.includes("src/main.tsx"),
    )
    .map((p) => p.pid);
}

export function parsePsListing(output: string): ProcEntry[] {
  const entries: ProcEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*\S)\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    entries.push({ pid: Number(match[1]), tty: match[2] ?? "", command: match[3] ?? "" });
  }
  return entries;
}

function lookupSelfTty(): string {
  // `tty=` prints `ttys001` for an attached process and `??` for none — the
  // same format `ps -t` echoes back, so the rival comparison needs no
  // translation.
  return execFileSync("ps", ["-p", String(process.pid), "-o", "tty="], {
    encoding: "utf8",
  }).trim();
}

function listTtyProcesses(tty: string): ProcEntry[] {
  // Scoping to one tty keeps the scan ~15ms where a full `ps -axo` costs
  // 200-290ms on a busy box.
  const output = execFileSync("ps", ["-t", tty, "-o", "pid=,tty=,command="], {
    encoding: "utf8",
  });
  return parsePsListing(output);
}

export type TerminateDeps = {
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL" | 0) => void;
  sleep: (ms: number) => Promise<void>;
};

const defaultTerminateDeps: TerminateDeps = {
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const POLL_INTERVAL_MS = 10;
const SIGTERM_GRACE_MS = 250;
const SIGKILL_GRACE_MS = 50;

async function pollUntilGone(pid: number, capMs: number, deps: TerminateDeps): Promise<boolean> {
  for (let waited = 0; waited < capMs; waited += POLL_INTERVAL_MS) {
    await deps.sleep(POLL_INTERVAL_MS);
    try {
      deps.kill(pid, 0);
    } catch {
      return true; // ESRCH: exited
    }
  }
  return false;
}

export async function terminate(
  pid: number,
  deps: TerminateDeps = defaultTerminateDeps,
): Promise<void> {
  try {
    deps.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  // The orphan traps no signals, so SIGTERM normally lands within a poll tick;
  // escalate only if it is somehow still alive at the grace cap, then stop —
  // stdin frees as it dies.
  if (await pollUntilGone(pid, SIGTERM_GRACE_MS, deps)) {
    return;
  }
  try {
    deps.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  await pollUntilGone(pid, SIGKILL_GRACE_MS, deps);
}

export type ReapDeps = {
  isTty: () => boolean;
  lookupSelfTty: () => string;
  listTtyProcesses: (tty: string) => ProcEntry[];
  terminate: (pid: number) => Promise<void>;
};

const defaultReapDeps: ReapDeps = {
  isTty: () => process.stdout.isTTY === true,
  lookupSelfTty,
  listTtyProcesses,
  terminate: (pid) => terminate(pid),
};

/**
 * Best-effort: terminate any other Station UI holding this terminal's stdin.
 * No-op unless stdin is a real tty (a piped or test run skips it), and never
 * blocks startup if `ps` is unavailable. Callers must await the result before
 * putting stdin into raw mode — a surviving rival reader tears key sequences.
 */
export async function terminateRivalStationUIs(deps: ReapDeps = defaultReapDeps): Promise<void> {
  if (!deps.isTty()) {
    return;
  }
  let rivals: number[];
  try {
    const myTty = deps.lookupSelfTty();
    if (myTty === "" || myTty === "??") {
      return;
    }
    rivals = selectRivalStationUiPids(deps.listTtyProcesses(myTty), process.pid, myTty);
  } catch {
    return;
  }
  await Promise.all(rivals.map((pid) => deps.terminate(pid)));
}
