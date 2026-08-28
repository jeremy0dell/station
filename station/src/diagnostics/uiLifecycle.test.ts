import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { componentLogPath, createJsonlLogger, readJsonlLog } from "@station/observability";
import { describe, expect, it } from "bun:test";
import { createUiLifecycleWitness } from "./uiLifecycle.js";

const context = {
  uiRunId: "ui_11111111-1111-4111-8111-111111111111",
  rendererPid: 4242,
  clientKind: "native_renderer" as const,
};

describe("UI lifecycle witness", () => {
  it("records ordered surface and flushed intentional shutdown evidence", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-ui-lifecycle-"));
    let tick = 0;
    const logger = createJsonlLogger({
      component: "tui",
      path: componentLogPath(stateDir, "tui"),
      clock: { now: () => new Date(Date.UTC(2026, 4, 20, 12, 0, tick++)) },
    });
    const witness = createUiLifecycleWitness({
      logger,
      context,
      clock: { now: () => new Date(Date.UTC(2026, 4, 20, 12, 0, tick++)) },
    });

    await witness.started();
    await witness.ready("workspace");
    await witness.surfaceChanged("workspace", "station_overlay", "overlay_open");
    await witness.surfaceChanged("station_overlay", "workspace", "overlay_close");
    await witness.shutdownRequested("ctrl_q");
    await witness.shutdownCompleted("ctrl_q");
    await witness.flush();

    const records = await readJsonlLog(join(stateDir, "logs", "tui.jsonl"));
    expect(records.map((record) => record.lifecycle?.kind)).toEqual([
      "ui.started",
      "ui.ready",
      "ui.surface.changed",
      "ui.surface.changed",
      "ui.shutdown.requested",
      "ui.shutdown.completed",
    ]);
    expect(records.map((record) => record.lifecycle?.source.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(records[4]?.lifecycle).toMatchObject({
      uiRunId: context.uiRunId,
      reason: "ctrl_q",
    });
    expect(JSON.stringify(records)).not.toContain("terminal output");
  });

  it("retains a normalized fatal error without arbitrary failure data", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-ui-fatal-"));
    const logger = createJsonlLogger({
      component: "tui",
      path: componentLogPath(stateDir, "tui"),
    });
    const witness = createUiLifecycleWitness({ logger, context });

    await witness.started();
    await witness.fatalShutdown(new Error("renderer failed"));

    const records = await readJsonlLog(join(stateDir, "logs", "tui.jsonl"));
    expect(records.map((record) => record.lifecycle?.kind)).toEqual([
      "ui.started",
      "ui.shutdown.requested",
      "ui.fatal",
    ]);
    expect(records.at(-1)?.lifecycle).toMatchObject({
      kind: "ui.fatal",
      error: { code: "TUI_FATAL", message: "The native Station UI failed." },
    });
    expect(JSON.stringify(records)).not.toContain("renderer failed");
  });

  it("records content-free terminal-loss failure evidence without completion", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-ui-terminal-loss-"));
    const logger = createJsonlLogger({
      component: "tui",
      path: componentLogPath(stateDir, "tui"),
    });
    const witness = createUiLifecycleWitness({ logger, context });

    await witness.shutdownRequested("terminal_loss");
    await witness.fatal(new Error("private terminal output"));
    await witness.flush();

    const records = await readJsonlLog(join(stateDir, "logs", "tui.jsonl"));
    expect(records.map((record) => record.lifecycle?.kind)).toEqual([
      "ui.shutdown.requested",
      "ui.fatal",
    ]);
    expect(records[0]?.lifecycle).toMatchObject({ reason: "terminal_loss" });
    expect(records[1]?.lifecycle).toMatchObject({
      error: { code: "TUI_FATAL", message: "The native Station UI failed." },
    });
    expect(JSON.stringify(records)).not.toContain("private terminal output");
  });

  for (const { label, error, privateValue } of [
    {
      label: "SafeError",
      error: {
        tag: "FilesystemError",
        code: "SECRET_PATH",
        message: "Failed under /Users/private/project.",
      },
      privateValue: "/Users/private/project",
    },
    {
      label: "ExternalCommandError",
      error: {
        tag: "ExternalCommandError",
        code: "COMMAND_FAILED",
        message: "A private command failed.",
        command: "private-command --secret",
        cwd: "/Users/private/project",
        stderrSnippet: "secret output",
      },
      privateValue: "private-command --secret",
    },
  ] as const) {
    it(`normalizes ${label} inputs to the fixed fatal contract`, async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "station-ui-fixed-fatal-"));
      const logger = createJsonlLogger({
        component: "tui",
        path: componentLogPath(stateDir, "tui"),
      });
      const witness = createUiLifecycleWitness({ logger, context });

      await witness.fatalShutdown(error);

      const records = await readJsonlLog(join(stateDir, "logs", "tui.jsonl"));
      expect(records.map((record) => record.lifecycle?.kind)).toEqual([
        "ui.shutdown.requested",
        "ui.fatal",
      ]);
      expect(records.at(-1)?.lifecycle).toMatchObject({
        kind: "ui.fatal",
        error: { code: "TUI_FATAL", message: "The native Station UI failed." },
      });
      expect(JSON.stringify(records)).not.toContain(privateValue);
    });
  }

  it("never lets lifecycle write or flush failures escape", async () => {
    const failure = new Error("disk failed");
    const witness = createUiLifecycleWitness({
      context,
      logger: {
        path: "/unwritable/tui.jsonl",
        log: async () => {
          throw failure;
        },
        debug: async () => {
          throw failure;
        },
        info: async () => {
          throw failure;
        },
        warn: async () => {
          throw failure;
        },
        error: async () => {
          throw failure;
        },
        flush: async () => {
          throw failure;
        },
      },
    });

    await witness.started();
    await witness.fatalShutdown(failure);
    expect(true).toBe(true);
  });
});
