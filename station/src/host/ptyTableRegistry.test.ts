import type { PtyHandoffEntry } from "@station/contracts";
import type { HostSpawnParams } from "@station/host";
import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedTerminal, type ScriptedTerminal } from "../terminal/testing/scriptedTerminal.js";
import type { StationTerminalProcess } from "../terminal/types.js";
import { waitFor } from "../terminal/testing/waitFor.js";
import { writeScrollbackExport } from "./orphanBridges.js";
import { createPtyTable, type PtyAdoptionTarget, type PtyAdoptedTerminal } from "./ptyTable.js";

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
  return {
    bridgeProtocolVersion: 1,
    bridgePid: 4242,
    controlSocket: `/state/run/pty-bridges/${ptyId}.sock`,
    command: "claude",
    cols: 80,
    rows: 24,
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
    const { ptyId } = table.spawn(baseParams);
    spawned[0]?.scripted.helpers.emitData("exported-output");

    const manifest = await table.exportRegistry();
    const entry = manifest[ptyId];
    expect(entry).toBeDefined();
    expect(entry?.bridgePid).toEqual(999);
    expect(entry?.controlSocket).toEqual(join(directory, `${ptyId}.sock`));
    expect(entry?.identity.terminalTargetId).toEqual("native:wt-1");
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
  function adopterPool(terminals: Map<string, PtyAdoptedTerminal>) {
    const adoptedTargets: PtyAdoptionTarget[] = [];
    return {
      adoptedTargets,
      adoptTerminal: async (target: PtyAdoptionTarget): Promise<PtyAdoptedTerminal> => {
        adoptedTargets.push(target);
        const terminal = terminals.get(target.ptyId);
        if (terminal === undefined) {
          throw new Error(`no scripted terminal for ${target.ptyId}`);
        }
        return terminal;
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
      alive: true,
      terminalTargetId: "native:wt-1",
      cols: 80,
      rows: 24,
    });

    table.write("pty-3", "forwarded\n");
    expect(scripted.helpers.writes).toEqual(["forwarded\n"]);
    table.resize("pty-3", 101, 31);
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
      "pty-2": handoffEntry("pty-2"),
    });
    expect(report.adopted).toEqual(["pty-2"]);
    expect(report.failed).toEqual([{ ptyId: "pty-1", reason: "adopt-failed" }]);
    expect(table.has("pty-1")).toEqual(false);
    expect(table.has("pty-2")).toEqual(true);
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

    const report = await table.adoptRegistry({ "pty-1": handoffEntry("pty-1") });
    expect(report).toEqual({
      adopted: [],
      failed: [{ ptyId: "pty-1", reason: "duplicate-pty-id" }],
    });
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
      new Map<string, PtyAdoptedTerminal>([["pty-1", { ...scripted.terminal, parkedEvicted: true }]]),
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

  it("reaps an adopted PTY whose bridge reports exit after adoption", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const pool = adopterPool(new Map([["pty-5", scripted.terminal]]));
    const table = createPtyTable({ adoptTerminal: pool.adoptTerminal });
    await table.adoptRegistry({ "pty-5": handoffEntry("pty-5") });
    scripted.helpers.emitExit({ exitCode: 4 });
    await waitFor(() => !table.has("pty-5"), 2_000);
    table.disposeAll();
  });
});
