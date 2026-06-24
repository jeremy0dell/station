import {
  ClaudeHarnessProvider,
  claudeHookPayloadToHarnessEventReport,
  compactClaudeHookPayload,
} from "@station/claude";
import type { StationConfig } from "@station/config";
import type { ProviderProjectConfig, WorktreeObservation } from "@station/contracts";
import type { HostListEntry, StationHostClient } from "@station/host";
import {
  createStationHostController,
  StationTerminalProvider,
  stationTargetId,
} from "@station/terminal";
import {
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import { createObserverCore, ProviderRegistry } from "../../src/internal";
import { createTestObserver } from "../support/testObserver";

const now = "2026-06-11T12:00:00.000Z";
const clock = { now: () => new Date(now) };

const project: ProviderProjectConfig = {
  id: "web",
  label: "web",
  root: "/tmp/station/web",
  defaults: { harness: "claude", terminal: "fake-terminal", layout: "agent-shell" },
  worktrunk: { enabled: true },
};

const stationWorktree: WorktreeObservation = createFakeWorktree({
  id: "wt_web_station",
  projectId: "web",
  branch: "station",
  path: "/tmp/station/web/station",
  now,
});

const stationSecondWorktree: WorktreeObservation = createFakeWorktree({
  id: "wt_web_station_two",
  projectId: "web",
  branch: "station-two",
  path: "/tmp/station/web/station-two",
  now,
});

describe("observer reconcile with a station-hosted target", () => {
  it("derives a session from one station target and coexists with a tmux target", async () => {
    const station = new StationTerminalProvider({ clock });
    await station.openWorkspace({
      project,
      worktree: stationWorktree,
      harness: "claude",
      layout: "agent-shell",
      sessionId: "ses_station",
    });

    const core = createObserverCore({ config, providers: providers(station), clock });
    const snapshot = await core.reconcile("station-coexist");

    // Both terminal providers' targets survive a single reconcile.
    const sessionsById = new Map(snapshot.sessions.map((session) => [session.id, session]));
    expect([...sessionsById.keys()].sort()).toEqual(["ses_station", "ses_tmux"]);
    expect(sessionsById.get("ses_station")).toMatchObject({
      worktreeId: "wt_web_station",
      harness: { provider: "claude" },
    });
    expect(sessionsById.get("ses_tmux")).toMatchObject({
      worktreeId: "wt_web_task",
      harness: { provider: "claude" },
    });

    const stationRow = snapshot.rows.find((row) => row.id === "wt_web_station");
    expect(stationRow?.agent).toMatchObject({ harness: "claude", sessionId: "ses_station" });
    expect(stationRow?.terminal?.provider).toBe("native");
    // A Station-hosted agent is not focusable/closeable from the dashboard — the
    // provider reports canFocusTarget/canCloseTarget:false — so the dashboard
    // does not dispatch a focus/close the station provider can only reject.
    expect(stationRow?.terminal?.focusable).toBeUndefined();
    expect(stationRow?.terminal?.closeable).toBeUndefined();

    // Reporting exit drops only the station target; the tmux session survives.
    expect(station.markExited(stationTargetId("wt_web_station"))).toBe(true);
    const afterExit = await core.reconcile("station-exit");
    expect(afterExit.sessions.map((session) => session.id)).toEqual(["ses_tmux"]);
    expect(afterExit.rows.find((row) => row.id === "wt_web_station")?.agent).toBeUndefined();
  });

  it("resolves a racing double openWorkspace to one session carrying the second", async () => {
    // The accepted prepare TOCTOU: two distinct UIs both openWorkspace for
    // the same worktree before reconcile. The deterministic `station:<worktreeId>`
    // id makes the second upsert the first — never two targets/runs.
    const station = new StationTerminalProvider({ clock });
    await station.openWorkspace({
      project,
      worktree: stationWorktree,
      harness: "claude",
      layout: "agent-shell",
      sessionId: "ses_first",
    });
    await station.openWorkspace({
      project,
      worktree: stationWorktree,
      harness: "claude",
      layout: "agent-shell",
      sessionId: "ses_second",
    });
    expect(await station.listTargets()).toHaveLength(1);

    const core = createObserverCore({ config, providers: providers(station), clock });
    const snapshot = await core.reconcile("station-toctou");

    // Exactly one session/run for the worktree, carrying the second (winning) id.
    const stationSessions = snapshot.sessions.filter(
      (session) => session.worktreeId === "wt_web_station",
    );
    expect(stationSessions.map((session) => session.id)).toEqual(["ses_second"]);
    expect(snapshot.rows.find((row) => row.id === "wt_web_station")?.agent?.sessionId).toBe(
      "ses_second",
    );
  });

  it("re-derives the one station session from host.list after losing in-memory targets", async () => {
    // Observer-restart proxy: the provider's #targets are empty, but the host
    // still owns the PTY. listTargets must rebuild the single target from
    // host.list (cwd === harnessBinding.worktreePath) so reconcile derives exactly
    // one session — never a duplicate, never zero.
    const station = hostBackedStation(
      fakeHostClient({
        list: async () => [
          {
            ptyId: "pty-1",
            terminalTargetId: stationTargetId("wt_web_station"),
            worktreeId: "wt_web_station",
            projectId: "web",
            sessionId: "ses_station",
            worktreePath: "/tmp/station/web/station",
            harnessProvider: "claude",
            pid: 99,
            alive: true,
            cols: 80,
            rows: 24,
          },
        ],
      }),
    );

    const core = createObserverCore({ config, providers: providers(station), clock });
    const snapshot = await core.reconcile("station-restart");

    const stationSessions = snapshot.sessions.filter(
      (session) => session.worktreeId === "wt_web_station",
    );
    expect(stationSessions.map((session) => session.id)).toEqual(["ses_station"]);
    expect(snapshot.rows.find((row) => row.id === "wt_web_station")?.terminal?.provider).toBe(
      "native",
    );
    expect(snapshot.rows.find((row) => row.id === "wt_web_station")?.terminal?.focusable).toBe(
      true,
    );
  });

  it("keeps host-backed Station fallback targets live but not dashboard-focusable", async () => {
    const station = hostBackedStation(fakeHostClient({ list: async () => [] }));
    await station.openWorkspace({
      project,
      worktree: stationWorktree,
      harness: "claude",
      layout: "agent-shell",
      sessionId: "ses_station",
    });

    const core = createObserverCore({ config, providers: providers(station), clock });
    const snapshot = await core.reconcile("station-ui-fallback-unreachable-host");
    const stationRow = snapshot.rows.find((row) => row.id === "wt_web_station");

    expect(stationRow?.agent).toMatchObject({ harness: "claude", sessionId: "ses_station" });
    expect(stationRow?.terminal?.provider).toBe("native");
    expect(stationRow?.terminal?.focusable).toBeUndefined();
    expect(stationRow?.terminal?.closeable).toBeUndefined();
  });

  it("re-derives multiple station sessions from distinct host PTYs", async () => {
    const station = hostBackedStation(
      fakeHostClient({
        list: async () => [
          hostListEntry({
            ptyId: "pty-1",
            worktree: stationWorktree,
            sessionId: "ses_station",
            pid: 99,
          }),
          hostListEntry({
            ptyId: "pty-2",
            worktree: stationSecondWorktree,
            sessionId: "ses_station_two",
            pid: 100,
          }),
        ],
      }),
    );

    const core = createObserverCore({
      config,
      providers: providers(station, [stationSecondWorktree]),
      clock,
    });
    const snapshot = await core.reconcile("station-multiple-host-ptys");

    expect(snapshot.sessions.map((session) => session.id).sort()).toEqual([
      "ses_station",
      "ses_station_two",
      "ses_tmux",
    ]);
    expect(snapshot.rows.find((row) => row.id === "wt_web_station")?.agent).toMatchObject({
      harness: "claude",
      sessionId: "ses_station",
    });
    expect(snapshot.rows.find((row) => row.id === "wt_web_station_two")?.agent).toMatchObject({
      harness: "claude",
      sessionId: "ses_station_two",
    });
    expect(snapshot.rows.find((row) => row.id === "wt_web_station")?.terminal?.provider).toBe(
      "native",
    );
    expect(snapshot.rows.find((row) => row.id === "wt_web_station_two")?.terminal?.provider).toBe(
      "native",
    );
  });

  it("promotes a station session's row to working on a harness hook event", async () => {
    const station = new StationTerminalProvider({ clock });
    await station.openWorkspace({
      project,
      worktree: stationWorktree,
      harness: "claude",
      layout: "agent-shell",
      sessionId: "ses_station",
    });
    const registry = providers(station);
    const { sqlite, core, api } = createTestObserver({ config, providers: registry, clock });

    // Before any hook the station session exists only at discovery confidence.
    await core.reconcile("station-initial");
    expect(
      core.getSnapshot().rows.find((row) => row.id === "wt_web_station")?.agent?.state,
    ).not.toBe("working");

    // The load-bearing claim: a claude hook tagged with the station session/target
    // promotes the row to `working` — the same path the live agent's PTY drives.
    const receipt = await api.reportHarnessEvent(
      stationClaudeReport("report_station_working", "2026-06-11T12:00:01.000Z", {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "toolu_station_1",
      }),
    );
    expect(receipt).toMatchObject({ status: "accepted", scheduledReconcile: true });

    const snapshot = await core.reconcile("station-working");
    const row = snapshot.rows.find((candidate) => candidate.id === "wt_web_station");
    expect(row?.agent).toMatchObject({
      harness: "claude",
      state: "working",
      sessionId: "ses_station",
    });
    expect(row?.terminal?.provider).toBe("native");
    expect(snapshot.sessions.find((s) => s.id === "ses_station")?.status).toMatchObject({
      value: "working",
      source: "harness_event",
    });
    sqlite.close();
  });
});

function stationClaudeReport(
  reportId: string,
  observedAt: string,
  fields: Record<string, unknown>,
) {
  const compacted = compactClaudeHookPayload({
    session_id: "claude_station_native",
    transcript_path: "/home/user/.claude/projects/-tmp-station-web-station/sess.jsonl",
    cwd: "/tmp/station/web/station",
    permission_mode: "default",
    station_project_id: "web",
    station_worktree_id: "wt_web_station",
    station_session_id: "ses_station",
    station_terminal_target_id: stationTargetId("wt_web_station"),
    ...fields,
  });
  return claudeHookPayloadToHarnessEventReport({
    reportId,
    observedAt,
    payload: compacted.payload,
    diagnostics: {
      payloadBytes: compacted.originalByteCount,
      compactedBytes: compacted.compactedByteCount,
      compacted: compacted.compacted,
      omittedFieldNames: compacted.omittedFieldNames,
    },
  });
}

function fakeHostClient(over: Partial<StationHostClient> = {}): StationHostClient {
  return {
    health: async () => ({ ok: true, protocolVersion: 1 }),
    spawn: async () => ({ ptyId: "pty-1", pid: 99 }),
    write: async () => undefined,
    resize: async () => undefined,
    list: async () => [] as HostListEntry[],
    focus: async () => undefined,
    close: async () => ({ closed: true }),
    attach: async () => {
      throw new Error("unused");
    },
    dispose: () => undefined,
    ...over,
  };
}

function hostBackedStation(client: StationHostClient): StationTerminalProvider {
  const controller = createStationHostController(
    {
      socketPath: "/tmp/reconcile-station-host.sock",
      stateDir: "/tmp",
      hostEntry: "/tmp/hostMain.ts",
    },
    { clientFactory: () => client, spawnHost: () => ({ pid: 1, unref: () => undefined }) },
  );
  return new StationTerminalProvider({ clock, host: controller });
}

function providers(
  station: StationTerminalProvider,
  extraWorktrees: WorktreeObservation[] = [],
): ProviderRegistry {
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider({
      now,
      worktrees: [
        createFakeWorktree({
          id: "wt_web_task",
          projectId: "web",
          branch: "task",
          path: "/tmp/station/web/task",
          now,
        }),
        stationWorktree,
        ...extraWorktrees,
      ],
    }),
    terminal: new FakeTerminalProvider({
      now,
      targets: [
        createFakeTerminalTarget({
          id: "tmux:station:@1:%2",
          provider: "tmux",
          projectId: "web",
          worktreeId: "wt_web_task",
          sessionId: "ses_tmux",
          now,
          harnessBinding: {
            role: "main-agent",
            harnessProvider: "claude",
            currentCommand: "claude",
          },
          providerData: { sessionName: "station", windowId: "@1", paneId: "%2" },
        }),
      ],
    }),
    terminals: [station],
    harnesses: [
      new ClaudeHarnessProvider({
        now: () => new Date(now),
        runner: async (input) => ({
          command: input.command,
          args: input.args ?? [],
          stdout: "2.1.173 (Claude Code)\n",
          stderr: "",
          exitCode: 0,
        }),
      }),
    ],
  });
}

function hostListEntry(input: {
  ptyId: string;
  worktree: WorktreeObservation;
  sessionId: string;
  pid: number;
}): HostListEntry {
  return {
    kind: "agent",
    ptyId: input.ptyId,
    terminalTargetId: stationTargetId(input.worktree.id),
    worktreeId: input.worktree.id,
    projectId: input.worktree.projectId,
    sessionId: input.sessionId,
    worktreePath: input.worktree.path,
    harnessProvider: "claude",
    pid: input.pid,
    alive: true,
    cols: 80,
    rows: 24,
  };
}

const config: StationConfig = {
  schemaVersion: 1,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "claude",
    layout: "agent-shell",
  },
  projects: [
    {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: { harness: "claude", terminal: "fake-terminal", layout: "agent-shell" },
      worktrunk: { enabled: true },
    },
  ],
};
