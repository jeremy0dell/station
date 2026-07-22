import { describe, expect, it } from "vitest";
import {
  type ObserverProcessEntry,
  parseObserverPsOutput,
  runObserverReap,
  selectReapPlan,
} from "../../src/observerReap.js";

const SOCK = "/Users/u/.local/state/station/observer.sock";
const OTHER = "/Users/u/.local/state/unrelated/observer.sock";

function proc(
  pid: number,
  socketPath: string | undefined,
  token = `t${pid}`,
): ObserverProcessEntry {
  const argv = ["/bin/node", "/repo/apps/cli/dist/observerMain.js", "--state-dir", "/x"];
  return socketPath === undefined
    ? { pid, argv, startToken: token }
    : { pid, argv, startToken: token, socketPath };
}

describe("parseObserverPsOutput", () => {
  it("keeps real node observerMain.js processes and resolves their socket", () => {
    const out = [
      " 3740 Sat Jul  4 17:45:33 2026 /opt/node/bin/node /repo/apps/cli/dist/observerMain.js --socket /a/o.sock",
      "19359 Sat Jul  4 17:47:24 2026 /bin/zsh -c grep observerMain.js in some command",
      "  501 Fri Jan  2 09:00:00 2026 /usr/bin/ssh -N host",
    ].join("\n");
    const entries = parseObserverPsOutput(out);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.pid).toBe(3740);
    expect(entries[0]?.startToken).toBe("Sat Jul  4 17:45:33 2026");
    expect(entries[0]?.socketPath).toBe("/a/o.sock");
  });

  it("excludes a shell wrapper whose argv mentions observerMain.js (self-match guard)", () => {
    const out =
      "88888 Sat Jul  4 17:47:24 2026 /bin/zsh -c ps -axww | grep observerMain.js --state-dir /x";
    expect(parseObserverPsOutput(out)).toEqual([]);
  });

  it("keeps only the exact compiled stn observer command shape", () => {
    const out = [
      " 4001 Sat Jul  4 17:45:33 2026 /opt/station/stn __observer --socket /compiled/o.sock",
      " 4002 Sat Jul  4 17:45:34 2026 /opt/station/stn observer start --socket /wrong/o.sock",
      " 4003 Sat Jul  4 17:45:35 2026 /opt/station/stn-copy __observer --socket /wrong/o.sock",
      " 4004 Sat Jul  4 17:45:36 2026 /bin/zsh -c /opt/station/stn __observer --socket /wrong/o.sock",
    ].join("\n");

    expect(parseObserverPsOutput(out)).toEqual([
      expect.objectContaining({ pid: 4001, socketPath: "/compiled/o.sock" }),
    ]);
  });
});

describe("selectReapPlan", () => {
  it("targets same-socket duplicates and never the keeper or other sockets", () => {
    const plan = selectReapPlan({
      socketPath: SOCK,
      processes: [proc(100, SOCK), proc(200, SOCK), proc(300, OTHER), proc(400, undefined)],
      holders: [100],
    });
    expect(plan.keeper).toBe(100);
    expect(plan.targets.map((t) => t.pid)).toEqual([200]);
    expect(plan.duplicates).toBe(1);
  });

  it("refuses the whole reap when no live owner holds the socket", () => {
    const plan = selectReapPlan({ socketPath: SOCK, processes: [proc(200, SOCK)], holders: [] });
    expect(plan.keeper).toBeUndefined();
    expect(plan.targets).toEqual([]);
  });

  it("disambiguates multiple holders via health pid and refuses the rest", () => {
    const plan = selectReapPlan({
      socketPath: SOCK,
      processes: [proc(100, SOCK), proc(101, SOCK), proc(200, SOCK)],
      holders: [100, 101],
      healthPid: 101,
    });
    expect(plan.keeper).toBe(101);
    expect(plan.refusals.map((r) => r.pid)).toContain(100);
    expect(plan.targets.map((t) => t.pid)).toEqual([200]); // holders never targeted
  });

  it("refuses everything when >1 holder and health does not name one of them", () => {
    const plan = selectReapPlan({
      socketPath: SOCK,
      processes: [proc(100, SOCK), proc(101, SOCK), proc(200, SOCK)],
      holders: [100, 101],
      healthPid: 999,
    });
    expect(plan.keeper).toBeUndefined();
    expect(plan.targets).toEqual([]);
    expect(plan.refusals.map((r) => r.pid).sort()).toEqual([100, 101]);
  });

  it("refuses a candidate with no start-time token instead of killing blind", () => {
    const plan = selectReapPlan({
      socketPath: SOCK,
      processes: [proc(100, SOCK), { pid: 200, argv: [], startToken: "", socketPath: SOCK }],
      holders: [100],
    });
    expect(plan.targets).toEqual([]);
    expect(plan.refusals.map((r) => r.reason)).toContain("no start-time token to re-verify");
  });
});

describe("runObserverReap", () => {
  const noop = () => Promise.resolve();

  it("dry-run lists without signaling", async () => {
    const signals: unknown[] = [];
    const out = await runObserverReap(
      SOCK,
      { force: false },
      {
        listObserverProcesses: () => [proc(100, SOCK), proc(200, SOCK)],
        socketHolders: () => [100],
        signal: (pid, sig) => {
          signals.push([pid, sig]);
          return true;
        },
        sleep: noop,
      },
    );
    expect(out.applied).toBe(false);
    expect(out.plan.targets.map((t) => t.pid)).toEqual([200]);
    expect(signals).toEqual([]);
  });

  it("force terminates duplicates and never the keeper", async () => {
    const dead = new Set<number>();
    const sent: Array<[number, string | number]> = [];
    const out = await runObserverReap(
      SOCK,
      { force: true, graceMs: 0 },
      {
        listObserverProcesses: () => [proc(100, SOCK), proc(200, SOCK), proc(300, SOCK)],
        socketHolders: () => [100],
        processStartToken: (pid) => `t${pid}`,
        signal: (pid, sig) => {
          sent.push([pid, sig]);
          if (sig === "SIGTERM" || sig === "SIGKILL") dead.add(pid);
          return !dead.has(pid); // signal 0 after death -> false
        },
        sleep: noop,
      },
    );
    expect(out.applied).toBe(true);
    expect(out.killed.sort()).toEqual([200, 300]);
    expect(out.survived).toEqual([]);
    expect(sent.some(([pid]) => pid === 100)).toBe(false); // keeper untouched
    expect(
      sent
        .filter(([, sig]) => sig === "SIGTERM")
        .map(([pid]) => pid)
        .sort(),
    ).toEqual([200, 300]);
  });

  it("does not signal a PID whose start token changed (PID reuse)", async () => {
    const sent: Array<[number, string | number]> = [];
    const out = await runObserverReap(
      SOCK,
      { force: true, graceMs: 0 },
      {
        listObserverProcesses: () => [proc(100, SOCK), proc(200, SOCK, "old-token")],
        socketHolders: () => [100],
        processStartToken: (pid) => (pid === 200 ? "REUSED-different" : `t${pid}`),
        signal: (pid, sig) => {
          sent.push([pid, sig]);
          return true;
        },
        sleep: noop,
      },
    );
    expect(sent.some(([pid, sig]) => pid === 200 && sig === "SIGTERM")).toBe(false);
    expect(out.applied).toBe(true);
  });

  it("aborts when the socket owner changes mid-reap", async () => {
    let calls = 0;
    const out = await runObserverReap(
      SOCK,
      { force: true, graceMs: 0 },
      {
        listObserverProcesses: () => [proc(100, SOCK), proc(200, SOCK)],
        // First read (selection) = [100]; a later read shows a takeover to [999].
        socketHolders: () => (calls++ === 0 ? [100] : [999]),
        processStartToken: (pid) => `t${pid}`,
        signal: () => true,
        sleep: noop,
      },
    );
    expect(out.aborted).toBe("owner-changed");
  });
});
