import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runCli } from "@station/cli";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { type MachineProfile, machineProfiles } from "@station/testing";
import { afterEach, describe, expect, it } from "vitest";

// Tier 1 of the varied-machine-state test environment: drive the real `stn setup
// check --json` against each declarative profile in-process via injected deps, and
// assert the profile's exit code + per-check status. The same profiles back the
// Linux-container (tier 2) and macOS Tart-VM (tier 3) runners.
describe("setup machine profiles", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  for (const profile of machineProfiles) {
    it(`${profile.name}: ${profile.description}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "station-setup-profile-"));
      tempRoots.push(root);
      const repo = join(root, "repo");
      const home = join(root, "home");
      const configPath = join(home, "config.toml");
      await mkdir(repo, { recursive: true });

      const result = await runCli(["--config", configPath, "setup", "check", "--json"], {
        setupDeps: profileToSetupDeps(profile, repo, home, configPath),
      });

      expect(result.code).toBe(profile.expect.exitCode);
      const plan = result.output as {
        summary: { requiredOk: boolean };
        checks: { id: string; status: string }[];
      };
      expect(plan.summary.requiredOk).toBe(profile.expect.requiredOk);
      const statusById = new Map(plan.checks.map((check) => [check.id, check.status]));
      for (const [id, status] of Object.entries(profile.expect.checks)) {
        expect(statusById.get(id), `check ${id} for profile ${profile.name}`).toBe(status);
      }
    });
  }
});

const harnessCommands: Record<string, string> = {
  codex: "codex",
  cursor: "agent",
  opencode: "opencode",
  crush: "crush",
  pi: "pi",
  claude: "claude",
};

// Compile a declarative profile into the real SetupCommandDeps injection surface:
// a PATH-access set for path-resolved tools and a runner that answers the version
// and presence probes the checks make.
function profileToSetupDeps(
  profile: MachineProfile,
  repo: string,
  home: string,
  configPath: string,
) {
  const state = profile.state;
  const presentPaths = new Set<string>();
  const addBin = (presence: string, bin: string) => {
    if (presence === "present") presentPaths.add(`/fake/bin/${bin}`);
  };
  addBin(state.worktrunk, "wt");
  addBin(state.tmux, "tmux");
  addBin(state.bun, "bun");
  addBin(state.diffnav, "diffnav");
  addBin(state.gitDelta, "delta");

  const versions: Record<string, string> = {};
  if (state.worktrunk === "present") versions["wt --version"] = "worktrunk 1.2.3\n";
  if (state.tmux === "present") versions["tmux -V"] = "tmux 3.5a\n";
  for (const harness of state.harnesses) {
    versions[`${harnessCommands[harness] ?? harness} --version`] = `${harness} 1.0.0\n`;
  }

  const runner = async (input: ExternalCommandInput): Promise<ExternalCommandResult> => {
    const bin = input.command.startsWith("/fake/bin/") ? basename(input.command) : input.command;
    const args = input.args ?? [];
    const key = `${bin} ${args.join(" ")}`;
    if (input.command === "git") {
      if (state.git === "absent") throw enoent(key);
      if (args[0] === "rev-parse") {
        if (!state.insideRepo) throw exitCode(key, 128);
        return ok(input, `${repo}\n`);
      }
      if (args[0] === "symbolic-ref") return ok(input, "origin/main\n");
      return ok(input, "");
    }
    if (bin === "brew") {
      if (state.brew === "absent") throw enoent(key);
      return ok(input, "Homebrew 4.0.0\n");
    }
    if (bin === "xcode-select") {
      if (state.platform === "darwin" && state.xcodeClt === "present") {
        return ok(input, "/Library/Developer/CommandLineTools\n");
      }
      throw exitCode(key, 1);
    }
    const stdout = versions[key];
    if (stdout !== undefined) return ok(input, stdout);
    throw enoent(key);
  };

  const files: Record<string, string> = {};
  if (state.configToml !== undefined) {
    files[configPath] = state.configToml.replaceAll("{{REPO}}", repo);
  }

  return {
    cwd: repo,
    homeDir: home,
    env: { PATH: "/fake/bin" },
    platform: state.platform,
    runner,
    access: async (path: string) => {
      if (!presentPaths.has(path)) throw enoent(path);
    },
    fs: {
      async readFile(path: string) {
        const content = files[path];
        if (content === undefined) throw enoent(path);
        return content;
      },
    },
    now: () => new Date("2026-06-08T12:00:00.000Z"),
  };
}

function ok(input: ExternalCommandInput, stdout: string): ExternalCommandResult {
  return { command: input.command, args: input.args ?? [], stdout, stderr: "", exitCode: 0 };
}

function enoent(key: string): Error {
  return Object.assign(new Error(`missing command: ${key}`), { code: "ENOENT" });
}

function exitCode(key: string, code: number): Error {
  return Object.assign(new Error(`command failed: ${key}`), { code });
}
