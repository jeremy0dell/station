import { describe, expect, it } from "bun:test";
import { parsePsListing, selectRivalStationUiPids } from "./singleInstance.js";

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
  ];

  it("targets only a rival UI on the same tty", () => {
    expect(selectRivalStationUiPids(ROWS, SELF, "ttys001")).toEqual([5018]);
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
