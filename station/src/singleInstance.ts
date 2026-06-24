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

declare const Bun: { sleepSync(ms: number): void };

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

function listProcesses(): ProcEntry[] {
  // `tty=` prints `ttys001` for an attached process and `??` for none, so the
  // self lookup and the rival comparison share one identical tty format.
  const output = execFileSync("ps", ["-axo", "pid=,tty=,command="], { encoding: "utf8" });
  return parsePsListing(output);
}

function terminate(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  // The orphan traps no signals, so SIGTERM normally lands; escalate only if it
  // is somehow still alive after a short grace, then stop — stdin frees as it dies.
  Bun.sleepSync(250);
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch {
    // exited within the grace window
  }
}

/**
 * Best-effort: terminate any other Station UI holding this terminal's stdin.
 * No-op unless stdin is a real tty (a piped or test run skips it), and never
 * blocks startup if `ps` is unavailable.
 */
export function terminateRivalStationUIs(): void {
  if (process.stdout.isTTY !== true) {
    return;
  }
  let processes: ProcEntry[];
  try {
    processes = listProcesses();
  } catch {
    return;
  }
  const self = processes.find((p) => p.pid === process.pid);
  if (self === undefined || self.tty === "??" || self.tty === "") {
    return;
  }
  for (const pid of selectRivalStationUiPids(processes, process.pid, self.tty)) {
    terminate(pid);
  }
}
