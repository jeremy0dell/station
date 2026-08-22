import { access, readFile, writeFile } from "node:fs/promises";
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
  createCodexSentinel,
  createRealCodexFixture,
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
    const codex = await createRealCodexFixture({ env, repo });
    const testEnv = codex.env;
    const config = await writeRealStationConfig({
      env: testEnv,
      repo,
      codexCommand: codex.codexCommand,
      installCodexHooks: true,
    });
    await writeFile(
      config.configPath,
      `${(await readFile(config.configPath, "utf8")).replace(
        "[harness.codex]\n",
        "[harness.codex]\nresume = true\n",
      )}\n[feature_flags]\nsession_resume_agent = true\nstation_persistent_agents = true\n`,
      "utf8",
    );
    await codex.installHooks(config);
    const nativeSession = uniqueTmuxSession("station-real-native-mouse");
    const branch = `nm-${process.pid}-${Date.now().toString(36).slice(-6)}`;
    const groupName = "Native mouse Group";
    const client = createRealObserverClient(config, 30_000);
    let commandId: string | undefined;
    let runtime: NativeRuntime | undefined;

    cleanup.defer(async () => {
      await runStationJson(testEnv, {
        configPath: config.configPath,
        args: ["observer", "stop"],
        env: isolatedStationEnv(config),
      }).catch(() => undefined);
    });
    cleanup.defer(async () => {
      await killTmuxSession(testEnv, config.tmuxSession);
    });
    cleanup.defer(async () => {
      await removeRealWorktrunkWorktree({ env: testEnv, config, repo, branch });
    });
    cleanup.defer(async () => {
      await stopStationHostIfIdle(config);
    });
    cleanup.defer(async () => {
      await removeWorktreeThroughObserver(config, branch);
    });

    try {
      await runStationJson(testEnv, {
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
      await killTmuxSession(testEnv, config.tmuxSession);
      const dormant = await waitForSnapshot(
        client,
        (snapshot: StationSnapshot) => {
          const row = snapshot.rows.find((candidate) => candidate.branch === branch);
          return (
            row !== undefined &&
            !worktreeHasLiveAgent(row) &&
            row.recovery?.kind === "agent-resume" &&
            snapshot.sessions.some(
              (session) => session.worktreeId === row.id && session.origin === "station",
            )
          );
        },
        `Real Codex did not exit into a launchable Station session for ${branch}.`,
        120_000,
      );
      const dormantRow = findRowByBranch(dormant, branch);
      const dormantSession = dormant.sessions.find(
        (session) => session.worktreeId === dormantRow.id && session.origin === "station",
      );
      if (dormantSession === undefined) {
        throw new Error(`Observer did not retain a Station session for ${branch}.`);
      }
      const groupReceipt = await client.dispatch({
        type: "sessionGroup.create",
        payload: {
          projectId: config.projectId,
          name: groupName,
          initialSessionIds: [dormantSession.id],
        },
      });
      await waitForCommandRecord(client, groupReceipt.commandId, { timeoutMs: 30_000 });
      await waitForSnapshot(
        client,
        (snapshot) =>
          snapshot.sessionGroups.some(
            (group) => group.name === groupName && group.sessionIds.includes(dormantSession.id),
          ),
        `Observer did not create ${groupName} for ${branch}.`,
        30_000,
      );

      const launched = await launchNativeStationInTmux({
        env: testEnv,
        configPath: config.configPath,
        observerSocketPath: config.socketPath,
        stateDir: config.stateDir,
        sessionName: nativeSession,
        cwd: repo.repoPath,
        dimensions: NATIVE_DIMENSIONS,
      });
      cleanup.defer(async () => {
        await killTmuxSession(testEnv, nativeSession);
      });
      const ptyClient = await startAttachedTmuxPtyClient({
        env: testEnv,
        sessionName: nativeSession,
        dimensions: NATIVE_DIMENSIONS,
      });
      cleanup.defer(ptyClient.close);
      runtime = { client: ptyClient, config, env: testEnv, target: launched.target };

      const welcome = await waitForNativeFrame(
        runtime,
        (frame) => frame.includes("Open project view"),
        "Native Station did not render its welcome project-view button.",
      );
      await writeSgrClick(ptyClient, cellForText(welcome, "Open project view"));

      const expanded = await waitForNativeFrame(
        runtime,
        (frame) =>
          frame.includes("[shell]") &&
          frame.includes(`╭ ▼ ${groupName} 1 session`) &&
          hasDashboardSessionRow(frame, branch),
        "The native-only Station overlay did not render its Group and real session.",
      );
      expect(expanded).toContain("[shell]");
      const projectCell = cellForText(expanded, PROJECT_LABEL);
      const groupCell = cellForText(expanded, groupName);
      const styleBefore = styledLineForText(await captureNativeFrame(runtime, true), PROJECT_LABEL);
      const groupStyleBefore = styledLineForText(
        await captureNativeFrame(runtime, true),
        groupName,
      );

      await ptyClient.write(sgrMouse(35, groupCell));
      await waitForStyledLineChange(
        runtime,
        groupName,
        groupStyleBefore,
        "Raw SGR motion did not reach the native Group-header hover state.",
      );
      await ptyClient.write(sgrMouse(35, { column: 1, row: 1 }));
      for (let index = 0; index < 3; index += 1) {
        await ptyClient.write(Buffer.from("\x1b[B", "utf8"));
      }
      await writeSgrClick(ptyClient, groupCell);
      await waitForNativeFrame(
        runtime,
        (frame) => frame.includes(`▶ ${groupName}`) && !hasDashboardSessionRow(frame, branch),
        "One native SGR click did not collapse the focused member's Group exactly once.",
      );
      await ptyClient.write(Buffer.from("\r", "utf8"));
      await waitForNativeFrame(
        runtime,
        (frame) => frame.includes(`▼ ${groupName}`) && hasDashboardSessionRow(frame, branch),
        "Collapsed native Group focus did not restore to identity for Enter expansion.",
      );
      await writeSgrClick(ptyClient, groupCell);
      await waitForNativeFrame(
        runtime,
        (frame) => frame.includes(`▶ ${groupName}`) && !hasDashboardSessionRow(frame, branch),
        "The deliberate native Group click did not collapse exactly once.",
      );
      await writeSgrClick(ptyClient, groupCell);
      await waitForNativeFrame(
        runtime,
        (frame) => frame.includes(`▼ ${groupName}`) && hasDashboardSessionRow(frame, branch),
        "The deliberate native Group click did not expand exactly once.",
      );

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
        (frame) => frame.includes(`▶ ${PROJECT_LABEL}`) && !hasDashboardSessionRow(frame, branch),
        "One native SGR down/up click did not collapse the project exactly once.",
      );
      await writeSgrClick(ptyClient, projectCell);
      await waitForNativeFrame(
        runtime,
        (frame) => frame.includes(`▼ ${PROJECT_LABEL}`) && hasDashboardSessionRow(frame, branch),
        "The first deliberate native click did not expand the project once.",
      );
      await writeSgrClick(ptyClient, projectCell);
      await waitForNativeFrame(
        runtime,
        (frame) => frame.includes(`▶ ${PROJECT_LABEL}`) && !hasDashboardSessionRow(frame, branch),
        "The second deliberate native click did not collapse the project once.",
      );
      await ptyClient.write(Buffer.from(`/${branch}\r`, "utf8"));
      const collapsedFiltered = await waitForNativeFrame(
        runtime,
        (frame) =>
          frame.includes(`▶ ${PROJECT_LABEL}`) &&
          !hasDashboardSessionRow(frame, branch) &&
          frame.includes("/ edit") &&
          frame.includes("Esc clear"),
        "An applied native filter did not preserve the collapsed project disclosure.",
      );
      await writeSgrClick(ptyClient, projectCell);
      await waitForNativeFrame(
        runtime,
        (frame) => frame.includes(`▼ ${PROJECT_LABEL}`) && hasDashboardSessionRow(frame, branch),
        "The filtered native project did not expand to reveal its matching session.",
      );
      await writeSgrClick(ptyClient, projectCell);
      await waitForNativeFrame(
        runtime,
        (frame) => frame.includes(`▶ ${PROJECT_LABEL}`) && !hasDashboardSessionRow(frame, branch),
        "The filtered native project did not collapse its matching session.",
      );

      await writeSgrClick(ptyClient, cellForText(collapsedFiltered, "/ edit"));
      const reopenedFilter = await waitForNativeFrame(
        runtime,
        (frame) => frame.includes(`FILTER /${branch}`),
        "Clicking the native applied-filter edit control did not reopen the header editor.",
      );
      await ptyClient.write(Buffer.from("\t", "utf8"));
      const conditionFields = await waitForNativeFrame(
        runtime,
        (frame) => frame.includes("FILTER CONDITIONS") && frame.includes("S Status"),
        "Tab did not open the native persistent-filter condition chooser.",
      );
      await writeSgrClick(ptyClient, cellForText(conditionFields, "Status"));
      const statusValues = await waitForNativeFrame(
        runtime,
        (frame) => frame.includes("STATUS CONDITION") && frame.includes("Working"),
        "Clicking Status did not open native condition values.",
      );
      await writeSgrClick(ptyClient, cellForText(statusValues, "[←]"));
      const returnedFields = await waitForNativeFrame(
        runtime,
        (frame) => frame.includes("FILTER CONDITIONS") && frame.includes("S Status"),
        "The native condition back control did not return to the field chooser.",
      );
      await writeSgrClick(ptyClient, cellForText(returnedFields, "Status"));
      const reopenedStatusValues = await waitForNativeFrame(
        runtime,
        (frame) => frame.includes("STATUS CONDITION") && frame.includes("Working"),
        "Clicking Status after Back did not reopen native condition values.",
      );
      await writeSgrClick(ptyClient, cellForText(reopenedStatusValues, "Working"));
      await waitForNativeFrame(
        runtime,
        (frame) => frame.includes("[✓] Working"),
        "Clicking Working did not toggle the native condition value.",
      );
      await writeSgrClick(ptyClient, cellForText(reopenedFilter, `FILTER /${branch}`));
      await waitForNativeFrame(
        runtime,
        (frame) => frame.includes(`FILTER /${branch}`) && !frame.includes("STATUS CONDITION"),
        "Native condition click-away did not return to filter text editing.",
      );

      await ptyClient.write(Buffer.from("\t", "utf8"));
      const fieldsForBuild = await waitForNativeFrame(
        runtime,
        (frame) => frame.includes("FILTER CONDITIONS") && frame.includes("S Status"),
        "The native condition chooser did not reopen for staged editing.",
      );
      await writeSgrClick(ptyClient, cellForText(fieldsForBuild, "Status"));
      const valuesForBuild = await waitForNativeFrame(
        runtime,
        (frame) => frame.includes("STATUS CONDITION") && frame.includes("Working"),
        "The native Status values did not reopen for staged editing.",
      );
      await writeSgrClick(ptyClient, cellForText(valuesForBuild, "Working"));
      const selectedForBuild = await waitForNativeFrame(
        runtime,
        (frame) => frame.includes("[✓] Working") && frame.includes("Done (Enter)"),
        "The native Status value did not select before returning to the builder.",
      );
      await writeSgrClick(ptyClient, cellForText(selectedForBuild, "Done (Enter)"));
      const builtFilter = await waitForNativeFrame(
        runtime,
        (frame) =>
          frame.includes("FILTER CONDITIONS") &&
          frame.includes("Working") &&
          frame.includes("Apply filter (F)"),
        "The native Done control did not retain the selected Status value.",
      );
      await writeSgrClick(ptyClient, cellForText(builtFilter, "Apply filter (F)"));
      const reapplied = await waitForNativeFrame(
        runtime,
        (frame) =>
          frame.includes(`▶ ${PROJECT_LABEL}`) &&
          !hasDashboardSessionRow(frame, branch) &&
          frame.includes("Status=Working") &&
          frame.includes("Esc clear"),
        "The native Apply filter control did not apply the complete staged filter.",
      );
      await writeSgrClick(ptyClient, cellForText(reapplied, "Esc clear"));
      await waitForNativeFrame(
        runtime,
        (frame) => frame.includes(`▶ ${PROJECT_LABEL}`) && !hasDashboardSessionRow(frame, branch),
        "Clicking the native clear control did not restore the stored collapsed view.",
      );

      await writeSgrClick(ptyClient, projectCell);
      const reexpanded = await waitForNativeFrame(
        runtime,
        (frame) => frame.includes(`▼ ${PROJECT_LABEL}`) && hasDashboardSessionRow(frame, branch),
        "The native project did not re-expand before row activation.",
      );

      const sessionCell = cellForText(reexpanded, branch);
      const sessionStyleBefore = styledLineForText(await captureNativeFrame(runtime, true), branch);
      await ptyClient.write(sgrMouse(35, sessionCell));
      await waitForStyledLineChange(
        runtime,
        branch,
        sessionStyleBefore,
        "Raw SGR motion did not reach the framed native session row.",
      );
      await writeSgrClick(ptyClient, sessionCell);
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
            row.agent.sessionId === dormantSession.id &&
            row.terminal?.provider === "native" &&
            worktreeHasLiveAgent(row)
          );
        },
        "The native row click did not resume the real Codex agent in the Observer snapshot.",
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
        expect(await tmuxSessionExists(testEnv, nativeSession)).toBe(false);
        expect(await tmuxSessionExists(testEnv, config.tmuxSession)).toBe(false);
        expect(await pathExists(worktreePath)).toBe(false);
        expect(await pathExists(repo.root)).toBe(false);
      }
    } catch (error) {
      await writeNativeFailureBundle(testEnv, config, commandId);
      const diagnostics =
        runtime === undefined ? "" : await nativeDiagnostics(runtime).catch(() => "");
      throw new Error(`${errorMessage(error)}${diagnostics}`, { cause: error });
    }
  }, 360_000);
});

function isolatedStationEnv(config: RealStationConfigFixture): NodeJS.ProcessEnv {
  return {
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

function hasDashboardSessionRow(frame: string, branch: string): boolean {
  return frame.split("\n").some((line) => line.includes(branch) && /\[[1-9a-z]\]/u.test(line));
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
