import { afterEach, describe, expect, it } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import * as timers from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  acquireStationTtyOwnership,
  currentStdinMatchesStationTty,
  type StationTtyIdentity,
  type StationTtyOwnership,
  type StationTtyOwnershipDeps,
} from "./singleInstance.js";

const TEST_IDENTITY: StationTtyIdentity = {
  platform: "darwin",
  dev: "11",
  rdev: "22",
  ino: "33",
};
const TEST_PID = 42_424;
const TEST_TTY = "ttys344";
const UID = process.geteuid?.() ?? -1;
const stationDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");

type TestChild = {
  process: ChildProcessWithoutNullStreams;
  exited: Promise<number | null>;
  stderr(): string;
};

let tempRoot: string | undefined;
let ownerships: StationTtyOwnership[] = [];
let childProcesses: TestChild[] = [];
let processKillRestorers: Array<() => void> = [];

afterEach(async () => {
  for (const restore of processKillRestorers.reverse()) restore();
  processKillRestorers = [];
  for (const ownership of ownerships.reverse()) ownership.release();
  ownerships = [];
  for (const child of childProcesses) {
    if (child.process.exitCode === null) child.process.kill();
    await child.exited;
  }
  childProcesses = [];
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

function makeRoot(): string {
  tempRoot ??= mkdtempSync("/tmp/station-tty-ownership-test-");
  return join(tempRoot, "rendezvous");
}

function fakeStat(identity: StationTtyIdentity = TEST_IDENTITY) {
  return {
    dev: BigInt(identity.dev),
    rdev: BigInt(identity.rdev),
    ino: BigInt(identity.ino),
    isCharacterDevice: () => true,
  };
}

function clearPsListing(command = "bun test src/singleInstance.test.ts"): string {
  return `${TEST_PID} ${TEST_TTY} ${command}\n`;
}

function makeDeps(
  root = makeRoot(),
  overrides: Partial<StationTtyOwnershipDeps> = {},
): StationTtyOwnershipDeps {
  return {
    isStdinTty: () => true,
    platform: "darwin",
    readStdinStat: () => fakeStat(),
    readTtyPathStat: () => fakeStat(),
    effectiveUid: () => UID,
    rendezvousDirectory: () => root,
    runPs: (args) => (args[0] === "-p" ? `${TEST_TTY}\n` : clearPsListing()),
    selfPid: TEST_PID,
    takeoverTimeoutMs: 2_000,
    ...overrides,
  };
}

async function acquireOwned(deps = makeDeps()): Promise<StationTtyOwnership> {
  const result = await acquireStationTtyOwnership(deps);
  expect(result.kind).toBe("owned");
  if (result.kind !== "owned") throw new Error(JSON.stringify(result));
  ownerships.push(result.ownership);
  return result.ownership;
}

function claimStem(identity: StationTtyIdentity = TEST_IDENTITY): string {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);
}

function socketPath(root: string): string {
  return join(root, `${claimStem()}.sock`);
}

describe("TTY identity and legacy upgrade evidence", () => {
  it("does no identity, process, filesystem, socket, SQLite, or signal work for non-TTY stdin", async () => {
    const calls: string[] = [];
    const kill = forbidProcessKill(() => {
      calls.push("kill");
    });
    const result = await acquireStationTtyOwnership({
      isStdinTty: () => false,
      readStdinStat: () => {
        calls.push("fstat");
        return fakeStat();
      },
      readTtyPathStat: () => {
        calls.push("tty-stat");
        return fakeStat();
      },
      runPs: () => {
        calls.push("ps");
        return "";
      },
      rendezvousDirectory: () => {
        calls.push("filesystem");
        return makeRoot();
      },
    });
    kill.restore();
    expect(result).toEqual({ kind: "not-required", reason: "stdin-not-tty" });
    expect(calls).toEqual([]);
  });

  it("derives one claim from fstat identity and reuses it across HMR acquisition", async () => {
    const root = makeRoot();
    const first = await acquireOwned(makeDeps(root));
    first.setTakeoverHandler(() => {});
    const secondResult = await acquireStationTtyOwnership(
      makeDeps(root, {
        runPs: () => {
          throw new Error("HMR reuse must not scan processes");
        },
      }),
    );
    expect(secondResult.kind).toBe("owned");
    if (secondResult.kind !== "owned") return;
    expect(secondResult.ownership).toBe(first);
    expect(readdirSync(root).filter((name) => name.endsWith(".sqlite"))).toHaveLength(1);
  });

  it("canonicalizes signed Bun device metadata before hashing or protocol exchange", async () => {
    const signedDeviceStat = () => ({ ...fakeStat(), dev: -227_081_116n });
    const result = await acquireStationTtyOwnership(
      makeDeps(makeRoot(), {
        readStdinStat: signedDeviceStat,
        readTtyPathStat: signedDeviceStat,
      }),
    );
    expect(result).toMatchObject({
      kind: "owned",
      ownership: { identity: { dev: "18446744073482470500" } },
    });
    if (result.kind === "owned") ownerships.push(result.ownership);
  });

  it("accepts Linux pts names after corroborating the controlling TTY device", async () => {
    const tty = "pts/7";
    const ttyPaths: string[] = [];
    await acquireOwned(
      makeDeps(makeRoot(), {
        platform: "linux",
        readTtyPathStat: (path) => {
          ttyPaths.push(path);
          return fakeStat();
        },
        runPs: (args) =>
          args[0] === "-p" ? `${tty}\n` : `${TEST_PID} ${tty} bun test src/main.tsx\n`,
      }),
    );
    expect(ttyPaths).toEqual(["/dev/pts/7"]);
  });

  it("fails closed before scanning peers when the controlling TTY is not stdin", async () => {
    let listedPeers = false;
    const result = await acquireStationTtyOwnership(
      makeDeps(makeRoot(), {
        readTtyPathStat: () => fakeStat({ ...TEST_IDENTITY, ino: "34" }),
        runPs: (args) => {
          if (args[0] === "-p") return `${TEST_TTY}\n`;
          listedPeers = true;
          return clearPsListing();
        },
      }),
    );
    expect(result).toMatchObject({ kind: "refused", reason: "claim-unavailable" });
    expect(listedPeers).toBe(false);
  });

  it("revalidates the exact stdin device before raw mode", () => {
    expect(currentStdinMatchesStationTty(TEST_IDENTITY, makeDeps())).toBe(true);
    expect(
      currentStdinMatchesStationTty(
        TEST_IDENTITY,
        makeDeps(makeRoot(), { readStdinStat: () => fakeStat({ ...TEST_IDENTITY, ino: "34" }) }),
      ),
    ).toBe(false);
  });

  it("fails closed on unsupported platforms and non-character interactive stdin", async () => {
    const unsupported = await acquireStationTtyOwnership(makeDeps(makeRoot(), { platform: "win32" }));
    expect(unsupported).toMatchObject({
      kind: "refused",
      reason: "identity-unavailable",
      error: { code: "TUI_TTY_OWNERSHIP_UNAVAILABLE" },
    });
    const notCharacter = await acquireStationTtyOwnership(
      makeDeps(makeRoot(), {
        readStdinStat: () => ({ ...fakeStat(), isCharacterDevice: () => false }),
      }),
    );
    expect(notCharacter).toMatchObject({ kind: "refused", reason: "identity-unavailable" });
  });

  it("conservatively refuses unrelated source-looking Bun and exact compiled rows without signaling", async () => {
    const kill = forbidProcessKill();
    for (const command of ["bun /tmp/unrelated/src/main.tsx", "/opt/station/stn __tui"]) {
      const result = await acquireStationTtyOwnership(
        makeDeps(makeRoot(), {
          runPs: (args) =>
            args[0] === "-p"
              ? `${TEST_TTY}\n`
              : `${clearPsListing()}4242 ${TEST_TTY} ${command}\n`,
        }),
      );
      expect(result).toMatchObject({
        kind: "refused",
        reason: "legacy-owner-possible",
        error: { code: "TUI_TTY_LEGACY_OWNER_POSSIBLE" },
      });
      expect(result.kind === "refused" ? result.error.hint : "").toContain("sent no signal");
    }
    expect(kill.calls()).toBe(0);
    kill.restore();
  });

  it("does not treat shell wrappers or misleading substrings as process authority", async () => {
    const listing = [
      clearPsListing().trimEnd(),
      `100 ${TEST_TTY} /bin/bash -c bun run link:station && bun --hot src/main.tsx`,
      `101 ${TEST_TTY} bun /tmp/src/main.tsx.backup`,
      `102 ${TEST_TTY} /bin/sh -c /opt/station/stn __tui`,
    ].join("\n");
    await acquireOwned(
      makeDeps(makeRoot(), {
        runPs: (args) => (args[0] === "-p" ? `${TEST_TTY}\n` : `${listing}\n`),
      }),
    );
  });

  it("fails closed on flattened paths, repeated flags, malformed/truncated rows, and unavailable ps", async () => {
    const uncertainListings = [
      `${clearPsListing()}100 ${TEST_TTY} bun --hot --hot /tmp/path with spaces/src/main.tsx\n`,
      `${clearPsListing()}not-a-row\n`,
      clearPsListing().trimEnd(),
    ];
    for (const listing of uncertainListings) {
      const result = await acquireStationTtyOwnership(
        makeDeps(makeRoot(), {
          runPs: (args) => (args[0] === "-p" ? `${TEST_TTY}\n` : listing),
        }),
      );
      expect(result.kind).toBe("refused");
    }
    const unavailable = await acquireStationTtyOwnership(
      makeDeps(makeRoot(), {
        runPs: () => {
          throw new Error("ps unavailable");
        },
      }),
    );
    expect(unavailable).toMatchObject({ kind: "refused", reason: "claim-unavailable" });
  });
});

describe("private claim files", () => {
  it("refuses symlinked and non-private rendezvous directories", async () => {
    const parent = makeRoot();
    const target = join(tempRoot!, "target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, parent);
    const symlinked = await acquireStationTtyOwnership(makeDeps(parent));
    expect(symlinked).toMatchObject({ kind: "refused", reason: "claim-unavailable" });
    rmSync(parent);
    mkdirSync(parent, { mode: 0o755 });
    const publicDirectory = await acquireStationTtyOwnership(makeDeps(parent));
    expect(publicDirectory).toMatchObject({ kind: "refused", reason: "claim-unavailable" });
  });

  it("refuses symlinked, wrongly-moded, and corrupt claim databases", async () => {
    for (const kind of ["symlink", "mode", "corrupt"] as const) {
      const root = makeRoot();
      mkdirSync(root, { mode: 0o700 });
      const database = join(root, `${claimStem()}.sqlite`);
      if (kind === "symlink") {
        const target = join(tempRoot!, "claim-target");
        writeFileSync(target, "");
        symlinkSync(target, database);
      } else {
        writeFileSync(database, kind === "corrupt" ? "not sqlite" : "");
        chmodSync(database, kind === "mode" ? 0o644 : 0o600);
      }
      const result = await acquireStationTtyOwnership(makeDeps(root));
      expect(result).toMatchObject({ kind: "refused", reason: "claim-unavailable" });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a live or malformed endpoint and removes only a proven-stale owned socket", async () => {
    const root = makeRoot();
    mkdirSync(root, { mode: 0o700 });
    const liveServer = createServer((socket) => socket.end("malformed\n"));
    await new Promise<void>((resolve) => liveServer.listen(socketPath(root), resolve));
    const live = await acquireStationTtyOwnership(makeDeps(root));
    expect(live).toMatchObject({ kind: "refused", reason: "claim-unavailable" });
    await new Promise<void>((resolve) => liveServer.close(() => resolve()));

    const recovered = await acquireOwned(makeDeps(root));
    expect(existsSync(socketPath(root))).toBe(true);
    recovered.release();
    expect(existsSync(socketPath(root))).toBe(false);
  });
});

describe("control protocol and HMR", () => {
  it("updates the HMR handler and accepts one exact takeover frame", async () => {
    const root = makeRoot();
    const owner = await acquireOwned(makeDeps(root));
    let oldCalls = 0;
    let newCalls = 0;
    owner.setTakeoverHandler(() => oldCalls++);
    const reused = await acquireStationTtyOwnership(makeDeps(root));
    expect(reused.kind).toBe("owned");
    if (reused.kind !== "owned") return;
    reused.ownership.setTakeoverHandler(() => newCalls++);

    expect(await sendRawFrame(socketPath(root), "takeover\n")).toBe("accepted");
    await timers.setTimeout(5);
    expect({ oldCalls, newCalls }).toEqual({ oldCalls: 0, newCalls: 1 });
  });

  it("rejects unknown, partial, multiple, and oversized takeover frames", async () => {
    const root = makeRoot();
    const owner = await acquireOwned(makeDeps(root));
    let calls = 0;
    owner.setTakeoverHandler(() => calls++);
    const invalidFrames = [
      "unknown\n",
      "takeover",
      "takeover\ntakeover\n",
      `${"x".repeat(4_097)}\n`,
    ];
    for (const frame of invalidFrames) {
      expect(await sendRawFrame(socketPath(root), frame)).toBe("");
    }
    expect(calls).toBe(0);
  });
});

describe("cross-process ownership", () => {
  it("acquires after an incumbent cooperatively releases and invokes its handler once", async () => {
    const root = makeRoot();
    const child = await spawnOwner(root, "release");
    const result = await acquireStationTtyOwnership(makeDeps(root));
    expect(result.kind).toBe("owned");
    if (result.kind === "owned") ownerships.push(result.ownership);
    await waitForPath(join(root, "handled"));
    expect(readFileSync(join(root, "handled"), "utf8")).toBe("1");
    await child.exited;
  });

  it("times out after accepted takeover when the owner does not release, with no signal fallback", async () => {
    const root = makeRoot();
    const child = await spawnOwner(root, "ignore");
    const kill = forbidProcessKill();
    const result = await acquireStationTtyOwnership(
      makeDeps(root, { takeoverTimeoutMs: 100 }),
    );
    expect(result).toMatchObject({
      kind: "refused",
      reason: "takeover-timeout",
      error: { code: "TUI_TTY_TAKEOVER_TIMEOUT" },
    });
    expect(kill.calls()).toBe(0);
    kill.restore();
    expect(child.process.exitCode).toBeNull();
    expect(existsSync(join(root, "handled"))).toBe(true);
  });

  it("recovers the transaction and stale endpoint automatically after owner process exit", async () => {
    const root = makeRoot();
    const child = await spawnOwner(root, "exit");
    await child.exited;
    expect(existsSync(socketPath(root))).toBe(true);
    await acquireOwned(makeDeps(root));
  });

  it("elects exactly one of two contenders after one accepted cooperative shutdown", async () => {
    const root = makeRoot();
    const owner = await spawnOwner(root, "delayed-release");
    const contenders = [spawnContender(root, "a"), spawnContender(root, "b")];
    const children = await Promise.all(contenders);
    await Promise.all(children.map((child) => child.exited));
    await owner.exited;
    const outcomes = ["a", "b"].map((name) =>
      existsSync(join(root, `${name}-owned`)) ? "owned" : "refused",
    );
    expect(outcomes.filter((outcome) => outcome === "owned")).toHaveLength(1);
  });
});

async function sendRawFrame(path: string, frame: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const chunks: Buffer[] = [];
    socket.setTimeout(1_000, () => socket.destroy(new Error("socket timeout")));
    socket.once("connect", () => socket.write(frame));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
    socket.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve("");
      else reject(error);
    });
  });
}

async function spawnOwner(
  root: string,
  behavior: "release" | "delayed-release" | "ignore" | "exit",
): Promise<TestChild> {
  const script = `
    import { writeFileSync } from "node:fs";
    import { acquireStationTtyOwnership } from "./src/singleInstance.ts";
    const root = process.env.STATION_TTY_TEST_ROOT;
    const tty = ${JSON.stringify(TEST_TTY)};
    const identity = ${JSON.stringify(TEST_IDENTITY)};
    const result = await acquireStationTtyOwnership({
      isStdinTty: () => true,
      platform: "darwin",
      readStdinStat: () => ({ dev: 11n, rdev: 22n, ino: 33n, isCharacterDevice: () => true }),
      readTtyPathStat: () => ({ dev: 11n, rdev: 22n, ino: 33n, isCharacterDevice: () => true }),
      effectiveUid: () => process.geteuid(),
      rendezvousDirectory: () => root,
      runPs: (args) => args[0] === "-p" ? tty + "\\n" : process.pid + " " + tty + " bun child-owner\\n",
      selfPid: process.pid,
    });
    if (result.kind !== "owned") throw new Error(JSON.stringify(result));
    writeFileSync(root + "/ready", "1");
    let handled = 0;
    result.ownership.setTakeoverHandler(() => {
      handled += 1;
      writeFileSync(root + "/handled", String(handled));
      if (${JSON.stringify(behavior)} === "release") {
        result.ownership.release();
        setTimeout(() => process.exit(0), 10);
      } else if (${JSON.stringify(behavior)} === "delayed-release") {
        setTimeout(() => { result.ownership.release(); process.exit(0); }, 75);
      }
    });
    if (${JSON.stringify(behavior)} === "exit") setTimeout(() => process.exit(0), 50);
    setTimeout(() => process.exit(2), 10_000);
  `;
  const child = spawnTestChild(script, { STATION_TTY_TEST_ROOT: root });
  childProcesses.push(child);
  await waitForPath(join(root, "ready"), child);
  return child;
}

async function spawnContender(root: string, name: string): Promise<TestChild> {
  const script = `
    import { writeFileSync } from "node:fs";
    import { acquireStationTtyOwnership } from "./src/singleInstance.ts";
    const root = process.env.STATION_TTY_TEST_ROOT;
    const name = process.env.STATION_TTY_TEST_NAME;
    const tty = ${JSON.stringify(TEST_TTY)};
    const result = await acquireStationTtyOwnership({
      isStdinTty: () => true,
      platform: "darwin",
      readStdinStat: () => ({ dev: 11n, rdev: 22n, ino: 33n, isCharacterDevice: () => true }),
      readTtyPathStat: () => ({ dev: 11n, rdev: 22n, ino: 33n, isCharacterDevice: () => true }),
      effectiveUid: () => process.geteuid(),
      rendezvousDirectory: () => root,
      runPs: (args) => args[0] === "-p" ? tty + "\\n" : process.pid + " " + tty + " bun contender\\n",
      selfPid: process.pid,
      takeoverTimeoutMs: 1000,
    });
    writeFileSync(root + "/" + name + "-" + (result.kind === "owned" ? "owned" : "refused"), result.kind);
    if (result.kind === "owned") {
      setTimeout(() => { result.ownership.release(); process.exit(0); }, 150);
    } else {
      process.exit(0);
    }
  `;
  const child = spawnTestChild(script, {
    STATION_TTY_TEST_ROOT: root,
    STATION_TTY_TEST_NAME: name,
  });
  childProcesses.push(child);
  return child;
}

async function waitForPath(path: string, child?: TestChild): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!existsSync(path) && Date.now() < deadline) {
    if (child !== undefined && child.process.exitCode !== null) {
      throw new Error(`fixture exited ${child.process.exitCode}: ${child.stderr()}`);
    }
    await timers.setTimeout(10);
  }
  if (!existsSync(path)) throw new Error(`Timed out waiting for ${path}`);
}

function spawnTestChild(script: string, env: NodeJS.ProcessEnv): TestChild {
  const child = spawn(process.execPath, ["--eval", script], {
    cwd: stationDirectory,
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
  let stderr = "";
  child.stdin.end();
  child.stdout.resume();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return {
    process: child,
    exited: new Promise((resolve) => child.once("close", resolve)),
    stderr: () => stderr,
  };
}

function forbidProcessKill(onCall?: () => void): { calls(): number; restore(): void } {
  const original = process.kill;
  let calls = 0;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    process.kill = original;
  };
  processKillRestorers.push(restore);
  process.kill = ((..._args: Parameters<typeof process.kill>) => {
    calls += 1;
    onCall?.();
    throw new Error("process.kill must not be called");
  }) as typeof process.kill;
  return { calls: () => calls, restore };
}
