import type { PtyHandoffEntry } from "@station/contracts";
import type { HostSpawnParams } from "@station/host";
import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedTerminal, type ScriptedTerminal } from "../../terminal/testing/scriptedTerminal.js";
import type { StationTerminalProcess } from "../../terminal/types.js";
import { waitFor } from "../../terminal/testing/waitFor.js";
import { writeScrollbackExport } from "../orphanBridges.js";
import { PtyHandoffRestorationError } from "../ptyHandoff.js";
import { createPtyTable, type PtyAdoptionTarget, type PtyAdoptedTerminal } from "../ptyTable.js";

const baseParams: HostSpawnParams = {
  kind: "agent",
  terminalTargetId: "native:wt-1",
  worktreeId: "wt-1",
  projectId: "proj-1",
  sessionId: "ses-1",
  worktreePath: "/repo/wt-1",
  harnessProvider: "claude",
  command: "claude",
  args: [],
  cwd: "/repo/wt-1",
  cols: 80,
  rows: 24,
};

function handoffEntry(ptyId: string, overrides: Partial<PtyHandoffEntry> = {}): PtyHandoffEntry {
  const sequence = Number.parseInt(ptyId.slice("pty-".length), 10);
  return {
    bridgeProtocolVersion: 2,
    bridgePid: 4_242 + sequence,
    controlSocket: `/state/run/pty-bridges/${ptyId}.sock`,
    command: "claude",
    cols: 80,
    rows: 24,
    ptyInstanceId: `instance-${ptyId}`,
    identity: {
      kind: "agent",
      terminalTargetId: "native:wt-1",
      worktreeId: "wt-1",
      projectId: "proj-1",
      sessionId: "ses-1",
      worktreePath: "/repo/wt-1",
      harnessProvider: "claude",
    },
    ...overrides,
  };
}

/** Scripted terminal plus the bridge pid the registry exports require. */
function bridgeScripted(): { scripted: ScriptedTerminal; terminal: StationTerminalProcess } {
  const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
  return { scripted, terminal: { ...scripted.terminal, bridgePid: 999 } };
}

describe("createPtyTable registry export", () => {
  it("exports live bridge-backed PTYs with a persisted scrollback ref", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-registry-"));
    const spawned: { scripted: ScriptedTerminal; terminal: StationTerminalProcess }[] = [];
    const table = createPtyTable({
      orphanBridges: { directory },
      createTerminal: () => {
        const created = bridgeScripted();
        spawned.push(created);
        return created.terminal;
      },
    });
    const { ptyId, ptyInstanceId } = table.spawn(baseParams);
    spawned[0]?.scripted.helpers.emitData("exported-output");

    expect(table.recoveryInventory()).toMatchObject([
      {
        ptyId,
        handoffSupport: { kind: "non-releasable", reason: "release-unsupported" },
      },
    ]);

    const manifest = await table.exportRegistry();
    const entry = manifest[ptyId];
    expect(entry).toBeDefined();
    expect(entry?.bridgePid).toEqual(999);
    expect(entry?.controlSocket).toEqual(join(directory, `${ptyId}.sock`));
    expect(entry?.identity.terminalTargetId).toEqual("native:wt-1");
    expect(entry?.ptyInstanceId).toEqual(ptyInstanceId);
    expect(entry?.ringComplete).toEqual(true);
    const scrollback = JSON.parse(await readFile(String(entry?.scrollbackRef), "utf8"));
    expect(scrollback.events.some((event: { type: string; data?: string }) =>
      event.type === "data" && event.data === "exported-output",
    )).toEqual(true);
    table.disposeAll();
  });

  it("skips terminals without a bridge transport instead of failing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-registry-"));
    const events: Array<{ event: string; attributes: Record<string, unknown> }> = [];
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const table = createPtyTable({
      orphanBridges: { directory },
      createTerminal: () => scripted.terminal,
      onEvent: (event, attributes) => {
        events.push({ event, attributes });
      },
    });
    table.spawn(baseParams);
    const manifest = await table.exportRegistry();
    expect(Object.keys(manifest)).toEqual([]);
    expect(
      events.some(({ event }) => event === "pty.handoff.export-skipped"),
    ).toEqual(true);
    table.disposeAll();
  });
});

describe("createPtyTable registry adoption", () => {
  function adopterPool<T extends StationTerminalProcess>(terminals: Map<string, T>) {
    const adoptedTargets: PtyAdoptionTarget[] = [];
    return {
      adoptedTargets,
      adoptTerminal: async (target: PtyAdoptionTarget): Promise<PtyAdoptedTerminal> => {
        adoptedTargets.push(target);
        const terminal = terminals.get(target.ptyId);
        if (terminal === undefined) {
          throw new Error(`no scripted terminal for ${target.ptyId}`);
        }
        return {
          ...terminal,
          releaseToOrphan: terminal.releaseToOrphan ?? (() => false),
        };
      },
    };
  }

  it("adopts manifest entries as live PTYs and forwards I/O", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const pool = adopterPool(new Map([["pty-3", scripted.terminal]]));
    const table = createPtyTable({ adoptTerminal: pool.adoptTerminal });

    const report = await table.adoptRegistry({ "pty-3": handoffEntry("pty-3") });
    expect(report).toEqual({ adopted: ["pty-3"], failed: [] });
    expect(table.list()[0]).toMatchObject({
      ptyId: "pty-3",
      ptyInstanceId: "instance-pty-3",
      alive: true,
      terminalTargetId: "native:wt-1",
      cols: 80,
      rows: 24,
    });
    expect(pool.adoptedTargets).toHaveLength(1);
    expect(pool.adoptedTargets[0]).toMatchObject({
      ptyId: "pty-3",
      ptyInstanceId: "instance-pty-3",
      bridgePid: 4_245,
    });

    const controller = await table.attach(table.list()[0]!, "att-registry", "controller");
    controller.write(controller.controlState.controlEpoch, "forwarded\n");
    expect(scripted.helpers.writes).toEqual(["forwarded\n"]);
    controller.resize(controller.controlState.controlEpoch, 101, 31);
    expect(scripted.helpers.resizes).toEqual([{ cols: 101, rows: 31 }]);

    // Adoption replays data into the ring exactly like spawn.
    scripted.helpers.emitData("adopted-output");
    expect(table.snapshot("pty-3").rawChunks.join("")).toContain("adopted-output");
    table.disposeAll();
  });

  it("fails closed on an invalid manifest", async () => {
    const table = createPtyTable({});
    await expect(table.adoptRegistry({ "pty-1": { bridgePid: -1 } })).rejects.toMatchObject({
      code: "HOST_HANDOFF_MANIFEST_INVALID",
    });
  });

  it("isolates per-entry adoption failures", async () => {
    const good = createScriptedTerminal({ cols: 80, rows: 24 });
    const pool = adopterPool(new Map([["pty-2", good.terminal]]));
    const table = createPtyTable({ adoptTerminal: pool.adoptTerminal });

    const report = await table.adoptRegistry({
      "pty-1": handoffEntry("pty-1"),
      "pty-2": handoffEntry("pty-2", {
        identity: { ...handoffEntry("pty-2").identity, terminalTargetId: "native:wt-2" },
      }),
    });
    expect(report.adopted).toEqual(["pty-2"]);
    expect(report.failed).toEqual([{ ptyId: "pty-1", reason: "adopt-failed" }]);
    expect(table.has("pty-1")).toEqual(false);
    expect(table.has("pty-2")).toEqual(true);
    table.disposeAll();
  });

  it("re-parks semantic initialization failures and continues later entries", async () => {
    const failed = createScriptedTerminal({ cols: 80, rows: 24 });
    const good = createScriptedTerminal({ cols: 80, rows: 24 });
    let releases = 0;
    let semanticAttempts = 0;
    const pool = adopterPool(
      new Map<string, StationTerminalProcess>([
        [
          "pty-1",
          {
            ...failed.terminal,
            releaseToOrphan() {
              releases += 1;
              return true;
            },
          },
        ],
        ["pty-2", good.terminal],
      ]),
    );
    const table = createPtyTable({
      adoptTerminal: pool.adoptTerminal,
      createSemanticTerminal: () => {
        semanticAttempts += 1;
        if (semanticAttempts === 1) {
          throw new Error("semantic init failed");
        }
        return {
          write() {},
          resize() {},
          capture: async () => [],
          dispose() {},
        };
      },
    });

    const report = await table.adoptRegistry({
      "pty-1": handoffEntry("pty-1"),
      "pty-2": handoffEntry("pty-2", {
        identity: { ...handoffEntry("pty-2").identity, terminalTargetId: "native:wt-2" },
      }),
    });

    expect(report).toEqual({
      adopted: ["pty-2"],
      failed: [{ ptyId: "pty-1", reason: "semantic-init-failed" }],
    });
    expect(table.list().map(({ ptyId }) => ptyId)).toEqual(["pty-2"]);
    expect(releases).toBe(1);
    expect(failed.helpers.isDisposed()).toBe(false);
    table.disposeAll();
  });

  it("rolls back adopted subscriptions, re-parks, and continues later entries", async () => {
    const failed = createScriptedTerminal({ cols: 80, rows: 24 });
    const good = createScriptedTerminal({ cols: 80, rows: 24 });
    let releases = 0;
    let semanticDisposals = 0;
    let exitSubscriptionAttempts = 0;
    const pool = adopterPool(
      new Map<string, StationTerminalProcess>([
        [
          "pty-1",
          {
            ...failed.terminal,
            onExit(listener) {
              exitSubscriptionAttempts += 1;
              if (exitSubscriptionAttempts === 1) {
                throw new Error("exit subscription failed");
              }
              return failed.terminal.onExit(listener);
            },
            releaseToOrphan() {
              releases += 1;
              return true;
            },
          },
        ],
        ["pty-2", good.terminal],
      ]),
    );
    const table = createPtyTable({
      adoptTerminal: pool.adoptTerminal,
      createSemanticTerminal: () => ({
        write() {},
        resize() {},
        capture: async () => [],
        dispose() {
          semanticDisposals += 1;
        },
      }),
    });

    const report = await table.adoptRegistry({
      "pty-1": handoffEntry("pty-1"),
      "pty-2": handoffEntry("pty-2", {
        identity: { ...handoffEntry("pty-2").identity, terminalTargetId: "native:wt-2" },
      }),
    });

    expect(report).toEqual({
      adopted: ["pty-2"],
      failed: [{ ptyId: "pty-1", reason: "activation-failed" }],
    });
    expect(table.list().map(({ ptyId }) => ptyId)).toEqual(["pty-2"]);
    expect(releases).toBe(1);
    expect(failed.helpers.isDisposed()).toBe(false);
    expect(semanticDisposals).toBe(1);

    const retried = await table.adoptRegistry({ "pty-1": handoffEntry("pty-1") });
    expect(retried).toEqual({ adopted: ["pty-1"], failed: [] });
    expect(table.list().map(({ ptyId }) => ptyId).sort()).toEqual(["pty-1", "pty-2"]);
    table.disposeAll();
  });

  it("refuses to shadow a live entry with the same ptyId", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const pool = adopterPool(new Map([["pty-1", scripted.terminal]]));
    const table = createPtyTable({
      adoptTerminal: pool.adoptTerminal,
      createTerminal: () => bridgeScripted().terminal,
    });
    table.spawn(baseParams);

    await expect(
      table.adoptRegistry({ "pty-1": handoffEntry("pty-1") }),
    ).rejects.toMatchObject({ code: "HOST_TARGET_CONFLICT" });
    expect(pool.adoptedTargets).toEqual([]);
    table.disposeAll();
  });

  it("refuses to shadow a live target before invoking the adopter", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const pool = adopterPool(new Map([["pty-9", scripted.terminal]]));
    const table = createPtyTable({
      adoptTerminal: pool.adoptTerminal,
      createTerminal: () => bridgeScripted().terminal,
    });
    table.spawn(baseParams);

    await expect(
      table.adoptRegistry({ "pty-9": handoffEntry("pty-9") }),
    ).rejects.toMatchObject({ code: "HOST_TARGET_CONFLICT" });
    expect(pool.adoptedTargets).toEqual([]);
    table.disposeAll();
  });

  it("advances the spawn sequence past adopted ids", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const pool = adopterPool(new Map([["pty-7", scripted.terminal]]));
    const fresh = bridgeScripted();
    const table = createPtyTable({
      adoptTerminal: pool.adoptTerminal,
      createTerminal: () => fresh.terminal,
    });
    await table.adoptRegistry({ "pty-7": handoffEntry("pty-7") });
    const { ptyId } = table.spawn({ ...baseParams, terminalTargetId: "native:wt-next" });
    expect(ptyId).toEqual("pty-8");
    table.disposeAll();
  });

  it("marks replay incomplete when the parked backlog evicted output", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const pool = adopterPool(
      new Map<string, PtyAdoptedTerminal>([
        [
          "pty-1",
          { ...scripted.terminal, parkedEvicted: true, releaseToOrphan: () => false },
        ],
      ]),
    );
    const table = createPtyTable({ adoptTerminal: pool.adoptTerminal });
    await table.adoptRegistry({ "pty-1": handoffEntry("pty-1") });
    expect(table.snapshot("pty-1").rawComplete).toEqual(false);
    table.disposeAll();
  });

  it("restores the exported ring from the scrollback ref", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-adopt-"));
    const scrollbackRef = await writeScrollbackExport(directory, "pty-4", {
      initialCols: 80,
      initialRows: 24,
      complete: true,
      events: [{ type: "data", data: "pre-handoff-history" }],
    });
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const pool = adopterPool(new Map([["pty-4", scripted.terminal]]));
    const table = createPtyTable({ adoptTerminal: pool.adoptTerminal });

    await table.adoptRegistry({
      "pty-4": handoffEntry("pty-4", { scrollbackRef, ringComplete: true }),
    });
    const snapshot = table.snapshot("pty-4");
    expect(snapshot.rawChunks.join("")).toContain("pre-handoff-history");
    expect(snapshot.rawComplete).toEqual(true);
    table.disposeAll();
  });

  it("keeps a truncated exported ring incomplete through adoption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-adopt-"));
    const scrollbackRef = await writeScrollbackExport(directory, "pty-6", {
      initialCols: 80,
      initialRows: 24,
      complete: false,
      events: [{ type: "data", data: "tail-only" }],
    });
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const pool = adopterPool(new Map([["pty-6", scripted.terminal]]));
    const table = createPtyTable({ adoptTerminal: pool.adoptTerminal });

    await table.adoptRegistry({
      "pty-6": handoffEntry("pty-6", { scrollbackRef, ringComplete: false }),
    });
    const snapshot = table.snapshot("pty-6");
    expect(snapshot.rawChunks.join("")).toContain("tail-only");
    expect(snapshot.rawComplete).toEqual(false);
    table.disposeAll();
  });

  it("fails closed when a scrollback ref cannot be read back", async () => {
    const events: string[] = [];
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const pool = adopterPool(new Map([["pty-6", scripted.terminal]]));
    const table = createPtyTable({
      adoptTerminal: pool.adoptTerminal,
      onEvent: (event) => {
        events.push(event);
      },
    });

    const report = await table.adoptRegistry({
      "pty-6": handoffEntry("pty-6", {
        scrollbackRef: "/nonexistent/pty-6.scrollback.json",
        ringComplete: true,
      }),
    });
    expect(report.adopted).toEqual(["pty-6"]);
    expect(table.snapshot("pty-6").rawComplete).toEqual(false);
    expect(events).toContain("pty.handoff.scrollback-import-failed");
    table.disposeAll();
  });

  it("reaps an adopted PTY whose bridge reports exit after adoption", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const pool = adopterPool(new Map([["pty-5", scripted.terminal]]));
    const table = createPtyTable({ adoptTerminal: pool.adoptTerminal });
    await table.adoptRegistry({ "pty-5": handoffEntry("pty-5") });
    scripted.helpers.emitExit({ exitCode: 4 });
    await waitFor(() => !table.has("pty-5"), 2_000);
    table.disposeAll();
  });

  it("processes fidelity never writes a screen snapshot ref", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-processes-only-"));
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const table = createPtyTable({
      orphanBridges: { directory },
      createTerminal: () => ({
        ...scripted.terminal,
        bridgePid: 1_004,
        releaseToOrphan() {
          scripted.terminal.dispose();
          return false;
        },
      }),
      createSemanticTerminal: () => ({
        write: () => undefined,
        resize: () => undefined,
        capture: async () => {
          throw new Error("should not capture for processes fidelity");
        },
        dispose: () => undefined,
      }),
    });
    const { ptyId } = table.spawn(baseParams);
    const report = await table.releaseRegistryForHandoff("processes");
    expect(report.fidelity).toEqual("processes");
    expect(report.manifest[ptyId]?.screenSnapshotRef).toBeUndefined();
    expect(report.manifest[ptyId]?.scrollbackRef).toBeDefined();
    table.disposeAll();
  });

  it("releaseRegistryForHandoff parks via releaseToOrphan without kill", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-release-"));
    let released = false;
    let killed = false;
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const table = createPtyTable({
      orphanBridges: { directory },
      createTerminal: () => ({
        ...scripted.terminal,
        bridgePid: 1_001,
        releaseToOrphan() {
          released = true;
          return false;
        },
        kill() {
          killed = true;
          scripted.terminal.kill();
        },
      }),
    });
    const { ptyId } = table.spawn(baseParams);
    expect(table.recoveryInventory()).toMatchObject([
      { ptyId, handoffSupport: { kind: "bridge-releasable" } },
    ]);
    const report = await table.releaseRegistryForHandoff("processes");
    expect(report.released).toEqual([ptyId]);
    expect(report.manifest[ptyId]?.bridgePid).toEqual(1_001);
    expect(released).toEqual(true);
    expect(killed).toEqual(false);
    expect(table.list()).toEqual([]);
    table.disposeAll();
  });

  it("screen fidelity writes a snapshot ref when capture succeeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-screen-ok-"));
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const table = createPtyTable({
      orphanBridges: { directory },
      createTerminal: () => ({
        ...scripted.terminal,
        bridgePid: 1_002,
        releaseToOrphan() {
          scripted.terminal.dispose();
          return false;
        },
      }),
      createSemanticTerminal: () => ({
        write: () => undefined,
        resize: () => undefined,
        capture: async () => ["\x1bcrestored"],
        dispose: () => undefined,
      }),
    });
    const { ptyId } = table.spawn(baseParams);
    const report = await table.releaseRegistryForHandoff("screen");
    expect(report.fidelity).toEqual("screen");
    expect(report.manifest[ptyId]?.screenSnapshotRef).toEqual(
      join(directory, `${ptyId}.screen.json`),
    );
    const screen = JSON.parse(
      await readFile(String(report.manifest[ptyId]?.screenSnapshotRef), "utf8"),
    );
    expect(screen.sequences).toEqual(["\x1bcrestored"]);
    table.disposeAll();
  });

  it("refuses release when any live terminal cannot be parked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-partial-refuse-"));
    const events: string[] = [];
    let released = false;
    const bridge = createScriptedTerminal({ cols: 80, rows: 24 });
    const local = createScriptedTerminal({ cols: 80, rows: 24 });
    let next = 0;
    const table = createPtyTable({
      orphanBridges: { directory },
      onEvent: (event) => {
        events.push(event);
      },
      createTerminal: () => {
        next += 1;
        if (next === 1) {
          return {
            ...bridge.terminal,
            bridgePid: 1_010,
            releaseToOrphan() {
              released = true;
              return false;
            },
          };
        }
        return local.terminal;
      },
    });
    table.spawn(baseParams);
    table.spawn({
      ...baseParams,
      terminalTargetId: "native:wt-2",
      worktreeId: "wt-2",
      sessionId: "ses-2",
      kind: "aux",
    });
    const report = await table.releaseRegistryForHandoff("processes");
    expect(report.released).toEqual([]);
    expect(report.skipped).toEqual([{ ptyId: "pty-2", reason: "no-bridge-transport" }]);
    expect(released).toEqual(false);
    expect(table.list()).toHaveLength(2);
    expect(events).toContain("pty.handoff.refused-partial");
    table.disposeAll();
  });

  it("retains only unrestored parks when release-readiness rollback is partial", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-release-rollback-"));
    let bridgePid = 2_000;
    const table = createPtyTable({
      orphanBridges: { directory },
      createTerminal: () => {
        const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
        bridgePid += 1;
        return {
          ...scripted.terminal,
          bridgePid,
          releaseToOrphan() {
            scripted.terminal.dispose();
            return true;
          },
        };
      },
      adoptTerminal: async (target) => {
        if (target.ptyId === "pty-1") {
          throw new Error("bridge unavailable");
        }
        const scripted = createScriptedTerminal(target.size);
        return {
          ...scripted.terminal,
          bridgePid: 3_000,
          releaseToOrphan() {
            scripted.terminal.dispose();
            return true;
          },
        };
      },
    });
    const first = table.spawn(baseParams);
    const second = table.spawn({
      ...baseParams,
      terminalTargetId: "native:wt-2",
      worktreeId: "wt-2",
      sessionId: "ses-2",
      kind: "aux",
    });
    // A park artifact without its promised listener deterministically refuses release readiness.
    await writeFile(join(directory, `${first.ptyId}.park.json`), "{}");
    await writeFile(join(directory, `${second.ptyId}.park.json`), "{}");

    let failure: unknown;
    try {
      await table.releaseRegistryForHandoff("processes");
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof PtyHandoffRestorationError).toBe(true);
    if (!(failure instanceof PtyHandoffRestorationError)) {
      throw new Error("Expected partial restoration evidence.");
    }
    expect(Object.keys(failure.remainingManifest)).toEqual([first.ptyId]);
    expect(table.list().map(({ ptyId }) => ptyId)).toEqual([second.ptyId]);
    table.disposeAll();
  });

  it("screen fidelity degrades when capture fails and still releases parks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-screen-degrade-"));
    const events: string[] = [];
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const table = createPtyTable({
      orphanBridges: { directory },
      onEvent: (event) => {
        events.push(event);
      },
      createTerminal: () => ({
        ...scripted.terminal,
        bridgePid: 1_003,
        releaseToOrphan() {
          scripted.terminal.dispose();
          return false;
        },
      }),
      createSemanticTerminal: () => ({
        write: () => undefined,
        resize: () => undefined,
        capture: async () => {
          throw new Error("capture unavailable");
        },
        dispose: () => undefined,
      }),
    });
    const { ptyId } = table.spawn(baseParams);
    const report = await table.releaseRegistryForHandoff("screen");
    expect(report.released).toEqual([ptyId]);
    expect(report.manifest[ptyId]?.screenSnapshotRef).toBeUndefined();
    expect(report.manifest[ptyId]?.scrollbackRef).toBeDefined();
    expect(events).toContain("pty.handoff.screen-export-failed");
    table.disposeAll();
  });
});
