import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderProjectConfig, StationCommand } from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import { createErrorEnvelope, toSafeError } from "../../src/diagnostics/errors";
import { createSqliteObserverPersistence } from "../../src/persistence";
import { openObserverSqlite } from "../../src/sqlite";

const now = "2026-05-20T12:00:00.000Z";
const later = "2026-05-20T12:01:00.000Z";
const earlier = "2026-05-20T11:59:00.000Z";

const command: StationCommand = {
  type: "observer.reconcile",
  payload: {
    reason: "persistence-test",
  },
};

const project: ProviderProjectConfig = {
  id: "web",
  label: "web",
  root: "/tmp/station/web",
  defaults: {
    harness: "fake-harness",
    terminal: "fake-terminal",
    layout: "agent-shell",
  },
  worktrunk: {
    enabled: true,
  },
};

function ids() {
  let event = 0;
  let observation = 0;
  return {
    eventId: () => {
      event += 1;
      return `evt_${event}`;
    },
    observationId: () => {
      observation += 1;
      return `obs_${observation}`;
    },
  };
}

async function tempDbPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "station-observer-db-")), "observer.sqlite");
}

describe("observer persistence", () => {
  it("stores command lifecycle, event history, and SafeError separately from envelopes", async () => {
    const dbPath = await tempDbPath();
    const sqlite = openObserverSqlite({ path: dbPath, clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids(),
    });
    const internalError = new Error("internal sqlite detail");
    const safeError = toSafeError(internalError, {
      tag: "PersistenceError",
      code: "PERSISTENCE_WRITE_FAILED",
      message: "Observer persistence write failed.",
    });
    const envelope = createErrorEnvelope({
      id: "err_1",
      error: internalError,
      fallback: {
        tag: "PersistenceError",
        code: "PERSISTENCE_WRITE_FAILED",
        message: "Observer persistence write failed.",
      },
      commandId: "cmd_1",
      createdAt: now,
    });

    await persistence.recordCommandAccepted({
      commandId: "cmd_1",
      command,
      createdAt: now,
      traceId: "trc_persist",
      spanId: "spn_persist",
    });
    await persistence.markCommandStarted("cmd_1", now);
    await persistence.markCommandFailed({
      commandId: "cmd_1",
      safeError,
      envelope,
      finishedAt: later,
    });
    await persistence.recordEvent(
      {
        type: "command.failed",
        commandId: "cmd_1",
        error: safeError,
        traceId: "trc_persist",
        spanId: "spn_persist",
      },
      { commandId: "cmd_1", traceId: "trc_persist", spanId: "spn_persist", createdAt: later },
    );
    sqlite.close();

    const reopened = openObserverSqlite({ path: dbPath, clock: { now: () => new Date(later) } });
    const reloaded = createSqliteObserverPersistence({
      sqlite: reopened,
      clock: { now: () => new Date(later) },
      idFactory: ids(),
    });

    expect(await reloaded.listCommands()).toEqual([
      expect.objectContaining({
        id: "cmd_1",
        status: "failed",
        error: safeError,
        traceId: "trc_persist",
        spanId: "spn_persist",
      }),
    ]);
    expect(JSON.stringify((await reloaded.listCommands())[0]?.error)).not.toContain("internal");
    expect(await reloaded.listCommandErrors("cmd_1")).toEqual([
      expect.objectContaining({
        commandId: "cmd_1",
        envelope: expect.objectContaining({
          id: "err_1",
          stack: expect.stringContaining("internal sqlite detail"),
        }),
      }),
    ]);
    expect(await reloaded.listEvents({ commandId: "cmd_1" })).toEqual([
      expect.objectContaining({
        type: "command.failed",
        commandId: "cmd_1",
        traceId: "trc_persist",
        spanId: "spn_persist",
      }),
    ]);
    reopened.close();
  });

  it("upserts session recovery handles by provider-native target without provider payloads", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids(),
    });

    const first = await persistence.upsertSessionRecoveryHandle({
      id: "report_1",
      provider: "codex",
      projectId: "web",
      worktreeId: "wt_web_recover",
      sessionId: "ses_web_recover",
      target: { kind: "native-session", id: "codex_session_123" },
      cwd: "/tmp/station/web/recover",
      terminalTargetId: "tmux:station:@1:%2",
      harnessRunId: "codex:run_1",
      observedAt: now,
      lastSeenAt: now,
    });
    const second = await persistence.upsertSessionRecoveryHandle({
      id: "report_2",
      provider: "codex",
      projectId: "web",
      worktreeId: "wt_web_recover",
      target: { kind: "native-session", id: "codex_session_123" },
      observedAt: earlier,
      lastSeenAt: later,
    });

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      provider: "codex",
      projectId: "web",
      worktreeId: "wt_web_recover",
      sessionId: "ses_web_recover",
      target: { kind: "native-session", id: "codex_session_123" },
      cwd: "/tmp/station/web/recover",
      terminalTargetId: "tmux:station:@1:%2",
      harnessRunId: "codex:run_1",
      observedAt: earlier,
      lastSeenAt: later,
    });
    expect(await persistence.getSessionRecoveryHandle(first.id)).toEqual(second);
    expect(
      await persistence.listSessionRecoveryHandles({
        projectId: "web",
        worktreeId: "wt_web_recover",
      }),
    ).toEqual([second]);
    expect(JSON.stringify(second)).not.toContain("providerData");
    sqlite.close();
  });

  it("stores only the newest unacknowledged turn readiness per session", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids(),
    });

    const first = await persistence.upsertSessionTurnReadiness({
      sessionId: "ses_web_ready",
      projectId: "web",
      worktreeId: "wt_web_ready",
      token: "report_first",
      completedAt: now,
    });
    expect(first).toMatchObject({
      sessionId: "ses_web_ready",
      token: "report_first",
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await persistence.upsertSessionTurnReadiness({
      sessionId: "ses_web_ready",
      projectId: "web",
      worktreeId: "wt_web_ready",
      token: "report_older",
      completedAt: earlier,
      updatedAt: later,
    });
    expect(await persistence.listSessionTurnReadiness()).toEqual([
      expect.objectContaining({
        sessionId: "ses_web_ready",
        token: "report_first",
        completedAt: now,
        updatedAt: now,
      }),
    ]);

    await persistence.upsertSessionTurnReadiness({
      sessionId: "ses_web_ready",
      projectId: "web",
      worktreeId: "wt_web_ready",
      token: "report_newer",
      completedAt: later,
      updatedAt: later,
    });
    expect(await persistence.listSessionTurnReadiness()).toEqual([
      expect.objectContaining({
        sessionId: "ses_web_ready",
        token: "report_newer",
        completedAt: later,
        updatedAt: later,
      }),
    ]);

    await expect(
      persistence.deleteSessionTurnReadiness({
        sessionId: "ses_web_ready",
        token: "report_first",
      }),
    ).resolves.toBe(0);
    expect(await persistence.listSessionTurnReadiness()).toEqual([
      expect.objectContaining({ token: "report_newer" }),
    ]);

    await expect(
      persistence.deleteSessionTurnReadiness({
        sessionId: "ses_web_ready",
        token: "report_newer",
      }),
    ).resolves.toBe(1);
    await expect(persistence.listSessionTurnReadiness()).resolves.toEqual([]);
    sqlite.close();
  });

  it("skips retired command rows without requiring a migration", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids(),
    });
    const insertCommand = sqlite.database.prepare(`
      INSERT INTO commands (id, type, payload_json, status, created_at, trace_id, span_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insertCommand.run(
      "cmd_retired_send_prompt",
      "session.sendPrompt",
      JSON.stringify({
        type: "session.sendPrompt",
        payload: {
          sessionId: "ses_web_main",
          prompt: "Summarize current status.",
          delivery: "harness-native",
        },
      }),
      "succeeded",
      now,
      null,
      null,
    );
    insertCommand.run(
      "cmd_retired_hooks_install",
      "hooks.install",
      JSON.stringify({
        type: "hooks.install",
        payload: {
          provider: "worktrunk",
        },
      }),
      "succeeded",
      now,
      null,
      null,
    );
    await persistence.recordCommandAccepted({
      commandId: "cmd_current",
      command,
      createdAt: later,
    });

    expect((await persistence.listCommands()).map((item) => item.id)).toEqual(["cmd_current"]);
    sqlite.close();
  });

  it("skips retired command events in historical diagnostic reads", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids(),
    });
    const insertEvent = sqlite.database.prepare(`
      INSERT INTO events (id, type, source, command_id, trace_id, span_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertEvent.run(
      "evt_retired_send_prompt",
      "command.accepted",
      "observer",
      "cmd_retired_send_prompt",
      null,
      null,
      JSON.stringify({
        type: "command.accepted",
        commandId: "cmd_retired_send_prompt",
        command: {
          type: "session.sendPrompt",
          payload: {
            sessionId: "ses_web_main",
            prompt: "Summarize current status.",
          },
        },
      }),
      now,
    );
    insertEvent.run(
      "evt_retired_hooks_install",
      "command.accepted",
      "observer",
      "cmd_retired_hooks_install",
      null,
      null,
      JSON.stringify({
        type: "command.accepted",
        commandId: "cmd_retired_hooks_install",
        command: {
          type: "hooks.install",
          payload: {
            provider: "worktrunk",
          },
        },
      }),
      now,
    );
    await persistence.recordEvent(
      {
        type: "observer.reconciled",
        at: later,
        changed: 0,
      },
      { createdAt: later },
    );

    expect((await persistence.listEvents()).map((event) => event.id)).toEqual(["evt_1"]);
    sqlite.close();
  });

  it("drops retired provider hook event rows rather than upgrading them", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids(),
    });
    const insertEvent = sqlite.database.prepare(`
      INSERT INTO events (id, type, source, command_id, trace_id, span_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertEvent.run(
      "evt_retired_ingested",
      "hook.ingested",
      "hook",
      null,
      null,
      null,
      JSON.stringify({
        type: "hook.ingested",
        at: now,
        hookId: "hook_retired",
        provider: "worktrunk",
        event: "PostToolUse",
      }),
      now,
    );
    await persistence.recordEvent(
      {
        type: "observer.reconciled",
        at: later,
        changed: 0,
      },
      { createdAt: later },
    );

    const events = await persistence.listEvents();
    expect(events.map((event) => event.id)).toEqual(["evt_1"]);
    expect(await persistence.listEvents({ type: "providerHook.ingested" })).toEqual([]);
    sqlite.close();
  });

  it("expires and prunes provider observations", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids(),
    });
    const activeWorktree = createFakeWorktree({ id: "wt_active", projectId: "web", now });
    const expiredWorktree = createFakeWorktree({ id: "wt_expired", projectId: "web", now });
    const nullExpiryWorktree = createFakeWorktree({ id: "wt_null_expiry", projectId: "web", now });

    await persistence.recordProviderObservation({
      provider: "fake-worktree",
      providerType: "worktree",
      entityKind: "worktree",
      entityKey: activeWorktree.id,
      payload: activeWorktree,
      observedAt: now,
      expiresAt: later,
    });
    await persistence.recordProviderObservation({
      provider: "fake-worktree",
      providerType: "worktree",
      entityKind: "worktree",
      entityKey: expiredWorktree.id,
      payload: expiredWorktree,
      observedAt: now,
      expiresAt: earlier,
    });
    // No expiresAt -> NULL expiry row; pruneExpiredProviderObservations never removes these.
    await persistence.recordProviderObservation({
      provider: "fake-worktree",
      providerType: "worktree",
      entityKind: "worktree",
      entityKey: nullExpiryWorktree.id,
      payload: nullExpiryWorktree,
      observedAt: earlier,
    });

    expect(
      (await persistence.listProviderObservations({ now })).map((item) => item.entityKey),
    ).toEqual(["wt_null_expiry", "wt_active"]);
    expect(
      (
        await persistence.listProviderObservations({
          entityKind: "worktree",
          now,
        })
      ).map((item) => item.entityKey),
    ).toEqual(["wt_null_expiry", "wt_active"]);
    expect(
      await persistence.listProviderObservations({
        entityKind: "harness_event",
        now,
      }),
    ).toEqual([]);
    expect(await persistence.listProviderObservations({ includeExpired: true, now })).toHaveLength(
      3,
    );
    expect(await persistence.pruneExpiredProviderObservations(now)).toBe(1);
    expect(await persistence.listProviderObservations({ includeExpired: true, now })).toHaveLength(
      2,
    );
    sqlite.close();
  });

  it("can return only the latest provider observation per entity", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids(),
    });
    const first = createFakeWorktree({ id: "wt_active", projectId: "web", now: earlier });
    const second = createFakeWorktree({ id: "wt_active", projectId: "web", now });
    const other = createFakeWorktree({ id: "wt_other", projectId: "web", now: later });
    const sameTimestampFirst = createFakeWorktree({
      id: "wt_tie",
      projectId: "web",
      now: later,
    });
    const sameTimestampSecond = {
      ...sameTimestampFirst,
      branch: "tie-latest",
    };

    for (const worktree of [first, second, other, sameTimestampFirst, sameTimestampSecond]) {
      await persistence.recordProviderObservation({
        provider: "fake-worktree",
        providerType: "worktree",
        entityKind: "worktree",
        entityKey: worktree.id,
        payload: worktree,
        observedAt: worktree.observedAt,
        expiresAt: "2026-05-21T12:00:00.000Z",
      });
    }

    expect(
      (
        await persistence.listProviderObservations({
          entityKind: "worktree",
          latestOnly: true,
          now,
        })
      ).map((item) => `${item.entityKey}:${item.observedAt}`),
    ).toEqual([
      "wt_active:2026-05-20T12:00:00.000Z",
      "wt_other:2026-05-20T12:01:00.000Z",
      "wt_tie:2026-05-20T12:01:00.000Z",
    ]);
    expect(
      (
        await persistence.listProviderObservations({
          entityKind: "worktree",
          latestOnly: true,
          now,
        })
      ).find((item) => item.entityKey === "wt_tie")?.payload,
    ).toMatchObject({ branch: "tie-latest" });
    sqlite.close();
  });

  it("seeds session titles from branches and preserves custom titles across reconcile persistence", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids(),
    });
    const initialWorktree = createFakeWorktree({
      id: "wt_web_feature",
      projectId: "web",
      branch: "feature/auth",
      now,
    });
    const terminalTarget = createFakeTerminalTarget({
      id: "term_web_feature",
      projectId: "web",
      worktreeId: "wt_web_feature",
      sessionId: "ses_web_feature",
      now,
    });
    const harnessRun = createFakeHarnessRun({
      id: "run_web_feature",
      projectId: "web",
      worktreeId: "wt_web_feature",
      sessionId: "ses_web_feature",
      now,
    });

    await persistence.persistReconcileResult({
      projects: [project],
      worktrees: [initialWorktree],
      terminalTargets: [terminalTarget],
      harnessRuns: [harnessRun],
      observedAt: now,
    });

    expect(await persistence.listSessions()).toEqual([
      expect.objectContaining({
        id: "ses_web_feature",
        title: "feature/auth",
      }),
    ]);

    await persistence.renameSession({
      sessionId: "ses_web_feature",
      title: "Readable feature task",
    });
    await persistence.persistReconcileResult({
      projects: [project],
      worktrees: [
        {
          ...initialWorktree,
          branch: "feature/provider-renamed",
          observedAt: later,
        },
      ],
      terminalTargets: [{ ...terminalTarget, observedAt: later }],
      harnessRuns: [{ ...harnessRun, observedAt: later }],
      observedAt: later,
    });

    expect(await persistence.listSessions()).toEqual([
      expect.objectContaining({
        id: "ses_web_feature",
        title: "Readable feature task",
      }),
    ]);
    sqlite.close();
  });

  it("seeds session titles once before launch and preserves them across reconcile and rename", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids(),
    });
    const worktree = createFakeWorktree({
      id: "wt_web_seeded",
      projectId: "web",
      branch: "agent-created-branch",
      now: later,
    });
    const terminalTarget = createFakeTerminalTarget({
      id: "term_web_seeded",
      projectId: "web",
      worktreeId: "wt_web_seeded",
      sessionId: "ses_web_seeded",
      now: later,
    });
    const harnessRun = createFakeHarnessRun({
      id: "run_web_seeded",
      projectId: "web",
      worktreeId: "wt_web_seeded",
      sessionId: "ses_web_seeded",
      now: later,
    });

    await persistence.seedSessionTitle({
      sessionId: "ses_web_seeded",
      projectId: "web",
      worktreeId: "wt_web_seeded",
      title: "original-session-title",
      createdAt: now,
      lastSeenAt: now,
    });
    await persistence.seedSessionTitle({
      sessionId: "ses_web_seeded",
      projectId: "web",
      worktreeId: "wt_web_seeded",
      title: "agent-created-branch",
      createdAt: later,
      lastSeenAt: later,
    });

    expect(await persistence.listSessions()).toEqual([
      expect.objectContaining({
        id: "ses_web_seeded",
        title: "original-session-title",
        createdAt: now,
        lastSeenAt: later,
      }),
    ]);

    await persistence.persistReconcileResult({
      projects: [project],
      worktrees: [worktree],
      terminalTargets: [terminalTarget],
      harnessRuns: [harnessRun],
      observedAt: later,
    });

    expect(await persistence.listSessions()).toEqual([
      expect.objectContaining({
        id: "ses_web_seeded",
        title: "original-session-title",
      }),
    ]);

    await persistence.renameSession({
      sessionId: "ses_web_seeded",
      title: "user renamed session",
    });
    await persistence.seedSessionTitle({
      sessionId: "ses_web_seeded",
      projectId: "web",
      worktreeId: "wt_web_seeded",
      title: "ignored later seed",
      createdAt: later,
      lastSeenAt: later,
    });

    expect(await persistence.listSessions()).toEqual([
      expect.objectContaining({
        id: "ses_web_seeded",
        title: "user renamed session",
      }),
    ]);
    sqlite.close();
  });

  it("deletes a pre-launch title seed when launch cleanup requests it", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids(),
    });

    await persistence.seedSessionTitle({
      sessionId: "ses_cleanup_seed",
      projectId: "web",
      worktreeId: "wt_web_cleanup_seed",
      title: "cleanup-seed",
      createdAt: now,
      lastSeenAt: now,
    });
    await expect(persistence.deleteSessionTitleSeed("ses_cleanup_seed")).resolves.toBe(1);
    await expect(persistence.listSessions()).resolves.toEqual([]);
    sqlite.close();
  });

  it("persists correlation records across observer restart", async () => {
    const dbPath = await tempDbPath();
    const sqlite = openObserverSqlite({ path: dbPath, clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids(),
    });
    const worktree = createFakeWorktree({ id: "wt_web_main", projectId: "web", now });
    const terminal = createFakeTerminalTarget({
      id: "term_web_main",
      projectId: "web",
      worktreeId: "wt_web_main",
      sessionId: "ses_web_main",
      harnessRunId: "run_web_main",
      now,
    });
    const run = createFakeHarnessRun({
      id: "run_web_main",
      projectId: "web",
      worktreeId: "wt_web_main",
      sessionId: "ses_web_main",
      now,
    });

    await persistence.persistReconcileResult({
      projects: [project],
      worktrees: [worktree],
      terminalTargets: [terminal],
      harnessRuns: [run],
      observedAt: now,
    });
    expect(
      (
        await persistence.listCurrentProviderEntityObservations({
          entityKind: ["worktree", "terminal_target"],
          now,
        })
      ).map((item) => `${item.entityKind}:${item.entityKey}`),
    ).toEqual(["worktree:wt_web_main", "terminal_target:term_web_main"]);
    sqlite.close();

    const reopened = openObserverSqlite({ path: dbPath, clock: { now: () => new Date(later) } });
    const reloaded = createSqliteObserverPersistence({ sqlite: reopened, idFactory: ids() });

    expect(
      (
        await reloaded.listCurrentProviderEntityObservations({
          entityKind: ["worktree", "terminal_target"],
          now: later,
        })
      ).map((item) => `${item.entityKind}:${item.entityKey}`),
    ).toEqual(["worktree:wt_web_main", "terminal_target:term_web_main"]);
    expect(await reloaded.listSessions()).toEqual([
      expect.objectContaining({
        id: "ses_web_main",
        projectId: "web",
        worktreeId: "wt_web_main",
        harness: "fake-harness",
        terminalProvider: "fake-terminal",
      }),
    ]);
    await expect(
      reloaded.findRememberedHarnessProviderForWorktree({
        projectId: "web",
        worktreeId: "wt_web_main",
        worktreePath: worktree.path,
      }),
    ).resolves.toBe("fake-harness");
    reopened.close();
  });

  it("creates and manages current worktree metadata rows by kind", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids(),
    });

    expect(
      sqlite.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("worktree_metadata_current"),
    ).toMatchObject({ name: "worktree_metadata_current" });

    await persistence.upsertWorktreeMetadataCurrent({
      worktreeId: "wt_web_main",
      kind: "change_summary",
      cacheKey: "first",
      expiresAt: later,
      payload: {
        kind: "branch_diff",
        additions: 1,
        deletions: 2,
        filesChanged: 1,
        binaryFiles: 0,
        baseRef: "main",
        baseSha: "1111111111111111111111111111111111111111",
        mergeBaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        headRef: "feature",
        headSha: "2222222222222222222222222222222222222222",
        source: "local_git",
        checkedAt: now,
      },
    });
    await persistence.upsertWorktreeMetadataCurrent({
      worktreeId: "wt_web_main",
      kind: "change_summary",
      cacheKey: "second",
      expiresAt: later,
      payload: {
        kind: "branch_diff",
        additions: 3,
        deletions: 4,
        filesChanged: 2,
        binaryFiles: 1,
        baseRef: "main",
        baseSha: "1111111111111111111111111111111111111111",
        mergeBaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        headRef: "feature",
        headSha: "3333333333333333333333333333333333333333",
        source: "local_git",
        checkedAt: now,
      },
    });
    await persistence.upsertWorktreeMetadataCurrent({
      worktreeId: "wt_web_main",
      kind: "pull_request",
      expiresAt: later,
      payload: {
        number: 12,
        host: "github",
        baseRef: "main",
        headRef: "feature",
        checkedAt: now,
      },
    });
    await persistence.upsertWorktreeMetadataCurrent({
      worktreeId: "wt_web_main",
      kind: "checks",
      expiresAt: later,
      payload: {
        state: "running",
        total: 3,
        pending: 3,
        source: "github",
        checkedAt: now,
      },
    });
    await persistence.upsertWorktreeMetadataCurrent({
      worktreeId: "wt_web_expired",
      kind: "change_summary",
      expiresAt: earlier,
      payload: {
        kind: "branch_diff",
        additions: 9,
        deletions: 0,
        source: "local_git",
        checkedAt: earlier,
      },
    });

    expect(
      (await persistence.listWorktreeMetadataCurrent({ kind: "change_summary", now })).map(
        (row) =>
          `${row.worktreeId}:${row.cacheKey}:${row.payload.additions}:${row.payload.mergeBaseSha}`,
      ),
    ).toEqual(["wt_web_main:second:3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    expect(
      await persistence.listWorktreeMetadataCurrent({
        kind: ["change_summary", "pull_request", "checks"],
        includeExpired: true,
        now,
      }),
    ).toHaveLength(4);
    expect(await persistence.deleteWorktreeMetadataCurrent({ worktreeId: "wt_web_main" })).toBe(3);
    expect(await persistence.deleteWorktreeMetadataCurrent({ worktreeId: "wt_web_expired" })).toBe(
      1,
    );
    expect(await persistence.listWorktreeMetadataCurrent({ includeExpired: true, now })).toEqual(
      [],
    );
    sqlite.close();
  });

  it("marks existing current metadata stale with a SafeError", async () => {
    const safeError = toSafeError(undefined, {
      tag: "LocalGitMetadataError",
      code: "LOCAL_GIT_CHANGE_SUMMARY_FAILED",
      message: "Local git change summary refresh failed.",
    });
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids(),
    });
    const payload = {
      kind: "branch_diff" as const,
      additions: 1,
      deletions: 0,
      source: "local_git",
      checkedAt: now,
    };

    await persistence.upsertWorktreeMetadataCurrent({
      worktreeId: "wt_web_main",
      kind: "change_summary",
      cacheKey: "cache",
      expiresAt: later,
      payload,
    });
    await persistence.upsertWorktreeMetadataCurrent({
      worktreeId: "wt_web_main",
      kind: "change_summary",
      cacheKey: "cache",
      expiresAt: later,
      payload: {
        ...payload,
        stale: true,
      },
      stale: true,
      lastError: safeError,
    });

    await expect(
      persistence.listWorktreeMetadataCurrent({ kind: "change_summary", now }),
    ).resolves.toEqual([
      expect.objectContaining({
        worktreeId: "wt_web_main",
        stale: true,
        payload: expect.objectContaining({ stale: true }),
        lastError: safeError,
      }),
    ]);
    sqlite.close();
  });

  it("omits current metadata rows whose payload no longer parses", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids(),
    });
    sqlite.database
      .prepare(
        `
          INSERT INTO worktree_metadata_current
            (worktree_id, kind, payload_json, updated_at)
          VALUES (?, ?, ?, ?)
        `,
      )
      .run(
        "wt_web_invalid",
        "change_summary",
        JSON.stringify({ kind: "branch_diff", additions: -1 }),
        now,
      );

    await expect(
      persistence.listWorktreeMetadataCurrent({
        kind: "change_summary",
        includeExpired: true,
        now,
      }),
    ).resolves.toEqual([]);
    sqlite.close();
  });
});
