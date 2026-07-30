import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ObserverProcessIdentitySchema,
  type StationCommand,
  type StationSnapshot,
  worktreeHasLiveAgent,
} from "../../../packages/contracts/dist/index.js";
import {
  safeErrorFromUnknown,
  stationObserverBuildVersion,
} from "../../../packages/runtime/dist/index.js";
import { createStationHostClient } from "../../../packages/station-host/dist/index.js";
import { findRowByBranch } from "../../support/real-station/assertions";
import {
  createCodexHookEnabledWrapper,
  createCodexSentinel,
  waitForCodexSentinel,
} from "../../support/real-station/codex";
import {
  type RealStationConfigFixture,
  uniqueTmuxSession,
  writeRealStationConfig,
} from "../../support/real-station/config";
import {
  type RealE2eEnvironment,
  realE2eEnabled,
  requireRealE2eEnvironment,
} from "../../support/real-station/env";
import { CleanupStack, runStation, runStationJson } from "../../support/real-station/process";
import {
  createRealObserverClient,
  waitForCommandRecord,
  waitForSnapshot,
} from "../../support/real-station/protocol";
import { createRealTempRepo } from "../../support/real-station/repo";
import {
  type AttachedTmuxPtyClient,
  captureTmuxPane,
  killTmuxSession,
  launchNativeStationInTmux,
  startAttachedTmuxPtyClient,
  tmuxSessionExists,
} from "../../support/real-station/tmux";
import { removeRealWorktrunkWorktree } from "../../support/real-station/worktrunk";

const describeReal = realE2eEnabled() ? describe : describe.skip;
const NATIVE_DIMENSIONS = { columns: 200, rows: 50 } as const;
const PROJECT_LABEL = "station real E2E";

type Cell = {
  column: number;
  row: number;
};

type NativeRuntime = {
  client: AttachedTmuxPtyClient;
  config: RealStationConfigFixture;
  env: RealE2eEnvironment;
  target: string;
};

describeReal("real native Station mouse input", () => {
  let env: RealE2eEnvironment;
  let cleanup: CleanupStack;

  beforeAll(async () => {
    env = await requireRealE2eEnvironment({ worktrunk: true, tmux: true, codex: true });
  });

  afterEach(async () => {
    await cleanup?.run();
  });

  it("routes raw SGR hover and clicks through the native renderer exactly once", async () => {
    cleanup = new CleanupStack();
    const repo = await createRealTempRepo(env);
    cleanup.defer(repo.cleanup);
    const codexCommand = await createCodexHookEnabledWrapper({ env, repo });
    const config = await writeRealStationConfig({
      env,
      repo,
      codexCommand,
      installCodexHooks: true,
    });
    await runStationJson(env, {
      configPath: config.configPath,
      args: ["hooks", "install", "codex", "--yes"],
      timeoutMs: 30_000,
      env: isolatedStationEnv(config),
    });
    const nativeSession = uniqueTmuxSession("station-real-native-mouse");
    const branch = `nm-${process.pid}-${Date.now().toString(36).slice(-6)}`;
    const client = createRealObserverClient(config, 30_000);
    let commandId: string | undefined;
    let runtime: NativeRuntime | undefined;

    cleanup.defer(async () => {
      await runStationJson(env, {
        configPath: config.configPath,
        args: ["observer", "stop"],
        env: isolatedStationEnv(config),
      }).catch(() => undefined);
    });
    cleanup.defer(async () => {
      await killTmuxSession(env, config.tmuxSession);
    });
    cleanup.defer(async () => {
      await removeRealWorktrunkWorktree({ env, config, repo, branch });
    });
    cleanup.defer(async () => {
      await stopStationHostIfIdle(config);
    });
    cleanup.defer(async () => {
      await removeWorktreeThroughObserver(config, branch);
    });

    try {
      await runStationJson(env, {
        configPath: config.configPath,
        args: ["observer", "start", "--timeout-ms", "30000"],
        timeoutMs: 45_000,
        env: isolatedStationEnv(config),
      });
      const sentinel = createCodexSentinel(repo, "native-mouse");
      const createCommand: StationCommand = {
        type: "session.create",
        payload: {
          projectId: config.projectId,
          branch,
          harness: {
            provider: "codex",
            mode: "exec",
          },
          terminal: {
            provider: "tmux",
            layout: "agent-build-shell",
            focus: false,
          },
          initialPrompt: sentinel.prompt,
        },
      };
      const createReceipt = await client.dispatch(createCommand);
      commandId = createReceipt.commandId;
      await waitForCommandRecord(client, createReceipt.commandId, { timeoutMs: 180_000 });

      const created = await waitForSnapshot(
        client,
        (snapshot: StationSnapshot) => snapshot.rows.some((row) => row.branch === branch),
        `Observer did not create the native mouse fixture ${branch}.`,
        90_000,
      );
      const createdRow = findRowByBranch(created, branch);
      await waitForCodexSentinel(sentinel, { rootPath: createdRow.path, timeoutMs: 180_000 });
      await killTmuxSession(env, config.tmuxSession);
      const dormant = await waitForSnapshot(
        client,
        (snapshot: StationSnapshot) => {
          const row = snapshot.rows.find((candidate) => candidate.branch === branch);
          return (
            row !== undefined &&
            !worktreeHasLiveAgent(row) &&
            snapshot.sessions.some(
              (session) => session.worktreeId === row.id && session.origin === "station",
            )
          );
        },
        `Real Codex did not exit into a launchable Station session for ${branch}.`,
        120_000,
      );
      const dormantRow = findRowByBranch(dormant, branch);
      const previousSessionIds = new Set(
        (dormant as StationSnapshot).sessions
          .filter((session) => session.worktreeId === dormantRow.id)
          .map((session) => session.id),
      );

      const launched = await launchNativeStationInTmux({
        env,
        configPath: config.configPath,
        observerSocketPath: config.socketPath,
        stateDir: config.stateDir,
        sessionName: nativeSession,
        cwd: repo.repoPath,
        dimensions: NATIVE_DIMENSIONS,
      });
      cleanup.defer(async () => {
        await killTmuxSession(env, nativeSession);
      });
      const ptyClient = await startAttachedTmuxPtyClient({
        env,
        sessionName: nativeSession,
        dimensions: NATIVE_DIMENSIONS,
      });
      cleanup.defer(ptyClient.close);
      runtime = { client: ptyClient, config, env, target: launched.target };

      const welcome = await waitForNativeFrame(
        runtime,
        (frame) => frame.includes("Open project view"),
        "Native Station did not render its welcome project-view button.",
      );
      await writeSgrClick(ptyClient, cellForText(welcome, "Open project view"));

      const expanded = await waitForNativeFrame(
        runtime,
        (frame) => frame.includes("[shell]") && frame.includes(branch),
        "The native-only Station overlay did not render its project action and real session.",
      );
      expect(expanded).toContain("[shell]");
      const projectCell = cellForText(expanded, PROJECT_LABEL);
      const styleBefore = styledLineForText(await captureNativeFrame(runtime, true), PROJECT_LABEL);

      await ptyClient.write(sgrMouse(35, projectCell));
      await waitForStyledLineChange(
        runtime,
        PROJECT_LABEL,
        styleBefore,
        "Raw SGR motion did not reach the native project-header hover state.",
      );

      await writeSgrClick(ptyClient, projectCell);
      await waitForNativeFrame(
        runtime,
        (frame) => frame.includes(`▶ ${PROJECT_LABEL}`) && !frame.includes(branch),
        "One native SGR down/up click did not collapse the project exactly once.",
      );
      await writeSgrClick(ptyClient, projectCell);
      await waitForNativeFrame(
        runtime,
        (frame) => frame.includes(`▼ ${PROJECT_LABEL}`) && frame.includes(branch),
        "The first deliberate native click did not expand the project once.",
      );
      await writeSgrClick(ptyClient, projectCell);
      await waitForNativeFrame(
        runtime,
        (frame) => frame.includes(`▶ ${PROJECT_LABEL}`) && !frame.includes(branch),
        "The second deliberate native click did not collapse the project once.",
      );
      await writeSgrClick(ptyClient, projectCell);
      const reexpanded = await waitForNativeFrame(
        runtime,
        (frame) => frame.includes(`▼ ${PROJECT_LABEL}`) && frame.includes(branch),
        "The native project did not re-expand before row activation.",
      );

      await writeSgrClick(ptyClient, cellForText(reexpanded, branch));
      await waitForNativeFrame(
        runtime,
        (frame) => !frame.includes("[shell]") && !frame.includes("[quick session]"),
        "Clicking the native session row did not visibly leave the overlay for its agent pane.",
        60_000,
      );
      const active = await waitForSnapshotWithDiagnostics(
        runtime,
        client,
        (snapshot) => {
          const row = snapshot.rows.find((candidate) => candidate.branch === branch);
          return (
            row?.agent?.harness === "codex" &&
            row.agent.sessionId !== undefined &&
            !previousSessionIds.has(row.agent.sessionId) &&
            row.terminal?.provider === "native" &&
            worktreeHasLiveAgent(row)
          );
        },
        "The native row click did not start a new real Codex agent in the Observer snapshot.",
        120_000,
      );
      expect(findRowByBranch(active, branch).agent).toMatchObject({ harness: "codex" });

      const observerPid = await readObserverPid(config);
      const nativePid = launched.panePid;
      const attachedClientPid = ptyClient.processId;
      const worktreePath = dormantRow.path;
      if (process.env.STATION_REAL_E2E_KEEP_TEMP !== "1") {
        await cleanup.run();
        expect(await waitForPidExit(nativePid, 10_000)).toBe(true);
        expect(await waitForPidExit(attachedClientPid, 10_000)).toBe(true);
        expect(await waitForPidExit(observerPid, 10_000)).toBe(true);
        expect(await tmuxSessionExists(env, nativeSession)).toBe(false);
        expect(await tmuxSessionExists(env, config.tmuxSession)).toBe(false);
        expect(await pathExists(worktreePath)).toBe(false);
        expect(await pathExists(repo.root)).toBe(false);
      }
    } catch (error) {
      await writeNativeFailureBundle(env, config, commandId);
      const diagnostics =
        runtime === undefined ? "" : await nativeDiagnostics(runtime).catch(() => "");
      throw new Error(`${errorMessage(error)}${diagnostics}`, { cause: error });
    }
  }, 360_000);
});

function isolatedStationEnv(config: RealStationConfigFixture): NodeJS.ProcessEnv {
  return {
    CODEX_HOME: join(dirname(config.configPath), "codex-home"),
    STATION_CONFIG_PATH: config.configPath,
    STATION_OBSERVER_SOCKET_PATH: config.socketPath,
    STATION_HOST_SOCKET_PATH: join(dirname(config.socketPath), "station-host.sock"),
    STATION_LAYOUT_PATH: join(config.stateDir, "station", "layout.json"),
  };
}

async function writeNativeFailureBundle(
  env: RealE2eEnvironment,
  config: RealStationConfigFixture,
  commandId: string | undefined,
): Promise<void> {
  const args = ["debug", "bundle"];
  if (commandId !== undefined) args.push("--command", commandId);
  await runStationJson(env, {
    configPath: config.configPath,
    args,
    timeoutMs: 30_000,
    env: isolatedStationEnv(config),
  }).catch(() => undefined);
}

async function removeWorktreeThroughObserver(
  config: RealStationConfigFixture,
  branch: string,
): Promise<void> {
  const client = createRealObserverClient(config, 30_000);
  const snapshot = (await client.getSnapshot({ includeDebug: true }).catch(() => undefined)) as
    | StationSnapshot
    | undefined;
  const row = snapshot?.rows.find((candidate) => candidate.branch === branch);
  if (row === undefined) return;
  if (row.registrationIdentity === undefined) {
    throw new Error(`Cannot safely remove ${branch}: registration identity is absent.`);
  }
  const receipt = await client.dispatch({
    type: "worktree.remove",
    payload: {
      projectId: row.projectId,
      worktreeId: row.id,
      expectedPath: row.path,
      expectedBranch: row.branch,
      expectedRegistrationIdentity: row.registrationIdentity,
      force: true,
    },
  });
  await waitForCommandRecord(client, receipt.commandId, { timeoutMs: 90_000 });
}

async function stopStationHostIfIdle(config: RealStationConfigFixture): Promise<void> {
  const socketPath = join(dirname(config.socketPath), "station-host.sock");
  if (!(await pathExists(socketPath))) return;
  const buildVersion = stationObserverBuildVersion();
  const host = createStationHostClient({
    socketPath,
    expectedBuildVersion: buildVersion,
    timeoutMs: 10_000,
  });
  try {
    await host.stopIfIdle(buildVersion);
  } finally {
    host.dispose();
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await pathExists(socketPath))) {
    await delay(100);
  }
  if (await pathExists(socketPath)) {
    throw new Error(`Station host socket remained after idle stop: ${socketPath}`);
  }
}

async function waitForNativeFrame(
  runtime: NativeRuntime,
  predicate: (frame: string) => boolean,
  message: string,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = "";
  while (Date.now() < deadline) {
    frame = await captureNativeFrame(runtime).catch(() => "");
    if (predicate(frame)) return frame;
    await delay(100);
  }
  throw new Error(`${message}${await nativeDiagnostics(runtime, frame)}`);
}

async function waitForStyledLineChange(
  runtime: NativeRuntime,
  needle: string,
  previous: string,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let line = "";
  while (Date.now() < deadline) {
    const frame = await captureNativeFrame(runtime, true).catch(() => "");
    line = styledLineForText(frame, needle);
    if (line !== "" && line !== previous) return;
    await delay(100);
  }
  throw new Error(`${message}\nLast styled line:\n${line}${await nativeDiagnostics(runtime)}`);
}

async function waitForSnapshotWithDiagnostics(
  runtime: NativeRuntime,
  client: ReturnType<typeof createRealObserverClient>,
  predicate: (snapshot: StationSnapshot) => boolean,
  message: string,
  timeoutMs: number,
): Promise<StationSnapshot> {
  try {
    return await waitForSnapshot(client, predicate, message, timeoutMs);
  } catch (error) {
    throw new Error(`${message}${await nativeDiagnostics(runtime)}`, { cause: error });
  }
}

async function captureNativeFrame(runtime: NativeRuntime, styled = false): Promise<string> {
  return captureTmuxPane({
    env: runtime.env,
    target: runtime.target,
    styled,
    preserveTrailingSpaces: true,
    visibleOnly: true,
  });
}

function cellForText(frame: string, needle: string): Cell {
  const lines = frame.split("\n");
  const row = lines.findIndex((line) => line.includes(needle));
  const column = row < 0 ? -1 : (lines[row]?.indexOf(needle) ?? -1);
  if (row < 0 || column < 0) {
    throw new Error(`Native frame does not contain ${JSON.stringify(needle)}.`);
  }
  return {
    column: column + Math.floor(needle.length / 2) + 1,
    row: row + 1,
  };
}

function styledLineForText(frame: string, needle: string): string {
  return frame.split("\n").find((line) => stripAnsi(line).includes(needle)) ?? "";
}

function stripAnsi(value: string): string {
  const escapeCharacter = String.fromCharCode(27);
  let plain = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] === escapeCharacter && value[index + 1] === "[") {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        index += 1;
        if (code >= 64 && code <= 126) break;
      }
      continue;
    }
    plain += value[index] ?? "";
    index += 1;
  }
  return plain;
}

function sgrMouse(code: number, cell: Cell, final: "M" | "m" = "M"): Uint8Array {
  return Buffer.from(`\u001B[<${code};${cell.column};${cell.row}${final}`, "utf8");
}

async function writeSgrClick(client: AttachedTmuxPtyClient, cell: Cell): Promise<void> {
  await client.write(sgrMouse(0, cell));
  await client.write(sgrMouse(0, cell, "m"));
}

async function nativeDiagnostics(runtime: NativeRuntime, lastFrame?: string): Promise<string> {
  const pane = lastFrame ?? (await captureNativeFrame(runtime).catch(() => "<unavailable>"));
  const styled = await captureNativeFrame(runtime, true).catch(() => "<unavailable>");
  const snapshot = await runStation(runtime.env, {
    configPath: runtime.config.configPath,
    args: ["snapshot", "--json", "--include-debug"],
    timeoutMs: 10_000,
    env: isolatedStationEnv(runtime.config),
  }).catch((error) => ({ stdout: "", stderr: errorMessage(error) }));
  const evidencePaths = [
    join(runtime.config.stateDir, "logs", "observer.jsonl"),
    join(runtime.config.stateDir, "logs", "cli.jsonl"),
    join(runtime.config.stateDir, "logs", "tui.jsonl"),
    join(runtime.config.stateDir, "logs", "station-host.jsonl"),
  ];
  const evidence = await Promise.all(
    evidencePaths.map(async (path) => {
      const text = await readFile(path, "utf8").catch(() => "<absent>");
      return `${path}:\n${text.slice(-12_000)}`;
    }),
  );
  return [
    "\nLast native pane:",
    pane.slice(-16_000),
    "\nLast styled native pane:",
    styled.slice(-16_000),
    runtime.client.outputTail(),
    "\nObserver snapshot stdout:",
    snapshot.stdout.slice(-16_000),
    "\nObserver snapshot stderr:",
    snapshot.stderr.slice(-8_000),
    "\nObserver evidence:",
    evidence.join("\n"),
  ].join("\n");
}

async function readObserverPid(config: RealStationConfigFixture): Promise<number> {
  const serialized = await readFile(`${config.socketPath}.pid`, "utf8");
  try {
    const decoded: unknown = JSON.parse(serialized);
    return ObserverProcessIdentitySchema.parse(decoded).pid;
  } catch (cause) {
    throw new Error(`Observer identity is invalid at ${config.socketPath}.pid.`, { cause });
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await delay(100);
  }
  return !processExists(pid);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  const safeError = safeErrorFromUnknown(error, {
    tag: "RealE2eError",
    code: "REAL_NATIVE_MOUSE_FAILED",
    message: "Real native mouse acceptance failed.",
  });
  return `${safeError.code}: ${safeError.message}${safeError.hint === undefined ? "" : `\n${safeError.hint}`}`;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
