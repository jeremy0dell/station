import { runCli } from "@station/cli";
import { runObserverCommand, shouldSuppressCliProcessOutput } from "@station/cli/internal";
import {
  type ReconcileReceipt,
  StationCommandSchema,
  type StationSnapshot,
} from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";
import { cliCommandRegistry } from "../../src/commandRegistry.js";
import type { CliCommandNode } from "../../src/commands/cliCommand/types.js";

const now = "2026-05-20T12:00:00.000Z";

describe("CLI manual-smoke commands", () => {
  it("defaults to the TUI when no subcommand is provided", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const sockets: Array<string | undefined> = [];

    const result = await runCli(["--config", configPath], {
      env: {},
      observerDeps: runningObserverDeps({ socketPath: fixture.socketPath }),
      tuiDeps: {
        spawnRenderer: async ({ env }) => {
          sockets.push(env.STATION_OBSERVER_SOCKET_PATH);
          return { status: "exited", code: 0 };
        },
      },
    });

    expect(result).toEqual({
      code: 0,
      output: { status: "exited", code: 0 },
    });
    expect(sockets).toEqual([fixture.socketPath]);
  });

  it("prints the observer snapshot through snapshot --json", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const snapshot = snapshotFixture();

    const result = await runCli(["--config", configPath, "snapshot", "--json"], {
      observerDeps: runningObserverDeps({ socketPath: fixture.socketPath, snapshot }),
    });

    expect(result).toEqual({
      code: 0,
      output: snapshot,
    });
  });

  it("requests an immediate observer reconcile", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const reconciles: Array<string | undefined> = [];
    const receipt: ReconcileReceipt = {
      schemaVersion: "0.5.0",
      reason: "manual-smoke",
      reconciledAt: now,
      snapshot: snapshotFixture(),
    };

    const result = await runCli(["--config", configPath, "reconcile", "--reason", "manual-smoke"], {
      observerDeps: runningObserverDeps({
        socketPath: fixture.socketPath,
        reconcile: async (reason) => {
          reconciles.push(reason);
          return receipt;
        },
      }),
    });

    expect(result).toEqual({
      code: 0,
      output: receipt,
    });
    expect(reconciles).toEqual(["manual-smoke"]);
  });

  it("passes observer startup timeouts from observer commands", async () => {
    const fixture = await createTempState();
    await expect(
      runObserverCommand(
        ["start", "--timeout-ms"],
        { config: fixture.config },
        runningObserverDeps({ socketPath: fixture.socketPath }),
      ),
    ).rejects.toThrow("--timeout-ms requires a value.");
  });

  it("rejects malformed global config options before default command routing", async () => {
    await expect(runCli(["--config"])).rejects.toThrow("--config requires a value.");
    await expect(runCli(["--config", "doctor"])).rejects.toThrow("--config requires a value.");
  });

  it("returns root help as plain text", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.outputFormat).toBe("text");
    const text = textOutput(result);
    expect(text).toContain("Usage:\n  stn [--config <path>] [command]");
    expect(text).toContain("Commands:");
    expect(text).toContain("debug");
    expect(text).toContain("project");
    expect(text).toContain("setup");
  });

  it("returns root manual with behavior notes and verification examples", async () => {
    const result = await runCli(["--man"]);

    expect(result.code).toBe(0);
    expect(result.outputFormat).toBe("text");
    const text = textOutput(result);
    expect(text).toContain("Behavior Notes:");
    expect(text).toContain("Manual Verification:");
    expect(text).toContain("pnpm stn project add --man");
  });

  it("serves config-backed command help before loading config", async () => {
    const result = await runCli([
      "--config",
      "/tmp/station-missing-config.toml",
      "doctor",
      "--help",
    ]);

    expect(result).toMatchObject({ code: 0, outputFormat: "text" });
    expect(textOutput(result)).toContain("Usage:\n  stn doctor [--project <id>]");
  });

  it("ignores command options and operands when resolving help topics", async () => {
    const projectAdd = await runCli(["project", "add", fixtureRootPath(), "--help"]);
    const setupCheck = await runCli(["setup", "check", "--json", "--help"]);
    const doctor = await runCli(["doctor", "--project", "demo", "--help"]);
    const hookInstall = await runCli([
      "hooks",
      "install",
      "codex",
      "--hook-bin",
      "stn-ingress",
      "--help",
    ]);

    expect(projectAdd).toMatchObject({ code: 0, outputFormat: "text" });
    expect(textOutput(projectAdd)).toContain("Usage:\n  stn project add <path>");
    expect(setupCheck).toMatchObject({ code: 0, outputFormat: "text" });
    expect(textOutput(setupCheck)).toContain("Usage:\n  stn setup check [--json] [--no-brew]");
    expect(doctor).toMatchObject({ code: 0, outputFormat: "text" });
    expect(textOutput(doctor)).toContain("Usage:\n  stn doctor [--project <id>]");
    expect(hookInstall).toMatchObject({ code: 0, outputFormat: "text" });
    expect(textOutput(hookInstall)).toContain(
      "Usage:\n  stn hooks install <target> --yes [options]",
    );
  });

  it("resolves nested debug and project manual topics", async () => {
    const bundle = await runCli(["debug", "bundle", "--help"]);
    const projectAdd = await runCli(["project", "add", "--man"]);

    expect(bundle).toMatchObject({ code: 0, outputFormat: "text" });
    expect(textOutput(bundle)).toContain("stn debug bundle --latest-failure");
    expect(projectAdd).toMatchObject({ code: 0, outputFormat: "text" });
    expect(textOutput(projectAdd)).toContain("Usage:\n  stn project add <path>");
    expect(textOutput(projectAdd)).toContain("Behavior Notes:");
  });

  it("resolves hook action target help without running hook commands", async () => {
    const result = await runCli(["hooks", "install", "codex", "--help"]);

    expect(result).toMatchObject({ code: 0, outputFormat: "text" });
    const text = textOutput(result);
    expect(text).toContain("Usage:\n  stn hooks install <target> --yes [options]");
    expect(text).toContain("One of: worktrunk, claude, codex, cursor, crush, opencode, event.");
  });

  it("does not advertise fake command ids in command help examples", async () => {
    const result = await runCli(["command", "--help"]);

    expect(result).toMatchObject({ code: 0, outputFormat: "text" });
    const text = textOutput(result);
    expect(text).toContain("stn command dispatch --stdin --wait");
    expect(text).not.toContain("cmd_123");
  });

  it("keeps registered examples free of placeholder ids and fake paths", () => {
    const examples = collectRegistryExamples(cliCommandRegistry);

    expect(examples.length).toBeGreaterThan(0);
    for (const { topic, example } of examples) {
      for (const pattern of blockedExamplePatterns) {
        expect(example, `${topic}: ${example}`).not.toMatch(pattern);
      }
    }
  });

  it("keeps command dispatch examples schema-valid", () => {
    const dispatchExamples = collectRegistryExamples(cliCommandRegistry).filter(({ example }) =>
      example.includes("stn command dispatch"),
    );

    expect(dispatchExamples.length).toBeGreaterThan(0);
    for (const { topic, example } of dispatchExamples) {
      const payload = commandDispatchJsonPayload(example);
      expect(payload, `${topic}: ${example}`).toBeDefined();
      const parsed = StationCommandSchema.safeParse(JSON.parse(String(payload)));
      expect(parsed.success, `${topic}: ${example}`).toBe(true);
    }
  });

  it("fails unknown help topics with a useful message", async () => {
    await expect(runCli(["foo", "bar", "--help"])).rejects.toThrow(
      "Unknown help topic: stn foo bar",
    );
  });

  it("does not suppress process output for help and manual requests", () => {
    expect(shouldSuppressCliProcessOutput(["tui", "--help"])).toBe(false);
    expect(shouldSuppressCliProcessOutput(["popup", "--man"])).toBe(false);
    expect(shouldSuppressCliProcessOutput(["observe", "-h"])).toBe(false);
  });
});

function textOutput(result: { output?: unknown }): string {
  expect(typeof result.output).toBe("string");
  return String(result.output);
}

const blockedExamplePatterns = [
  /\b(?:cmd|trc|diag)_[0-9]+\b/,
  /~\/Developer\//,
  /\bstation command get \S+/,
  /\bstation project (?:remove|doctor) [A-Za-z0-9._-]+\b/,
  /\bstation notify turn-completion$/,
] as const;

function collectRegistryExamples(
  node: CliCommandNode,
  path: readonly string[] = [],
): Array<{ topic: string; example: string }> {
  const topic = path.length === 0 ? "stn" : `stn ${path.join(" ")}`;
  const examples = (node.examples ?? []).map((example) => ({ topic, example }));
  const childExamples = (node.children ?? []).flatMap((child) =>
    collectRegistryExamples(child, [...path, child.name]),
  );
  return [...examples, ...childExamples];
}

function commandDispatchJsonPayload(example: string): string | undefined {
  return /printf '%s\\n' '([^']+)' \| pnpm stn command dispatch\b/.exec(example)?.[1];
}

function fixtureRootPath(): string {
  return "/tmp/station-help-fixture";
}

function runningObserverDeps(options: {
  socketPath: string;
  snapshot?: StationSnapshot;
  reconcile?: (reason?: string) => Promise<ReconcileReceipt>;
}) {
  return {
    clientFactory: (socketPath: string) =>
      ({
        health: async () => ({
          schemaVersion: "0.5.0",
          status: "healthy",
          pid: 1234,
          startedAt: now,
          version: "0.0.0",
          socketPath,
        }),
        getSnapshot: async () => options.snapshot ?? snapshotFixture(),
        reconcile:
          options.reconcile ??
          (async (reason?: string) => ({
            schemaVersion: "0.5.0",
            reason: reason ?? "manual",
            reconciledAt: now,
            snapshot: options.snapshot ?? snapshotFixture(),
          })),
      }) as never,
    sleep: async () => undefined,
  };
}

function snapshotFixture(): StationSnapshot {
  return {
    schemaVersion: "0.5.0",
    generatedAt: now,
    observer: { pid: 1234, startedAt: now, version: "0.0.0", healthy: true },
    providerHealth: {},
    projects: [],
    rows: [],
    sessions: [],
    counts: {
      projects: 0,
      worktrees: 0,
      agents: 0,
      working: 0,
      idle: 0,
      attention: 0,
      unknown: 0,
    },
    alerts: [],
  };
}
