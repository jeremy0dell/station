import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createObserverClient } from "../../packages/protocol/dist/index.js";
import { createStationHostClient } from "../../packages/station-host/dist/index.js";

const binaryPath = resolve(process.env.STATION_BINARY_PATH ?? "station/dist/bin/stn");
const expectedVersion = parseExpectedVersion(process.argv.slice(2));
const ptyOnly = process.env.STATION_BINARY_SMOKE_PTY_ONLY === "1";
const root = await mkdtemp(join(tmpdir(), "station-binary-smoke-"));
const homeDir = join(root, "home");
const stateDir = join(root, "state");
const runtimeDir = join(root, "runtime");
const hostileDir = join(root, "hostile");
const socketPath = join(runtimeDir, "observer.sock");
const configPath = join(root, "config.toml");
const markerPath = join(root, "ambient-config-pwned");
const childEnv = isolatedBinaryEnv({ homeDir, runtimeDir });

let observerClient;
let observerPid;
let hostClient;
let hostProcess;

try {
  await access(binaryPath, constants.X_OK);
  await Promise.all([
    mkdir(homeDir, { recursive: true, mode: 0o700 }),
    mkdir(stateDir, { recursive: true, mode: 0o700 }),
    mkdir(runtimeDir, { recursive: true, mode: 0o700 }),
    mkdir(hostileDir, { recursive: true, mode: 0o700 }),
  ]);
  await writeSmokeConfig(configPath, stateDir, socketPath);
  await writeHostileConfig(hostileDir, markerPath);

  if (!ptyOnly) {
    const version = await run(binaryPath, ["--version"], { env: childEnv });
    assertEqual(version.stdout.trim(), expectedVersion, "compiled --version");

    const help = await run(binaryPath, ["--help"], { env: childEnv });
    assertIncludes(help.stdout, "Usage:", "compiled --help");

    const popupHelp = await run(join(dirname(binaryPath), "stn-tmux-popup"), ["--help"], {
      env: childEnv,
    });
    assertIncludes(popupHelp.stdout, "stn popup", "popup symlink dispatch");

    const setup = await run(
      binaryPath,
      ["--config", configPath, "setup", "check", "--json", "--no-brew"],
      { cwd: root, env: childEnv, allowedExitCodes: [1] },
    );
    const setupPlan = JSON.parse(setup.stdout);
    assertEqual(setupPlan.summary.launchReady, true, "compiled setup launchReady");
    assertEqual(setupPlan.summary.workflowReady, false, "compiled setup workflowReady");
    assertEqual(setupPlan.summary.requiredOk, false, "compiled setup requiredOk alias");

    await run(binaryPath, ["--config", configPath, "observer", "start", "--timeout-ms", "30000"], {
      env: childEnv,
    });
    observerClient = createObserverClient({ socketPath, timeoutMs: 5000 });
    const health = await observerClient.health();
    observerPid = health.pid;
    assertEqual(health.status, "healthy", "compiled observer health");
    const snapshot = await observerClient.getSnapshot();
    assertEqual(snapshot.observer.healthy, true, "compiled observer snapshot");

    const ingress = await run(
      join(dirname(binaryPath), "stn-ingress"),
      ["--socket", socketPath, "--state-dir", stateDir, "worktrunk", "post-create"],
      {
        env: childEnv,
        input: JSON.stringify({ branch: "station/binary-smoke" }),
      },
    );
    assertEqual(ingress.code, 0, "ingress symlink receipt");
    assertEqual(
      await directoryFileCount(join(stateDir, "spool", "hooks")),
      0,
      "online ingress must not spool",
    );
    assertEqual((await observerClient.health()).status, "healthy", "observer after ingress");

    const bootLog = await readFile(join(stateDir, "logs", "observer-boot.log"), "utf8");
    const bootHeader = JSON.parse(bootLog.split(/\r?\n/, 1)[0] ?? "{}");
    assertEqual(bootHeader.command?.[0], binaryPath, "detached observer executable");
    assertEqual(bootHeader.command?.[1], "__observer", "detached observer internal route");

    const piExtensionPath = await findFile(join(stateDir, "run", "assets", "pi"), (name) =>
      name.endsWith(".mjs"),
    );
    await import(`${pathToFileURL(piExtensionPath).href}?smoke=${Date.now()}`);

    await observerClient.stop();
    observerClient = undefined;
    await waitForMissing(socketPath);
  }

  const hostSocketPath = join(runtimeDir, "station-host.sock");
  hostProcess = spawn(
    binaryPath,
    ["__station-host", "--socket", hostSocketPath, "--state-dir", stateDir],
    {
      cwd: hostileDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const hostDiagnostics = collectOutput(hostProcess);
  hostClient = createStationHostClient({
    socketPath: hostSocketPath,
    timeoutMs: 1000,
    expectedBuildVersion: expectedVersion,
  });
  await waitForHost(hostClient, hostDiagnostics);
  const hostHealth = await hostClient.health();
  assertEqual(hostHealth.buildVersion, expectedVersion, "compiled station-host build version");
  await access(markerPath).then(
    () => fail("hostile .env or bunfig preload created its marker"),
    () => undefined,
  );

  const spawned = await hostClient.spawn({
    terminalTargetId: "native:binary-smoke",
    worktreeId: "binary-smoke",
    projectId: "binary-smoke",
    sessionId: "ses_binary_smoke",
    worktreePath: root,
    harnessProvider: "scripted",
    command: "/bin/sh",
    args: ["-c", "printf STATION_BINARY_PTY_OK; sleep 1; exit 7"],
    cwd: root,
    cols: 80,
    rows: 24,
  });
  const attachment = await hostClient.attach(spawned.ptyId);
  const terminalResult = await collectTerminalResult(attachment, 10_000);
  assertIncludes(terminalResult.output, "STATION_BINARY_PTY_OK", "compiled host PTY output");
  assertEqual(terminalResult.exitCode, 7, "compiled host PTY exit code");

  const hostLog = await readFile(join(stateDir, "logs", "station-host.jsonl"), "utf8");
  assertIncludes(hostLog, '"ptyImplementation":"bun"', "compiled host PTY implementation");
  await findFile(join(stateDir, "run", "assets", "ctty"), (name) => name === "station-ctty-helper");

  process.stdout.write("binary smoke passed\n");
} finally {
  if (observerClient !== undefined) {
    await observerClient.stop().catch(() => undefined);
    await waitForMissing(socketPath).catch(() => undefined);
  }
  if (observerPid !== undefined) {
    await terminateProcess(observerPid);
  }
  hostClient?.dispose();
  if (hostProcess !== undefined && hostProcess.exitCode === null) {
    hostProcess.kill("SIGTERM");
    try {
      await waitForExit(hostProcess, 3000);
    } catch {
      hostProcess.kill("SIGKILL");
      await waitForExit(hostProcess, 3000).catch(() => undefined);
    }
  }
  await rm(root, { recursive: true, force: true });
}

function parseExpectedVersion(args) {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.length === 0) {
    return "0.1.0-dev";
  }
  if (
    normalized.length === 2 &&
    normalized[0] === "--expected-version" &&
    normalized[1]?.length > 0
  ) {
    return normalized[1];
  }
  throw new Error("Usage: run-binary-smoke.mjs --expected-version <version>");
}

function isolatedBinaryEnv({ homeDir: home, runtimeDir: runtime }) {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_RUNTIME_DIR: runtime,
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/sh",
    LANG: "C",
    TERM: "xterm-256color",
    TMPDIR: join(home, "tmp"),
  };
}

async function writeSmokeConfig(path, state, socket) {
  await writeFile(
    path,
    [
      "schema_version = 1",
      "projects = []",
      "",
      "[observer]",
      `state_dir = ${JSON.stringify(state)}`,
      `socket_path = ${JSON.stringify(socket)}`,
      "",
      "[defaults]",
      'worktree_provider = "noop-worktree"',
      'terminal = "noop-terminal"',
      'harness = "noop-harness"',
      'layout = "agent-shell"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

async function writeHostileConfig(directory, marker) {
  await writeFile(
    join(directory, ".env"),
    [
      "STATION_PTY_IMPL=ambient-config-must-not-load",
      `STATION_DASHBOARD_COMMAND=touch ${marker}`,
    ].join("\n"),
  );
  await writeFile(join(directory, "bunfig.toml"), '[run]\npreload = ["./preload.mjs"]\n');
  await writeFile(
    join(directory, "preload.mjs"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "pwned");\n`,
  );
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args.join(" ")} timed out\n${stderr}`));
    }, options.timeoutMs ?? 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      const allowed = options.allowedExitCodes ?? [0];
      if (code === null || !allowed.includes(code)) {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited ${code ?? signal ?? "unknown"}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }
      resolveRun({ code, stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}

function collectOutput(child) {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => (stdout += chunk));
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  return () => ({ stdout, stderr });
}

async function waitForHost(client, diagnostics) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await client.health();
      return;
    } catch {
      await delay(50);
    }
  }
  const output = diagnostics();
  fail(`compiled station-host did not become healthy\n${output.stdout}\n${output.stderr}`);
}

async function collectTerminalResult(attachment, timeoutMs) {
  let output = attachment.ack.scrollback.join("");
  if (attachment.ack.exited) {
    fail("compiled PTY exited before its exit frame could be observed");
  }
  const iterator = attachment.frames[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const next = await Promise.race([
        iterator.next(),
        delay(remaining).then(() => ({ timeout: true })),
      ]);
      if (next.timeout === true) break;
      if (next.done) break;
      if (next.value.type === "data") output += next.value.data;
      if (next.value.type === "exit") {
        return { output, exitCode: next.value.exitCode };
      }
    }
  } finally {
    await iterator.return?.();
  }
  fail(`timed out waiting for compiled PTY exit; output=${JSON.stringify(output)}`);
}

async function findFile(directory, matches) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      try {
        return await findFile(path, matches);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("No matching file")) throw error;
      }
    } else if (entry.isFile() && matches(entry.name)) {
      return path;
    }
  }
  throw new Error(`No matching file under ${directory}`);
}

async function directoryFileCount(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile())
      .length;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

async function waitForMissing(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      await delay(25);
    } catch {
      return;
    }
  }
  fail(`path remained present: ${path}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveWait, reject) => {
    const timeout = setTimeout(() => reject(new Error("process did not exit")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveWait();
    });
  });
}

async function terminateProcess(pid) {
  if (await waitForProcessExit(pid, 3000)) return;
  if (!signalProcess(pid, "SIGTERM")) return;
  if (await waitForProcessExit(pid, 3000)) return;
  if (!signalProcess(pid, "SIGKILL")) return;
  if (!(await waitForProcessExit(pid, 3000))) {
    throw new Error(`observer process ${pid} survived SIGKILL`);
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await delay(25);
  }
  return !processIsAlive(pid);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    fail(`${label}: expected ${JSON.stringify(value)} to include ${JSON.stringify(expected)}`);
  }
}

function fail(message) {
  throw new Error(message);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
