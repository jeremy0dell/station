import { describe, expect, it } from "bun:test";
import {
  parsePsListing,
  type ReapDeps,
  selectRivalStationUiPids,
  terminate,
  type TerminateDeps,
  terminateRivalStationUIs,
} from "./singleInstance.js";

describe("selectRivalStationUiPids", () => {
  const SELF = 7588;
  const ROWS = [
    { pid: 5018, tty: "ttys001", command: "bun --hot src/main.tsx" }, // stale orphan, same tty
    { pid: SELF, tty: "ttys001", command: "bun --hot src/main.tsx" }, // self
    {
      pid: 7548,
      tty: "ttys001",
      command: "/bin/bash -c bun run link:station && bun --hot src/main.tsx",
    }, // launcher: argv mentions the script but it is not the bun process
    { pid: 4242, tty: "ttys002", command: "bun --hot src/main.tsx" }, // a UI on another terminal
    { pid: 9000, tty: "ttys001", command: "bun src/host/hostMain.ts" }, // host daemon, not a UI
    { pid: 9001, tty: "ttys001", command: "/usr/local/bin/stn __tui" }, // compiled UI
  ];

  it("targets only a rival UI on the same tty", () => {
    expect(selectRivalStationUiPids(ROWS, SELF, "ttys001")).toEqual([5018, 9001]);
  });

  it("never returns self even on a shared tty", () => {
    expect(selectRivalStationUiPids(ROWS, SELF, "ttys001")).not.toContain(SELF);
  });

  it("ignores the bash launcher whose argv merely mentions the script", () => {
    expect(selectRivalStationUiPids(ROWS, SELF, "ttys001")).not.toContain(7548);
  });

  it("ignores a UI attached to a different tty", () => {
    expect(selectRivalStationUiPids(ROWS, SELF, "ttys001")).not.toContain(4242);
  });

  it("matches a bun invoked by absolute path", () => {
    const rows = [{ pid: 1, tty: "ttys001", command: "/opt/homebrew/bin/bun --hot src/main.tsx" }];
    expect(selectRivalStationUiPids(rows, 99, "ttys001")).toEqual([1]);
  });

  it("matches only the exact compiled stn TUI command shape", () => {
    const rows = [
      { pid: 1, tty: "ttys001", command: "/opt/station/stn __tui" },
      { pid: 2, tty: "ttys001", command: "/opt/station/stn __station-host" },
      { pid: 3, tty: "ttys001", command: "/opt/station/stn __tui extra" },
      { pid: 4, tty: "ttys001", command: "/opt/station/stn-copy __tui" },
      { pid: 5, tty: "ttys001", command: "/bin/sh -c /opt/station/stn __tui" },
    ];
    expect(selectRivalStationUiPids(rows, 99, "ttys001")).toEqual([1]);
  });
});

describe("parsePsListing", () => {
  it("splits pid, tty, and the full command including spaces", () => {
    const out = "  5018 ttys001 bun --hot src/main.tsx\n  321 ?? /sbin/launchd\n\n";
    expect(parsePsListing(out)).toEqual([
      { pid: 5018, tty: "ttys001", command: "bun --hot src/main.tsx" },
      { pid: 321, tty: "??", command: "/sbin/launchd" },
    ]);
  });
});

function recordingKill(record: Array<"SIGTERM" | "SIGKILL" | 0>, alive: () => boolean) {
  const deps: TerminateDeps = {
    kill: (_pid, signal) => {
      record.push(signal);
      if (signal === 0 && !alive()) {
        throw new Error("ESRCH");
      }
    },
    sleep: () => Promise.resolve(),
  };
  return deps;
}

describe("terminate", () => {
  it("sends SIGTERM and stops polling once the pid is gone", async () => {
    const calls: Array<"SIGTERM" | "SIGKILL" | 0> = [];
    await terminate(42, recordingKill(calls, () => false));
    expect(calls).toEqual(["SIGTERM", 0]);
  });

  it("returns without polling when the pid is already gone", async () => {
    const calls: Array<"SIGTERM" | "SIGKILL" | 0> = [];
    let slept = 0;
    await terminate(42, {
      kill: (_pid, signal) => {
        calls.push(signal);
        throw new Error("ESRCH");
      },
      sleep: () => {
        slept += 1;
        return Promise.resolve();
      },
    });
    expect(calls).toEqual(["SIGTERM"]);
    expect(slept).toBe(0);
  });

  it("escalates to SIGKILL at the grace cap when SIGTERM is ignored, then stops", async () => {
    const calls: Array<"SIGTERM" | "SIGKILL" | 0> = [];
    await terminate(42, recordingKill(calls, () => true));
    const sigkillIndex = calls.indexOf("SIGKILL");
    expect(calls[0]).toBe("SIGTERM");
    expect(sigkillIndex).toBeGreaterThan(1);
    expect(calls.lastIndexOf("SIGKILL")).toBe(sigkillIndex);
    expect(calls.slice(1, sigkillIndex).every((call) => call === 0)).toBe(true);
    // Polls after SIGKILL, then gives up on an unkillable pid rather than spinning.
    expect(calls.length).toBeGreaterThan(sigkillIndex + 1);
    expect(calls.slice(sigkillIndex + 1).every((call) => call === 0)).toBe(true);
  });

  it("stops the escalation poll once SIGKILL lands", async () => {
    const calls: Array<"SIGTERM" | "SIGKILL" | 0> = [];
    await terminate(
      42,
      recordingKill(calls, () => !calls.includes("SIGKILL")),
    );
    expect(calls[0]).toBe("SIGTERM");
    expect(calls.filter((call) => call === "SIGKILL")).toHaveLength(1);
    // One probe observes the death and ends the poll.
    expect(calls.slice(calls.indexOf("SIGKILL") + 1)).toEqual([0]);
  });
});

function reapDeps(overrides: Partial<ReapDeps>, reaped: number[]): ReapDeps {
  return {
    isTty: () => true,
    lookupSelfTty: () => "ttys001",
    listTtyProcesses: () => [],
    terminate: (pid) => {
      reaped.push(pid);
      return Promise.resolve();
    },
    ...overrides,
  };
}

describe("terminateRivalStationUIs", () => {
  it("skips the tty lookup when stdout is not a tty", async () => {
    let lookedUp = false;
    const reaped: number[] = [];
    await terminateRivalStationUIs(
      reapDeps(
        {
          isTty: () => false,
          lookupSelfTty: () => {
            lookedUp = true;
            return "ttys001";
          },
        },
        reaped,
      ),
    );
    expect(lookedUp).toBe(false);
    expect(reaped).toEqual([]);
  });

  it("does not scan or reap when the self tty is '??' or empty", async () => {
    for (const tty of ["??", ""]) {
      let scanned = false;
      const reaped: number[] = [];
      await terminateRivalStationUIs(
        reapDeps(
          {
            lookupSelfTty: () => tty,
            listTtyProcesses: () => {
              scanned = true;
              return [];
            },
          },
          reaped,
        ),
      );
      expect(scanned).toBe(false);
      expect(reaped).toEqual([]);
    }
  });

  it("skips reaping when ps is unavailable", async () => {
    const reaped: number[] = [];
    await terminateRivalStationUIs(
      reapDeps(
        {
          lookupSelfTty: () => {
            throw new Error("ps unavailable");
          },
        },
        reaped,
      ),
    );
    expect(reaped).toEqual([]);
  });

  it("resolves only after every same-tty rival's terminate completes", async () => {
    const rival = process.pid + 1;
    const reaped: number[] = [];
    let settled = false;
    await terminateRivalStationUIs(
      reapDeps(
        {
          listTtyProcesses: () => [
            { pid: rival, tty: "ttys001", command: "bun --hot src/main.tsx" },
            { pid: process.pid, tty: "ttys001", command: "bun --hot src/main.tsx" },
          ],
          terminate: async (pid) => {
            reaped.push(pid);
            await Promise.resolve();
            settled = true;
          },
        },
        reaped,
      ),
    );
    expect(reaped).toEqual([rival]);
    expect(settled).toBe(true);
  });
});
