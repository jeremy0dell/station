import {
  type ObserverProcessEntry,
  parseObserverProcessList,
  selectObserverReapPlan,
} from "@station/observer/internal";
import { describe, expect, it } from "vitest";
import { observerCommandSummary } from "../../src/commands/observer.js";
import {
  createLocalObserverReap,
  type ObserverReapDeps,
  runObserverReap,
} from "../../src/observerReap.js";

const SOCK = "/Users/u/.local/state/station/observer.sock";
const OTHER = "/Users/u/.local/state/unrelated/observer.sock";
const BUILD = `1.2.3+station.${"a".repeat(64)}`;
const TOKEN = ["a47ac10b", "58cc", "4372", "a567", "0e02b2c3d479"].join("-");
const SOCKET_IDENTITY = { ino: 1n, birthtimeNs: 2n };

function runTestObserverReap(
  socketPath: string,
  options: { force: boolean; graceMs?: number },
  deps: ObserverReapDeps,
) {
  const readObserverProcess =
    deps.readObserverProcess ??
    ((pid: number) => deps.listObserverProcesses?.().find((entry) => entry.pid === pid));
  return runObserverReap(
    socketPath,
    options,
    createLocalObserverReap({
      ...deps,
      readObserverProcess,
      exclusion: deps.exclusion ?? {
        runExclusive: async (operation) => ({
          status: "completed",
          value: await operation(),
          released: true,
        }),
      },
      healthPid: deps.healthPid ?? (async () => 100),
    }),
  );
}

function proc(
  pid: number,
  socketPath: string | undefined,
  token = `t${pid}`,
): ObserverProcessEntry {
  const executablePath = "/bin/node";
  const argv = [executablePath, "/repo/apps/cli/dist/observerMain.js", "--state-dir", "/x"];
  const entry = {
    pid,
    argv,
    executablePath,
    startToken: token,
    processToken:
      pid === 100 ? TOKEN : ["b47ac10b", "58cc", "4372", "a567", "0e02b2c3d479"].join("-"),
    buildVersion: BUILD,
  };
  return socketPath === undefined ? entry : { ...entry, socketPath };
}

function keeperIdentity() {
  const keeper = proc(100, SOCK);
  return {
    pid: keeper.pid,
    osStartTime: keeper.startToken,
    processToken: keeper.processToken,
    version: keeper.buildVersion,
    socketPath: SOCK,
  };
}

describe("parseObserverProcessList", () => {
  it("keeps real node observerMain.js processes and resolves their socket", () => {
    const out = [
      ` 3740 Sat Jul  4 17:45:33 2026 /opt/node/bin/node /repo/apps/cli/dist/observerMain.js --socket /a/o.sock --state-dir /a/state --startup-timeout-ms 10000 --build-version ${BUILD} --process-token ${TOKEN}`,
      "19359 Sat Jul  4 17:47:24 2026 /bin/zsh -c grep observerMain.js in some command",
      "  501 Fri Jan  2 09:00:00 2026 /usr/bin/ssh -N host",
    ].join("\n");
    const entries = parseObserverProcessList(out);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.pid).toBe(3740);
    expect(entries[0]?.startToken).toBe("Sat Jul  4 17:45:33 2026");
    expect(entries[0]?.socketPath).toBe("/a/o.sock");
  });

  it("excludes a shell wrapper whose argv mentions observerMain.js (self-match guard)", () => {
    const out =
      "88888 Sat Jul  4 17:47:24 2026 /bin/zsh -c ps -axww | grep observerMain.js --state-dir /x";
    expect(parseObserverProcessList(out)).toEqual([]);
  });

  it("keeps only the exact compiled stn observer command shape", () => {
    const out = [
      ` 4001 Sat Jul  4 17:45:33 2026 /opt/station/stn __observer --socket /compiled/o.sock --state-dir /compiled/state --startup-timeout-ms 10000 --build-version ${BUILD} --process-token ${TOKEN}`,
      " 4002 Sat Jul  4 17:45:34 2026 /opt/station/stn observer start --socket /wrong/o.sock",
      " 4003 Sat Jul  4 17:45:35 2026 /opt/station/stn-copy __observer --socket /wrong/o.sock",
      " 4004 Sat Jul  4 17:45:36 2026 /bin/zsh -c /opt/station/stn __observer --socket /wrong/o.sock",
    ].join("\n");

    expect(parseObserverProcessList(out)).toEqual([
      expect.objectContaining({ pid: 4001, socketPath: "/compiled/o.sock" }),
    ]);
  });
});

describe("selectObserverReapPlan", () => {
  it("targets same-socket duplicates and never the keeper or other sockets", () => {
    const plan = selectObserverReapPlan({
      socketPath: SOCK,
      processes: [proc(100, SOCK), proc(200, SOCK), proc(300, OTHER), proc(400, undefined)],
      holders: [100],
    });
    expect(plan.keeper).toBe(100);
    expect(plan.targets.map((t) => t.pid)).toEqual([200]);
    expect(plan.duplicates).toBe(1);
  });

  it("refuses the whole reap when no live owner holds the socket", () => {
    const plan = selectObserverReapPlan({
      socketPath: SOCK,
      processes: [proc(200, SOCK)],
      holders: [],
    });
    expect(plan.keeper).toBeUndefined();
    expect(plan.targets).toEqual([]);
  });

  it("disambiguates multiple holders via health pid and refuses the rest", () => {
    const plan = selectObserverReapPlan({
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
    const plan = selectObserverReapPlan({
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
    const plan = selectObserverReapPlan({
      socketPath: SOCK,
      processes: [proc(100, SOCK), { ...proc(200, SOCK), startToken: "" }],
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
    const out = await runTestObserverReap(
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
    expect(out.plan.targets[0]?.automaticEligibility).toMatchObject({
      eligible: false,
      refusalReasons: [expect.stringContaining("evidence is unavailable")],
    });
    expect(observerCommandSummary(out)).toMatchObject({
      automaticEligibility: [
        expect.objectContaining({
          pid: 200,
          eligible: false,
        }),
      ],
    });
    expect(signals).toEqual([]);
  });

  it("force terminates duplicates and never the keeper", async () => {
    const dead = new Set<number>();
    const sent: Array<[number, string | number]> = [];
    const out = await runTestObserverReap(
      SOCK,
      { force: true, graceMs: 0 },
      {
        listObserverProcesses: () =>
          [proc(100, SOCK), proc(200, SOCK), proc(300, SOCK)].filter(
            (entry) => !dead.has(entry.pid),
          ),
        socketHolders: () => [100],
        processStartToken: (pid) => (dead.has(pid) ? undefined : `t${pid}`),
        readProcessIdentity: async () => keeperIdentity(),
        socketIdentity: async () => SOCKET_IDENTITY,
        unixSocketFdCount: () => 0,
        signal: (pid, sig) => {
          sent.push([pid, sig]);
          if (sig === "SIGTERM" || sig === "SIGKILL") dead.add(pid);
          return sig === 0 ? !dead.has(pid) : true;
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
    const out = await runTestObserverReap(
      SOCK,
      { force: true, graceMs: 0 },
      {
        listObserverProcesses: () => [proc(100, SOCK), proc(200, SOCK, "old-token")],
        socketHolders: () => [100],
        processStartToken: (pid) => (pid === 200 ? "REUSED-different" : `t${pid}`),
        readProcessIdentity: async () => keeperIdentity(),
        socketIdentity: async () => SOCKET_IDENTITY,
        unixSocketFdCount: () => 0,
        signal: (pid, sig) => {
          sent.push([pid, sig]);
          return true;
        },
        sleep: noop,
      },
    );
    expect(sent.some(([pid, sig]) => pid === 200 && sig === "SIGTERM")).toBe(false);
    expect(out).toMatchObject({ applied: false, aborted: "target-changed" });
    expect(observerCommandSummary(out)).toMatchObject({
      applied: false,
      aborted: "target-changed",
      killed: [],
      exited: [],
      survived: [],
    });
  });

  it("aborts when the socket owner changes mid-reap", async () => {
    let calls = 0;
    const out = await runTestObserverReap(
      SOCK,
      { force: true, graceMs: 0 },
      {
        listObserverProcesses: () => [proc(100, SOCK), proc(200, SOCK)],
        // First read (selection) = [100]; a later read shows a takeover to [999].
        socketHolders: () => (calls++ < 3 ? [100] : [999]),
        processStartToken: (pid) => `t${pid}`,
        readProcessIdentity: async () => keeperIdentity(),
        socketIdentity: async () => SOCKET_IDENTITY,
        unixSocketFdCount: () => 0,
        signal: () => true,
        sleep: noop,
      },
    );
    expect(out.aborted).toBe("owner-changed");
  });
});
