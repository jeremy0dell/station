import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@station/cli";
import { describe, expect, it } from "vitest";

describe("CLI event hook commands", () => {
  it("plans and installs the built-in agent state notification hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-event-hooks-"));
    const configPath = await writeConfig(root);
    const env = await envWithFakeCommand(root, "stn");

    const plan = await runCli([
      "--config",
      configPath,
      "event-hooks",
      "plan",
      "notify-agent-state",
    ]);

    expect(plan).toMatchObject({
      code: 0,
      output: {
        category: "observer-event-hook",
        hookId: "notify-agent-state",
        changed: true,
        installed: false,
      },
    });
    await expect(readFile(configPath, "utf8")).resolves.not.toContain("notify-agent-state");

    await expect(
      runCli(["--config", configPath, "event-hooks", "install", "notify-agent-state"]),
    ).rejects.toThrow("without --yes");

    const install = await runCli([
      "--config",
      configPath,
      "event-hooks",
      "install",
      "notify-agent-state",
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
    expect(after).toContain('id = "notify-agent-state"');
    expect(after).toContain('events = ["worktree.agentStateChanged"]');
    expect(after).toContain('command = "stn"');
    expect(after).toContain(
      `args = ["--config", ${JSON.stringify(configPath)}, "notify", "agent-state"]`,
    );
    expect(after).toContain("timeout_ms = 8000");
    expect(after).toContain("[hooks.event.filter]");
    expect(after).toContain('agent_state = "idle"');
    expect(after).not.toContain('[hooks.event.filter]\nharness = "codex"');
    expect(after).toContain('change_source = "harness_event_report"');
    expect(after).not.toContain('harness_event_type = "Stop"');

    const doctor = await runCli(["--config", configPath, "event-hooks", "doctor"], { env });
    expect(doctor).toMatchObject({
      code: 0,
      output: {
        category: "observer-event-hook",
        status: "ok",
        installed: true,
        commandCheck: {
          status: "ok",
          command: `stn --config ${configPath} notify agent-state`,
        },
      },
    });

    const currentPlan = await runCli([
      "--config",
      configPath,
      "event-hooks",
      "plan",
      "notify-agent-state",
    ]);
    expect(currentPlan).toMatchObject({
      code: 0,
      output: {
        category: "observer-event-hook",
        hookId: "notify-agent-state",
        changed: false,
        installed: true,
      },
    });
  });

  it("warns when the installed notification command is stale or unusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-event-hooks-stale-"));
    const configPath = await writeConfig(root);
    const env = await envWithoutCommand(root);

    await runCli(["--config", configPath, "event-hooks", "install", "notify-agent-state", "--yes"]);

    const doctor = await runCli(["--config", configPath, "event-hooks", "doctor"], { env });

    expect(doctor).toMatchObject({
      code: 1,
      output: {
        category: "observer-event-hook",
        status: "warn",
        installed: true,
        commandCheck: {
          status: "warn",
          command: `stn --config ${configPath} notify agent-state`,
        },
      },
    });
  });

  it("updates stale built-in notification hooks in place", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-event-hooks-update-"));
    const configPath = await writeConfig(root, [
      "",
      "[[hooks.event]]",
      'id = "notify-agent-state"',
      'events = ["worktree.agentStateChanged"]',
      'command = "osascript"',
      'args = ["-e", "display notification \\"Agent state changed.\\" with title \\"station\\""]',
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
          command: 'osascript -e display notification "Agent state changed." with title "station"',
        },
      },
    });

    const install = await runCli([
      "--config",
      configPath,
      "event-hooks",
      "install",
      "notify-agent-state",
      "--yes",
    ]);

    expect(install).toMatchObject({
      code: 0,
      output: {
        category: "observer-event-hook",
        hookId: "notify-agent-state",
        changed: true,
        installed: true,
      },
    });
    const after = await readFile(configPath, "utf8");
    expect(after.match(/id = "notify-agent-state"/g)).toHaveLength(1);
    expect(after).not.toContain('command = "osascript"');
    expect(after).not.toContain("display notification");
    expect(after).toContain("[hooks.event.filter]");
    expect(after).toContain('change_source = "harness_event_report"');
    expect(after).toContain('agent_state = "idle"');
    expect(after).not.toContain('harness_event_type = "Stop"');
    expect(after).toContain('command = "stn"');
    expect(after).toContain(
      `args = ["--config", ${JSON.stringify(configPath)}, "notify", "agent-state"]`,
    );
  });

  it("resets stale generated notification hook ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-event-hooks-reset-"));
    const configPath = await writeConfig(root, [
      "",
      "[[hooks.event]]",
      'id = "notify-agent-stale"',
      'events = ["worktree.agentStateChanged"]',
      'command = "osascript"',
      'args = ["-e", "display notification \\"Agent state changed.\\" with title \\"station\\""]',
      "timeout_ms = 3000",
      "",
      "[hooks.event.filter]",
      'agent_state = "idle"',
    ]);

    const install = await runCli([
      "--config",
      configPath,
      "event-hooks",
      "install",
      "notify-agent-state",
      "--yes",
    ]);

    expect(install).toMatchObject({
      code: 0,
      output: {
        category: "observer-event-hook",
        hookId: "notify-agent-state",
        changed: true,
        installed: true,
      },
    });
    const after = await readFile(configPath, "utf8");
    expect(after).not.toContain('id = "notify-agent-stale"');
    expect(after.match(/id = "notify-agent-state"/g)).toHaveLength(1);
    expect(after).not.toContain("display notification");
    expect(after).toContain('change_source = "harness_event_report"');
    expect(after).toContain('agent_state = "idle"');
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
