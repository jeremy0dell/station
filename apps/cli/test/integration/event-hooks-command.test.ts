import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@station/cli";
import { describe, expect, it } from "vitest";

describe("CLI event hook commands", () => {
  it("plans and installs the built-in turn completion notification hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-event-hooks-"));
    const configPath = await writeConfig(root);
    const env = await envWithFakeCommand(root, "stn");

    const plan = await runCli([
      "--config",
      configPath,
      "event-hooks",
      "plan",
      "notify-turn-completion",
    ]);

    expect(plan).toMatchObject({
      code: 0,
      output: {
        category: "observer-event-hook",
        hookId: "notify-agent-idle",
        changed: true,
        installed: false,
      },
    });
    await expect(readFile(configPath, "utf8")).resolves.not.toContain("notify-agent-idle");

    await expect(
      runCli(["--config", configPath, "event-hooks", "install", "notify-turn-completion"]),
    ).rejects.toThrow("without --yes");

    const install = await runCli([
      "--config",
      configPath,
      "event-hooks",
      "install",
      "notify-turn-completion",
      "--yes",
    ]);

    expect(install).toMatchObject({
      code: 0,
      output: {
        category: "observer-event-hook",
        installed: true,
      },
    });
    const after = await readFile(configPath, "utf8");
    expect(after).toContain('id = "notify-agent-idle"');
    expect(after).toContain('events = ["worktree.agentStateChanged"]');
    expect(after).toContain('command = "stn"');
    expect(after).toContain(
      `args = ["--config", ${JSON.stringify(configPath)}, "notify", "turn-completion"]`,
    );
    expect(after).toContain("timeout_ms = 8000");
    expect(after).toContain("[hooks.event.filter]");
    expect(after).toContain('agent_state = "idle"');
    expect(after).not.toContain('[hooks.event.filter]\nharness = "codex"');
    expect(after).toContain('change_source = "harness_event_report"');
    expect(after).toContain('harness_event_type = "Stop"');

    const doctor = await runCli(["--config", configPath, "event-hooks", "doctor"], { env });
    expect(doctor).toMatchObject({
      code: 0,
      output: {
        category: "observer-event-hook",
        status: "ok",
        installed: true,
        commandCheck: {
          status: "ok",
          command: `stn --config ${configPath} notify turn-completion`,
        },
      },
    });
  });

  it("warns when the installed notification command is stale or unusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-event-hooks-stale-"));
    const configPath = await writeConfig(root);
    const env = await envWithoutCommand(root);

    await runCli([
      "--config",
      configPath,
      "event-hooks",
      "install",
      "notify-turn-completion",
      "--yes",
    ]);

    const doctor = await runCli(["--config", configPath, "event-hooks", "doctor"], { env });

    expect(doctor).toMatchObject({
      code: 1,
      output: {
        category: "observer-event-hook",
        status: "warn",
        installed: true,
        commandCheck: {
          status: "warn",
          command: `stn --config ${configPath} notify turn-completion`,
        },
      },
    });
  });

  it("updates stale built-in notification hooks in place", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-event-hooks-update-"));
    const configPath = await writeConfig(root, [
      "",
      "[[hooks.event]]",
      'id = "notify-agent-idle"',
      'events = ["worktree.agentStateChanged"]',
      'command = "osascript"',
      'args = ["-e", "display notification \\"Agent turn complete.\\" with title \\"station\\""]',
      "timeout_ms = 3000",
      "",
      "[hooks.event.filter]",
      'agent_state = "idle"',
    ]);

    const doctor = await runCli(["--config", configPath, "event-hooks", "doctor"]);

    expect(doctor).toMatchObject({
      code: 1,
      output: {
        category: "observer-event-hook",
        status: "warn",
        installed: true,
        commandCheck: {
          status: "warn",
          command: 'osascript -e display notification "Agent turn complete." with title "station"',
        },
      },
    });

    const install = await runCli([
      "--config",
      configPath,
      "event-hooks",
      "install",
      "notify-turn-completion",
      "--yes",
    ]);

    expect(install).toMatchObject({
      code: 0,
      output: {
        category: "observer-event-hook",
        hookId: "notify-agent-idle",
        changed: true,
        installed: true,
      },
    });
    const after = await readFile(configPath, "utf8");
    expect(after.match(/id = "notify-agent-idle"/g)).toHaveLength(1);
    expect(after).not.toContain('command = "osascript"');
    expect(after).not.toContain("display notification");
    expect(after).toContain("[hooks.event.filter]");
    expect(after).toContain('change_source = "harness_event_report"');
    expect(after).toContain('harness_event_type = "Stop"');
    expect(after).toContain('command = "stn"');
    expect(after).toContain(
      `args = ["--config", ${JSON.stringify(configPath)}, "notify", "turn-completion"]`,
    );
  });

  it("keeps the legacy hooks event route as a compatibility alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-event-hooks-legacy-"));
    const configPath = await writeConfig(root);

    const plan = await runCli([
      "--config",
      configPath,
      "hooks",
      "plan",
      "event",
      "notify-turn-completion",
    ]);

    expect(plan).toMatchObject({
      code: 0,
      output: {
        category: "observer-event-hook",
        hookId: "notify-agent-idle",
      },
    });
  });
});

async function envWithFakeCommand(
  root: string,
  name: string,
): Promise<Record<string, string | undefined>> {
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const executable = join(binDir, name);
  await writeFile(executable, ["#!/bin/sh", "exit 0", ""].join("\n"), "utf8");
  await chmod(executable, 0o755);
  return { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
}

async function envWithoutCommand(root: string): Promise<Record<string, string | undefined>> {
  const binDir = join(root, "empty-bin");
  await mkdir(binDir, { recursive: true });
  return { ...process.env, PATH: binDir };
}

async function writeConfig(root: string, extraLines: string[] = []): Promise<string> {
  const configPath = join(root, "config.toml");
  await mkdir(join(root, "state"), { recursive: true });
  await writeFile(
    configPath,
    [
      "schema_version = 1",
      "projects = []",
      "",
      "[observer]",
      `socket_path = ${JSON.stringify(join(root, "run", "observer.sock"))}`,
      `state_dir = ${JSON.stringify(join(root, "state"))}`,
      "",
      "[defaults]",
      'worktree_provider = "worktrunk"',
      'terminal = "tmux"',
      'harness = "codex"',
      'layout = "agent-shell"',
      ...extraLines,
      "",
    ].join("\n"),
    "utf8",
  );
  return configPath;
}
