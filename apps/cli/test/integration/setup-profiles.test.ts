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

type ProfileState = MachineProfile["state"];
type HarnessId = "codex" | "cursor" | "opencode" | "pi" | "claude";

// Compile a declarative profile into the real SetupCommandDeps injection surface.
function profileToSetupDeps(
  profile: MachineProfile,
  repo: string,
  home: string,
  configPath: string,
) {
  const state = profile.state;
  const presentPaths = profileExecutablePaths(state);
  const files = profileConfigFiles(state, configPath, repo);
  return {
    cwd: repo,
    homeDir: home,
    env: { PATH: "/fake/bin" },
    platform: state.platform,
    runner: profileRunner(state, repo),
    access: profileAccess(presentPaths),
    fs: profileFileSystem(files),
    probeHarnessHooksStatus: profileHarnessTrackingProbe(state),
    now: () => new Date("2026-06-08T12:00:00.000Z"),
  };
}

function profileExecutablePaths(state: ProfileState): Set<string> {
  const tools = [
    [state.worktrunk, "wt"],
    [state.tmux, "tmux"],
    [state.bun, "bun"],
    [state.diffnav, "diffnav"],
    [state.gitDelta, "delta"],
  ] as const;
  return new Set(
    tools.flatMap(([presence, binary]) => (presence === "present" ? [`/fake/bin/${binary}`] : [])),
  );
}

function profileVersionOutputs(state: ProfileState): Record<string, string> {
  const versions: Record<string, string> = {};
  if (state.worktrunk === "present") versions["wt --version"] = "worktrunk 1.2.3\n";
  if (state.tmux === "present") versions["tmux -V"] = "tmux 3.5a\n";
  for (const harness of state.harnesses) {
    versions[`${harnessCommands[harness] ?? harness} --version`] = `${harness} 1.0.0\n`;
  }
  return versions;
}

function profileRunner(state: ProfileState, repo: string) {
  const versions = profileVersionOutputs(state);
  return (input: ExternalCommandInput): Promise<ExternalCommandResult> =>
    Promise.resolve().then(() => profileCommandResult(state, repo, versions, input));
}

function profileCommandResult(
  state: ProfileState,
  repo: string,
  versions: Readonly<Record<string, string>>,
  input: ExternalCommandInput,
): ExternalCommandResult {
  const bin = input.command.startsWith("/fake/bin/") ? basename(input.command) : input.command;
  const args = input.args ?? [];
  const key = `${bin} ${args.join(" ")}`;
  if (input.command === "git") return profileGitResult(state, repo, input, key, args);
  if (bin === "brew") {
    if (state.brew === "absent") throw enoent(key);
    return ok(input, "Homebrew 4.0.0\n");
  }
  if (bin === "xcode-select") return profileXcodeResult(state, input, key);

  const stdout = versions[key];
  if (stdout !== undefined) return ok(input, stdout);
  throw enoent(key);
}

function profileGitResult(
  state: ProfileState,
  repo: string,
  input: ExternalCommandInput,
  key: string,
  args: readonly string[],
): ExternalCommandResult {
  if (state.git === "absent") throw enoent(key);
  if (args[0] === "--version") return ok(input, "git version 2.50.1\n");
  if (args[0] === "rev-parse") {
    if (!state.insideRepo) throw exitCode(key, 128);
    return ok(input, `${repo}\n`);
  }
  if (args[0] === "symbolic-ref") return ok(input, "origin/main\n");
  return ok(input, "");
}

function profileXcodeResult(
  state: ProfileState,
  input: ExternalCommandInput,
  key: string,
): ExternalCommandResult {
  if (state.platform === "darwin" && state.xcodeClt === "present") {
    return ok(input, "/Library/Developer/CommandLineTools\n");
  }
  throw exitCode(key, 1);
}

function profileAccess(presentPaths: ReadonlySet<string>) {
  return (path: string): Promise<void> =>
    presentPaths.has(path) ? Promise.resolve() : Promise.reject(enoent(path));
}

function profileConfigFiles(
  state: ProfileState,
  configPath: string,
  repo: string,
): Record<string, string> {
  if (state.configToml === undefined) return {};
  return { [configPath]: state.configToml.replaceAll("{{REPO}}", repo) };
}

function profileFileSystem(files: Record<string, string>) {
  return {
    mkdir: () => Promise.resolve(),
    readFile(path: string) {
      const content = files[path];
      return content === undefined ? Promise.reject(enoent(path)) : Promise.resolve(content);
    },
    writeFile(path: string, content: string) {
      files[path] = content;
      return Promise.resolve();
    },
    rename(from: string, to: string) {
      const content = files[from];
      if (content === undefined) return Promise.reject(enoent(from));
      files[to] = content;
      delete files[from];
      return Promise.resolve();
    },
    access(path: string) {
      return files[path] === undefined ? Promise.reject(enoent(path)) : Promise.resolve();
    },
  };
}

function profileHarnessTrackingProbe(state: ProfileState) {
  return async (harnessId: HarnessId) => {
    const tracking = state.harnessTracking?.[harnessId];
    if (tracking === "unsupported" || harnessId === "pi") return undefined;
    if (tracking === "probe-failed") throw new Error("synthetic tracking probe failure");
    const installed = tracking === "prepared";
    return {
      provider: harnessId,
      requested: tracking !== undefined,
      installed,
      missing: installed ? [] : ["tracking artifact"],
      message: installed ? "Tracking artifacts are installed." : "Tracking artifacts are missing.",
    };
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
