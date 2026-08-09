import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { setupPackageRoot } from "../../src/commands/setup/checks/launchers.js";
import {
  tmuxPopupBindingBlock,
  tmuxPopupRunShellCommand,
} from "../../src/commands/setup/checks/tmuxBinding.js";
import * as setupCommand from "../../src/commands/setup/index.js";
import {
  configBackedHarnessHooksProbe,
  type GuidedPromptFixture,
  successfulProviderTrackingPort,
  toSetupPromptAdapter,
  withRequiredTrackingConsent,
} from "../fixtures/setupTrackingSupport.js";

type GuidedSetupCommandDeps = Omit<setupCommand.SetupCommandDeps, "prompt"> & {
  readonly prompt?: GuidedPromptFixture;
};

type GuidedSetupCommandArguments = [
  argv: Parameters<typeof setupCommand.runSetupCommand>[0],
  options: Parameters<typeof setupCommand.runSetupCommand>[1],
  deps?: GuidedSetupCommandDeps,
];

async function runSetupCommand(...args: GuidedSetupCommandArguments) {
  const deps = args[2] ?? {};
  const { prompt: promptFixture, ...baseDeps } = deps;
  return setupCommand.runSetupCommand(args[0], args[1], {
    ...baseDeps,
    ...(promptFixture === undefined
      ? {}
      : {
          prompt: withRequiredTrackingConsent({
            prompt: promptFixture,
            report: (message) => {
              void baseDeps.writeStdout?.(`${message}\n`);
            },
          }),
        }),
    probeHarnessHooksStatus:
      deps.probeHarnessHooksStatus ??
      configBackedHarnessHooksProbe(
        async (configPath) => (await deps.fs?.readFile(configPath)) ?? "",
      ),
    providerTrackingPort: deps.providerTrackingPort ?? successfulProviderTrackingPort,
  });
}

describe("guided setup command", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("writes config after accepted prompts", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const fs = fakeFs({});
    const chunks: string[] = [];
    const activations: { configPath: string; homeDir: string }[] = [];

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: fakeRunner(calls, {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "wt -y config shell install --dry-run zsh": "shell integration update pending\n",
          "tmux -V": "tmux 3.5a\n",
          "brew --version": "Homebrew 4.0.0\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
        fs,
        activateObserverConfig: async (input) => {
          expect(fs.files[input.configPath]).toContain("projects = []");
          expect(input.onStartupProgress).toEqual(expect.any(Function));
          activations.push({ configPath: input.configPath, homeDir: input.homeDir });
        },
        prompt: prompt({ confirms: [false, false, true, false, false] }),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
        now: () => new Date("2026-06-08T12:00:00.000Z"),
      },
    );

    expect(result.code).toBe(0);
    const configPath = join(root, "home/.config/station/config.toml");
    expect(fs.files[configPath]).toContain("projects = []");
    expect(activations).toEqual([{ configPath, homeDir: join(root, "home") }]);
    expect(chunks.join("")).not.toContain("Applying: Write STATION config");
    expect(chunks.join("")).not.toContain(`Applying: Write STATION config (${configPath})`);
    expect(chunks.join("")).toContain("Selected changes");
    expect(chunks.join("")).toContain("Write STATION config");
    expect(chunks.join("")).toContain("Activate Observer configuration");
    expect(chunks.join("")).toContain("Observer configuration active.");
    expect(chunks.join("")).toContain("Core setup complete.");
  });

  it("surfaces observer startup progress through the guided presenter during activation", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const chunks: string[] = [];

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "wt -y config shell install --dry-run zsh": "shell integration update pending\n",
          "tmux -V": "tmux 3.5a\n",
          "brew --version": "Homebrew 4.0.0\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
        fs,
        activateObserverConfig: async (input) => {
          input.onStartupProgress?.("Starting STATION observer…");
          input.onStartupProgress?.(
            "Still waiting for STATION observer; boot log: /tmp/observer-boot.log",
          );
        },
        prompt: prompt({ confirms: [false, false, true, false, false] }),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
        now: () => new Date("2026-06-08T12:00:00.000Z"),
      },
    );

    expect(result.code).toBe(0);
    const output = chunks.join("");
    expect(output).toContain("Starting STATION observer…");
    expect(output).toContain("Still waiting for STATION observer");
  });

  it("shows an unusable Git blocker before harness prompts without mutation", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const fs = fakeFs({});
    const chunks: string[] = [];
    let promptCount = 0;
    let activationCount = 0;
    const baseRunner = fakeRunner(calls, {
      "wt --version": "worktrunk 1.2.3\n",
      "tmux -V": "tmux 3.5a\n",
      "codex --version": "codex 0.1.0\n",
    });

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: async (input) => {
          if (input.command === "git" && input.args?.[0] === "--version") {
            throw Object.assign(new Error("Git execution denied"), { code: "EACCES" });
          }
          return baseRunner(input);
        },
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
        fs,
        activateObserverConfig: async () => {
          activationCount += 1;
        },
        prompt: {
          async confirm() {
            promptCount += 1;
            return true;
          },
          async selectMany() {
            promptCount += 1;
            return ["codex"];
          },
        },
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.code).toBe(1);
    expect(chunks.join("")).toContain("Git is installed but unusable.");
    expect(promptCount).toBe(0);
    expect(activationCount).toBe(0);
    expect(fs.files).toEqual({});
    expect(calls.some((call) => call.stdio === "inherit")).toBe(false);
  });

  it("continues with checkout launchers and prints a usable popup fallback when linking fails", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const fs = fakeFs({});
    const chunks: string[] = [];
    const packageRoot = setupPackageRoot();

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: fakeRunner(calls, {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "wt -y config shell install --dry-run zsh": "shell integration update pending\n",
          "tmux -V": "tmux 3.5a\n",
          "brew --version": "Homebrew 4.0.0\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/hunk",
          join(packageRoot, "bin/stn"),
          join(packageRoot, "bin/stn-ingress"),
          join(packageRoot, "integrations/terminal/tmux/bin/stn-popup"),
        ]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: {
          async confirm(message: string) {
            return (
              message.includes("Link STATION launchers") ||
              message.includes("Write and activate core Station config") ||
              message.includes("Install or load tmux popup binding")
            );
          },
          async selectMany() {
            return ["codex"];
          },
        },
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.code).toBe(0);
    expect(calls.find((call) => call.command === "pnpm")).toMatchObject({
      args: ["--dir", packageRoot, "station:link"],
      stdio: "inherit",
    });
    expect(chunks.join("")).toContain(
      "STATION launcher link failed. Continuing with checkout launcher paths.",
    );
    expect(chunks.join("")).toContain(`Direct fallback: ${join(packageRoot, "bin/stn")} popup`);
    expect(fs.files[join(root, "home/.config/station/config.toml")]).toContain("projects = []");
  });

  it("preserves every selected harness after linking checkout launchers", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const homeDir = join(root, "home");
    const configPath = join(homeDir, ".config/station/config.toml");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const fs = fakeFs({});
    const packageRoot = setupPackageRoot();

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir,
        env: { PATH: "/fake/bin" },
        runner: fakeRunner(calls, {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
          "opencode --version": "opencode 1.0.0\n",
          [`pnpm --dir ${packageRoot} station:link`]: "",
        }),
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/hunk",
          join(packageRoot, "bin/stn"),
          join(packageRoot, "bin/stn-ingress"),
          join(packageRoot, "integrations/terminal/tmux/bin/stn-popup"),
        ]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: {
          async confirm(message) {
            return (
              message.includes("Link STATION launchers") ||
              message.includes("Write and activate core Station config")
            );
          },
          async selectMany() {
            return ["codex", "opencode"];
          },
        },
        writeStdout: () => undefined,
      },
    );

    expect(result.code).toBe(0);
    expect(calls.find((call) => call.command === "pnpm")).toMatchObject({
      args: ["--dir", packageRoot, "station:link"],
      stdio: "inherit",
    });
    expect(fs.files[configPath].match(/^\[harness\.(codex|opencode)\]$/gm)).toHaveLength(2);
  });

  it("reprompts invalid harness selection before any mutation", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const homeDir = join(root, "home");
    const configPath = join(homeDir, ".config/station/config.toml");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const fs = fakeFs({});
    const activations: string[] = [];
    const chunks: string[] = [];
    let selectionPrompts = 0;

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir,
        env: { PATH: "/fake/bin" },
        runner: fakeRunner(calls, {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
          "opencode --version": "opencode 1.0.0\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
        fs,
        activateObserverConfig: async ({ configPath: activatedPath }) => {
          activations.push(activatedPath);
        },
        prompt: {
          async confirm(message) {
            return message.includes("Write and activate core Station config");
          },
          async selectMany() {
            selectionPrompts += 1;
            expect(fs.files[configPath]).toBeUndefined();
            expect(activations).toEqual([]);
            expect(calls.some((call) => call.stdio === "inherit")).toBe(false);
            return selectionPrompts === 1 ? ["opencode", "unknown"] : ["opencode"];
          },
        },
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.code).toBe(0);
    expect(selectionPrompts).toBe(2);
    expect(chunks.join("")).toContain("Choose only values shown in this list.");
    expect(fs.files[configPath]).toContain('harness = "opencode"');
    expect(fs.files[configPath]).not.toContain("[harness.codex]");
    expect(activations).toEqual([configPath]);
  });

  it("does not silently drop a selected harness after linking checkout launchers", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const homeDir = join(root, "home");
    const configPath = join(homeDir, ".config/station/config.toml");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const fs = fakeFs({});
    const packageRoot = setupPackageRoot();
    let codexProbes = 0;
    const baseRunner = fakeRunner(calls, {
      "git rev-parse --show-toplevel": repo,
      "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
      "wt --version": "worktrunk 1.2.3\n",
      "tmux -V": "tmux 3.5a\n",
      "opencode --version": "opencode 1.0.0\n",
      [`pnpm --dir ${packageRoot} station:link`]: "",
    });
    const runner = async (input: ExternalCommandInput): Promise<ExternalCommandResult> => {
      if (input.command === "codex" && input.args?.[0] === "--version") {
        calls.push(input);
        codexProbes += 1;
        if (codexProbes === 1) return commandResult(input, "codex 0.1.0\n");
        throw Object.assign(new Error("Codex disappeared"), { code: "ENOENT" });
      }
      return baseRunner(input);
    };

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir,
        env: { PATH: "/fake/bin" },
        runner,
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/hunk",
          join(packageRoot, "bin/stn"),
          join(packageRoot, "bin/stn-ingress"),
          join(packageRoot, "integrations/terminal/tmux/bin/stn-popup"),
        ]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: {
          async confirm(message) {
            return message.includes("Link STATION launchers");
          },
          async selectMany() {
            return ["codex", "opencode"];
          },
        },
        writeStdout: () => undefined,
      },
    );

    expect(result.code).toBe(1);
    expect(codexProbes).toBe(3);
    expect(fs.files[configPath]).toBeUndefined();
  });

  it("does not let an available harness mask an unavailable existing default", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const homeDir = join(root, "home");
    const configPath = join(homeDir, ".config/station/config.toml");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const fs = fakeFs({ [configPath]: configuredProjectToml(repo) });

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir,
        env: { PATH: "/fake/bin" },
        runner: fakeRunner(calls, {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "pi --version": "pi 0.1.0\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: {
          async confirm(message) {
            return message.includes("Write and activate core Station config");
          },
          async selectMany() {
            return ["pi"];
          },
        },
        writeStdout: () => undefined,
      },
    );

    expect(result.code).toBe(1);
    expect(fs.files[configPath]).toBe(configuredProjectToml(repo));
  });

  it("runs Worktrunk shell integration non-interactively after the STATION prompt", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const homeDir = join(root, "home");
    const zshrc = join(homeDir, ".zshrc");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const fs = fakeFs({ [zshrc]: "# existing zsh config\n" });
    const chunks: string[] = [];

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir,
        env: { PATH: "/fake/bin", SHELL: "/bin/zsh" },
        runner: fakeRunner(calls, {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
          "wt -y config shell install zsh": "",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: prompt({ confirms: [false, false, true, true, false] }),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.code).toBe(0);
    expect(
      calls.find(
        (call) =>
          call.command === "/fake/bin/wt" &&
          call.args?.[0] === "-y" &&
          !call.args.includes("--dry-run"),
      ),
    ).toMatchObject({
      args: ["-y", "config", "shell", "install", "zsh"],
      stdio: "inherit",
    });
    expect(fs.files[zshrc]).toBe("# existing zsh config\n");
    expect(chunks.join("")).toContain(
      "Starting: Install Worktrunk shell integration. Native output follows.",
    );
    expect(chunks.join("")).toContain("Finished: Install Worktrunk shell integration.");
  });

  it("keeps an unreadable shell rc probe inside the optional integration step", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const homeDir = join(root, "home");
    const zshrc = join(homeDir, ".zshrc");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const fs = fakeFs({ [zshrc]: "# existing zsh config\n" });
    const baseAccess = fs.access.bind(fs);
    fs.access = async (path) => {
      if (path === zshrc) throw Object.assign(new Error("symlink loop"), { code: "ELOOP" });
      await baseAccess(path);
    };
    const chunks: string[] = [];

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir,
        env: { PATH: "/fake/bin", SHELL: "/bin/zsh" },
        runner: fakeRunner(calls, {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: prompt({ confirms: [false, false, true, true, false] }),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.code).toBe(0);
    expect(
      calls.find(
        (call) =>
          call.command === "/fake/bin/wt" &&
          call.args?.[0] === "-y" &&
          !call.args.includes("--dry-run"),
      ),
    ).toMatchObject({
      args: ["-y", "config", "shell", "install", "zsh"],
    });
    expect(fs.files[zshrc]).toBe("# existing zsh config\n");
    expect(chunks.join("")).toContain(
      "Optional Worktrunk shell integration was not installed; core setup is complete.",
    );
    expect(chunks.join("")).toContain("Run: /fake/bin/wt -y config shell install zsh");
    expect(chunks.join("")).toContain("Failed: Install Worktrunk shell integration.");
  });

  it("declines required tracking before config or provider mutation", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "home/.config/station/config.toml");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const fs = fakeFs({});
    const chunks: string[] = [];

    const result = await setupCommand.runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: fakeRunner(calls, {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
        fs,
        prompt: toSetupPromptAdapter({
          prompt: {
            async confirm() {
              return false;
            },
            async selectMany() {
              return ["codex"];
            },
          },
          report: (message) => {
            chunks.push(`${message}\n`);
          },
        }),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.code).toBe(1);
    expect(fs.files[configPath]).toBeUndefined();
    expect(calls.some((call) => (call.args ?? []).includes("hooks"))).toBe(false);
    expect(chunks.join("")).toContain("Required agent tracking was declined");
    expect(chunks.join("")).not.toContain("Core setup complete");
  });

  it("dispatches typed cancellation and starts no later mutation", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "home/.config/station/config.toml");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const cancellations: string[] = [];

    const result = await setupCommand.runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        ...readySetupDeps(repo),
        fs,
        prompt: cancellingSetupPrompt(cancellations),
        writeStdout: () => undefined,
      },
    );

    expect(result.code).toBe(1);
    expect(cancellations).toEqual([
      "Setup cancelled. Changes already completed were kept. Run stn setup again to inspect the current state and continue.",
    ]);
    expect(fs.files[configPath]).toBeUndefined();
  });

  it("declining config write produces no writes", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    let activations = 0;

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
        fs,
        activateObserverConfig: async () => {
          activations += 1;
        },
        prompt: prompt({ confirms: [false, false, false] }),
        writeStdout: () => undefined,
      },
    );

    expect(result.code).toBe(1);
    expect(Object.keys(fs.files)).toEqual([]);
    expect(activations).toBe(0);
  });

  it("does not activate when the existing config needs no write", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const homeDir = join(root, "home");
    const configPath = join(homeDir, ".config/station/config.toml");
    await mkdir(repo, { recursive: true });
    const preparedConfig = configuredProjectToml(repo).replace(
      'command = "codex"',
      'command = "codex"\ninstall_hooks = true',
    );
    const fs = fakeFs({ [configPath]: preparedConfig });
    const chunks: string[] = [];
    let activations = 0;

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir,
        env: { PATH: "/fake/bin" },
        ...readySetupDeps(repo),
        fs,
        activateObserverConfig: async () => {
          activations += 1;
        },
        prompt: prompt({ confirms: [false, false] }),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    const output = chunks.join("");
    expect(result.code).toBe(0);
    expect(activations).toBe(0);
    expect(fs.files[configPath]).toBe(preparedConfig);
    expect(output).not.toContain("MISSING   Codex tracking");
    expect(output).not.toContain("WILL      Install Codex tracking");
  });

  it("enables and installs hooks for an already-configured harness", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const homeDir = join(root, "home");
    const configPath = join(homeDir, ".config/station/config.toml");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({ [configPath]: configuredProjectToml(repo) });
    const calls: ExternalCommandInput[] = [];
    let activations = 0;

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir,
        env: { PATH: "/fake/bin" },
        runner: fakeRunner(calls, {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
          [`stn --config ${configPath} hooks install codex --yes --hook-bin /fake/bin/stn-ingress`]:
            "",
        }),
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/hunk",
          "/fake/bin/stn",
          "/fake/bin/stn-ingress",
          "/fake/bin/stn-tmux-popup",
        ]),
        fs,
        activateObserverConfig: async () => {
          activations += 1;
        },
        prompt: {
          async confirm(message) {
            return (
              message.includes("Codex agent hooks") ||
              message.includes("Write and activate core Station config")
            );
          },
          async selectMany() {
            return ["codex"];
          },
        },
        writeStdout: () => undefined,
      },
    );

    expect(result.code).toBe(0);
    expect(activations).toBe(1);
    expect(fs.files[configPath]).toContain(
      '[harness.codex]\ninstall_hooks = true\nenabled = true\ncommand = "codex"',
    );
    expect(calls.some((call) => (call.args ?? []).includes("hooks"))).toBe(false);
  });

  it("prepares explicit selections and the preserved configured default", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const homeDir = join(root, "home");
    const configPath = join(homeDir, ".config/station/config.toml");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({ [configPath]: configuredProjectToml(repo) });
    const calls: ExternalCommandInput[] = [];
    const prompts: string[] = [];
    const preparedProviders: string[] = [];

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir,
        env: { PATH: "/fake/bin" },
        runner: fakeRunner(calls, {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
          "opencode --version": "opencode 1.0.0\n",
          [`stn --config ${configPath} hooks install opencode --yes`]: "",
        }),
        providerTrackingPort: async (operation) => {
          preparedProviders.push(
            operation.kind === "prepare-worktrunk-tracking" ? "worktrunk" : operation.harnessId,
          );
          return successfulProviderTrackingPort(operation);
        },
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/hunk",
          "/fake/bin/stn",
          "/fake/bin/stn-ingress",
          "/fake/bin/stn-tmux-popup",
        ]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: {
          async confirm(message) {
            prompts.push(message);
            return (
              message.includes("OpenCode agent hooks") ||
              message.includes("Write and activate core Station config")
            );
          },
          async selectMany() {
            return ["opencode"];
          },
        },
        writeStdout: () => undefined,
      },
    );

    expect(result.code).toBe(0);
    expect(prompts).not.toContain("Install OpenCode agent hooks?");
    expect(prompts).not.toContain("Install Codex agent hooks?");
    expect(preparedProviders).toEqual(["opencode", "codex"]);
    expect(calls.some((call) => (call.args ?? []).includes("hooks"))).toBe(false);
    expect(fs.files[configPath].match(/^harness = "codex"$/gm)).toHaveLength(1);
    expect(fs.files[configPath].match(/^\[harness\.codex\]$/gm)).toHaveLength(1);
    expect(fs.files[configPath].match(/^\[harness\.opencode\]$/gm)).toHaveLength(1);
    expect(fs.files[configPath]).toContain(
      '[harness.opencode]\nenabled = true\ncommand = "opencode"\ninstall_hooks = true',
    );
  });

  it("does not activate when the config write fails", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    fs.rename = async () => {
      throw new Error("synthetic rename failure");
    };
    let activations = 0;
    const chunks: string[] = [];

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        ...readySetupDeps(repo),
        fs,
        activateObserverConfig: async () => {
          activations += 1;
        },
        prompt: prompt({ confirms: [false, false, true] }),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.code).toBe(1);
    expect(activations).toBe(0);
    expect(fs.files[join(root, "home/.config/station/config.toml")]).toBeUndefined();
    expect(chunks.join("")).toContain("Config write failed.");
  });

  it("retains config and reports observer activation failure", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "home/.config/station/config.toml");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const chunks: string[] = [];
    let activations = 0;

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        ...readySetupDeps(repo),
        fs,
        activateObserverConfig: async () => {
          activations += 1;
          throw {
            tag: "ObserverStartupError",
            code: "TEST_ACTIVATION_FAILED",
            message: "The observer did not become healthy.",
            hint: "Inspect observer logs.",
          };
        },
        prompt: prompt({ confirms: [false, false, true] }),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    const output = chunks.join("");
    expect(result.code).toBe(1);
    expect(activations).toBe(1);
    expect(fs.files[configPath]).toContain("projects = []");
    expect(output).toContain("Config was written, but observer activation failed.");
    expect(output).toContain("Code: TEST_ACTIVATION_FAILED");
    expect(output).toContain("Hint: Inspect observer logs.");
    expect(output).toContain("The config is saved; remaining setup actions were not applied.");
    expect(output).toContain("Resolve the error above, then activate it with:");
    expect(output).toContain(`Run: stn --config ${configPath} observer restart`);
    expect(output).toContain(`Then rerun: stn --config ${configPath} setup apply --yes`);
    expect(output).not.toContain("Applying: Install Codex tracking");
    expect(output).not.toContain("Core setup complete.");
  });

  it("writes every selected harness and uses the explicit new-config default", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});

    await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
          "opencode --version": "opencode 1.0.0\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: prompt({
          confirms: [false, false, true, false, false],
          multiSelects: [["opencode", "codex"]],
          singleSelects: ["codex"],
        }),
        writeStdout: () => undefined,
      },
    );

    const config = fs.files[join(root, "home/.config/station/config.toml")];
    expect(config).toContain('harness = "codex"');
    expect(config).toContain("[harness.opencode]");
    expect(config).toContain("[harness.codex]");
  });

  it("installs the optional tmux popup binding when accepted", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "home/.config/station/config.toml");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const chunks: string[] = [];

    const result = await runSetupCommand(
      [],
      { configPath },
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        compiled: true,
        tmuxPopupOwnerRoot: "/fake/bin",
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/hunk",
          "/fake/bin/stn",
          "/fake/bin/stn-ingress",
          "/fake/bin/stn-tmux-popup",
        ]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: popupInstallPrompt,
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.code, chunks.join("")).toBe(0);
    const tmuxConfig = fs.files[join(root, "home/.tmux.conf")];
    expect(tmuxConfig).toContain(
      tmuxPopupBindingBlock("/fake/bin/stn-tmux-popup", {
        runShellCommand: tmuxPopupRunShellCommand("/fake/bin/stn-tmux-popup", configPath),
      }),
    );
    expect(chunks.join("")).toContain(
      "Tmux popup binding: tmux prefix + Space is persisted for future tmux servers",
    );
    expect(chunks.join("")).toContain("Direct fallback: stn popup");
  }, 15_000);

  it("does not offer or replace a user-configured tmux prefix key", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const homeDir = join(root, "home");
    const tmuxConfigPath = join(homeDir, ".tmux.conf");
    const originalTmuxConfig = "bind-key Space display-message 'custom action'\n";
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({ [tmuxConfigPath]: originalTmuxConfig });
    const prompts: string[] = [];

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir,
        env: { PATH: "/fake/bin" },
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/hunk",
          "/fake/bin/stn",
          "/fake/bin/stn-ingress",
          "/fake/bin/stn-tmux-popup",
        ]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: {
          async confirm(message) {
            prompts.push(message);
            return message.startsWith("Write and activate core Station config?");
          },
          async selectMany() {
            return ["codex"];
          },
        },
        writeStdout: () => undefined,
      },
    );

    expect(result.code).toBe(0);
    expect(fs.files[tmuxConfigPath]).toBe(originalTmuxConfig);
    expect(prompts.some((message) => message.startsWith("Install or load tmux"))).toBe(false);
  });

  it("preserves a customized tmux key while replacing Station's command", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const homeDir = join(root, "home");
    const tmuxConfigPath = join(homeDir, ".tmux.conf");
    const originalTmuxConfig = tmuxPopupBindingBlock("/old/stn-tmux-popup", {
      bindingKey: "C-s",
    });
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({ [tmuxConfigPath]: originalTmuxConfig });
    const chunks: string[] = [];

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir,
        env: { PATH: "/fake/bin" },
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/hunk",
          "/fake/bin/stn",
          "/fake/bin/stn-ingress",
          "/fake/bin/stn-tmux-popup",
        ]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: popupInstallPrompt,
        now: () => new Date("2026-06-08T12:00:00.000Z"),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    const tmuxConfig = fs.files[tmuxConfigPath];
    expect(result.code).toBe(0);
    expect(fs.files[`${tmuxConfigPath}.2026-06-08T12-00-00-000Z.bak`]).toBe(originalTmuxConfig);
    expect(tmuxConfig).toContain("bind-key C-s run-shell -b");
    expect(tmuxConfig).toContain("'/fake/bin/stn-tmux-popup'");
    expect(tmuxConfig).not.toContain("/old/stn-tmux-popup");
    expect(chunks.join("")).toContain("Tmux popup binding: tmux prefix + C-s is persisted");
  });

  it.each([
    ["the existing file is unreadable", "read"],
    ["the backup cannot be created", "backup"],
  ] as const)("does not replace tmux config when %s", async (_description, failure) => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const homeDir = join(root, "home");
    const tmuxConfigPath = join(homeDir, ".tmux.conf");
    const originalTmuxConfig = "set -g mouse on\n";
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({ [tmuxConfigPath]: originalTmuxConfig });
    const readFile = fs.readFile.bind(fs);
    const writeFile = fs.writeFile.bind(fs);
    let rejectTmuxPersistence = false;
    fs.readFile = async (path) => {
      if (rejectTmuxPersistence && failure === "read" && path === tmuxConfigPath) {
        throw Object.assign(new Error("tmux config denied"), { code: "EACCES" });
      }
      return readFile(path);
    };
    fs.writeFile = async (path, content) => {
      if (
        rejectTmuxPersistence &&
        failure === "backup" &&
        path.startsWith(`${tmuxConfigPath}.`) &&
        path.endsWith(".bak")
      ) {
        throw Object.assign(new Error("tmux backup denied"), { code: "EACCES" });
      }
      return writeFile(path, content);
    };
    const chunks: string[] = [];

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir,
        env: { PATH: "/fake/bin" },
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/hunk",
          "/fake/bin/stn",
          "/fake/bin/stn-ingress",
          "/fake/bin/stn-tmux-popup",
        ]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: {
          async confirm(message) {
            if (message.startsWith("Install or load tmux popup binding?")) {
              rejectTmuxPersistence = true;
              return true;
            }
            return message.startsWith("Write and activate core Station config?");
          },
          async selectMany() {
            return ["codex"];
          },
        },
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.code).toBe(0);
    expect(fs.files[tmuxConfigPath]).toBe(originalTmuxConfig);
    expect(
      Object.keys(fs.files).some(
        (path) => path.startsWith(`${tmuxConfigPath}.`) && path.endsWith(".bak"),
      ),
    ).toBe(false);
    expect(chunks.join("")).toContain("SETUP_TMUX_WRITE_FAILED");
  });

  it("does not report a rebound tmux launcher as loaded when startup still fails", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const homeDir = join(root, "home");
    const launcherCommand = "/fake/bin/stn-tmux-popup";
    const runShellCommand = tmuxPopupRunShellCommand(launcherCommand);
    const serialized = runShellCommand.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({
      [join(homeDir, ".tmux.conf")]: tmuxPopupBindingBlock(launcherCommand),
    });
    const calls: ExternalCommandInput[] = [];
    const chunks: string[] = [];

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir,
        env: { PATH: "/fake/bin", TMUX: "/tmp/tmux.sock,1,0" },
        runner: async (input) => {
          calls.push(input);
          const command = basename(input.command);
          const key = `${command} ${(input.args ?? []).join(" ")}`;
          if (key === "tmux list-keys -T prefix") {
            return commandResult(input, `bind-key -T prefix Space run-shell -b "${serialized}"\n`);
          }
          if (command === "tmux" && input.args?.[0] === "run-shell") {
            return { ...commandResult(input, ""), exitCode: 127 };
          }
          const outputs: Record<string, string> = {
            "git rev-parse --show-toplevel": repo,
            "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
            "wt --version": "worktrunk 1.2.3\n",
            "tmux -V": "tmux 3.5a\n",
            "codex --version": "codex 0.1.0\n",
          };
          const stdout = outputs[key] ?? defaultProbeOutput(key);
          if (stdout !== undefined) return commandResult(input, stdout);
          if (command === "tmux" && input.args?.[0] === "bind-key") {
            return commandResult(input, "");
          }
          if ((input.args ?? []).includes("hooks") && (input.args ?? []).includes("install")) {
            return commandResult(input, "");
          }
          throw Object.assign(new Error(`missing fake command: ${key}`), { code: "ENOENT" });
        },
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/hunk",
          "/fake/bin/stn",
          "/fake/bin/stn-ingress",
          launcherCommand,
        ]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: popupInstallPrompt,
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    const output = chunks.join("");
    expect(result.code).toBe(0);
    expect(output).toContain(
      "Tmux popup binding: tmux prefix + Space is persisted for future tmux servers; no current server was live-loaded.",
    );
    expect(output).not.toContain("persisted and loaded in the current tmux server");
    // Intent-bound replanning plus the mutation-boundary recheck probe launcher startup.
    expect(
      calls.filter((call) => basename(call.command) === "tmux" && call.args?.[0] === "run-shell"),
    ).toHaveLength(8);
  });

  it("delegates Worktrunk launcher composition while resolving the agent ingress launcher", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const calls: ExternalCommandInput[] = [];
    const configPath = join(root, "home/.config/station/config.toml");
    const order: string[] = [];
    const runner = fakeRunner(calls, {
      "git rev-parse --show-toplevel": repo,
      "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
      "wt --version": "worktrunk 1.2.3\n",
      "tmux -V": "tmux 3.5a\n",
      "codex --version": "codex 0.1.0\n",
      "opencode --version": "opencode 1.0.0\n",
      [`stn --config ${configPath} hooks install worktrunk --yes`]: "",
      [`stn --config ${configPath} hooks install codex --yes --hook-bin /fake/bin/stn-ingress`]: "",
      [`stn --config ${configPath} hooks install opencode --yes`]: "",
    });

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: async (input) => {
          const result = await runner(input);
          if (input.command === "/fake/bin/stn" && input.args?.[2] === "hooks") {
            order.push(`hook:${input.args[4]}`);
          }
          return result;
        },
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/hunk",
          "/fake/bin/stn",
          "/fake/bin/stn-ingress",
          "/fake/bin/stn-tmux-popup",
        ]),
        fs,
        activateObserverConfig: async () => {
          order.push("activate");
        },
        providerTrackingPort: async (operation) => {
          order.push(
            `hook:${
              operation.kind === "prepare-worktrunk-tracking" ? "worktrunk" : operation.harnessId
            }`,
          );
          return successfulProviderTrackingPort(operation);
        },
        prompt: prompt({
          confirms: [true, true, true, true, false, false],
          multiSelects: [["codex", "opencode"]],
        }),
        writeStdout: () => undefined,
      },
    );

    expect(result.code).toBe(0);
    expect(order).toEqual(["activate", "hook:worktrunk", "hook:codex", "hook:opencode"]);
    expect(fs.files[configPath]).toContain("use_lifecycle_hooks = true");
    expect(fs.files[configPath].match(/install_hooks = true/g)).toHaveLength(2);
    expect(calls.some((call) => (call.args ?? []).includes("hooks"))).toBe(false);
  });

  it("uses fresh tracking evidence after a later hook installer reports failure", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "home/.config/station/config.toml");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const chunks: string[] = [];
    let activations = 0;

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: async (input) => {
          if ((input.args ?? []).includes("hooks") && (input.args ?? []).includes("install")) {
            throw new Error("synthetic hook install failure");
          }
          return fakeRunner([], {
            "git rev-parse --show-toplevel": repo,
            "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
            "wt --version": "worktrunk 1.2.3\n",
            "tmux -V": "tmux 3.5a\n",
            "codex --version": "codex 0.1.0\n",
          })(input);
        },
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/hunk",
          "/fake/bin/stn",
          "/fake/bin/stn-ingress",
          "/fake/bin/stn-tmux-popup",
        ]),
        fs,
        activateObserverConfig: async () => {
          activations += 1;
        },
        providerTrackingPort: async (operation) => ({
          status: "failed",
          operationId: operation.id,
          error: {
            tag: "SyntheticTrackingError",
            code: "SYNTHETIC_TRACKING_FAILED",
            message: "synthetic hook install failure",
          },
        }),
        prompt: prompt({ confirms: [true, true] }),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    const output = chunks.join("");
    expect(result.code).toBe(0);
    expect(activations).toBe(1);
    expect(fs.files[configPath]).toContain("use_lifecycle_hooks = true");
    expect(output).toContain("Hook install failed.");
    expect(output).toContain("Observer configuration active.");
    expect(output).toContain("Core setup complete.");
  });

  it("continues after one agent hook fails and retries enabled hooks on the next run", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const homeDir = join(root, "home");
    const configPath = join(homeDir, ".config/station/config.toml");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const calls: ExternalCommandInput[] = [];
    let codexHookAttempts = 0;
    const baseRunner = fakeRunner(calls, {
      "git rev-parse --show-toplevel": repo,
      "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
      "wt --version": "worktrunk 1.2.3\n",
      "tmux -V": "tmux 3.5a\n",
      "codex --version": "codex 0.1.0\n",
      "opencode --version": "opencode 1.0.0\n",
      [`stn --config ${configPath} hooks install codex --yes --hook-bin /fake/bin/stn-ingress`]: "",
      [`stn --config ${configPath} hooks install opencode --yes`]: "",
    });
    let openCodeHookAttempts = 0;
    const promptAdapter: GuidedPromptFixture = {
      async confirm(message) {
        return (
          message.includes("Codex tracking") ||
          message.includes("OpenCode tracking") ||
          message.includes("Write and activate core Station config")
        );
      },
      async selectMany() {
        return ["codex", "opencode"];
      },
    };
    const deps: GuidedSetupCommandDeps = {
      cwd: repo,
      homeDir,
      env: { PATH: "/fake/bin" },
      runner: baseRunner,
      access: fakeAccess([
        "/fake/bin/wt",
        "/fake/bin/tmux",
        "/fake/bin/bun",
        "/fake/bin/hunk",
        "/fake/bin/stn",
        "/fake/bin/stn-ingress",
        "/fake/bin/stn-tmux-popup",
      ]),
      fs,
      activateObserverConfig: noopActivateObserverConfig,
      providerTrackingPort: async (operation) => {
        if (operation.kind === "prepare-worktrunk-tracking") {
          return successfulProviderTrackingPort(operation);
        }
        if (operation.harnessId === "codex") {
          codexHookAttempts += 1;
          if (codexHookAttempts === 1) {
            throw new Error("synthetic Codex hook failure");
          }
        }
        if (operation.harnessId === "opencode") openCodeHookAttempts += 1;
        return successfulProviderTrackingPort(operation);
      },
      probeHarnessHooksStatus: async (
        harnessId: "codex" | "opencode" | "pi" | "cursor" | "claude",
      ) => {
        if (harnessId === "pi") return undefined;
        const installed = harnessId === "codex" ? codexHookAttempts > 1 : openCodeHookAttempts > 0;
        return {
          provider: harnessId,
          requested: fs.files[configPath]?.includes("install_hooks = true") === true,
          installed,
          missing: installed ? [] : ["tracking artifact"],
          message: installed
            ? "Tracking artifacts are installed."
            : "Tracking artifacts are missing.",
        };
      },
      prompt: promptAdapter,
      writeStdout: () => undefined,
    };

    const first = await runSetupCommand([], {}, deps);
    const second = await runSetupCommand([], {}, deps);

    expect(first.code).toBe(1);
    expect(second.code).toBe(0);
    expect(fs.files[configPath].match(/install_hooks = true/g)).toHaveLength(2);
    expect(codexHookAttempts).toBe(2);
    expect(openCodeHookAttempts).toBe(1);
    expect(calls.some((call) => (call.args ?? []).includes("hooks"))).toBe(false);
  });

  it("installs a selected agent CLI when no harness is available, then continues", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const calls: ExternalCommandInput[] = [];
    const chunks: string[] = [];
    let codexInstalled = false;

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        platform: "darwin",
        runner: async (input) => {
          calls.push(input);
          const key = `${input.command} ${(input.args ?? []).join(" ")}`;
          if (
            input.command === "/bin/bash" &&
            input.args?.[0] === "-c" &&
            input.args?.[1]?.includes("https://chatgpt.com/codex/install.sh") === true
          ) {
            codexInstalled = true;
            return commandResult(input, "");
          }
          if (key === "codex --version" && codexInstalled) {
            return commandResult(input, "codex 0.1.0\n");
          }
          return fakeRunner([], {
            "git rev-parse --show-toplevel": repo,
            "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
            "xcode-select -p": "/Library/Developer/CommandLineTools\n",
            "wt --version": "worktrunk 1.2.3\n",
            "tmux -V": "tmux 3.5a\n",
          })(input);
        },
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        // Accept the Codex install and the config write; decline the rest. Match on
        // message text so the test is robust to the exact prompt count (e.g. which
        // optional prompts fire depends on launcher detection on the host).
        prompt: {
          async confirm(message: string) {
            return (
              message.includes("Install Homebrew") ||
              message.includes("Install Codex?") ||
              message.includes("Write and activate core Station config")
            );
          },
          async selectMany() {
            return ["codex"];
          },
        },
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.code).toBe(0);
    expect(
      calls.find(
        (call) =>
          call.command === "/bin/bash" &&
          call.args?.[1]?.includes("https://chatgpt.com/codex/install.sh") === true,
      ),
    ).toMatchObject({
      args: ["-c", expect.stringContaining("CODEX_NON_INTERACTIVE=1")],
      stdio: "inherit",
    });
    expect(fs.files[join(root, "home/.config/station/config.toml")]).toContain("[harness.codex]");
    expect(chunks.join("")).toContain("No supported agent CLI is available.");
    expect(chunks.join("")).toContain("Starting: Install Codex. Native output follows.");
    expect(chunks.join("")).toContain("Finished: Install Codex.");
    expect(chunks.join("")).toContain(
      "Homebrew install failed.\nContinuing with non-Homebrew agent installers where supported.",
    );
  });

  it("continues installing selected agents after one installer fails", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const homeDir = join(root, "home");
    const configPath = join(homeDir, ".config/station/config.toml");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const calls: ExternalCommandInput[] = [];
    const chunks: string[] = [];
    const promptEvents: string[] = [];
    let piInstalled = false;

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir,
        env: { PATH: "/fake/bin" },
        platform: "linux",
        runner: async (input) => {
          calls.push(input);
          const key = `${input.command} ${(input.args ?? []).join(" ")}`;
          if (
            input.command === "/bin/bash" &&
            input.args?.[1]?.includes("https://chatgpt.com/codex/install.sh") === true
          ) {
            throw new Error("Codex installer failed");
          }
          if (
            key ===
            `npm install --global --prefix ${homeDir}/.local --ignore-scripts --no-fund --no-audit @earendil-works/pi-coding-agent`
          ) {
            piInstalled = true;
            return commandResult(input, "");
          }
          if (key === "pi --version" && piInstalled) {
            return commandResult(input, "pi 0.1.0\n");
          }
          return fakeRunner([], {
            "git --version": "git version 2.49.0\n",
            "git rev-parse --show-toplevel": repo,
            "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
            "wt --version": "worktrunk 1.2.3\n",
            "tmux -V": "tmux 3.5a\n",
          })(input);
        },
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: {
          async confirm(message: string) {
            return (
              message.includes("Install Codex?") ||
              message.includes("Install Pi?") ||
              message.includes("Write and activate core Station config")
            );
          },
          async selectMany() {
            return ["codex", "pi"];
          },
        },
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.code).toBe(0);
    const codexCallIndex = calls.findIndex(
      (call) =>
        call.command === "/bin/bash" &&
        call.args?.[1]?.includes("https://chatgpt.com/codex/install.sh") === true,
    );
    const piCallIndex = calls.findIndex(
      (call) => call.command === "npm" && call.args?.includes("@earendil-works/pi-coding-agent"),
    );
    expect(codexCallIndex).toBeGreaterThanOrEqual(0);
    expect(piCallIndex).toBeGreaterThan(codexCallIndex);
    expect(fs.files[configPath]).toContain("[harness.pi]");
    expect(chunks.join("")).toContain("Failed: Install Codex.");
    expect(chunks.join("")).toContain("Finished: Install Pi.");
    expect(chunks.join("")).toContain("These selected agent CLIs are still unavailable:\n- Codex");
    expect(promptEvents).toEqual([]);
  });

  it("closes prompts and writes nothing when harness install choices are declined", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const chunks: string[] = [];
    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
        fs,
        prompt: prompt({
          confirms: [false, false, false, false],
          multiSelects: [[]],
        }),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.code).toBe(1);
    expect(Object.keys(fs.files)).toEqual([]);
    expect(chunks.join("")).toContain("No agent CLI was installed.");
  });

  it("kicks the Command Line Tools installer on macOS when accepted", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const calls: ExternalCommandInput[] = [];
    const chunks: string[] = [];

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        platform: "darwin",
        runner: async (input) => {
          calls.push(input);
          const key = `${input.command} ${(input.args ?? []).join(" ")}`;
          // Bare Mac: the Command Line Tools are absent until installed.
          if (key === "xcode-select -p") {
            throw Object.assign(new Error("no developer tools"), { code: "ENOENT" });
          }
          if (key === "xcode-select --install") return commandResult(input, "");
          return commandResult(input, "");
        },
        access: fakeAccess([]),
        fs,
        prompt: prompt({ confirms: [true] }),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.code).toBe(1);
    expect(calls).toContainEqual(
      expect.objectContaining({ command: "xcode-select", args: ["--install"], stdio: "inherit" }),
    );
    expect(chunks.join("")).toContain(
      "Command Line Tools installation started in a separate window.",
    );
    expect(Object.keys(fs.files)).toEqual([]);
  });

  it("does not claim the Command Line Tools installer started when launch fails", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const chunks: string[] = [];

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        platform: "darwin",
        runner: async (input) => {
          const key = `${input.command} ${(input.args ?? []).join(" ")}`;
          if (key === "xcode-select -p") {
            throw Object.assign(new Error("no developer tools"), { code: "ENOENT" });
          }
          if (key === "xcode-select --install") {
            throw new Error("installer launch denied");
          }
          return commandResult(input, "");
        },
        access: fakeAccess([]),
        fs: fakeFs({}),
        prompt: prompt({ confirms: [true] }),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    const output = chunks.join("");
    expect(result.code).toBe(1);
    expect(output).toContain("Install Command Line Tools");
    expect(output).toContain("EXTERNAL_COMMAND_FAILED");
    expect(output).toContain("Command Line Tools installation did not start.");
    expect(output).not.toContain("installation started in a separate window");
  });

  it("prints Command Line Tools guidance on macOS when declined", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const calls: ExternalCommandInput[] = [];
    const chunks: string[] = [];

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        platform: "darwin",
        runner: async (input) => {
          calls.push(input);
          if (`${input.command} ${(input.args ?? []).join(" ")}` === "xcode-select -p") {
            throw Object.assign(new Error("no developer tools"), { code: "ENOENT" });
          }
          return commandResult(input, "");
        },
        access: fakeAccess([]),
        fs,
        prompt: prompt({ confirms: [false] }),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.code).toBe(1);
    expect(
      calls.some((call) => call.command === "xcode-select" && call.args?.[0] === "--install"),
    ).toBe(false);
    expect(chunks.join("")).toContain("Install the Command Line Tools (xcode-select --install)");
  });

  it("offers Homebrew and prints the callout when declined on macOS", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const calls: ExternalCommandInput[] = [];
    const chunks: string[] = [];

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        platform: "darwin",
        // CLT present (default probe) but Homebrew and Hunk are missing, so the
        // brew prompt fires; declining must surface the manual callout.
        runner: fakeRunner(calls, {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/delta"]),
        fs,
        prompt: prompt({ confirms: [false] }),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.code).toBe(1);
    expect(chunks.join("")).toContain("Install Homebrew first: https://brew.sh");
    expect(chunks.join("")).toContain("Command Line Tools: xcode-select --install");
    expect(calls.some((call) => call.command === "/bin/bash")).toBe(false);
  });

  it("shows a compact required-tool proposal instead of the diagnostic matrix", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const chunks: string[] = [];

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        platform: "linux",
        runner: fakeRunner(calls, {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "brew --version": "Homebrew 4.0.0\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/delta"]),
        fs: fakeFs({}),
        prompt: prompt({ confirms: [false] }),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    const output = chunks.join("");
    expect(result.code).toBe(1);
    expect(output).toContain("Set up Station on this machine.");
    expect(output).toContain("It will ask before installing tools or updating configuration.");
    expect(output).toContain("Checking local tools and Station configuration...");
    expect(output).toContain("Required tools");
    expect(output).toContain("Homebrew will install:\n- Install Hunk");
    expect(output).toContain("Official formula ↗ (https://formulae.brew.sh/formula/hunk)");
    expect(output).not.toContain("Agent selection: unresolved");
    expect(output).not.toContain("STATION state directory");
    expect(output).not.toContain("MISSING");
    expect(output).not.toMatch(/(?:^|\n)Core(?:\n|$)/);
    expect(output).not.toMatch(/(?:^|\n)Recommended(?:\n|$)/);
    expect(calls.some((call) => call.command === "brew" && call.args?.[0] === "install")).toBe(
      false,
    );
  });

  it("installs core tools after a fresh Apple-Silicon Homebrew install, then writes config", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const calls: ExternalCommandInput[] = [];
    const chunks: string[] = [];
    const configPath = join(root, "home/.config/station/config.toml");

    // Fresh arm64 Mac: CLT present, but brew and every core tool are missing. brew
    // and the brew-installed tools resolve ONLY once /opt/homebrew/bin is on the
    // probe/exec PATH — the exact state that broke onboarding before this fix.
    const installed = new Set<string>();
    let brewInstalled = false;
    const formulaTool: Record<string, string> = {
      worktrunk: "wt",
      tmux: "tmux",
      bun: "bun",
      hunk: "hunk",
    };
    const hasBrewPrefix = (input: ExternalCommandInput) =>
      input.env?.PATH?.includes("/opt/homebrew/bin") === true;

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        platform: "darwin",
        runner: async (input) => {
          calls.push(input);
          // Dependency checks run the resolved path (e.g. /opt/homebrew/bin/wt), so
          // match on the command basename, not the literal string.
          const bin = input.command.split("/").pop() ?? input.command;
          const key = `${bin} ${(input.args ?? []).join(" ")}`;
          // The official Homebrew installer (curl | bash).
          if (input.command === "/bin/bash") {
            brewInstalled = true;
            return commandResult(input, "");
          }
          // brew resolves only after install AND with its prefix on PATH.
          if (key === "brew --version") {
            if (brewInstalled && hasBrewPrefix(input)) {
              return commandResult(input, "Homebrew 4.0.0\n");
            }
            throw Object.assign(new Error("brew not found"), { code: "ENOENT" });
          }
          // `brew install` must itself run with the brew prefix on PATH, or brew is
          // unresolvable on a fresh Mac; mark the tool installed on success.
          if (bin === "brew" && input.args?.[0] === "install") {
            if (!hasBrewPrefix(input)) {
              throw Object.assign(new Error("brew not found"), { code: "ENOENT" });
            }
            const tool = formulaTool[input.args?.[1] ?? ""];
            if (tool !== undefined) installed.add(tool);
            return commandResult(input, "");
          }
          // worktrunk/tmux resolve via the brew-prefix access below (PATH sensitivity),
          // then run --version on the resolved path — gate the output on install state.
          if (key === "wt --version") {
            if (installed.has("wt")) return commandResult(input, "worktrunk 1.2.3\n");
            throw Object.assign(new Error("wt not found"), { code: "ENOENT" });
          }
          if (key === "tmux -V") {
            if (installed.has("tmux")) return commandResult(input, "tmux 3.5a\n");
            throw Object.assign(new Error("tmux not found"), { code: "ENOENT" });
          }
          const staticOutputs: Record<string, string> = {
            "git --version": "git version 2.49.0\n",
            "git rev-parse --show-toplevel": repo,
            "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
            "codex --version": "codex 0.1.0\n",
            "xcode-select -p": "/Library/Developer/CommandLineTools\n",
          };
          const out = staticOutputs[key];
          if (out !== undefined) return commandResult(input, out);
          if ((input.args ?? []).includes("hooks") && (input.args ?? []).includes("install")) {
            return commandResult(input, "");
          }
          throw Object.assign(new Error(`missing fake command: ${key}`), { code: "ENOENT" });
        },
        // bun/Hunk (and wt/tmux path resolution) live in the brew prefix and
        // resolve only once their formula has been installed.
        access: async (path) => {
          const present =
            path.startsWith(`${setupPackageRoot()}/`) ||
            (installed.has("wt") && path === "/opt/homebrew/bin/wt") ||
            (installed.has("tmux") && path === "/opt/homebrew/bin/tmux") ||
            (installed.has("bun") && path === "/opt/homebrew/bin/bun") ||
            (installed.has("hunk") && path === "/opt/homebrew/bin/hunk");
          if (!present) {
            throw Object.assign(new Error(`missing path: ${path}`), { code: "ENOENT" });
          }
        },
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        // Accept the bootstrap, the core-tool installs, and the config write; decline
        // every optional extra. Matching on text keeps this robust to prompt ordering.
        prompt: {
          async confirm(message: string) {
            return (
              message.includes("Install Homebrew") ||
              message.includes("Install these required tools") ||
              message.includes("Write and activate core Station config")
            );
          },
          async selectMany() {
            return ["codex"];
          },
        },
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.code).toBe(0);
    const output = chunks.join("");
    const completedReview = output.slice(
      output.indexOf("Already completed prerequisites"),
      output.indexOf("Will apply"),
    );
    for (const label of ["Worktrunk / wt", "tmux", "Bun", "Hunk"]) {
      expect(completedReview).toContain(`Install ${label}`);
    }
    expect(completedReview).not.toContain("Apply setup change");
    // The brew-install actions actually ran (not silent no-ops) — the discriminator:
    // before the fix the re-probe never sees brew, so these are never executed.
    expect(
      calls
        .filter((call) => call.command === "brew" && call.args?.[0] === "install")
        .map((call) => call.args?.[1]),
    ).toEqual(expect.arrayContaining(["worktrunk", "tmux", "bun", "hunk"]));
    expect(fs.files[configPath]).toContain("projects = []");
  });

  it("keeps brew tools after a fresh Mac installs its first agent CLI", async () => {
    // The harness-install path re-probes facts AFTER the brew tools were installed.
    // That re-probe must keep the brew prefix, or the just-installed core tools read
    // as missing again and config write dead-ends at exit 1. No agent CLI is present
    // initially, so ensureHarnessAvailable installs one and runs the lossy re-probe.
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const calls: ExternalCommandInput[] = [];
    const configPath = join(root, "home/.config/station/config.toml");

    const installed = new Set<string>();
    let brewInstalled = false;
    let codexInstalled = false;
    const formulaTool: Record<string, string> = {
      worktrunk: "wt",
      tmux: "tmux",
      bun: "bun",
      hunk: "hunk",
    };
    const hasBrewPrefix = (input: ExternalCommandInput) =>
      input.env?.PATH?.includes("/opt/homebrew/bin") === true;

    const result = await runSetupCommand(
      [],
      {},
      {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        platform: "darwin",
        runner: async (input) => {
          calls.push(input);
          const bin = input.command.split("/").pop() ?? input.command;
          const key = `${bin} ${(input.args ?? []).join(" ")}`;
          if (input.command === "/bin/bash") {
            brewInstalled = true;
            return commandResult(input, "");
          }
          // The agent CLI installer (no agent CLI is present until this runs).
          if (bin === "brew" && input.args?.join(" ") === "install --cask homebrew/cask/codex") {
            codexInstalled = true;
            return commandResult(input, "");
          }
          if (key === "codex --version") {
            if (codexInstalled) return commandResult(input, "codex 0.1.0\n");
            throw Object.assign(new Error("codex not found"), { code: "ENOENT" });
          }
          if (key === "brew --version") {
            if (brewInstalled && hasBrewPrefix(input)) {
              return commandResult(input, "Homebrew 4.0.0\n");
            }
            throw Object.assign(new Error("brew not found"), { code: "ENOENT" });
          }
          if (bin === "brew" && input.args?.[0] === "install") {
            if (!hasBrewPrefix(input)) {
              throw Object.assign(new Error("brew not found"), { code: "ENOENT" });
            }
            const tool = formulaTool[input.args?.[1] ?? ""];
            if (tool !== undefined) installed.add(tool);
            return commandResult(input, "");
          }
          if (key === "wt --version") {
            if (installed.has("wt")) return commandResult(input, "worktrunk 1.2.3\n");
            throw Object.assign(new Error("wt not found"), { code: "ENOENT" });
          }
          if (key === "tmux -V") {
            if (installed.has("tmux")) return commandResult(input, "tmux 3.5a\n");
            throw Object.assign(new Error("tmux not found"), { code: "ENOENT" });
          }
          const staticOutputs: Record<string, string> = {
            "git --version": "git version 2.49.0\n",
            "git rev-parse --show-toplevel": repo,
            "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
            "xcode-select -p": "/Library/Developer/CommandLineTools\n",
          };
          const out = staticOutputs[key];
          if (out !== undefined) return commandResult(input, out);
          if ((input.args ?? []).includes("hooks") && (input.args ?? []).includes("install")) {
            return commandResult(input, "");
          }
          throw Object.assign(new Error(`missing fake command: ${key}`), { code: "ENOENT" });
        },
        access: async (path) => {
          const present =
            path.startsWith(`${setupPackageRoot()}/`) ||
            (installed.has("wt") && path === "/opt/homebrew/bin/wt") ||
            (installed.has("tmux") && path === "/opt/homebrew/bin/tmux") ||
            (installed.has("bun") && path === "/opt/homebrew/bin/bun") ||
            (installed.has("hunk") && path === "/opt/homebrew/bin/hunk");
          if (!present) {
            throw Object.assign(new Error(`missing path: ${path}`), { code: "ENOENT" });
          }
        },
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: {
          async confirm(message: string) {
            return (
              message.includes("Install Homebrew") ||
              message.includes("Install these required tools") ||
              message.includes("Install Codex") ||
              message.includes("Write and activate core Station config")
            );
          },
          async selectMany() {
            return ["codex"];
          },
        },
        writeStdout: () => undefined,
      },
    );

    // Without the brew prefix on the post-agent-install re-probe this exits 1 with no
    // config: the brew tools (resolvable only under /opt/homebrew/bin) re-read missing.
    expect(result.code).toBe(0);
    expect(
      calls.some(
        (call) =>
          call.command === "brew" && call.args?.join(" ") === "install --cask homebrew/cask/codex",
      ),
    ).toBe(true);
    expect(fs.files[configPath]).toContain("projects = []");
  });
});

async function tempRoot(tempRoots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "station-setup-guided-"));
  tempRoots.push(root);
  return root;
}

function prompt(input: {
  confirms: boolean[];
  multiSelects?: string[][];
  singleSelects?: string[];
}): GuidedPromptFixture {
  const confirms = [...input.confirms];
  const multiSelects = [...(input.multiSelects ?? [])];
  const singleSelects = [...(input.singleSelects ?? [])];
  return {
    async confirm() {
      return confirms.shift() ?? false;
    },
    async selectMany() {
      return multiSelects.shift() ?? ["codex"];
    },
    async selectOne(request) {
      return singleSelects.shift() ?? request.choices[0]?.value ?? "";
    },
  };
}

const popupInstallPrompt: GuidedPromptFixture = {
  async confirm(message) {
    return (
      message.startsWith("Write and activate core Station config?") ||
      message.startsWith("Install or load tmux popup binding?")
    );
  },
  async selectMany() {
    return ["codex"];
  },
};

function readySetupDeps(repo: string) {
  return {
    runner: fakeRunner([], {
      "git rev-parse --show-toplevel": repo,
      "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
      "wt --version": "worktrunk 1.2.3\n",
      "tmux -V": "tmux 3.5a\n",
      "brew --version": "Homebrew 4.0.0\n",
      "codex --version": "codex 0.1.0\n",
    }),
    access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
  };
}

function configuredProjectToml(repo: string): string {
  return [
    "schema_version = 1",
    "",
    "[defaults]",
    'worktree_provider = "worktrunk"',
    'terminal = "tmux"',
    'harness = "codex"',
    'layout = "agent-shell"',
    "",
    "[harness.codex]",
    "enabled = true",
    'command = "codex"',
    "",
    "[[projects]]",
    'id = "repo"',
    'label = "repo"',
    `root = ${JSON.stringify(repo)}`,
    "",
  ].join("\n");
}

function noopActivateObserverConfig(): Promise<void> {
  return Promise.resolve();
}

function cancellingSetupPrompt(cancellations: string[]): setupCommand.SetupPromptAdapter {
  const noop = () => undefined;
  return {
    isInteractiveTerminal: () => true,
    intro: noop,
    outro: noop,
    cancel: (message) => cancellations.push(message),
    async confirm() {
      return { kind: "cancelled" };
    },
    async selectOne() {
      return { kind: "cancelled" };
    },
    async selectMany() {
      return { kind: "cancelled" };
    },
    note: noop,
    logStep: noop,
    logSuccess: noop,
    logWarn: noop,
    logError: noop,
    logInfo: noop,
  };
}

function fakeRunner(
  calls: ExternalCommandInput[],
  outputs: Record<string, string>,
): (input: ExternalCommandInput) => Promise<ExternalCommandResult> {
  return async (input) => {
    calls.push(input);
    const key = `${input.command} ${(input.args ?? []).join(" ")}`;
    // Synthetic machines have macOS Command Line Tools unless a test overrides it.
    const stdout =
      outputs[key] ??
      fakeBinOutput(input, outputs) ??
      ((input.args ?? []).includes("hooks") && (input.args ?? []).includes("install")
        ? ""
        : undefined) ??
      defaultProbeOutput(key);
    if (stdout === undefined) {
      throw Object.assign(new Error(`missing fake command: ${key}`), { code: "ENOENT" });
    }
    return commandResult(input, stdout);
  };
}

function fakeBinOutput(
  input: ExternalCommandInput,
  outputs: Record<string, string>,
): string | undefined {
  if (!input.command.startsWith("/fake/bin/")) {
    return undefined;
  }
  return outputs[`${basename(input.command)} ${(input.args ?? []).join(" ")}`];
}

function defaultProbeOutput(key: string): string | undefined {
  if (key === "git --version") return "git version 2.49.0\n";
  return key === "xcode-select -p" ? "/Library/Developer/CommandLineTools\n" : undefined;
}

function commandResult(input: ExternalCommandInput, stdout: string): ExternalCommandResult {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout,
    stderr: "",
    exitCode: 0,
  };
}

function fakeAccess(paths: readonly string[]): (path: string) => Promise<void> {
  const available = new Set(paths);
  const packageRoot = setupPackageRoot();
  return async (path) => {
    if (!available.has(path) && !path.startsWith(`${packageRoot}/`)) {
      throw Object.assign(new Error(`missing path: ${path}`), { code: "ENOENT" });
    }
  };
}

function fakeFs(initial: Record<string, string>) {
  const files = { ...initial };
  return {
    files,
    async mkdir() {
      return undefined;
    },
    async readFile(path: string) {
      const content = files[path];
      if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return content;
    },
    async writeFile(path: string, content: string) {
      files[path] = content;
    },
    async rename(from: string, to: string) {
      const content = files[from];
      if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      files[to] = content;
      delete files[from];
    },
    async access(path: string) {
      if (files[path] === undefined) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
    },
  };
}
