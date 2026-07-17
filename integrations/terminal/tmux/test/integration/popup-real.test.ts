import { type ChildProcess, execFile, spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  type CommandId,
  type CommandRecord,
  type ObserverApi,
  ObserverProcessIdentitySchema,
  STATION_SCHEMA_VERSION,
  type StationCommand,
  type StationEvent,
  type StationSnapshot,
  StationSnapshotSchema,
  type TerminalTargetId,
} from "@station/contracts";
import { startProtocolServer, type UnixSocketServer } from "@station/protocol";
import {
  environmentWithoutGitLocals,
  resolveExecutablePath,
  stationObserverBuildVersion,
} from "@station/runtime";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { mockObserverSnapshot } from "../../../../../station/src/sources/fixtures/mockObserverSnapshot.js";
import { buildManagedFastPopupRunShellCommand, openTmuxPopup } from "../../src/popup";
import { parsePopupActiveClaim } from "../../src/popup/fastProtocol";
import { TmuxProvider } from "../../src/provider";
import { shellQuote } from "../../src/shell";
import { buildTmuxTargetId } from "../../src/topology";

const execFileAsync = promisify(execFile);
const runRealTmux = process.env.STATION_REAL_TMUX === "1";
const describeRealTmux = runRealTmux ? describe : describe.skip;
const checkoutRoot = resolve(".");
const builtCliPath = join(checkoutRoot, "apps/cli/dist/main.js");
const builtBinaryPath = join(checkoutRoot, "station/dist/bin/stn");
const persistentUiSessionName = "_station-ui";
const rendererEntry = "src/dashboardRenderer/main.tsx";
const realDashboardFrameUrl = new URL(
  "../fixtures/real-dashboard-99x25.frame.json",
  import.meta.url,
);
const outputTailBytes = 64 * 1024;
const popupBorderColumns = 2;
const popupBorderRows = 2;
const nestedTmuxStatusRows = 1;
const outerTmuxStatusRows = 1;
const ptyBridgeScript = `
import fcntl
import os
import pty
import select
import struct
import sys
import termios

control_fd = 3
rows = int(sys.argv[1])
columns = int(sys.argv[2])
winsize = struct.pack("HHHH", rows, columns, 0, 0)
os.set_inheritable(control_fd, False)
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(sys.stdin.fileno(), termios.TIOCSWINSZ, winsize)
    os.environ.setdefault("TERM", "xterm-256color")
    os.execvp(sys.argv[3], sys.argv[3:])

fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
control_buffer = b""
control_open = True
while True:
    inputs = [sys.stdin.buffer, fd]
    if control_open:
        inputs.append(control_fd)
    readable, _, _ = select.select(inputs, [], [])
    if sys.stdin.buffer in readable:
        data = os.read(sys.stdin.fileno(), 4096)
        if not data:
            break
        os.write(fd, data)
    if control_open and control_fd in readable:
        data = os.read(control_fd, 4096)
        if not data:
            control_open = False
        else:
            control_buffer += data
            while b"\\n" in control_buffer:
                line, control_buffer = control_buffer.split(b"\\n", 1)
                parts = line.decode("ascii").split()
                if len(parts) != 3 or parts[0] != "resize":
                    raise ValueError("invalid PTY control command")
                next_rows = int(parts[1])
                next_columns = int(parts[2])
                if next_rows <= 0 or next_columns <= 0:
                    raise ValueError("PTY dimensions must be positive")
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", next_rows, next_columns, 0, 0))
    if fd in readable:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(sys.stdout.fileno(), data)

try:
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
except ChildProcessError:
    sys.exit(0)
`;

type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type OutputTail = {
  append(chunk: Buffer): void;
  text(): string;
};

type TrackedChild = {
  child: ChildProcess;
  exit: Promise<ChildExit>;
  label: string;
  stderr: OutputTail;
  stdout: OutputTail;
};

type TmuxPtyClient = TrackedChild & {
  clientName: string;
  close(): Promise<void>;
  resize(rows: number, columns: number): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
};

type MarkerFixture = {
  ptyClient?: TmuxPtyClient;
  root: string;
  wrapper: string;
  wrapperLogPath: string;
};

type DashboardFixture = {
  attachLogPath: string;
  bareTmuxLogPath: string;
  cliProcesses: TrackedChild[];
  configPath: string;
  env: NodeJS.ProcessEnv;
  nestedCliPids: Set<number>;
  nestedClientPids: Set<number>;
  observerPids: Set<number>;
  observerServer?: UnixSocketServer;
  observerSocketPath: string;
  otherPtyClients: TmuxPtyClient[];
  panePids: Set<number>;
  projectRoot: string;
  ptyClient?: TmuxPtyClient;
  rendererPids: Set<number>;
  root: string;
  wrapper: string;
  wrapperLogPath: string;
};

type Dimensions = {
  columns: number;
  rows: number;
};

type AttachRecord = Dimensions & {
  args: string;
  pid: number;
  tty: string;
};

type NestedClientEvidence = Dimensions & {
  name: string;
  pid: number;
  tty: string;
};

type PaneEvidence = Dimensions & {
  id: string;
  pid: number;
  tty: string;
};

type ProcessRecord = {
  command: string;
  pid: number;
  ppid: number;
  tty: string;
};

type RendererEvidence = Dimensions & {
  command: string;
  pid: number;
  tty: string;
};

type DashboardProcessEvidence = {
  cli: ProcessRecord;
  renderer: RendererEvidence;
};

type DashboardRuntimeEvidence = {
  cliPid: number;
  nestedClientPid: number;
  observerPid: number;
  panePid: number;
  popupCliPid: number;
  rendererPid: number;
  tmuxServerPid: number;
};

type CapturedFrame = Dimensions & {
  lines: string[];
};

const CapturedFrameSchema = z
  .object({
    columns: z.number().int().positive(),
    rows: z.number().int().positive(),
    lines: z.array(z.string()),
  })
  .strict()
  .refine((frame) => frame.lines.length === frame.rows, {
    message: "captured frame line count must equal its row count",
  })
  .refine((frame) => frame.lines.every((line) => line.length === frame.columns), {
    message: "captured frame lines must equal its column count",
  });

function parseJsonFixture<T>(serialized: string, schema: z.ZodType<T>, label: string): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(`${label} does not match its schema: ${parsed.error.message}`);
  }
  return parsed.data;
}

type TmuxClientTarget = {
  clientName: string;
  paneId: string;
  sessionName: string;
  windowId: string;
};

describeRealTmux("real tmux dev popup routing", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let tmux: string;

  beforeAll(async () => {
    const requestedTmux = process.env.STATION_TMUX_BIN ?? "tmux";
    const resolvedTmux = await resolveExecutablePath(requestedTmux);
    if (resolvedTmux === undefined) {
      throw new Error(`tmux executable not found: ${requestedTmux}`);
    }
    tmux = resolve(resolvedTmux);
    await execFileAsync(tmux, ["-V"], { timeout: 10_000 });
    await execFileAsync("python3", ["--version"], { timeout: 10_000 });
    await access(builtCliPath).catch(() => {
      throw new Error(`Built CLI not found at ${builtCliPath}; run pnpm build first.`);
    });
    await access(builtBinaryPath).catch(() => {
      throw new Error(`Compiled CLI not found at ${builtBinaryPath}; run pnpm build:binary first.`);
    });
  });

  afterEach(async () => {
    const currentCleanup = cleanup;
    cleanup = undefined;
    await currentCleanup?.();
  }, 180_000);

  it("plain popup routing attaches the registered dev UI and reuses its process", async () => {
    const root = await makeCheckoutTempRoot();
    const wrapperLogPath = join(root, "tmux-wrapper.log");
    const wrapper = await writeTmuxWrapper({
      root,
      tmux,
      label: `stn-popup-${process.pid}-${Date.now()}`,
      attachLogPath: join(root, "attach.log"),
      wrapperLogPath,
    });
    const fixture: MarkerFixture = { root, wrapper, wrapperLogPath };
    cleanup = () => cleanupMarkerFixture(fixture);

    const baseSession = "base";
    const devSession = "_station-ui-dev-real";
    const normalSession = "_station-ui-normal";
    const devMarker = join(root, "dev-started.txt");
    const normalMarker = join(root, "normal-started.txt");
    const devCommand = persistentMarkerCommand(devMarker);
    const normalCommand = persistentMarkerCommand(normalMarker);

    await tmuxExec(wrapper, ["new-session", "-d", "-s", baseSession, "sleep 300"]);
    fixture.ptyClient = await startTmuxPtyClient({
      tmux: wrapper,
      sessionName: baseSession,
    });

    await setGlobalOption(wrapper, "@station_tui_dev_session_name", devSession);
    await setGlobalOption(wrapper, "@station_tui_dev_command", devCommand);
    await setGlobalOption(wrapper, "@station_tui_dev_owner", `${process.pid}:real-tmux`);
    await setGlobalOption(wrapper, "@station_tui_dev_root", root);

    await openAndCloseRegisteredPopup({
      tmux: wrapper,
      clientName: fixture.ptyClient.clientName,
      devCommand,
      expectedSession: devSession,
      registeredDevPopupRoot: root,
    });
    await waitForFileText(devMarker, "start\n");
    const firstDevPid = await panePid(wrapper, devSession);

    await openAndCloseRegisteredPopup({
      tmux: wrapper,
      clientName: fixture.ptyClient.clientName,
      devCommand,
      expectedSession: devSession,
      registeredDevPopupRoot: root,
    });
    const secondDevPid = await panePid(wrapper, devSession);
    const devStarts = await readFile(devMarker, "utf8");

    expect(secondDevPid).toBe(firstDevPid);
    expect(devStarts).toBe("start\n");

    await setGlobalOption(wrapper, "@station_tui_dev_owner", "999999999:stale");
    await openAndCloseRegisteredPopup({
      tmux: wrapper,
      clientName: fixture.ptyClient.clientName,
      devCommand: normalCommand,
      expectedSession: normalSession,
      registeredDevPopupRoot: root,
      uiSessionName: normalSession,
    });

    await expect(readFile(normalMarker, "utf8")).resolves.toBe("start\n");
  }, 60_000);

  it("renders an exact real dashboard and routes outer keyboard and resize without replacing the renderer", async () => {
    const fixture = await createDashboardFixture(tmux, {
      height: "100%",
      position: "C",
      width: "100%",
    });
    cleanup = () => cleanupDashboardFixture(fixture);
    const snapshot = deterministicDashboardSnapshot(fixture.projectRoot);
    fixture.observerServer = await startProtocolServer({
      socketPath: fixture.observerSocketPath,
      api: deterministicPopupObserver(snapshot),
    });
    delete fixture.env.STATION_SOURCE;

    await tmuxExec(fixture.wrapper, ["new-session", "-d", "-s", "base", "sleep 300"], fixture.env);
    await tmuxExec(fixture.wrapper, ["set-option", "-g", "mouse", "on"], fixture.env);
    fixture.ptyClient = await startTmuxPtyClient({
      tmux: fixture.wrapper,
      sessionName: "base",
      env: fixture.env,
      initialDimensions: outerDimensionsForDashboard({ rows: 40, columns: 120 }),
    });

    const firstPopup = spawnPopupCli(fixture, fixture.ptyClient.clientName);
    await waitForPaneContent(
      fixture,
      firstPopup,
      isAcceptanceDashboardContent,
      "deterministic real dashboard did not render",
    );
    const firstRuntime = await waitForDashboardRuntimeEvidence(fixture, firstPopup, process.pid);
    const popupAttach = await waitForPopupAttachRecord(fixture);
    expect(popupAttach).toMatchObject({ rows: 41, columns: 120 });
    await expectConvergedDashboardDimensions(fixture, { rows: 40, columns: 120 });
    await resizeDashboardSurface(fixture, { rows: 25, columns: 99 });

    const baseline = await captureStableFrame(fixture);
    assertStructuralDashboardFrame(baseline);
    expect(baseline).toEqual(await readExpectedDashboardFrame());

    await fixture.ptyClient.write(Buffer.from("?", "utf8"));
    await waitForPaneContent(
      fixture,
      firstPopup,
      (content) => content.includes("station help"),
      "outer keyboard input did not open station help",
    );
    await fixture.ptyClient.write(Buffer.from([0x1b]));
    await waitForPaneContent(
      fixture,
      firstPopup,
      (content) => isAcceptanceDashboardContent(content) && !content.includes("station help"),
      "Esc did not return from station help to the dashboard",
    );
    await waitForExactFrame(fixture, baseline);

    for (const dimensions of [
      { rows: 24, columns: 80 },
      { rows: 25, columns: 99 },
      { rows: 40, columns: 120 },
    ]) {
      await resizeDashboardSurface(fixture, dimensions);
      const resized = await captureStableFrame(fixture);
      assertStructuralDashboardFrame(resized);
      expectDashboardRuntimeUnchanged(
        firstRuntime,
        await currentDashboardRuntimeEvidence(fixture, firstPopup, process.pid),
      );
    }

    await fixture.ptyClient.write(Buffer.from([0x1b]));
    await waitForNestedClientGone(fixture);
    await expectSuccessfulExit(firstPopup, 10_000);

    const secondPopup = spawnPopupCli(fixture, fixture.ptyClient.clientName);
    await waitForPaneContent(
      fixture,
      secondPopup,
      isAcceptanceDashboardContent,
      "dashboard did not render after outer-input dismissal and reopen",
    );
    const reopened = await currentDashboardRuntimeEvidence(fixture, secondPopup, process.pid);
    expect(reopened.panePid).toBe(firstRuntime.panePid);
    expect(reopened.cliPid).toBe(firstRuntime.cliPid);
    expect(reopened.rendererPid).toBe(firstRuntime.rendererPid);
    expect(reopened.observerPid).toBe(firstRuntime.observerPid);
    await assertWrapperAudit(fixture);
    await assertPathMissing(
      fixture.bareTmuxLogPath,
      "a child invoked bare tmux instead of the private wrapper",
    );
  }, 120_000);

  it("forwards outer SGR hover, deliberate clicks, and wheel input exactly once", async () => {
    const fixture = await createDashboardFixture(tmux);
    fixture.env.STATION_SCENARIO = "many-projects";
    cleanup = () => cleanupDashboardFixture(fixture);

    await tmuxExec(fixture.wrapper, ["new-session", "-d", "-s", "base", "sleep 300"], fixture.env);
    // The outer client must be in mouse mode before it can forward raw SGR input into the popup.
    await tmuxExec(fixture.wrapper, ["set-option", "-g", "mouse", "on"], fixture.env);
    fixture.ptyClient = await startTmuxPtyClient({
      tmux: fixture.wrapper,
      sessionName: "base",
      env: fixture.env,
    });

    const popup = spawnPopupCli(fixture, fixture.ptyClient.clientName);
    const dashboard = await waitForPaneContent(
      fixture,
      popup,
      isManyProjectDashboardContent,
      "many-project dashboard did not render for SGR characterization",
    );
    const nestedClient = await waitForNestedClient(fixture);
    const outerDimensions = await readOuterClientDimensions(fixture, fixture.ptyClient.clientName);
    const headerCell = paneCell(dashboard, "▼ station");
    const headerOuter = centeredPopupOuterCell(outerDimensions, nestedClient, headerCell);
    const headerStyleBefore = await captureHiddenStyledLine(fixture, "▼ station");

    await fixture.ptyClient.write(sgrMouse(35, headerOuter));
    await waitForHiddenStyledLine(
      fixture,
      "▼ station",
      (line) => line !== headerStyleBefore,
      "outer SGR motion did not reach project-header hover",
    );

    await writeSgrClick(fixture.ptyClient, headerOuter);
    await waitForPaneContent(
      fixture,
      popup,
      (content) => content.includes("▶ station") && !content.includes("station-overlay"),
      "one outer SGR down/up click did not collapse exactly once",
    );
    await writeSgrClick(fixture.ptyClient, headerOuter);
    await waitForPaneContent(
      fixture,
      popup,
      (content) => content.includes("▼ station") && content.includes("station-overlay"),
      "the first deliberate repeated click did not expand the project",
    );
    await writeSgrClick(fixture.ptyClient, headerOuter);
    await waitForPaneContent(
      fixture,
      popup,
      (content) => content.includes("▶ station") && !content.includes("station-overlay"),
      "the second deliberate repeated click did not collapse the project",
    );
    await writeSgrClick(fixture.ptyClient, headerOuter);
    const expandedDashboard = await waitForPaneContent(
      fixture,
      popup,
      (content) => content.includes("▼ station") && content.includes("docs-cleanup"),
      "project did not re-expand before the wheel characterization",
    );
    const childCell = paneCell(expandedDashboard, "docs-cleanup");
    const childOuter = centeredPopupOuterCell(outerDimensions, nestedClient, childCell);
    await fixture.ptyClient.write(sgrMouse(65, childOuter));
    await waitForPaneContent(
      fixture,
      popup,
      (content) => !content.includes("▼ station") && content.includes("docs-cleanup"),
      "outer SGR wheel input over a child row did not change visible content",
    );

    await closeOuterPopup(fixture);
    await expectSuccessfulExit(popup, 10_000);
    await waitForNestedClientGone(fixture);
  }, 120_000);

  it("keeps live dashboard dividers within 60 percent popups across geometry changes", async () => {
    const fixture = await createDashboardFixture(tmux, {
      height: "60%",
      position: "C",
      width: "60%",
    });
    cleanup = () => cleanupDashboardFixture(fixture);
    fixture.observerServer = await startProtocolServer({
      socketPath: fixture.observerSocketPath,
      api: popupFocusObserver([]),
    });
    delete fixture.env.STATION_SOURCE;

    await tmuxExec(fixture.wrapper, ["new-session", "-d", "-s", "base", "sleep 300"], fixture.env);

    const geometryMatrix: ReadonlyArray<{
      label: string;
      outer: Dimensions;
      nested: Dimensions;
      pane: Dimensions;
    }> = [
      {
        label: "cold issue geometry",
        outer: { columns: 169, rows: 47 },
        nested: { columns: 99, rows: 26 },
        pane: { columns: 99, rows: 25 },
      },
      {
        label: "tiny fallback",
        outer: { columns: 70, rows: 25 },
        nested: { columns: 40, rows: 13 },
        pane: { columns: 40, rows: 12 },
      },
      {
        label: "supported minimum",
        outer: { columns: 104, rows: 32 },
        nested: { columns: 60, rows: 17 },
        pane: { columns: 60, rows: 16 },
      },
      {
        label: "standard terminal",
        outer: { columns: 137, rows: 45 },
        nested: { columns: 80, rows: 25 },
        pane: { columns: 80, rows: 24 },
      },
      {
        label: "percentage round down",
        outer: { columns: 168, rows: 47 },
        nested: { columns: 98, rows: 26 },
        pane: { columns: 98, rows: 25 },
      },
      {
        label: "above issue geometry",
        outer: { columns: 170, rows: 47 },
        nested: { columns: 100, rows: 26 },
        pane: { columns: 100, rows: 25 },
      },
      {
        label: "large terminal",
        outer: { columns: 204, rows: 72 },
        nested: { columns: 120, rows: 41 },
        pane: { columns: 120, rows: 40 },
      },
      {
        label: "return to issue geometry",
        outer: { columns: 169, rows: 47 },
        nested: { columns: 99, rows: 26 },
        pane: { columns: 99, rows: 25 },
      },
    ];

    let hiddenPanePid: number | undefined;
    let hiddenCliPid: number | undefined;
    let rendererPid: number | undefined;

    for (const geometry of geometryMatrix) {
      const attachRecordIndex = await popupAttachRecordCount(fixture);
      fixture.ptyClient = await startTmuxPtyClient({
        tmux: fixture.wrapper,
        sessionName: "base",
        env: fixture.env,
        initialDimensions: geometry.outer,
      });
      expect(await readOuterClientDimensions(fixture, fixture.ptyClient.clientName)).toEqual(
        geometry.outer,
      );

      const popup = spawnPopupCli(fixture, fixture.ptyClient.clientName);
      const nestedClient = await waitForNestedClient(fixture);
      expect(
        { columns: nestedClient.columns, rows: nestedClient.rows },
        `${geometry.label} nested client geometry`,
      ).toEqual(geometry.nested);
      const popupAttach = await waitForPopupAttachRecord(fixture, attachRecordIndex);
      expect(
        { columns: popupAttach.columns, rows: popupAttach.rows },
        `${geometry.label} popup PTY geometry`,
      ).toEqual(geometry.nested);

      const pane = await waitForPaneDimensions(fixture, geometry.pane);
      expect(nestedClient.rows, `${geometry.label} hidden status row`).toBe(pane.rows + 1);
      const content = await waitForPaneContent(
        fixture,
        popup,
        (candidate) => dashboardFrameMatchesGeometry(candidate, geometry.pane),
        `${geometry.label} dashboard frame did not converge`,
      );
      assertDashboardFrameGeometry(content, geometry.pane, geometry.label);

      const processes = await waitForDashboardProcessEvidence(fixture, pane);
      recordRuntimeEvidence(fixture, nestedClient, pane, processes);
      expect(
        { columns: processes.renderer.columns, rows: processes.renderer.rows },
        `${geometry.label} renderer geometry`,
      ).toEqual(geometry.pane);
      expect(processes.renderer.tty).toBe(pane.tty);

      hiddenPanePid ??= pane.pid;
      hiddenCliPid ??= processes.cli.pid;
      rendererPid ??= processes.renderer.pid;
      expect(pane.pid, `${geometry.label} hidden pane reuse`).toBe(hiddenPanePid);
      expect(processes.cli.pid, `${geometry.label} hidden CLI reuse`).toBe(hiddenCliPid);
      expect(processes.renderer.pid, `${geometry.label} renderer reuse`).toBe(rendererPid);

      await closeOuterPopup(fixture);
      await expectSuccessfulExit(popup, 10_000);
      await waitForNestedClientGone(fixture);
      const outerClient = fixture.ptyClient;
      await outerClient.close();
      fixture.ptyClient = undefined;
    }

    await assertPathMissing(
      fixture.bareTmuxLogPath,
      "a child invoked bare tmux instead of the private wrapper",
    );
  }, 240_000);

  it("persistent dashboard dismisses with Esc and Q, preserves its renderer, and resolves the current focus client", async () => {
    const fixture = await createDashboardFixture(tmux);
    cleanup = () => cleanupDashboardFixture(fixture);
    const focusCommands: StationCommand[] = [];
    fixture.observerServer = await startProtocolServer({
      socketPath: fixture.observerSocketPath,
      api: popupFocusObserver(focusCommands),
    });
    delete fixture.env.STATION_SOURCE;
    delete fixture.env.STATION_TMUX_BIN;
    fixture.env.STATION_FOCUS_CLIENT_ID = "stale-startup-client";

    await tmuxExec(fixture.wrapper, ["new-session", "-d", "-s", "base", "sleep 300"], fixture.env);
    fixture.ptyClient = await startTmuxPtyClient({
      tmux: fixture.wrapper,
      sessionName: "base",
      env: fixture.env,
    });
    await tmuxExec(
      fixture.wrapper,
      ["new-session", "-d", "-s", "base-other", "sleep 300"],
      fixture.env,
    );
    const otherClient = await startTmuxPtyClient({
      tmux: fixture.wrapper,
      sessionName: "base-other",
      env: fixture.env,
    });
    fixture.otherPtyClients.push(otherClient);

    const escPopup = spawnPopupCli(fixture, fixture.ptyClient.clientName);
    await waitForPaneContent(fixture, escPopup, isDashboardContent, "dashboard did not render");
    const firstClient = await waitForNestedClient(fixture);
    const firstPane = await readPaneEvidence(fixture);
    const firstProcesses = await waitForDashboardProcessEvidence(fixture, firstPane);
    recordRuntimeEvidence(fixture, firstClient, firstPane, firstProcesses);

    await fixture.ptyClient.write(Buffer.from([0x1b]));
    await waitForNestedClientGone(fixture);
    await expectSuccessfulExit(escPopup, 10_000);

    const qPopup = spawnPopupCli(fixture, fixture.ptyClient.clientName);
    await waitForPaneContent(
      fixture,
      qPopup,
      isDashboardContent,
      "dashboard did not reopen after Esc",
    );
    const afterEscClient = await waitForNestedClient(fixture);
    const afterEscPane = await readPaneEvidence(fixture);
    const afterEscProcesses = await waitForDashboardProcessEvidence(fixture, afterEscPane);
    recordRuntimeEvidence(fixture, afterEscClient, afterEscPane, afterEscProcesses);
    expect(afterEscPane.pid).toBe(firstPane.pid);
    expect(afterEscProcesses.renderer.pid).toBe(firstProcesses.renderer.pid);

    await fixture.ptyClient.write(Buffer.from("Q", "utf8"));
    await waitForNestedClientGone(fixture);
    await expectSuccessfulExit(qPopup, 10_000);

    const failedFocusPopup = spawnPopupCli(fixture, otherClient.clientName);
    await waitForPaneContent(
      fixture,
      failedFocusPopup,
      isDashboardContent,
      "dashboard did not reopen after Q",
    );
    const otherNestedClient = await waitForNestedClient(fixture);
    const otherPane = await readPaneEvidence(fixture);
    const otherProcesses = await waitForDashboardProcessEvidence(fixture, otherPane);
    recordRuntimeEvidence(fixture, otherNestedClient, otherPane, otherProcesses);
    expect(otherPane.pid).toBe(firstPane.pid);
    expect(otherProcesses.renderer.pid).toBe(firstProcesses.renderer.pid);

    await otherClient.write(Buffer.from("1", "utf8"));
    await waitForPaneContent(
      fixture,
      failedFocusPopup,
      (content) => content.includes("Private popup focus failed."),
      "failed focus did not leave the popup visible with its error toast",
    );
    expect((await waitForNestedClient(fixture)).pid).toBe(otherNestedClient.pid);

    await otherClient.write(Buffer.from("1", "utf8"));
    await waitForNestedClientGone(fixture);
    await expectSuccessfulExit(failedFocusPopup, 10_000);
    expect(focusOrigin(focusCommands.at(-1))).toEqual({
      provider: "tmux",
      clientId: otherClient.clientName,
    });

    const currentClientPopup = spawnPopupCli(fixture, fixture.ptyClient.clientName);
    await waitForPaneContent(
      fixture,
      currentClientPopup,
      isDashboardContent,
      "dashboard did not reopen after successful focus",
    );
    const currentNestedClient = await waitForNestedClient(fixture);
    const currentPane = await readPaneEvidence(fixture);
    const currentProcesses = await waitForDashboardProcessEvidence(fixture, currentPane);
    recordRuntimeEvidence(fixture, currentNestedClient, currentPane, currentProcesses);
    expect(currentPane.pid).toBe(firstPane.pid);
    expect(currentProcesses.renderer.pid).toBe(firstProcesses.renderer.pid);

    await fixture.ptyClient.write(Buffer.from("1", "utf8"));
    await waitForNestedClientGone(fixture);
    await expectSuccessfulExit(currentClientPopup, 10_000);
    expect(focusOrigin(focusCommands.at(-1))).toEqual({
      provider: "tmux",
      clientId: fixture.ptyClient.clientName,
    });
    await assertPathMissing(
      fixture.bareTmuxLogPath,
      "a child invoked bare tmux instead of the private wrapper",
    );
  }, 180_000);

  it("shows truthful tmux and native Station focus outcomes while preserving the warm renderer", async () => {
    const fixture = await createDashboardFixture(tmux);
    cleanup = () => cleanupDashboardFixture(fixture);
    const focusCommands: StationCommand[] = [];
    const snapshot = deterministicDashboardSnapshot(fixture.projectRoot);
    delete fixture.env.STATION_SOURCE;

    await tmuxExec(fixture.wrapper, ["new-session", "-d", "-s", "base", "sleep 300"], fixture.env);
    const destination = await createTmuxFocusDestination(fixture);
    fixture.observerServer = await startProtocolServer({
      socketPath: fixture.observerSocketPath,
      api: focusOutcomeObserver({
        snapshot,
        focusCommands,
        targetId: destination.targetId,
        tmuxCommand: fixture.wrapper,
      }),
    });
    fixture.ptyClient = await startTmuxPtyClient({
      tmux: fixture.wrapper,
      sessionName: "base",
      env: fixture.env,
    });

    const tmuxPopup = spawnPopupCli(fixture, fixture.ptyClient.clientName);
    await waitForPaneContent(
      fixture,
      tmuxPopup,
      isAcceptanceDashboardContent,
      "focus dashboard did not render",
    );
    const firstRuntime = await waitForDashboardRuntimeEvidence(fixture, tmuxPopup, process.pid);

    await fixture.ptyClient.write(Buffer.from("1", "utf8"));
    await waitForNestedClientGone(fixture);
    await expectSuccessfulExit(tmuxPopup, 10_000);
    const visibleTarget = await waitForTmuxClientTarget(fixture, destination);
    expect(visibleTarget).toEqual({
      clientName: fixture.ptyClient.clientName,
      paneId: destination.paneId,
      sessionName: destination.sessionName,
      windowId: destination.windowId,
    });
    expect(await captureTmuxPane(fixture, destination.sessionName)).toContain(
      "STATION PRIVATE FOCUS TARGET",
    );
    expect(focusCommands).toHaveLength(1);
    expect(focusCommands[0]).toMatchObject({
      type: "terminal.focus",
      payload: {
        sessionId: "ses_popup_tmux",
        origin: { provider: "tmux", clientId: fixture.ptyClient.clientName },
      },
    });

    await tmuxExec(
      fixture.wrapper,
      ["switch-client", "-c", fixture.ptyClient.clientName, "-t", "base"],
      fixture.env,
    );

    const nativePopup = spawnPopupCli(fixture, fixture.ptyClient.clientName);
    await waitForPaneContent(
      fixture,
      nativePopup,
      isAcceptanceDashboardContent,
      "focus dashboard did not reopen",
    );
    const reopenedRuntime = await currentDashboardRuntimeEvidence(
      fixture,
      nativePopup,
      process.pid,
    );
    expect(reopenedRuntime.panePid).toBe(firstRuntime.panePid);
    expect(reopenedRuntime.cliPid).toBe(firstRuntime.cliPid);
    expect(reopenedRuntime.rendererPid).toBe(firstRuntime.rendererPid);
    expect(reopenedRuntime.observerPid).toBe(firstRuntime.observerPid);

    await fixture.ptyClient.write(Buffer.from("2", "utf8"));
    const nativeMessage = 'This agent runs in the "native" terminal and';
    const nativeFrame = await waitForPaneContent(
      fixture,
      nativePopup,
      (content) => content.includes(nativeMessage),
      "native Station focus refusal was not rendered",
    );
    expect(nativeFrame).toContain(nativeMessage);
    expect((await waitForNestedClient(fixture)).pid).toBe(reopenedRuntime.nestedClientPid);
    expect(focusCommands).toHaveLength(1);

    await fixture.ptyClient.write(Buffer.from("1", "utf8"));
    await waitForNestedClientGone(fixture);
    await expectSuccessfulExit(nativePopup, 10_000);
    expect(await waitForTmuxClientTarget(fixture, destination)).toEqual(visibleTarget);
    expect(focusCommands).toHaveLength(2);
    expect(focusCommands[1]).toMatchObject({
      type: "terminal.focus",
      payload: {
        sessionId: "ses_popup_tmux",
        origin: { provider: "tmux", clientId: fixture.ptyClient.clientName },
      },
    });
    await assertWrapperAudit(fixture);
  }, 120_000);

  it("compiled managed binding honors dashboard dismissal, reuses the warm UI, and fails without entering view mode", async () => {
    const fixture = await createDashboardFixture(tmux, {
      height: "50%",
      position: "C",
      width: "50%",
    });
    const validConfig = await readFile(fixture.configPath, "utf8");
    cleanup = async () => {
      await writeFile(fixture.configPath, validConfig, "utf8");
      await cleanupDashboardFixture(fixture);
    };

    await tmuxExec(
      fixture.wrapper,
      ["new-session", "-d", "-s", "base", "-c", fixture.projectRoot, "sleep 300"],
      fixture.env,
    );
    fixture.ptyClient = await startTmuxPtyClient({
      tmux: fixture.wrapper,
      sessionName: "base",
      env: fixture.env,
    });
    await tmuxExec(
      fixture.wrapper,
      ["new-session", "-d", "-s", "base-cross", "-c", fixture.projectRoot, "sleep 300"],
      fixture.env,
    );
    const secondaryClient = await startTmuxPtyClient({
      tmux: fixture.wrapper,
      sessionName: "base-cross",
      env: fixture.env,
    });
    fixture.otherPtyClients.push(secondaryClient);
    const outerClients = [fixture.ptyClient, secondaryClient] as const;

    const installedRoot = dirname(await realpath(builtBinaryPath));
    const fallbackAlias = join(installedRoot, "stn-tmux-popup");
    expect(await realpath(fallbackAlias)).toBe(await realpath(builtBinaryPath));
    const runShellCommand = buildManagedFastPopupRunShellCommand({
      configPath: fixture.configPath,
      installedRoot,
      fallbackAlias,
      tmuxCommand: fixture.wrapper,
    });
    await tmuxExec(
      fixture.wrapper,
      ["bind-key", "Space", "run-shell", "-b", runShellCommand],
      fixture.env,
    );

    await Promise.all(outerClients.map(triggerPopupBinding));
    await waitForTmuxSession(fixture.wrapper, persistentUiSessionName);
    const coldAction = await waitForCoherentActivePopup(fixture, outerClients);
    const firstClient = coldAction.nestedClient;
    const crossClient =
      coldAction.owner === fixture.ptyClient ? secondaryClient : fixture.ptyClient;
    const crossSession = crossClient === fixture.ptyClient ? "base" : "base-cross";
    await waitForHiddenPaneContent(
      fixture,
      isDashboardContent,
      "compiled cold binding did not render the dashboard",
    );
    const firstPane = await readPaneEvidence(fixture);
    const firstProcesses = await waitForDashboardProcessEvidence(fixture, firstPane);
    const firstObserverPid = await recordObserverPid(fixture);
    recordRuntimeEvidence(fixture, firstClient, firstPane, firstProcesses);

    const route = await tmuxGlobalOption(fixture, "@station_popup_ui_route");
    expect(route).toMatch(/^v1\.n\./);
    expect(await tmuxSessionOption(fixture, "@station_popup_ui_lease")).toBe(route);
    expect(await tmuxGlobalOption(fixture, "@station_popup_ui_root")).toBe(installedRoot);

    await coldAction.owner.write(Buffer.from([0x1b]));
    await waitForNestedClientGone(fixture);
    await waitForGlobalOptionValue(fixture, "@station_popup_active_claim", "");

    await writeFile(fixture.configPath, 'schema_version = "malformed"\n', "utf8");
    await triggerPopupBinding(coldAction.owner);
    const qClient = await waitForNestedClient(fixture);
    await waitForHiddenPaneContent(
      fixture,
      isDashboardContent,
      "compiled dashboard did not reopen after Esc",
    );
    const qPane = await readPaneEvidence(fixture);
    const qProcesses = await waitForDashboardProcessEvidence(fixture, qPane);
    const qObserverPid = await recordObserverPid(fixture);
    recordRuntimeEvidence(fixture, qClient, qPane, qProcesses);

    expect(qPane.pid).toBe(firstPane.pid);
    expect(qProcesses.renderer.pid).toBe(firstProcesses.renderer.pid);
    expect(qObserverPid).toBe(firstObserverPid);
    expect(qClient.columns).toBe(firstClient.columns);
    expect(qClient.rows).toBe(firstClient.rows);

    await coldAction.owner.write(Buffer.from("Q", "utf8"));
    await waitForNestedClientGone(fixture);
    await waitForGlobalOptionValue(fixture, "@station_popup_active_claim", "");

    await triggerPopupBinding(coldAction.owner);
    const warmClient = await waitForNestedClient(fixture);
    await waitForHiddenPaneContent(
      fixture,
      isDashboardContent,
      "compiled warm binding did not bypass malformed config after Q",
    );
    const warmPane = await readPaneEvidence(fixture);
    const warmProcesses = await waitForDashboardProcessEvidence(fixture, warmPane);
    const warmObserverPid = await recordObserverPid(fixture);
    recordRuntimeEvidence(fixture, warmClient, warmPane, warmProcesses);

    expect(warmPane.pid).toBe(firstPane.pid);
    expect(warmProcesses.renderer.pid).toBe(firstProcesses.renderer.pid);
    expect(warmObserverPid).toBe(firstObserverPid);
    expect(warmClient.columns).toBe(firstClient.columns);
    expect(warmClient.rows).toBe(firstClient.rows);

    await triggerPopupBinding(crossClient);
    await waitForGlobalOptionValue(fixture, "@station_popup_client", crossClient.clientName);
    const transferredClient = await waitForNestedClientReplacement(fixture, warmClient.pid);
    const transferredPane = await readPaneEvidence(fixture);
    const transferredProcesses = await waitForDashboardProcessEvidence(fixture, transferredPane);
    recordRuntimeEvidence(fixture, transferredClient, transferredPane, transferredProcesses);

    expect(transferredPane.pid).toBe(firstPane.pid);
    expect(transferredProcesses.renderer.pid).toBe(firstProcesses.renderer.pid);
    expect(await recordObserverPid(fixture)).toBe(firstObserverPid);

    await setGlobalOption(fixture.wrapper, "@station_popup_ui_route", "malformed");
    const outputBeforeFailure = crossClient.stdout.text();
    await triggerPopupBinding(crossClient);
    await delay(1_000);

    expect(await tmuxPaneInMode(fixture, crossSession)).toBe("0");
    const invokingPane = await captureTmuxPane(fixture, crossSession);
    const outputAfterFailure = crossClient.stdout.text().slice(outputBeforeFailure.length);
    expect(invokingPane).not.toContain("returned 1");
    expect(invokingPane).not.toContain("station-popup-binding");
    expect(outputAfterFailure).not.toContain("returned 1");
    expect(outputAfterFailure).not.toContain("station-popup-binding");

    const stillAttached = await waitForNestedClient(fixture);
    expect(stillAttached.pid).toBe(transferredClient.pid);
    expect((await readPaneEvidence(fixture)).pid).toBe(firstPane.pid);
    expect((await waitForDashboardProcessEvidence(fixture, transferredPane)).renderer.pid).toBe(
      firstProcesses.renderer.pid,
    );
    expect(await recordObserverPid(fixture)).toBe(firstObserverPid);

    await crossClient.write(Buffer.from("?", "utf8"));
    await waitForHiddenPaneContent(
      fixture,
      (content) => content.includes("station help"),
      "dashboard was not usable after both popup routes failed",
    );

    await setGlobalOption(fixture.wrapper, "@station_popup_ui_route", route);
    await triggerPopupBinding(crossClient);
    await waitForNestedClientGone(fixture);
    await waitForGlobalOptionValue(fixture, "@station_popup_active_claim", "");
    expect(await tmuxPaneInMode(fixture, crossSession)).toBe("0");

    await Promise.all(outerClients.map(triggerPopupBinding));
    const competingAction = await waitForCoherentActivePopup(fixture, outerClients);
    expect(competingAction.nestedClient.pid).not.toBe(transferredClient.pid);
    expect((await readPaneEvidence(fixture)).pid).toBe(firstPane.pid);
    expect((await waitForDashboardProcessEvidence(fixture, transferredPane)).renderer.pid).toBe(
      firstProcesses.renderer.pid,
    );
    expect(await recordObserverPid(fixture)).toBe(firstObserverPid);
    expect(await tmuxPaneInMode(fixture, "base")).toBe("0");
    expect(await tmuxPaneInMode(fixture, "base-cross")).toBe("0");

    await competingAction.owner.write(Buffer.from([0x1b]));
    await waitForHiddenPaneContent(
      fixture,
      (content) => isDashboardContent(content) && !content.includes("station help"),
      "competing managed actions left the dashboard unusable",
    );
    await competingAction.owner.write(Buffer.from("?", "utf8"));
    await waitForHiddenPaneContent(
      fixture,
      (content) => content.includes("station help"),
      "competing managed actions did not preserve dashboard input",
    );
    await triggerPopupBinding(competingAction.owner);
    await waitForNestedClientGone(fixture);
    await waitForGlobalOptionValue(fixture, "@station_popup_active_claim", "");
    await assertPathMissing(
      fixture.bareTmuxLogPath,
      "a child invoked bare tmux instead of the private wrapper",
    );
  }, 180_000);
});

async function createDashboardFixture(
  tmux: string,
  geometry: { height: string; position: string; width: string } = {
    height: "24",
    position: "C",
    width: "80",
  },
): Promise<DashboardFixture> {
  const root = await makeCheckoutTempRoot();
  try {
    const projectRoot = join(root, "project");
    const home = join(root, "home");
    const xdgConfig = join(root, "xdg-config");
    const xdgData = join(root, "xdg-data");
    const xdgState = join(root, "xdg-state");
    const runtime = join(root, "r");
    const state = join(root, "state");
    const run = join(root, "run");
    const temp = join(root, "tmp");
    const providerHomes = {
      claude: join(root, "providers/claude"),
      codex: join(root, "providers/codex"),
      cursor: join(root, "providers/cursor"),
      opencode: join(root, "providers/opencode"),
    };
    await Promise.all([
      mkdir(projectRoot, { recursive: true }),
      mkdir(home, { recursive: true }),
      mkdir(xdgConfig, { recursive: true }),
      mkdir(xdgData, { recursive: true }),
      mkdir(xdgState, { recursive: true }),
      mkdir(runtime, { recursive: true }),
      mkdir(state, { recursive: true }),
      mkdir(run, { recursive: true }),
      mkdir(temp, { recursive: true }),
      ...Object.values(providerHomes).map((path) => mkdir(path, { recursive: true })),
    ]);
    await execFileAsync("git", ["init", "--initial-branch=main"], {
      cwd: projectRoot,
      env: environmentWithoutGitLocals(),
      timeout: 10_000,
    });

    const attachLogPath = join(root, "attach.log");
    const wrapperLogPath = join(root, "tmux-wrapper.log");
    const wrapper = await writeTmuxWrapper({
      root,
      tmux,
      label: `stn-real-${process.pid}-${Date.now()}`,
      attachLogPath,
      wrapperLogPath,
    });
    const bareTmuxLogPath = join(root, "bare-tmux.log");
    const shimDir = await writeFailingTmuxShim(root, bareTmuxLogPath);
    const observerSocketPath = join(run, "observer.sock");
    const configPath = await writeDashboardConfig({
      configPath: join(home, ".config/station/config.toml"),
      projectRoot,
      state,
      observerSocketPath,
      wrapper,
      geometry,
    });
    const env = dashboardFixtureEnv({
      root,
      home,
      xdgConfig,
      xdgData,
      xdgState,
      runtime,
      temp,
      providerHomes,
      shimDir,
      configPath,
      observerSocketPath,
      wrapper,
    });

    return {
      attachLogPath,
      bareTmuxLogPath,
      cliProcesses: [],
      configPath,
      env,
      nestedCliPids: new Set<number>(),
      nestedClientPids: new Set<number>(),
      observerPids: new Set<number>(),
      observerSocketPath,
      otherPtyClients: [],
      panePids: new Set<number>(),
      projectRoot,
      rendererPids: new Set<number>(),
      root,
      wrapper,
      wrapperLogPath,
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function dashboardFixtureEnv(input: {
  configPath: string;
  home: string;
  observerSocketPath: string;
  providerHomes: { claude: string; codex: string; cursor: string; opencode: string };
  root: string;
  runtime: string;
  shimDir: string;
  temp: string;
  wrapper: string;
  xdgConfig: string;
  xdgData: string;
  xdgState: string;
}): NodeJS.ProcessEnv {
  const env = environmentWithoutGitLocals();
  for (const key of [
    "TMUX",
    "STATION_DASHBOARD_COMMAND",
    "STATION_FOCUS_CLIENT_ID",
    "STATION_FOCUS_PROVIDER",
    "STATION_SCENARIO",
    "STATION_SOURCE",
    "STATION_TUI_COMMAND",
    "STATION_TUI_PERSISTENT",
    "STATION_TUI_POPUP",
    "STATION_TUI_SESSION_NAME",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    PATH: `${input.shimDir}:${env.PATH ?? ""}`,
    HOME: input.home,
    TMPDIR: input.temp,
    XDG_CONFIG_HOME: input.xdgConfig,
    XDG_DATA_HOME: input.xdgData,
    XDG_RUNTIME_DIR: input.runtime,
    XDG_STATE_HOME: input.xdgState,
    STATION_CONFIG_PATH: input.configPath,
    STATION_OBSERVER_SOCKET_PATH: input.observerSocketPath,
    STATION_HOST_SOCKET_PATH: join(input.root, "run/station-host.sock"),
    STATION_LAYOUT_PATH: join(input.root, "layout/layout.json"),
    STATION_TMUX_BIN: input.wrapper,
    STATION_SOURCE: "mock",
    CODEX_HOME: input.providerHomes.codex,
    CLAUDE_CONFIG_DIR: input.providerHomes.claude,
    STATION_CURSOR_HOME: input.providerHomes.cursor,
    OPENCODE_CONFIG_DIR: input.providerHomes.opencode,
    TERM: "xterm-256color",
    TZ: "UTC",
  };
}

async function writeDashboardConfig(input: {
  configPath: string;
  geometry: { height: string; position: string; width: string };
  observerSocketPath: string;
  projectRoot: string;
  state: string;
  wrapper: string;
}): Promise<string> {
  await mkdir(dirname(input.configPath), { recursive: true });
  await writeFile(
    input.configPath,
    [
      "schema_version = 1",
      "",
      "[observer]",
      `socket_path = ${JSON.stringify(input.observerSocketPath)}`,
      `state_dir = ${JSON.stringify(input.state)}`,
      "auto_start_from_hooks = false",
      "",
      "[defaults]",
      'worktree_provider = "noop-worktree"',
      'terminal = "tmux"',
      'harness = "noop-harness"',
      'layout = "agent-shell"',
      "",
      "[terminal.tmux]",
      `command = ${JSON.stringify(input.wrapper)}`,
      `popup_width = ${JSON.stringify(input.geometry.width)}`,
      `popup_height = ${JSON.stringify(input.geometry.height)}`,
      `popup_position = ${JSON.stringify(input.geometry.position)}`,
      "",
      "[[tui.widgets]]",
      'type = "fleet"',
      "",
      "[[tui.widgets]]",
      'type = "prs"',
      "",
      "[repository.github]",
      "enabled = false",
      "",
      "[[projects]]",
      'id = "popup-real"',
      'label = "popup real acceptance"',
      `root = ${JSON.stringify(input.projectRoot)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return input.configPath;
}

async function writeFailingTmuxShim(root: string, logPath: string): Promise<string> {
  const binDir = join(root, "bin");
  const shim = join(binDir, "tmux");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    shim,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shellQuote(logPath)}`,
      'printf "bare tmux invocation is forbidden in popup-real.test.ts\\n" >&2',
      "exit 97",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(shim, 0o755);
  return binDir;
}

async function writeTmuxWrapper(input: {
  attachLogPath: string;
  label: string;
  root: string;
  tmux: string;
  wrapperLogPath: string;
}): Promise<string> {
  const wrapper = join(input.root, "tmux-wrapper.sh");
  const tmuxTemp = join(input.root, "tmux-tmp");
  await mkdir(tmuxTemp, { recursive: true });
  await writeFile(
    wrapper,
    [
      "#!/bin/sh",
      `export TMUX_TMPDIR=${shellQuote(tmuxTemp)}`,
      "record_attach=0",
      "seen_command=0",
      "forbidden_global=0",
      'for arg in "$@"; do',
      '  if [ "$seen_command" -eq 0 ]; then',
      '    case "$arg" in',
      "      -L|-S|-f|-L?*|-S?*|-f?*) forbidden_global=1 ;;",
      "      -*) ;;",
      "      *) seen_command=1 ;;",
      "    esac",
      "  fi",
      '  if [ "$arg" = "attach-session" ]; then record_attach=1; fi',
      "done",
      'if [ "$forbidden_global" -ne 0 ]; then',
      '  printf "caller-supplied tmux server/config flags are forbidden\\n" >&2',
      "  exit 98",
      "fi",
      'if [ "$record_attach" -eq 1 ]; then',
      '  size="$(stty size 2>/dev/null || true)"',
      '  tty_name="$(tty 2>/dev/null || true)"',
      `  printf '%s\\t%s\\t%s\\t%s\\n' "$$" "$tty_name" "$size" "$*" >> ${shellQuote(input.attachLogPath)}`,
      "fi",
      `exec ${shellQuote(input.tmux)} -L ${shellQuote(input.label)} -f /dev/null "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(wrapper, 0o755);
  await writeFile(
    input.wrapperLogPath,
    `${input.tmux}\t-L\t${input.label}\t-f\t/dev/null\t--wrapper\n`,
    "utf8",
  );
  return wrapper;
}

async function openAndCloseRegisteredPopup(input: {
  clientName: string;
  devCommand: string;
  expectedSession: string;
  registeredDevPopupRoot?: string;
  tmux: string;
  uiSessionName?: string;
}): Promise<void> {
  let settled = false;
  const popup = openTmuxPopup({
    command: input.tmux,
    env: {
      STATION_FOCUS_CLIENT_ID: input.clientName,
    },
    preferRegisteredDevPopup: true,
    ...(input.registeredDevPopupRoot === undefined
      ? {}
      : { registeredDevPopupRoot: input.registeredDevPopupRoot }),
    timeoutMs: 10_000,
    tuiCommand: input.devCommand,
    ...(input.uiSessionName === undefined ? {} : { uiSessionName: input.uiSessionName }),
  }).finally(() => {
    settled = true;
  });

  await waitForTmuxSession(input.tmux, input.expectedSession);
  const deadline = Date.now() + 5_000;
  while (!settled && Date.now() < deadline) {
    await tmuxExec(input.tmux, ["display-popup", "-c", input.clientName, "-C"]).catch(
      () => undefined,
    );
    await delay(100);
  }
  await withTimeout(popup, 10_000, "tmux popup did not close after display-popup -C");
}

async function startTmuxPtyClient(input: {
  env?: NodeJS.ProcessEnv;
  initialDimensions?: Dimensions;
  sessionName: string;
  tmux: string;
}): Promise<TmuxPtyClient> {
  const initialDimensions = input.initialDimensions ?? { rows: 40, columns: 120 };
  const child = spawn(
    "python3",
    [
      "-c",
      ptyBridgeScript,
      String(initialDimensions.rows),
      String(initialDimensions.columns),
      input.tmux,
      "attach-session",
      "-t",
      input.sessionName,
    ],
    {
      env: {
        ...(input.env ?? process.env),
        TERM: "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );
  const control = child.stdio[3];
  if (control === undefined || control === null || !("write" in control)) {
    child.kill("SIGTERM");
    throw new Error("outer tmux PTY control pipe was not created");
  }
  const tracked = trackChild(child, "outer tmux PTY client");
  try {
    const clientName = await waitForTmuxClient({
      tmux: input.tmux,
      sessionName: input.sessionName,
      tracked,
      env: input.env,
    });
    return {
      ...tracked,
      clientName,
      close: async () => {
        let detachError: unknown;
        try {
          await tmuxExec(input.tmux, ["detach-client", "-t", clientName], input.env);
        } catch (error) {
          detachError = error;
        }
        child.stdin?.end();
        control.end();
        const result = await withTimeout(
          tracked.exit,
          5_000,
          "outer tmux PTY client did not exit after detach",
        );
        if (result.code !== 0 && result.signal === null) {
          throw new Error(`outer tmux PTY client exited with code ${result.code}`);
        }
        if (detachError !== undefined) {
          throw detachError;
        }
      },
      resize: async (rows, columns) => {
        if (!Number.isInteger(rows) || rows <= 0 || !Number.isInteger(columns) || columns <= 0) {
          throw new Error(`invalid outer PTY dimensions: ${columns}x${rows}`);
        }
        await writeStreamInput(
          control,
          Buffer.from(`resize ${rows} ${columns}\n`, "ascii"),
          "outer tmux PTY control pipe",
        );
      },
      write: (bytes) => writeChildInput(child, bytes),
    };
  } catch (error) {
    child.stdin?.end();
    control.end();
    child.kill("SIGTERM");
    await withTimeout(tracked.exit, 2_000, "failed PTY client did not exit").catch(() => undefined);
    throw error;
  }
}

async function waitForTmuxClient(input: {
  env?: NodeJS.ProcessEnv;
  sessionName: string;
  tmux: string;
  tracked: TrackedChild;
}): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (input.tracked.child.exitCode !== null || input.tracked.child.signalCode !== null) {
      throw new Error(`tmux client exited before attach${trackedOutput(input.tracked)}`);
    }
    const clients = await tmuxExec(
      input.tmux,
      ["list-clients", "-t", input.sessionName, "-F", "#{client_name}"],
      input.env,
    ).catch(() => "");
    const client = nonEmptyLines(clients)[0];
    if (client !== undefined) {
      return client;
    }
    await delay(100);
  }
  throw new Error(`tmux client did not attach${trackedOutput(input.tracked)}`);
}

function spawnPopupCli(fixture: DashboardFixture, clientName: string): TrackedChild {
  const child = spawn(process.execPath, [builtCliPath, "--config", fixture.configPath, "popup"], {
    cwd: fixture.projectRoot,
    env: {
      ...fixture.env,
      STATION_FOCUS_CLIENT_ID: clientName,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tracked = trackChild(child, `popup CLI ${child.pid ?? "unspawned"}`);
  fixture.cliProcesses.push(tracked);
  return tracked;
}

function trackChild(child: ChildProcess, label: string): TrackedChild {
  const stdout = createOutputTail();
  const stderr = createOutputTail();
  child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
  const exit = new Promise<ChildExit>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, exit, label, stderr, stdout };
}

function createOutputTail(): OutputTail {
  let tail = Buffer.alloc(0);
  return {
    append(chunk) {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > outputTailBytes) {
        tail = tail.subarray(tail.length - outputTailBytes);
      }
    },
    text: () => tail.toString("utf8"),
  };
}

async function writeChildInput(child: ChildProcess, bytes: Uint8Array): Promise<void> {
  const stdin = child.stdin;
  if (stdin === null) {
    throw new Error("outer tmux PTY stdin is closed");
  }
  await writeStreamInput(stdin, bytes, "outer tmux PTY stdin");
}

async function writeStreamInput(
  stream: NodeJS.WritableStream,
  bytes: Uint8Array,
  label: string,
): Promise<void> {
  if (
    ("destroyed" in stream && stream.destroyed === true) ||
    ("writableEnded" in stream && stream.writableEnded === true)
  ) {
    throw new Error(`${label} is closed`);
  }
  if (stream.write(bytes)) {
    return;
  }
  await new Promise<void>((resolveDrain, reject) => {
    stream.once("drain", resolveDrain);
    stream.once("error", reject);
  });
}

async function waitForPaneContent(
  fixture: DashboardFixture,
  popup: TrackedChild,
  predicate: (content: string) => boolean,
  failureMessage: string,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  let content = "";
  while (Date.now() < deadline) {
    if (popup.child.exitCode !== null || popup.child.signalCode !== null) {
      const result = await popup.exit;
      throw new Error(
        `${failureMessage}: popup CLI exited with code ${result.code} and signal ${result.signal}${trackedOutput(popup)}${await fixtureDiagnostics(fixture)}`,
      );
    }
    content = await tmuxExec(
      fixture.wrapper,
      ["capture-pane", "-p", "-N", "-t", persistentUiSessionName],
      fixture.env,
    ).catch(() => "");
    if (predicate(content)) {
      return content;
    }
    await delay(100);
  }
  throw new Error(
    `${failureMessage}${trackedOutput(popup)}\nLast hidden pane:\n${content.slice(-8_000)}${await fixtureDiagnostics(fixture)}`,
  );
}

async function waitForHiddenPaneContent(
  fixture: DashboardFixture,
  predicate: (content: string) => boolean,
  failureMessage: string,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  let content = "";
  while (Date.now() < deadline) {
    content = await tmuxExec(
      fixture.wrapper,
      ["capture-pane", "-p", "-N", "-t", persistentUiSessionName],
      fixture.env,
    ).catch(() => "");
    if (predicate(content)) {
      return content;
    }
    await delay(100);
  }
  throw new Error(
    `${failureMessage}\nLast hidden pane:\n${content.slice(-8_000)}${await fixtureDiagnostics(fixture)}`,
  );
}

async function captureHiddenStyledLine(fixture: DashboardFixture, needle: string): Promise<string> {
  const content = await tmuxExec(
    fixture.wrapper,
    ["capture-pane", "-e", "-p", "-N", "-t", persistentUiSessionName],
    fixture.env,
  );
  const line = content.split("\n").find((candidate) => candidate.includes(needle));
  if (line === undefined) {
    throw new Error(`hidden pane does not contain ${JSON.stringify(needle)}`);
  }
  return line;
}

async function waitForHiddenStyledLine(
  fixture: DashboardFixture,
  needle: string,
  predicate: (line: string) => boolean,
  failureMessage: string,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  let line = "";
  while (Date.now() < deadline) {
    line = await captureHiddenStyledLine(fixture, needle).catch(() => "");
    if (line !== "" && predicate(line)) {
      return line;
    }
    await delay(100);
  }
  throw new Error(
    `${failureMessage}\nLast styled line:\n${line}${await fixtureDiagnostics(fixture)}`,
  );
}

function paneCell(content: string, needle: string): { col: number; row: number } {
  const lines = content.split("\n");
  const row = lines.findIndex((line) => line.includes(needle));
  const col = row < 0 ? -1 : (lines[row]?.indexOf(needle) ?? -1);
  if (row < 0 || col < 0) {
    throw new Error(`pane does not contain ${JSON.stringify(needle)}`);
  }
  return { col, row };
}

function centeredPopupOuterCell(
  outer: Dimensions,
  client: Dimensions,
  cell: { col: number; row: number },
): { column: number; row: number } {
  // Inner dimensions exclude the border, and vertical centering excludes the outer status row.
  const popupWidth = client.columns + popupBorderColumns;
  const popupHeight = client.rows + popupBorderRows;
  const contentLeft = Math.floor((outer.columns - popupWidth) / 2) + 1;
  const contentTop = Math.floor((outer.rows - outerTmuxStatusRows - popupHeight) / 2) + 1;
  return {
    column: contentLeft + cell.col + 1,
    row: contentTop + cell.row + 1,
  };
}

function sgrMouse(
  code: number,
  cell: { column: number; row: number },
  final: "M" | "m" = "M",
): Uint8Array {
  return Buffer.from(`\u001b[<${code};${cell.column};${cell.row}${final}`, "utf8");
}

async function writeSgrClick(
  client: TmuxPtyClient,
  cell: { column: number; row: number },
): Promise<void> {
  await client.write(sgrMouse(0, cell));
  await client.write(sgrMouse(0, cell, "m"));
}

async function fixtureDiagnostics(fixture: DashboardFixture): Promise<string> {
  const sessions = await tmuxExec(
    fixture.wrapper,
    [
      "list-panes",
      "-a",
      "-F",
      "#{session_name} #{pane_id} dead=#{pane_dead} status=#{pane_dead_status} command=#{pane_current_command}",
    ],
    fixture.env,
  ).catch((error) => `unavailable: ${errorMessage(error)}`);
  const paths = [
    fixture.attachLogPath,
    fixture.bareTmuxLogPath,
    fixture.wrapperLogPath,
    join(fixture.root, "state/logs/observer.jsonl"),
    join(fixture.root, "state/logs/cli.jsonl"),
    join(fixture.root, "state/logs/tui.jsonl"),
  ];
  const files = await Promise.all(
    paths.map(async (path) => {
      const text = await readFile(path, "utf8").catch(() => "<absent>");
      const limit = path === fixture.wrapperLogPath ? 32_000 : 8_000;
      return `${path}:\n${text.slice(-limit)}`;
    }),
  );
  const routeEvidence = await tmuxExec(
    fixture.wrapper,
    [
      "display-message",
      "-p",
      "-t",
      `${persistentUiSessionName}:`,
      [
        "route=#{@station_popup_ui_route}",
        "lease=#{@station_popup_ui_lease}",
        "claim=#{@station_popup_active_claim}",
        "signature=#{@station_popup_ui_signature}",
        "session=#{@station_popup_ui_session_name}",
        "expected=#{@station_popup_ui_expected_signature}",
        "root=#{@station_popup_ui_root}",
        "client=#{@station_popup_client}",
        "focus=#{@station_popup_focus_client}",
        "devSession=#{@station_tui_dev_session_name}",
        "devCommand=#{@station_tui_dev_command}",
        "devOwner=#{@station_tui_dev_owner}",
        "devRoot=#{@station_tui_dev_root}",
      ].join("\n"),
    ],
    fixture.env,
  ).catch(() => "<unavailable>");
  const outerOutput =
    fixture.ptyClient === undefined ? "<absent>" : trackedOutput(fixture.ptyClient);
  return `\nPrivate tmux panes:\n${sessions}\nFast-route evidence:\n${routeEvidence}\nOuter PTY tail:${outerOutput}\nFixture evidence:\n${files.join("\n")}`;
}

function isDashboardContent(content: string): boolean {
  return (
    content.includes("FLEET") &&
    content.includes("Station snapshot mock") &&
    content.includes("? help")
  );
}

function isManyProjectDashboardContent(content: string): boolean {
  return (
    content.includes("FLEET") && content.includes("station-overlay") && content.includes("? help")
  );
}

function isAcceptanceDashboardContent(content: string): boolean {
  return content.includes("01 Private tmux destination") && content.includes("? help");
}

async function waitForPopupAttachRecord(
  fixture: DashboardFixture,
  recordIndex = 0,
): Promise<AttachRecord> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const records = (await readAttachRecords(fixture.attachLogPath)).filter((candidate) =>
      candidate.args.includes(`attach-session -t ${persistentUiSessionName}`),
    );
    const record = records[recordIndex];
    if (record !== undefined) {
      return record;
    }
    await delay(100);
  }
  throw new Error("popup wrapper did not record nested attach-session PTY geometry");
}

async function popupAttachRecordCount(fixture: DashboardFixture): Promise<number> {
  return (await readAttachRecords(fixture.attachLogPath)).filter((candidate) =>
    candidate.args.includes(`attach-session -t ${persistentUiSessionName}`),
  ).length;
}

async function readAttachRecords(path: string): Promise<AttachRecord[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return nonEmptyLines(text).flatMap((line) => {
    const [pidText, tty, size, args] = line.split("\t");
    if (pidText === undefined || tty === undefined || size === undefined || args === undefined) {
      return [];
    }
    const [rowsText, columnsText] = size.trim().split(/\s+/);
    const pid = Number(pidText);
    const rows = Number(rowsText);
    const columns = Number(columnsText);
    if (![pid, rows, columns].every((value) => Number.isInteger(value) && value > 0)) {
      return [];
    }
    return [{ args, columns, pid, rows, tty: normalizeTty(tty) }];
  });
}

async function waitForNestedClient(fixture: DashboardFixture): Promise<NestedClientEvidence> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const client = await readNestedClient(fixture);
    if (client !== undefined) {
      fixture.nestedClientPids.add(client.pid);
      return client;
    }
    await delay(100);
  }
  throw new Error(`nested popup tmux client did not attach${await fixtureDiagnostics(fixture)}`);
}

async function waitForNestedClientReplacement(
  fixture: DashboardFixture,
  previousPid: number,
): Promise<NestedClientEvidence> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const client = await readNestedClient(fixture);
    if (client !== undefined && client.pid !== previousPid) {
      fixture.nestedClientPids.add(client.pid);
      return client;
    }
    await delay(100);
  }
  throw new Error(`nested popup client ${previousPid} was not replaced`);
}

async function readNestedClient(
  fixture: DashboardFixture,
): Promise<NestedClientEvidence | undefined> {
  const output = await tmuxExec(
    fixture.wrapper,
    [
      "list-clients",
      "-t",
      persistentUiSessionName,
      "-F",
      "#{client_name}\t#{client_pid}\t#{client_width}\t#{client_height}\t#{client_tty}",
    ],
    fixture.env,
  ).catch(() => "");
  const lines = nonEmptyLines(output);
  if (lines.length > 1) {
    throw new Error(`expected one nested popup client, found ${lines.length}`);
  }
  const line = lines[0];
  if (line === undefined) {
    return undefined;
  }
  const [name, pidText, columnsText, rowsText, tty] = line.split("\t");
  if (
    name === undefined ||
    pidText === undefined ||
    columnsText === undefined ||
    rowsText === undefined ||
    tty === undefined
  ) {
    return undefined;
  }
  return {
    name,
    pid: positiveInteger(pidText, "nested client pid"),
    columns: positiveInteger(columnsText, "nested client columns"),
    rows: positiveInteger(rowsText, "nested client rows"),
    tty: normalizeTty(tty),
  };
}

async function waitForNestedClientGone(fixture: DashboardFixture): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const output = await tmuxExec(
      fixture.wrapper,
      ["list-clients", "-t", persistentUiSessionName, "-F", "#{client_name}"],
      fixture.env,
    ).catch(() => "");
    if (nonEmptyLines(output).length === 0) {
      return;
    }
    await delay(100);
  }
  throw new Error("nested popup tmux client remained attached after closing the popup");
}

async function readOuterClientDimensions(
  fixture: DashboardFixture,
  clientName: string,
): Promise<Dimensions> {
  const output = await tmuxExec(
    fixture.wrapper,
    ["list-clients", "-F", "#{client_name}\t#{client_width}\t#{client_height}"],
    fixture.env,
  );
  const record = nonEmptyLines(output)
    .map((line) => line.split("\t"))
    .find(([name]) => name === clientName);
  return {
    columns: positiveInteger(record?.[1], "outer client columns"),
    rows: positiveInteger(record?.[2], "outer client rows"),
  };
}

async function waitForPaneDimensions(
  fixture: DashboardFixture,
  expected: Dimensions,
): Promise<PaneEvidence> {
  const deadline = Date.now() + 10_000;
  let pane: PaneEvidence | undefined;
  while (Date.now() < deadline) {
    pane = await readPaneEvidence(fixture);
    if (pane.columns === expected.columns && pane.rows === expected.rows) {
      return pane;
    }
    await delay(100);
  }
  throw new Error(
    `hidden pane did not reach ${expected.columns}x${expected.rows}; last geometry was ${pane?.columns ?? "?"}x${pane?.rows ?? "?"}`,
  );
}

function dashboardFrameLines(content: string): string[] {
  return content
    .replace(/\n$/u, "")
    .split("\n")
    .map((line) => line.trimEnd());
}

function dashboardFrameMatchesGeometry(content: string, dimensions: Dimensions): boolean {
  const lines = dashboardFrameLines(content);
  const divider = "─".repeat(dimensions.columns - 1);
  return (
    lines[2] === divider &&
    lines[3]?.includes("SESSION") === true &&
    lines[dimensions.rows - 2] === divider &&
    lines[dimensions.rows - 1]?.startsWith("↵ open") === true &&
    !lines.includes("─")
  );
}

function assertDashboardFrameGeometry(
  content: string,
  dimensions: Dimensions,
  label: string,
): void {
  const lines = dashboardFrameLines(content);
  const divider = "─".repeat(dimensions.columns - 1);
  expect(lines[2], `${label} top divider`).toBe(divider);
  expect(lines[3], `${label} column header`).toContain("SESSION");
  expect(lines[dimensions.rows - 2], `${label} bottom divider`).toBe(divider);
  expect(lines[dimensions.rows - 1], `${label} footer`).toMatch(/^↵ open/u);
  expect(
    lines.filter((line) => line === divider),
    `${label} divider rows`,
  ).toHaveLength(2);
  expect(lines, `${label} wrapped divider cell`).not.toContain("─");
}

async function readPaneEvidence(fixture: DashboardFixture): Promise<PaneEvidence> {
  const output = await tmuxExec(
    fixture.wrapper,
    [
      "list-panes",
      "-t",
      persistentUiSessionName,
      "-F",
      "#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{pane_width}\t#{pane_height}",
    ],
    fixture.env,
  );
  const lines = nonEmptyLines(output);
  if (lines.length !== 1) {
    throw new Error(`expected one hidden dashboard pane, found ${lines.length}`);
  }
  const [id, pidText, tty, columnsText, rowsText] = lines[0]?.split("\t") ?? [];
  if (
    id === undefined ||
    pidText === undefined ||
    tty === undefined ||
    columnsText === undefined ||
    rowsText === undefined
  ) {
    throw new Error(`invalid hidden pane evidence: ${output}`);
  }
  const pane = {
    id,
    pid: positiveInteger(pidText, "hidden pane pid"),
    tty: normalizeTty(tty),
    columns: positiveInteger(columnsText, "hidden pane columns"),
    rows: positiveInteger(rowsText, "hidden pane rows"),
  };
  fixture.panePids.add(pane.pid);
  return pane;
}

async function waitForDashboardProcessEvidence(
  fixture: DashboardFixture,
  pane: PaneEvidence,
): Promise<DashboardProcessEvidence> {
  const deadline = Date.now() + 10_000;
  let processTree: ProcessRecord[] = [];
  while (Date.now() < deadline) {
    const processes = await processRecords();
    const byPid = new Map(processes.map((record) => [record.pid, record]));
    processTree = processes.filter(
      (record) => record.pid === pane.pid || isDescendantOf(record, pane.pid, byPid),
    );
    const cliMatches = processTree.filter(isNestedDashboardCliProcess);
    const rendererMatches = processTree.filter(isDashboardRendererProcess);
    for (const cli of cliMatches) fixture.nestedCliPids.add(cli.pid);
    for (const renderer of rendererMatches) fixture.rendererPids.add(renderer.pid);
    if (cliMatches.length > 1) {
      throw new Error(`expected one nested dashboard CLI, found ${cliMatches.length}`);
    }
    if (rendererMatches.length > 1) {
      throw new Error(
        `expected one dashboard renderer descendant, found ${rendererMatches.length}`,
      );
    }
    const cli = cliMatches[0];
    const renderer = rendererMatches[0];
    if (cli !== undefined && renderer !== undefined) {
      const dimensions = await sttyDimensions(normalizeTty(renderer.tty));
      return {
        cli,
        renderer: {
          ...dimensions,
          command: renderer.command,
          pid: renderer.pid,
          tty: normalizeTty(renderer.tty),
        },
      };
    }
    await delay(100);
  }
  throw new Error(
    `dashboard CLI and renderer were not found beneath pane pid ${pane.pid}:\n${processTree
      .map((record) => `${record.pid} <- ${record.ppid} ${record.tty} ${record.command}`)
      .join("\n")}`,
  );
}

function isNestedDashboardCliProcess(record: ProcessRecord): boolean {
  const [command, ...commandArgs] = record.command.split(/\s+/);
  const sourceCli =
    command !== undefined &&
    basename(command) === basename(process.execPath) &&
    commandArgs[0] === builtCliPath;
  const compiledCli = command !== undefined && resolve(command) === builtBinaryPath;
  const args = sourceCli ? commandArgs.slice(1) : commandArgs;
  const tuiIndex = args.indexOf("tui");
  return (
    (sourceCli || compiledCli) &&
    tuiIndex >= 0 &&
    args[tuiIndex + 1] === "--popup" &&
    args[tuiIndex + 2] === "--persistent"
  );
}

function isDashboardRendererProcess(record: ProcessRecord): boolean {
  const [command, entry] = record.command.split(/\s+/);
  const sourceRenderer =
    command !== undefined && basename(command) === "bun" && entry === rendererEntry;
  const compiledRenderer =
    command !== undefined && resolve(command) === builtBinaryPath && entry === "__dashboard";
  return sourceRenderer || compiledRenderer;
}

async function processRecords(): Promise<ProcessRecord[]> {
  const result = await execFileAsync("ps", ["-axww", "-o", "pid=,ppid=,tty=,command="], {
    timeout: 10_000,
  });
  return nonEmptyLines(result.stdout).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match === null) {
      return [];
    }
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        tty: match[3] ?? "",
        command: match[4] ?? "",
      },
    ];
  });
}

function isDescendantOf(
  processRecord: ProcessRecord,
  ancestorPid: number,
  byPid: ReadonlyMap<number, ProcessRecord>,
): boolean {
  const visited = new Set<number>();
  let parentPid = processRecord.ppid;
  while (parentPid > 0 && !visited.has(parentPid)) {
    if (parentPid === ancestorPid) {
      return true;
    }
    visited.add(parentPid);
    parentPid = byPid.get(parentPid)?.ppid ?? 0;
  }
  return false;
}

async function sttyDimensions(tty: string): Promise<Dimensions> {
  const result = await execFileAsync(
    "/bin/sh",
    ["-c", 'stty size < "$1"', "station-popup-stty", tty],
    { timeout: 10_000 },
  );
  const [rowsText, columnsText] = result.stdout.trim().split(/\s+/);
  return {
    rows: positiveInteger(rowsText, "renderer tty rows"),
    columns: positiveInteger(columnsText, "renderer tty columns"),
  };
}

function recordRuntimeEvidence(
  fixture: DashboardFixture,
  client: NestedClientEvidence,
  pane: PaneEvidence,
  processes: DashboardProcessEvidence,
): void {
  fixture.nestedCliPids.add(processes.cli.pid);
  fixture.nestedClientPids.add(client.pid);
  fixture.panePids.add(pane.pid);
  fixture.rendererPids.add(processes.renderer.pid);
}

async function recordObserverPid(fixture: DashboardFixture): Promise<number> {
  const identityPath = `${fixture.observerSocketPath}.pid`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const serialized = await readFile(identityPath, "utf8").catch(() => undefined);
    if (serialized !== undefined) {
      const identity = parseJsonFixture(
        serialized,
        ObserverProcessIdentitySchema,
        "observer process identity",
      );
      expect(identity.socketPath).toBe(fixture.observerSocketPath);
      fixture.observerPids.add(identity.pid);
      return identity.pid;
    }
    await delay(100);
  }
  throw new Error(`observer identity did not appear at ${identityPath}`);
}

async function triggerPopupBinding(client: TmuxPtyClient): Promise<void> {
  await client.write(Buffer.from([0x02]));
  await delay(25);
  await client.write(Buffer.from(" ", "utf8"));
}

async function tmuxGlobalOption(fixture: DashboardFixture, name: string): Promise<string> {
  return tmuxExec(fixture.wrapper, ["show-options", "-gqv", name], fixture.env).then((value) =>
    value.trimEnd(),
  );
}

async function tmuxSessionOption(fixture: DashboardFixture, name: string): Promise<string> {
  return tmuxExec(
    fixture.wrapper,
    ["show-options", "-t", persistentUiSessionName, "-qv", name],
    fixture.env,
  ).then((value) => value.trimEnd());
}

async function waitForGlobalOptionValue(
  fixture: DashboardFixture,
  name: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let actual = "";
  while (Date.now() < deadline) {
    actual = await tmuxGlobalOption(fixture, name);
    if (actual === expected) {
      return;
    }
    await delay(100);
  }
  throw new Error(
    `tmux option ${name} did not become ${JSON.stringify(expected)}; last value was ${JSON.stringify(actual)}${await fixtureDiagnostics(fixture)}`,
  );
}

async function waitForCoherentActivePopup(
  fixture: DashboardFixture,
  owners: readonly TmuxPtyClient[],
): Promise<{
  nestedClient: NestedClientEvidence;
  owner: TmuxPtyClient;
}> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rawClaim = await tmuxGlobalOption(fixture, "@station_popup_active_claim");
    const claim = parsePopupActiveClaim(rawClaim);
    const owner = owners.find((client) => client.clientName === claim?.clientName);
    const nestedClient = await readNestedClient(fixture);
    if (
      claim?.state === "open" &&
      owner !== undefined &&
      nestedClient !== undefined &&
      (await tmuxGlobalOption(fixture, "@station_popup_client")) === claim.clientName &&
      (await tmuxGlobalOption(fixture, "@station_popup_focus_client")) === claim.clientName
    ) {
      await delay(200);
      const settledClaim = await tmuxGlobalOption(fixture, "@station_popup_active_claim");
      const settledClient = await readNestedClient(fixture);
      if (
        settledClaim === rawClaim &&
        settledClient?.pid === nestedClient.pid &&
        (await tmuxGlobalOption(fixture, "@station_popup_client")) === claim.clientName &&
        (await tmuxGlobalOption(fixture, "@station_popup_focus_client")) === claim.clientName
      ) {
        return { nestedClient, owner };
      }
    }
    await delay(100);
  }
  throw new Error("competing managed bindings did not settle on one coherent popup owner");
}

async function tmuxPaneInMode(fixture: DashboardFixture, sessionName: string): Promise<string> {
  return tmuxExec(
    fixture.wrapper,
    ["display-message", "-p", "-t", `${sessionName}:0.0`, "#{pane_in_mode}"],
    fixture.env,
  ).then((value) => value.trim());
}

async function captureTmuxPane(fixture: DashboardFixture, sessionName: string): Promise<string> {
  return tmuxExec(
    fixture.wrapper,
    ["capture-pane", "-p", "-S", "-", "-t", `${sessionName}:0.0`],
    fixture.env,
  );
}

async function closeOuterPopup(fixture: DashboardFixture): Promise<void> {
  if (fixture.ptyClient === undefined) {
    return;
  }
  await tmuxExec(
    fixture.wrapper,
    ["display-popup", "-c", fixture.ptyClient.clientName, "-C"],
    fixture.env,
  );
}

async function expectSuccessfulExit(child: TrackedChild, timeoutMs: number): Promise<void> {
  const result = await withTimeout(child.exit, timeoutMs, `${child.label} did not exit`);
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(
      `${child.label} exited with code ${result.code} and signal ${result.signal}${trackedOutput(child)}`,
    );
  }
}

async function cleanupDashboardFixture(fixture: DashboardFixture): Promise<void> {
  const failures: Error[] = [];
  await cleanupStep(failures, "close active popup and await popup CLIs", async () => {
    for (const client of [fixture.ptyClient, ...fixture.otherPtyClients]) {
      if (client !== undefined) {
        await tmuxExec(
          fixture.wrapper,
          ["display-popup", "-c", client.clientName, "-C"],
          fixture.env,
        ).catch(() => undefined);
      }
    }
    for (const child of fixture.cliProcesses) {
      await expectSuccessfulExit(child, 10_000);
    }
  });
  await cleanupStep(failures, "stop isolated observer", async () => {
    if (fixture.observerServer !== undefined) {
      const observerServer = fixture.observerServer;
      fixture.observerServer = undefined;
      await observerServer.close();
      return;
    }
    await recordObserverPidIfPresent(fixture);
    await execFileAsync(
      process.execPath,
      [builtCliPath, "--config", fixture.configPath, "observer", "stop"],
      {
        cwd: fixture.projectRoot,
        env: fixture.env,
        timeout: 30_000,
      },
    );
  });
  await cleanupStep(failures, "detach outer PTY client", async () => {
    const otherPtyClients = fixture.otherPtyClients.splice(0);
    for (const client of otherPtyClients) {
      await client.close();
    }
    const ptyClient = fixture.ptyClient;
    fixture.ptyClient = undefined;
    await ptyClient?.close();
  });
  await cleanupStep(failures, "kill private tmux server", async () => {
    await tmuxExec(fixture.wrapper, ["kill-server"], fixture.env).catch(async (error) => {
      if (await privateTmuxServerExists(fixture.wrapper, fixture.env)) {
        throw error;
      }
    });
  });
  await cleanupStep(failures, "wait for fixture processes", async () => {
    const pidLabels = new Map<number, string[]>();
    const recordPids = (pids: Iterable<number>, label: string) => {
      for (const pid of pids) {
        const labels = pidLabels.get(pid) ?? [];
        labels.push(label);
        pidLabels.set(pid, labels);
      }
    };
    recordPids(
      fixture.cliProcesses.flatMap((tracked) =>
        tracked.child.pid === undefined ? [] : [tracked.child.pid],
      ),
      "outer popup CLI",
    );
    recordPids(fixture.nestedCliPids, "nested dashboard CLI");
    recordPids(fixture.nestedClientPids, "nested tmux client");
    recordPids(fixture.panePids, "hidden pane");
    recordPids(fixture.rendererPids, "dashboard renderer");
    recordPids(fixture.observerPids, "observer");
    const processFailures: Error[] = [];
    await Promise.all(
      [...pidLabels].map(async ([pid, labels]) => {
        if (await waitForPidExit(pid, 5_000)) {
          return;
        }
        processFailures.push(
          new Error(`fixture ${labels.join("/")} process ${pid} did not exit without a signal`),
        );
        return terminateRecordedPid(pid);
      }),
    );
    if (processFailures.length > 0) {
      throw new AggregateError(
        processFailures,
        `fixture processes required forced cleanup: ${processFailures.map((error) => error.message).join(", ")}`,
      );
    }
  });
  await cleanupStep(failures, "prove private isolation", async () => {
    if (await privateTmuxServerExists(fixture.wrapper, fixture.env)) {
      throw new Error("private tmux server still exists after kill-server");
    }
    await assertPathMissing(
      fixture.bareTmuxLogPath,
      "a child invoked bare tmux instead of the private wrapper",
    );
    await assertWrapperAudit(fixture);
  });
  if (failures.length === 0) {
    await cleanupStep(failures, "remove fixture root", async () => {
      await rm(fixture.root, { recursive: true, force: true });
      await assertPathMissing(fixture.root, "fixture root still exists after removal");
    });
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `real dashboard popup cleanup failed; retained ${fixture.root}: ${failures.map((error) => error.message).join("; ")}`,
    );
  }
}

function outerDimensionsForDashboard(dimensions: Dimensions): Dimensions {
  return {
    rows: dimensions.rows + popupBorderRows + nestedTmuxStatusRows,
    columns: dimensions.columns + popupBorderColumns,
  };
}

async function resizeDashboardSurface(
  fixture: DashboardFixture,
  dimensions: Dimensions,
): Promise<void> {
  if (fixture.ptyClient === undefined) {
    throw new Error("outer tmux PTY client is not attached");
  }
  const outer = outerDimensionsForDashboard(dimensions);
  await fixture.ptyClient.resize(outer.rows, outer.columns);
  await expectConvergedDashboardDimensions(fixture, dimensions);
}

async function expectConvergedDashboardDimensions(
  fixture: DashboardFixture,
  expected: Dimensions,
): Promise<void> {
  if (fixture.ptyClient === undefined) {
    throw new Error("outer tmux PTY client is not attached");
  }
  const clientName = fixture.ptyClient.clientName;
  const deadline = Date.now() + 10_000;
  let last = "no dimension evidence";
  while (Date.now() < deadline) {
    try {
      const nestedClient = await readNestedClient(fixture);
      const pane = await readPaneEvidence(fixture);
      const processes = await waitForDashboardProcessEvidence(fixture, pane);
      const outer = await readOuterClientDimensions(fixture, clientName);
      last = JSON.stringify({ outer, nestedClient, pane, renderer: processes.renderer });
      const expectedOuter = outerDimensionsForDashboard(expected);
      if (
        outer.rows === expectedOuter.rows &&
        outer.columns === expectedOuter.columns &&
        nestedClient?.rows === expected.rows + nestedTmuxStatusRows &&
        nestedClient.columns === expected.columns &&
        pane.rows === expected.rows &&
        pane.columns === expected.columns &&
        processes.renderer.rows === expected.rows &&
        processes.renderer.columns === expected.columns
      ) {
        return;
      }
    } catch (error) {
      last = errorMessage(error);
    }
    await delay(100);
  }
  throw new Error(
    `outer, nested-client, pane, and renderer dimensions did not converge to ${expected.columns}x${expected.rows}; last evidence: ${last}${await fixtureDiagnostics(fixture)}`,
  );
}

async function readExpectedDashboardFrame(): Promise<CapturedFrame> {
  const encoded = await readFile(realDashboardFrameUrl, "utf8");
  return parseJsonFixture(encoded, CapturedFrameSchema, "expected dashboard frame");
}

async function captureFrame(fixture: DashboardFixture): Promise<CapturedFrame> {
  const pane = await readPaneEvidence(fixture);
  const output = await tmuxExec(
    fixture.wrapper,
    ["capture-pane", "-p", "-N", "-t", persistentUiSessionName],
    fixture.env,
  );
  const serializedLines = output.endsWith("\n") ? output.slice(0, -1) : output;
  const lines = serializedLines.split("\n");
  if (lines.length !== pane.rows) {
    throw new Error(
      `captured ${lines.length} rows from a ${pane.columns}x${pane.rows} pane${await fixtureDiagnostics(fixture)}`,
    );
  }
  return { columns: pane.columns, rows: pane.rows, lines };
}

async function captureStableFrame(fixture: DashboardFixture): Promise<CapturedFrame> {
  const deadline = Date.now() + 10_000;
  let previous: CapturedFrame | undefined;
  while (Date.now() < deadline) {
    const current = await captureFrame(fixture);
    if (previous !== undefined && framesEqual(previous, current)) {
      return current;
    }
    previous = current;
    await delay(100);
  }
  throw new Error(
    `dashboard did not produce two identical consecutive frames${await fixtureDiagnostics(fixture)}`,
  );
}

async function waitForExactFrame(
  fixture: DashboardFixture,
  expected: CapturedFrame,
): Promise<CapturedFrame> {
  const deadline = Date.now() + 10_000;
  let previous: CapturedFrame | undefined;
  while (Date.now() < deadline) {
    const current = await captureFrame(fixture);
    if (
      framesEqual(current, expected) &&
      previous !== undefined &&
      framesEqual(previous, current)
    ) {
      return current;
    }
    previous = current;
    await delay(100);
  }
  throw new Error(
    `dashboard did not restore the exact baseline frame${await fixtureDiagnostics(fixture)}`,
  );
}

function framesEqual(left: CapturedFrame, right: CapturedFrame): boolean {
  return (
    left.columns === right.columns &&
    left.rows === right.rows &&
    left.lines.length === right.lines.length &&
    left.lines.every((line, index) => line === right.lines[index])
  );
}

function assertStructuralDashboardFrame(frame: CapturedFrame): void {
  expect(frame.lines).toHaveLength(frame.rows);
  expect(frame.lines.at(-1)).toContain("? help");
}

async function waitForDashboardRuntimeEvidence(
  fixture: DashboardFixture,
  popup: TrackedChild,
  observerPid: number,
): Promise<DashboardRuntimeEvidence> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await currentDashboardRuntimeEvidence(fixture, popup, observerPid);
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`dashboard runtime evidence did not converge: ${errorMessage(lastError)}`);
}

async function currentDashboardRuntimeEvidence(
  fixture: DashboardFixture,
  popup: TrackedChild,
  observerPid: number,
): Promise<DashboardRuntimeEvidence> {
  const nestedClient = await waitForNestedClient(fixture);
  const pane = await readPaneEvidence(fixture);
  const processes = await waitForDashboardProcessEvidence(fixture, pane);
  recordRuntimeEvidence(fixture, nestedClient, pane, processes);
  const popupCliPid = popup.child.pid;
  if (popupCliPid === undefined) {
    throw new Error("popup CLI has no process id");
  }
  return {
    cliPid: processes.cli.pid,
    nestedClientPid: nestedClient.pid,
    observerPid,
    panePid: pane.pid,
    popupCliPid,
    rendererPid: processes.renderer.pid,
    tmuxServerPid: await tmuxServerPid(fixture),
  };
}

function expectDashboardRuntimeUnchanged(
  expected: DashboardRuntimeEvidence,
  actual: DashboardRuntimeEvidence,
): void {
  expect(actual).toEqual(expected);
  for (const pid of Object.values(actual)) {
    expect(processExists(pid), `recorded runtime process ${pid} is not alive`).toBe(true);
  }
}

async function tmuxServerPid(fixture: DashboardFixture): Promise<number> {
  const output = await tmuxExec(fixture.wrapper, ["display-message", "-p", "#{pid}"], fixture.env);
  return positiveInteger(output.trim(), "private tmux server pid");
}

async function createTmuxFocusDestination(fixture: DashboardFixture): Promise<{
  paneId: string;
  sessionName: string;
  targetId: TerminalTargetId;
  windowId: string;
}> {
  const sessionName = "station-focus-target";
  await tmuxExec(
    fixture.wrapper,
    [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-n",
      "visible-focus-target",
      "sh",
      "-c",
      "printf 'STATION PRIVATE FOCUS TARGET\\n'; exec sleep 300",
    ],
    fixture.env,
  );
  const output = await tmuxExec(
    fixture.wrapper,
    [
      "display-message",
      "-p",
      "-t",
      `${sessionName}:0.0`,
      "#{session_name}\t#{window_id}\t#{pane_id}",
    ],
    fixture.env,
  );
  const [observedSession, windowId, paneId] = output.trim().split("\t");
  if (observedSession !== sessionName || windowId === undefined || paneId === undefined) {
    throw new Error(`invalid private focus destination evidence: ${output}`);
  }
  return {
    paneId,
    sessionName,
    targetId: buildTmuxTargetId({ sessionId: sessionName, windowId, paneId }),
    windowId,
  };
}

async function waitForTmuxClientTarget(
  fixture: DashboardFixture,
  expected: { paneId: string; sessionName: string; windowId: string },
): Promise<TmuxClientTarget> {
  if (fixture.ptyClient === undefined) {
    throw new Error("outer tmux PTY client is not attached");
  }
  const deadline = Date.now() + 10_000;
  let last = "";
  while (Date.now() < deadline) {
    const output = await tmuxExec(
      fixture.wrapper,
      ["list-clients", "-F", "#{client_name}\t#{session_name}\t#{window_id}\t#{pane_id}"],
      fixture.env,
    );
    last = output;
    for (const line of output.trim().split("\n")) {
      const [clientName, sessionName, windowId, paneId] = line.split("\t");
      if (
        clientName === fixture.ptyClient.clientName &&
        sessionName === expected.sessionName &&
        windowId === expected.windowId &&
        paneId === expected.paneId
      ) {
        return { clientName, sessionName, windowId, paneId };
      }
    }
    await delay(100);
  }
  throw new Error(
    `outer client did not visibly switch to the private target; last clients:\n${last}`,
  );
}

async function assertWrapperAudit(
  fixture: Pick<DashboardFixture, "wrapperLogPath">,
): Promise<void> {
  const lines = nonEmptyLines(await readFile(fixture.wrapperLogPath, "utf8"));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).toMatch(/^[^\t]+\t-L\t[^\t]+\t-f\t\/dev\/null\t--wrapper$/);
  }
}

function deterministicDashboardSnapshot(projectRoot: string): StationSnapshot {
  const templateSession = mockObserverSnapshot.sessions[0];
  const templateRow = mockObserverSnapshot.rows[0];
  const sessionCount = 20;
  const rows = Array.from({ length: sessionCount }, (_, index) => {
    const sequence = String(index + 1).padStart(2, "0");
    const sessionId =
      index === 0 ? "ses_popup_tmux" : index === 1 ? "ses_popup_native" : `ses_popup_${sequence}`;
    const worktreeId = `wt_popup_${sequence}`;
    const provider = index === 1 ? "native" : "tmux";
    const title =
      index === 0
        ? "01 Private tmux destination"
        : index === 1
          ? "02 Native Station session"
          : `${sequence} Scroll fixture session`;
    const terminal = {
      ...templateSession.terminal,
      provider,
      focusable: index !== 1,
      reason:
        index === 1
          ? "Station-hosted terminals are not externally focusable."
          : "Private tmux target is focusable from the popup client.",
    };
    const worktree = {
      state: "exists" as const,
      source: "worktrunk" as const,
      dirty: false,
      ahead: 0,
      behind: 0,
      ...(index === 0
        ? {
            pr: {
              number: 169,
              state: "draft" as const,
              baseRef: "main",
              headRef: "popup-acceptance",
            },
          }
        : {}),
    };
    return {
      ...templateRow,
      id: worktreeId,
      projectId: "popup-real",
      projectLabel: "POPUP ACCEPTANCE",
      branch: `popup-${sequence}`,
      path: join(projectRoot, `popup-${sequence}`),
      worktree,
      terminal,
      agent: {
        ...templateRow.agent,
        state: "idle" as const,
        runId: `run_popup_${sequence}`,
        sessionId,
        reason: "Deterministic popup acceptance session is idle.",
      },
      display: {
        statusLabel: "idle" as const,
        sortPriority: 40,
        alert: false,
        reason: "Deterministic popup acceptance session is idle.",
      },
      __session: {
        ...templateSession,
        id: sessionId,
        projectId: "popup-real",
        worktreeId,
        harness: {
          ...templateSession.harness,
          runId: `run_popup_${sequence}`,
        },
        terminal,
        status: {
          value: "idle" as const,
          confidence: "high" as const,
          reason: "Deterministic popup acceptance session is idle.",
          source: "harness_event" as const,
          updatedAt: "2026-06-11T12:00:00.000Z",
        },
        title,
        tags: ["popup-acceptance", provider],
      },
    };
  });
  const sessions = rows.map((row) => row.__session);
  const snapshotRows = rows.map(({ __session: _session, ...row }) => row);
  return StationSnapshotSchema.parse({
    ...mockObserverSnapshot,
    generatedAt: "2026-06-11T12:00:00.000Z",
    observer: {
      pid: 4242,
      startedAt: "2026-06-11T11:55:00.000Z",
      version: "0.0.0-popup-acceptance",
      healthy: true,
    },
    providerHealth: {
      tmux: mockObserverSnapshot.providerHealth.tmux,
      native: {
        providerId: "native",
        providerType: "terminal",
        status: "healthy",
        lastCheckedAt: "2026-06-11T12:00:00.000Z",
      },
      codex: mockObserverSnapshot.providerHealth.codex,
    },
    projects: [
      {
        ...mockObserverSnapshot.projects[0],
        id: "popup-real",
        label: "POPUP ACCEPTANCE",
        root: projectRoot,
        counts: {
          sessions: sessionCount,
          worktrees: sessionCount,
          agents: sessionCount,
          working: 0,
          idle: sessionCount,
          attention: 0,
          unknown: 0,
        },
      },
    ],
    rows: snapshotRows,
    sessions,
    counts: {
      projects: 1,
      sessions: sessionCount,
      worktrees: sessionCount,
      agents: sessionCount,
      working: 0,
      idle: sessionCount,
      attention: 0,
      unknown: 0,
    },
    alerts: [],
  });
}

function deterministicPopupObserver(snapshot: StationSnapshot): ObserverApi {
  return snapshotObserver(snapshot, async () => undefined);
}

function focusOutcomeObserver(input: {
  focusCommands: StationCommand[];
  snapshot: StationSnapshot;
  targetId: TerminalTargetId;
  tmuxCommand: string;
}): ObserverApi {
  const provider = new TmuxProvider({ command: input.tmuxCommand });
  return snapshotObserver(input.snapshot, async (command) => {
    if (command.type !== "terminal.focus") {
      return;
    }
    input.focusCommands.push(command);
    if (command.payload.sessionId !== "ses_popup_tmux") {
      throw new Error(`unexpected focus command for ${command.payload.sessionId ?? "<missing>"}`);
    }
    await provider.focusTarget(input.targetId, {
      ...(command.payload.origin === undefined ? {} : { origin: command.payload.origin }),
    });
  });
}

function snapshotObserver(
  snapshot: StationSnapshot,
  onDispatch: (command: StationCommand) => Promise<void>,
): ObserverApi {
  const records = new Map<CommandId, CommandRecord>();
  let commandCounter = 0;
  return {
    health: async () => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      status: "healthy",
      pid: process.pid,
      startedAt: "2026-06-11T11:55:00.000Z",
      version: stationObserverBuildVersion(),
    }),
    stop: async () => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      stopped: true,
      at: "2026-06-11T12:00:00.000Z",
    }),
    getSnapshot: async () => snapshot,
    subscribe: () => neverStationEvents(),
    dispatch: async (command) => {
      await onDispatch(command);
      commandCounter += 1;
      const commandId = `cmd_popup_acceptance_${commandCounter}` as CommandId;
      const now = "2026-06-11T12:00:00.000Z";
      records.set(commandId, {
        id: commandId,
        type: command.type,
        command,
        status: "succeeded",
        createdAt: now,
        startedAt: now,
        finishedAt: now,
      });
      return { commandId, accepted: true, status: "accepted" };
    },
    getCommand: async (commandId) => records.get(commandId),
    reconcile: async (reason = "manual") => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      reason,
      reconciledAt: "2026-06-11T12:00:00.000Z",
      snapshot,
    }),
    ingestProviderHookEvent: async () => unsupportedObserverCall("ingestProviderHookEvent"),
    reportHarnessEvent: async () => unsupportedObserverCall("reportHarnessEvent"),
    prepareExternalLaunch: async () => unsupportedObserverCall("prepareExternalLaunch"),
    reportExternalExit: async () => unsupportedObserverCall("reportExternalExit"),
    runDoctor: async () => unsupportedObserverCall("runDoctor"),
    collectDiagnostics: async () => unsupportedObserverCall("collectDiagnostics"),
  };
}

function popupFocusObserver(focusCommands: StationCommand[]): ObserverApi {
  const records = new Map<CommandId, CommandRecord>();
  let commandCounter = 0;
  return {
    health: async () => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      status: "healthy",
      pid: process.pid,
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      version: stationObserverBuildVersion(),
    }),
    stop: async () => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      stopped: true,
      at: new Date().toISOString(),
    }),
    getSnapshot: async () => mockObserverSnapshot,
    subscribe: () => neverStationEvents(),
    dispatch: async (command) => {
      commandCounter += 1;
      const commandId = `cmd_popup_real_${commandCounter}` as CommandId;
      const failed = commandCounter === 1;
      const now = new Date().toISOString();
      const record: CommandRecord = {
        id: commandId,
        type: command.type,
        command,
        status: failed ? "failed" : "succeeded",
        createdAt: now,
        startedAt: now,
        finishedAt: now,
      };
      if (failed) {
        record.error = {
          tag: "TerminalProviderError",
          code: "PRIVATE_POPUP_FOCUS_FAILED",
          message: "Private popup focus failed.",
        };
      }
      records.set(commandId, record);
      if (command.type === "terminal.focus") {
        focusCommands.push(command);
      }
      return { commandId, accepted: true, status: "accepted" };
    },
    getCommand: async (commandId) => records.get(commandId),
    reconcile: async (reason = "manual") => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      reason,
      reconciledAt: new Date().toISOString(),
      snapshot: mockObserverSnapshot,
    }),
    ingestProviderHookEvent: async () => unsupportedObserverCall("ingestProviderHookEvent"),
    reportHarnessEvent: async () => unsupportedObserverCall("reportHarnessEvent"),
    prepareExternalLaunch: async () => unsupportedObserverCall("prepareExternalLaunch"),
    reportExternalExit: async () => unsupportedObserverCall("reportExternalExit"),
    runDoctor: async () => unsupportedObserverCall("runDoctor"),
    collectDiagnostics: async () => unsupportedObserverCall("collectDiagnostics"),
  };
}

async function* neverStationEvents(): AsyncIterable<StationEvent> {
  await new Promise<never>(() => {});
}

function unsupportedObserverCall(operation: string): never {
  throw new Error(`Unexpected private popup Observer call: ${operation}`);
}

function focusOrigin(command: StationCommand | undefined): unknown {
  if (command?.type !== "terminal.focus") {
    throw new Error("Expected a terminal.focus command.");
  }
  return command.payload.origin;
}

async function cleanupMarkerFixture(fixture: MarkerFixture): Promise<void> {
  const failures: Error[] = [];
  await cleanupStep(failures, "detach marker PTY client", async () => fixture.ptyClient?.close());
  await cleanupStep(failures, "kill marker tmux server", async () => {
    await tmuxExec(fixture.wrapper, ["kill-server"]).catch(async (error) => {
      if (await privateTmuxServerExists(fixture.wrapper)) {
        throw error;
      }
    });
  });
  await cleanupStep(failures, "prove marker tmux server absent", async () => {
    if (await privateTmuxServerExists(fixture.wrapper)) {
      throw new Error("marker fixture tmux server still exists");
    }
    await assertWrapperAudit(fixture);
  });
  if (failures.length === 0) {
    await cleanupStep(failures, "remove marker fixture root", async () => {
      await rm(fixture.root, { recursive: true, force: true });
      await assertPathMissing(fixture.root, "marker fixture root still exists after removal");
    });
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `marker popup cleanup failed; retained ${fixture.root}`);
  }
}

async function cleanupStep(
  failures: Error[],
  label: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push(new Error(`${label}: ${errorMessage(error)}`, { cause: error }));
  }
}

async function recordObserverPidIfPresent(fixture: DashboardFixture): Promise<void> {
  const serialized = await readFile(`${fixture.observerSocketPath}.pid`, "utf8").catch(
    () => undefined,
  );
  if (serialized === undefined) {
    return;
  }
  const identity = parseJsonFixture(
    serialized,
    ObserverProcessIdentitySchema,
    "observer process identity",
  );
  if (identity.socketPath === fixture.observerSocketPath) {
    fixture.observerPids.add(identity.pid);
  }
}

async function privateTmuxServerExists(wrapper: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await tmuxExec(wrapper, ["list-sessions"], env);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      return true;
    }
    await delay(100);
  }
  return !processExists(pid);
}

async function terminateRecordedPid(pid: number): Promise<void> {
  if (!processExists(pid)) {
    return;
  }
  process.kill(pid, "SIGTERM");
  if (await waitForPidExit(pid, 2_000)) {
    return;
  }
  process.kill(pid, "SIGKILL");
  if (!(await waitForPidExit(pid, 2_000))) {
    throw new Error(`fixture process ${pid} survived SIGKILL`);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function assertPathMissing(path: string, message: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(message);
}

async function makeCheckoutTempRoot(): Promise<string> {
  const checkout = basename(checkoutRoot)
    .replaceAll(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 24);
  return mkdtemp(join("/tmp", `stn-${checkout}-`));
}

async function waitForTmuxSession(tmux: string, sessionName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await tmuxExec(tmux, ["has-session", "-t", sessionName]);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`tmux session ${sessionName} did not appear.`);
}

async function waitForFileText(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text === expected) {
      return;
    }
    await delay(100);
  }
  throw new Error(`File ${path} did not contain expected text.`);
}

async function panePid(tmux: string, sessionName: string): Promise<string> {
  return tmuxExec(tmux, ["display-message", "-p", "-t", sessionName, "#{pane_pid}"]).then((text) =>
    text.trim(),
  );
}

async function setGlobalOption(tmux: string, name: string, value: string): Promise<void> {
  await tmuxExec(tmux, ["set-option", "-gq", name, value]);
}

async function tmuxExec(tmux: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const output = await execFileAsync(tmux, args, {
    ...(env === undefined ? {} : { env }),
    timeout: 10_000,
  });
  return output.stdout;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function persistentMarkerCommand(markerPath: string): string {
  return `sh -c ${shellQuote(`printf 'start\\n' >> ${shellQuote(markerPath)}; while :; do sleep 1; done`)}`;
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} was not a positive integer: ${value ?? "<missing>"}`);
  }
  return parsed;
}

function normalizeTty(tty: string): string {
  const trimmed = tty.trim();
  if (trimmed.startsWith("/dev/") || trimmed === "?" || trimmed === "??") {
    return trimmed;
  }
  return `/dev/${trimmed}`;
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function trackedOutput(child: TrackedChild): string {
  const stdout = child.stdout.text();
  const stderr = child.stderr.text();
  return `\nstdout tail:\n${stdout}\nstderr tail:\n${stderr}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
