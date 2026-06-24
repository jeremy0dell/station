import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runCli } from "@station/cli";
import type { DoctorReport } from "@station/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { waitForSocketClosed } from "../../../../tests/support/sockets";

const execFileAsync = promisify(execFile);

describe("CLI release doctor", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    const roots = tempRoots.splice(0);
    for (const root of roots) {
      await stopReleaseDoctorObserver(root);
      await killObserverProcessesForRoot(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports project-local config diagnostics, missing Worktrunk, hooks, SQLite, and bundle availability", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-release-doctor-cli-"));
    tempRoots.push(root);
    const configPath = await writeReleaseDoctorConfig(root);

    const result = await runCli(["--config", configPath, "doctor"]);
    const report = result.output as DoctorReport;

    expect(result.code).toBe(0);
    expect(report.status).toBe("degraded");
    expect(report.config.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CONFIG_LOCAL_CONFIG_PARSE_FAILED",
          projectId: "release-web",
        }),
      ]),
    );
    expect(report.providers.worktrunk).toMatchObject({
      status: "unavailable",
      lastError: {
        code: "WORKTRUNK_UNAVAILABLE",
      },
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "sqlite",
          status: "ok",
        }),
        expect.objectContaining({
          name: "worktrunk-hooks",
          status: "warn",
          error: expect.objectContaining({
            code: "WORKTRUNK_HOOKS_MISSING",
          }),
        }),
      ]),
    );
    expect(report.debugBundle.available).toBe(true);
    expect(report.debugBundle.diagnosticsDir).toContain("diagnostics");
  }, 60_000);
});

async function writeReleaseDoctorConfig(root: string): Promise<string> {
  const projectRoot = join(root, "release-web");
  const localConfigDir = join(projectRoot, ".station");
  const stateDir = join(root, "state");
  const configPath = join(root, "config.toml");
  await mkdir(localConfigDir, { recursive: true });
  await mkdir(join(root, "worktrunk"), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(localConfigDir, "config.toml"), "schema_version = 1\n[commands\n");
  await writeFile(
    configPath,
    [
      "schema_version = 1",
      "",
      "[observer]",
      `socket_path = ${JSON.stringify(join(root, "run", "observer.sock"))}`,
      `state_dir = ${JSON.stringify(stateDir)}`,
      "",
      "[defaults]",
      'worktree_provider = "worktrunk"',
      'terminal = "noop-terminal"',
      'harness = "noop-harness"',
      'layout = "agent-shell"',
      "",
      "[worktree.worktrunk]",
      'command = "missing-wt-release-doctor"',
      `config_path = ${JSON.stringify(join(root, "worktrunk", "config.toml"))}`,
      `managed_root = ${JSON.stringify(join(root, ".worktrees"))}`,
      "use_lifecycle_hooks = true",
      'hook_mode = "required-for-mvp"',
      "",
      "[[projects]]",
      'id = "release-web"',
      'label = "Release Web"',
      `root = ${JSON.stringify(projectRoot)}`,
      'default_branch = "main"',
      "",
      "[projects.defaults]",
      'harness = "noop-harness"',
      'terminal = "noop-terminal"',
      'layout = "agent-shell"',
      "",
      "[projects.worktrunk]",
      "enabled = true",
      'base = "main"',
      "include_main = false",
      "include_external = false",
      "",
      "[projects.local_config]",
      "enabled = true",
      'path = ".station/config.toml"',
      'trust = "explicit"',
      "",
    ].join("\n"),
  );
  return configPath;
}

async function stopReleaseDoctorObserver(root: string): Promise<void> {
  const configPath = join(root, "config.toml");
  const socketPath = join(root, "run", "observer.sock");
  await runCli(["--config", configPath, "observer", "stop"]).catch(() => undefined);
  await waitForSocketClosed(socketPath, { timeoutMs: 1000 }).catch(() => undefined);
}

async function killObserverProcessesForRoot(root: string): Promise<void> {
  const result = await execFileAsync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (match === null) {
      continue;
    }
    const pid = Number(match[1]);
    const command = match[2] ?? "";
    if (!command.includes(root) || !command.includes("apps/cli/dist/observerMain.js")) {
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited is a successful cleanup outcome.
    }
  }
}
