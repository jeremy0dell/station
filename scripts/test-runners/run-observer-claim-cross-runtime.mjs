import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const runnerPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(dirname(runnerPath)));
const observerInternalUrl = pathToFileURL(
  join(repoRoot, "apps", "observer", "dist", "internal.js"),
).href;
const protocolUrl = pathToFileURL(join(repoRoot, "packages", "protocol", "dist", "index.js")).href;
const contentionTimeoutMs = 100;
const processTimeoutMs = 15_000;

if (process.argv[2] === "--socket-server-child") {
  await runSocketServerChild(parseFlags(process.argv.slice(3))).catch(failChild);
} else if (process.argv[2] === "--socket-probe-child") {
  await runSocketProbeChild(parseFlags(process.argv.slice(3))).catch(failChild);
} else if (process.argv[2] === "--child") {
  await runChild(parseFlags(process.argv.slice(3))).catch((error) => {
    failChild(error);
  });
} else {
  await runController(parseControllerArgs(process.argv.slice(2)));
}

async function runController({ rounds }) {
  const { observerBootClaimPath } = await import(observerInternalUrl);
  assert.equal(typeof observerBootClaimPath, "function");

  const tempRoot = mkdtempSync(join(tmpdir(), "station-observer-claim-cross-runtime-"));
  const socketPath = join(tempRoot, "socket directory with spaces", "observer.sock");
  const claimPath = observerBootClaimPath(socketPath);
  assert.equal(claimPath, join(dirname(socketPath), "observer.claim.sqlite"));

  let initialClaimIdentity;
  let maximumCriticalSectionConcurrency = 0;
  const threeContenderRounds = 10;

  try {
    for (let round = 0; round < rounds; round += 1) {
      const runtimes = round % 2 === 0 ? ["node", "bun"] : ["bun", "node"];
      const result = await runRace({
        tempRoot,
        socketPath,
        name: `two-${round + 1}`,
        runtimes,
      });
      maximumCriticalSectionConcurrency = Math.max(
        maximumCriticalSectionConcurrency,
        result.criticalSectionConcurrency,
      );
      initialClaimIdentity ??= claimIdentity(claimPath);
      assertClaimIdentity(claimPath, initialClaimIdentity);
    }

    for (let round = 0; round < threeContenderRounds; round += 1) {
      const runtimes = round % 2 === 0 ? ["node", "bun", "node"] : ["bun", "node", "bun"];
      const result = await runRace({
        tempRoot,
        socketPath,
        name: `three-${round + 1}`,
        runtimes,
      });
      maximumCriticalSectionConcurrency = Math.max(
        maximumCriticalSectionConcurrency,
        result.criticalSectionConcurrency,
      );
      assertClaimIdentity(claimPath, initialClaimIdentity);
    }

    const recoveryResult = await runKilledOwnerRecovery({ tempRoot, socketPath });
    maximumCriticalSectionConcurrency = Math.max(
      maximumCriticalSectionConcurrency,
      recoveryResult.criticalSectionConcurrency,
    );
    assertClaimIdentity(claimPath, initialClaimIdentity);
    assert.equal(maximumCriticalSectionConcurrency, 1);
    assertClaimFile(claimPath);
    assert.equal(await readIntegrityCheck(claimPath), "ok");
    await verifySocketSafetyAcrossRuntimes(tempRoot);

    console.log(
      `Observer boot claim passed ${rounds} alternating Node/Bun races, ` +
        `${threeContenderRounds} three-contender races, and killed-owner recovery.`,
    );
    console.log("Exactly one transaction entered each race; maximum critical concurrency was 1.");
    console.log("The persistent claim inode was unchanged and integrity_check=ok.");
    console.log("Node and Bun agreed on inaccessible, stale, and displaced-abandon socket safety.");
    console.log("No fairness property is asserted.");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function verifySocketSafetyAcrossRuntimes() {
  const tempRoot = mkdtempSync("/tmp/stn-socket-");
  try {
    for (const runtime of ["node", "bun"]) {
      const socketPath = join(tempRoot, `live-${runtime}.sock`);
      const owner = startSocketServerChild({
        runtime,
        socketPath,
        name: `live-${runtime}`,
        tempRoot,
        releaseMode: "close",
      });
      try {
        await waitFor(`${runtime} live socket`, () => existsSync(owner.readyPath));
        chmodSync(socketPath, 0o000);
        for (const probeRuntime of ["node", "bun"]) {
          assert.deepEqual(await runSocketProbe(probeRuntime, socketPath, tempRoot), {
            status: "inaccessible",
            reason: probeRuntime === "node" ? "permission-denied" : "live-holder",
            errorCode: "PROTOCOL_SOCKET_INACCESSIBLE",
          });
        }
        chmodSync(socketPath, 0o600);
      } finally {
        writeMarkerIfMissing(owner.releasePath);
        assertChildSucceeded(await owner.completed);
      }
    }

    const stalePath = join(tempRoot, "stale.sock");
    const staleOwner = startSocketServerChild({
      runtime: "node",
      socketPath: stalePath,
      name: "stale-owner",
      tempRoot,
      releaseMode: "exit",
    });
    await waitFor("stale socket owner", () => existsSync(staleOwner.readyPath));
    writeMarker(staleOwner.releasePath);
    assertChildSucceeded(await staleOwner.completed);
    for (const runtime of ["node", "bun"]) {
      assert.deepEqual(await runSocketProbe(runtime, stalePath, tempRoot), {
        status: "stale",
      });
    }
    unlinkSync(stalePath);

    for (const [ownerRuntime, successorRuntime] of [
      ["node", "bun"],
      ["bun", "node"],
    ]) {
      const socketPath = join(tempRoot, `displaced-${ownerRuntime}.sock`);
      const owner = startSocketServerChild({
        runtime: ownerRuntime,
        socketPath,
        name: `displaced-${ownerRuntime}`,
        tempRoot,
        releaseMode: "abandon",
      });
      await waitFor(`${ownerRuntime} displaced owner`, () => existsSync(owner.readyPath));
      unlinkSync(socketPath);
      const successor = startSocketServerChild({
        runtime: successorRuntime,
        socketPath,
        name: `successor-${successorRuntime}`,
        tempRoot,
        releaseMode: "close",
      });
      try {
        await waitFor(`${successorRuntime} successor`, () => existsSync(successor.readyPath));
        writeMarker(owner.releasePath);
        assertChildSucceeded(await owner.completed);
        for (const runtime of ["node", "bun"]) {
          assert.deepEqual(await runSocketProbe(runtime, socketPath, tempRoot), {
            status: "listening",
          });
        }
      } finally {
        writeMarkerIfMissing(successor.releasePath);
        assertChildSucceeded(await successor.completed);
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function startSocketServerChild({ runtime, socketPath, name, tempRoot, releaseMode }) {
  const readyPath = join(tempRoot, `${name}.ready`);
  const releasePath = join(tempRoot, `${name}.release`);
  const child = spawn(
    runtime === "node" ? nodeExecutable() : "bun",
    [
      runnerPath,
      "--socket-server-child",
      "--socket",
      socketPath,
      "--ready",
      readyPath,
      "--release",
      releasePath,
      "--release-mode",
      releaseMode,
    ],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.ok(child.pid !== undefined, `Could not start ${runtime} socket child.`);
  return {
    readyPath,
    releasePath,
    completed: collectChildExit(child, runtime),
  };
}

async function runSocketServerChild(flags) {
  const socketPath = requiredFlag(flags, "socket");
  const readyPath = requiredFlag(flags, "ready");
  const releasePath = requiredFlag(flags, "release");
  const releaseMode = requiredFlag(flags, "release-mode");
  const { listenUnixSocket } = await import(protocolUrl);
  const server = await listenUnixSocket({ socketPath, onConnection: () => undefined });
  writeMarker(readyPath);
  await waitFor("socket release", () => existsSync(releasePath));
  if (releaseMode === "close") await server.close();
  else if (releaseMode === "abandon") server.abandon();
  else assert.equal(releaseMode, "exit");
  if (releaseMode !== "close") process.exit(0);
}

async function runSocketProbe(runtime, socketPath, tempRoot) {
  const resultPath = join(tempRoot, `probe-${runtime}-${process.pid}-${Date.now()}.json`);
  const child = spawn(
    runtime === "node" ? nodeExecutable() : "bun",
    [runnerPath, "--socket-probe-child", "--socket", socketPath, "--result", resultPath],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assertChildSucceeded(await collectChildExit(child, runtime));
  const result = readJson(resultPath);
  rmSync(resultPath, { force: true });
  return result;
}

async function runSocketProbeChild(flags) {
  const socketPath = requiredFlag(flags, "socket");
  const resultPath = requiredFlag(flags, "result");
  const { probeUnixSocket } = await import(protocolUrl);
  const probe = await probeUnixSocket(socketPath);
  writeJson(resultPath, {
    status: probe.status,
    ...(probe.status === "inaccessible"
      ? { reason: probe.reason, errorCode: probe.error.code }
      : {}),
  });
}

async function runRace({ tempRoot, socketPath, name, runtimes }) {
  const raceDir = join(tempRoot, "races", name);
  const goPath = join(raceDir, "go");
  const releasePath = join(raceDir, "release");
  const activePath = join(raceDir, "active");
  mkdirSync(raceDir, { recursive: true, mode: 0o700 });

  const children = runtimes.map((runtime, index) =>
    startClaimChild({
      runtime,
      nonce: `${name}-${index}-${runtime}`,
      socketPath,
      raceDir,
      goPath,
      releasePath,
      activePath,
    }),
  );

  await waitFor(`${name} contenders to become ready`, () =>
    children.every(({ readyPath }) => existsSync(readyPath)),
  );
  writeMarker(goPath);

  await waitFor(`${name} claim decisions`, () => {
    const entries = children.filter(({ entryPath }) => existsSync(entryPath));
    const results = children.filter(({ resultPath }) => existsSync(resultPath));
    const crashed = children.some(
      ({ entryPath, exit, resultPath }) =>
        exit !== undefined && !existsSync(entryPath) && !existsSync(resultPath),
    );
    return crashed || entries.length > 1 || entries.length + results.length === children.length;
  });

  const entriesBeforeRelease = children
    .filter(({ entryPath }) => existsSync(entryPath))
    .map(({ entryPath }) => readJson(entryPath));
  writeMarker(releasePath);

  const exits = await Promise.all(children.map(({ completed }) => completed));
  for (const exit of exits) {
    assert.equal(
      exit.code,
      0,
      `${exit.runtime} child failed (${exit.signal ?? "no signal"}):\n${exit.stderr}`,
    );
  }

  const outcomes = children.map(({ resultPath }) => readJson(resultPath));
  const acquired = outcomes.filter(({ status }) => status === "acquired");
  const contended = outcomes.filter(({ status }) => status === "contended");
  assert.equal(entriesBeforeRelease.length, 1, `${name} had multiple transaction entrants.`);
  assert.equal(entriesBeforeRelease[0].overlap, false, `${name} overlapped its critical section.`);
  assert.equal(acquired.length, 1, `${name} did not produce exactly one acquired result.`);
  assert.equal(acquired[0].releaseStatus, "released", `${name} did not release cleanly.`);
  assert.equal(contended.length, runtimes.length - 1, `${name} had a non-busy losing result.`);
  assert.equal(existsSync(activePath), false, `${name} left its critical-section marker behind.`);

  return {
    criticalSectionConcurrency: entriesBeforeRelease.length,
    winner: entriesBeforeRelease[0],
  };
}

async function runKilledOwnerRecovery({ tempRoot, socketPath }) {
  const raceDir = join(tempRoot, "killed-owner");
  const goPath = join(raceDir, "go");
  const releasePath = join(raceDir, "release-never-written");
  const activePath = join(raceDir, "active");
  const nonce = `bun-owner-${process.pid}-${Date.now()}`;
  mkdirSync(raceDir, { recursive: true, mode: 0o700 });

  const owner = startClaimChild({
    runtime: "bun",
    nonce,
    socketPath,
    raceDir,
    goPath,
    releasePath,
    activePath,
  });
  await waitFor("Bun owner to become ready", () => existsSync(owner.readyPath));
  writeMarker(goPath);
  await waitFor("Bun owner to enter the claim transaction", () => existsSync(owner.entryPath));

  const entry = readJson(owner.entryPath);
  assert.equal(entry.nonce, nonce);
  assert.equal(entry.pid, owner.pid);
  assert.equal(entry.runtime, "bun");
  assert.equal(entry.overlap, false);
  assert.equal(existsSync(activePath), true);

  process.kill(owner.pid, "SIGKILL");
  const ownerExit = await owner.completed;
  assert.equal(ownerExit.code, null);
  assert.equal(ownerExit.signal, "SIGKILL");
  assert.equal(existsSync(owner.resultPath), false);
  rmSync(activePath, { recursive: true, force: true });

  const successor = await runRace({
    tempRoot,
    socketPath,
    name: "node-successor",
    runtimes: ["node"],
  });
  assert.equal(successor.winner.runtime, "node");
  return successor;
}

function startClaimChild({ runtime, nonce, socketPath, raceDir, goPath, releasePath, activePath }) {
  const readyPath = join(raceDir, `${nonce}.ready`);
  const entryPath = join(raceDir, `${nonce}.entry.json`);
  const resultPath = join(raceDir, `${nonce}.result.json`);
  const executable = runtime === "node" ? nodeExecutable() : "bun";
  const args = [
    runnerPath,
    "--child",
    "--runtime",
    runtime,
    "--nonce",
    nonce,
    "--socket",
    socketPath,
    "--ready",
    readyPath,
    "--go",
    goPath,
    "--release",
    releasePath,
    "--active",
    activePath,
    "--entry",
    entryPath,
    "--result",
    resultPath,
  ];
  const child = spawn(executable, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(child.pid !== undefined, `Could not start ${runtime} claim child.`);

  const record = {
    pid: child.pid,
    runtime,
    readyPath,
    entryPath,
    resultPath,
    exit: undefined,
    completed: undefined,
  };
  record.completed = collectChildExit(child, runtime).then((exit) => {
    record.exit = exit;
    return exit;
  });
  return record;
}

async function runChild(flags) {
  const runtime = requiredFlag(flags, "runtime");
  const nonce = requiredFlag(flags, "nonce");
  const socketPath = requiredFlag(flags, "socket");
  const readyPath = requiredFlag(flags, "ready");
  const goPath = requiredFlag(flags, "go");
  const releasePath = requiredFlag(flags, "release");
  const activePath = requiredFlag(flags, "active");
  const entryPath = requiredFlag(flags, "entry");
  const resultPath = requiredFlag(flags, "result");
  const { acquireObserverBootClaim } = await import(observerInternalUrl);
  assert.equal(typeof acquireObserverBootClaim, "function");

  writeMarker(readyPath);
  await waitFor("controller race barrier", () => existsSync(goPath));
  const result = await acquireObserverBootClaim({
    socketPath,
    timeoutMs: contentionTimeoutMs,
  });

  if (result.status !== "acquired") {
    writeJson(resultPath, { status: result.status, error: errorMessage(result.error) });
    return;
  }

  let ownsActiveMarker = false;
  let overlap = false;
  let releaseResult;
  try {
    try {
      mkdirSync(activePath, { mode: 0o700 });
      ownsActiveMarker = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      overlap = true;
    }
    writeJson(entryPath, {
      nonce,
      pid: process.pid,
      runtime,
      path: result.path,
      overlap,
    });
    await waitFor("controller claim release", () => existsSync(releasePath));
  } finally {
    if (ownsActiveMarker) rmSync(activePath, { recursive: true, force: true });
    releaseResult = result.release();
  }

  writeJson(resultPath, {
    status: "acquired",
    path: result.path,
    releaseStatus: releaseResult.status,
    ...(releaseResult.status === "failed"
      ? { releaseError: errorMessage(releaseResult.error) }
      : {}),
  });
  if (releaseResult.status !== "released") process.exitCode = 1;
}

function parseControllerArgs(args) {
  if (args[0] === "--") args = args.slice(1);
  if (args.length === 0) return { rounds: 50 };
  assert.deepEqual(args.slice(0, 1), ["--rounds"], "Usage: --rounds <positive integer>");
  assert.equal(args.length, 2, "Usage: --rounds <positive integer>");
  const rounds = Number(args[1]);
  assert.ok(Number.isSafeInteger(rounds) && rounds > 0, "--rounds must be a positive integer.");
  return { rounds };
}

function parseFlags(args) {
  assert.equal(args.length % 2, 0, "Child flags must be key/value pairs.");
  const flags = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    assert.ok(flag.startsWith("--"), `Expected a flag, received ${flag}.`);
    assert.equal(flags.has(flag.slice(2)), false, `Duplicate child flag ${flag}.`);
    flags.set(flag.slice(2), args[index + 1]);
  }
  return flags;
}

function requiredFlag(flags, name) {
  const value = flags.get(name);
  assert.ok(value !== undefined && value.length > 0, `Missing --${name}.`);
  return value;
}

function nodeExecutable() {
  return process.versions.bun === undefined ? process.execPath : "node";
}

function collectChildExit(child, runtime) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr, runtime }));
  });
}

async function waitFor(description, predicate) {
  const deadline = Date.now() + processTimeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function writeMarker(path) {
  writeFileSync(path, "", { flag: "wx", mode: 0o600 });
}

function writeMarkerIfMissing(path) {
  if (!existsSync(path)) writeMarker(path);
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function claimIdentity(path) {
  const stats = statSync(path);
  return { device: stats.dev, inode: stats.ino };
}

function assertClaimIdentity(path, expected) {
  assert.deepEqual(claimIdentity(path), expected, "The persistent claim database inode changed.");
}

function assertClaimFile(path) {
  const stats = lstatSync(path);
  assert.equal(stats.isFile(), true, "The claim database must be a regular file.");
  assert.equal(stats.isSymbolicLink(), false, "The claim database must not be a symlink.");
  assert.equal(stats.mode & 0o777, 0o600, "The claim database must remain mode 0600.");
}

async function readIntegrityCheck(path) {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare("PRAGMA integrity_check").get()?.integrity_check;
  } finally {
    database.close();
  }
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function assertChildSucceeded(exit) {
  assert.equal(
    exit.code,
    0,
    `${exit.runtime} child failed (${exit.signal ?? "no signal"}):\n${exit.stderr}`,
  );
}

function failChild(error) {
  console.error(error);
  process.exitCode = 1;
}
