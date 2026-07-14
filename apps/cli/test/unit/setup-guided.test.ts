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
import { runSetupCommand, type SetupPromptAdapter } from "../../src/commands/setup/index.js";

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
          "tmux -V": "tmux 3.5a\n",
          "brew --version": "Homebrew 4.0.0\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/diffnav",
          "/fake/bin/delta",
        ]),
        fs,
        activateObserverConfig: async (input) => {
          expect(fs.files[input.configPath]).toContain("[[projects]]");
          activations.push(input);
        },
        prompt: prompt({ confirms: [false, false, true, false, false] }),
        writeStdout: (chunk) => chunks.push(chunk),
        now: () => new Date("2026-06-08T12:00:00.000Z"),
      },
    );

    expect(result.code).toBe(0);
    const configPath = join(root, "home/.config/station/config.toml");
    expect(fs.files[configPath]).toContain("[[projects]]");
    expect(activations).toEqual([{ configPath, homeDir: join(root, "home") }]);
    expect(chunks.join("")).toContain(`Applying: Write STATION config (${configPath})`);
    expect(chunks.join("")).toContain("Completed: Write STATION config");
    expect(chunks.join("")).toContain("Observer configuration active.");
    expect(chunks.join("")).toContain("Core setup complete.");
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
          "tmux -V": "tmux 3.5a\n",
          "brew --version": "Homebrew 4.0.0\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/diffnav",
          "/fake/bin/delta",
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
              message.includes("Write STATION project config") ||
              message.includes("Install or load tmux popup binding")
            );
          },
          async select() {
            return "codex";
          },
        },
        writeStdout: (chunk) => chunks.push(chunk),
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
    expect(fs.files[join(root, "home/.config/station/config.toml")]).toContain("[[projects]]");
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
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/diffnav",
          "/fake/bin/delta",
        ]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: prompt({ confirms: [false, false, true, true, false] }),
        writeStdout: (chunk) => chunks.push(chunk),
      },
    );

    expect(result.code).toBe(0);
    expect(calls.find((call) => call.command === "wt" && call.args?.[0] === "-y")).toMatchObject({
      args: ["-y", "config", "shell", "install", "zsh"],
      stdio: "inherit",
    });
    expect(fs.files[zshrc]).toBe("# existing zsh config\n");
    expect(chunks.join("")).toContain("Running: wt -y config shell install zsh");
    expect(chunks.join("")).toContain("Completed: Install Worktrunk shell integration");
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
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/diffnav",
          "/fake/bin/delta",
        ]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: prompt({ confirms: [false, false, true, true, false] }),
        writeStdout: (chunk) => chunks.push(chunk),
      },
    );

    expect(result.code).toBe(0);
    expect(calls.find((call) => call.command === "wt" && call.args?.[0] === "-y")).toMatchObject({
      args: ["-y", "config", "shell", "install", "zsh"],
    });
    expect(fs.files[zshrc]).toBe("# existing zsh config\n");
    expect(chunks.join("")).toContain(
      "Optional Worktrunk shell integration was not installed; core setup is complete.",
    );
    expect(chunks.join("")).toContain("Run: wt -y config shell install zsh");
    expect(chunks.join("")).not.toContain("Failed: Install Worktrunk shell integration");
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
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/diffnav",
          "/fake/bin/delta",
        ]),
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
    const fs = fakeFs({ [configPath]: configuredProjectToml(repo) });
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
        writeStdout: () => undefined,
      },
    );

    expect(result.code).toBe(0);
    expect(activations).toBe(0);
    expect(fs.files[configPath]).toBe(configuredProjectToml(repo));
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
        writeStdout: (chunk) => chunks.push(chunk),
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
        writeStdout: (chunk) => chunks.push(chunk),
      },
    );

    const output = chunks.join("");
    expect(result.code).toBe(1);
    expect(activations).toBe(1);
    expect(fs.files[configPath]).toContain("[[projects]]");
    expect(output).toContain("Config was written, but observer activation failed.");
    expect(output).toContain("Code: TEST_ACTIVATION_FAILED");
    expect(output).toContain("Hint: Inspect observer logs.");
    expect(output).toContain(`Run: stn --config ${configPath} observer restart`);
    expect(output).not.toContain("Core setup complete.");
  });

  it("selects among multiple available harnesses", async () => {
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
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/diffnav",
          "/fake/bin/delta",
        ]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: prompt({ confirms: [false, false, true, false, false], selects: ["opencode"] }),
        writeStdout: () => undefined,
      },
    );

    expect(fs.files[join(root, "home/.config/station/config.toml")]).toContain(
      "[harness.opencode]",
    );
  });

  it("installs the optional tmux popup binding when accepted", async () => {
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
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/diffnav",
          "/fake/bin/delta",
          "/fake/bin/stn",
          "/fake/bin/stn-ingress",
          "/fake/bin/stn-tmux-popup",
        ]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: prompt({ confirms: [false, false, true, false, true] }),
        writeStdout: (chunk) => chunks.push(chunk),
      },
    );

    expect(result.code).toBe(0);
    expect(fs.files[join(root, "home/.tmux.conf")]).toContain("'/fake/bin/stn-tmux-popup'");
    expect(chunks.join("")).toContain(
      "Tmux popup binding: Ctrl-b Space is persisted for future tmux servers",
    );
    expect(chunks.join("")).toContain("Direct fallback: stn popup");
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
          throw Object.assign(new Error(`missing fake command: ${key}`), { code: "ENOENT" });
        },
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/diffnav",
          "/fake/bin/delta",
          "/fake/bin/stn",
          "/fake/bin/stn-ingress",
          launcherCommand,
        ]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        prompt: prompt({ confirms: [false, false, true, false, true] }),
        writeStdout: (chunk) => chunks.push(chunk),
      },
    );

    const output = chunks.join("");
    expect(result.code).toBe(0);
    expect(output).toContain(
      "Tmux popup binding: Ctrl-b Space is persisted for future tmux servers; no current server was live-loaded.",
    );
    expect(output).not.toContain("persisted and loaded in the current tmux server");
    expect(
      calls.filter((call) => basename(call.command) === "tmux" && call.args?.[0] === "run-shell"),
    ).toHaveLength(2);
  });

  it("installs accepted Worktrunk and agent hooks with resolved ingress launcher", async () => {
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
      [`stn --config ${configPath} hooks install worktrunk --yes --hook-bin /fake/bin/stn-ingress`]:
        "",
      [`stn --config ${configPath} hooks install codex --yes --hook-bin /fake/bin/stn-ingress`]: "",
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
          "/fake/bin/diffnav",
          "/fake/bin/delta",
          "/fake/bin/stn",
          "/fake/bin/stn-ingress",
          "/fake/bin/stn-tmux-popup",
        ]),
        fs,
        activateObserverConfig: async () => {
          order.push("activate");
        },
        prompt: prompt({ confirms: [true, true, true, false, false] }),
        writeStdout: () => undefined,
      },
    );

    expect(result.code).toBe(0);
    expect(order).toEqual(["hook:worktrunk", "hook:codex", "activate"]);
    expect(fs.files[configPath]).toContain("use_lifecycle_hooks = true");
    expect(fs.files[configPath]).toContain("install_hooks = true");
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "/fake/bin/stn",
          args: [
            "--config",
            configPath,
            "hooks",
            "install",
            "worktrunk",
            "--yes",
            "--hook-bin",
            "/fake/bin/stn-ingress",
          ],
          stdio: "inherit",
        }),
        expect.objectContaining({
          command: "/fake/bin/stn",
          args: [
            "--config",
            configPath,
            "hooks",
            "install",
            "codex",
            "--yes",
            "--hook-bin",
            "/fake/bin/stn-ingress",
          ],
          stdio: "inherit",
        }),
      ]),
    );
  });

  it("attempts activation after a hook install fails", async () => {
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
          "/fake/bin/diffnav",
          "/fake/bin/delta",
          "/fake/bin/stn",
          "/fake/bin/stn-ingress",
          "/fake/bin/stn-tmux-popup",
        ]),
        fs,
        activateObserverConfig: async () => {
          activations += 1;
        },
        prompt: prompt({ confirms: [true, false, true] }),
        writeStdout: (chunk) => chunks.push(chunk),
      },
    );

    const output = chunks.join("");
    expect(result.code).toBe(1);
    expect(activations).toBe(1);
    expect(fs.files[configPath]).toContain("use_lifecycle_hooks = true");
    expect(output).toContain("Hook install failed.");
    expect(output).toContain("Observer configuration active.");
    expect(output).not.toContain("Core setup complete.");
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
        runner: async (input) => {
          calls.push(input);
          const key = `${input.command} ${(input.args ?? []).join(" ")}`;
          if (key === "sh -c curl -fsSL https://chatgpt.com/codex/install.sh | sh") {
            codexInstalled = true;
            return commandResult(input, "");
          }
          if (key === "codex --version" && codexInstalled) {
            return commandResult(input, "codex 0.1.0\n");
          }
          return fakeRunner([], {
            "git rev-parse --show-toplevel": repo,
            "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
            "wt --version": "worktrunk 1.2.3\n",
            "tmux -V": "tmux 3.5a\n",
          })(input);
        },
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/diffnav",
          "/fake/bin/delta",
        ]),
        fs,
        activateObserverConfig: noopActivateObserverConfig,
        // Accept the Codex install and the config write; decline the rest. Match on
        // message text so the test is robust to the exact prompt count (e.g. which
        // optional prompts fire depends on launcher detection on the host).
        prompt: {
          async confirm(message: string) {
            return (
              message.includes("Install Codex?") || message.includes("Write STATION project config")
            );
          },
          async select() {
            return "codex";
          },
        },
        writeStdout: (chunk) => chunks.push(chunk),
      },
    );

    expect(result.code).toBe(0);
    expect(calls.find((call) => call.command === "sh")).toMatchObject({
      args: ["-c", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
      stdio: "inherit",
    });
    expect(fs.files[join(root, "home/.config/station/config.toml")]).toContain("[harness.codex]");
    expect(chunks.join("")).toContain("No supported agent CLI is available.");
    expect(chunks.join("")).toContain("Running: sh -c");
  });

  it("closes prompts and writes nothing when harness install choices are declined", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const chunks: string[] = [];
    let closed = false;

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
        access: fakeAccess([
          "/fake/bin/wt",
          "/fake/bin/tmux",
          "/fake/bin/bun",
          "/fake/bin/diffnav",
          "/fake/bin/delta",
        ]),
        fs,
        prompt: {
          ...prompt({ confirms: [false, false, false, false] }),
          close() {
            closed = true;
          },
        },
        writeStdout: (chunk) => chunks.push(chunk),
      },
    );

    expect(result.code).toBe(1);
    expect(closed).toBe(true);
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
        writeStdout: (chunk) => chunks.push(chunk),
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
        writeStdout: (chunk) => chunks.push(chunk),
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
        // CLT present (default probe) but Homebrew and diffnav are missing, so the
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
        writeStdout: (chunk) => chunks.push(chunk),
      },
    );

    expect(result.code).toBe(1);
    expect(chunks.join("")).toContain("Install Homebrew first: https://brew.sh");
    expect(chunks.join("")).toContain("Command Line Tools: xcode-select --install");
    expect(calls.some((call) => call.command === "/bin/bash")).toBe(false);
  });

  it("installs core tools after a fresh Apple-Silicon Homebrew install, then writes config", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const calls: ExternalCommandInput[] = [];
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
      diffnav: "diffnav",
      "git-delta": "delta",
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
            "git rev-parse --show-toplevel": repo,
            "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
            "codex --version": "codex 0.1.0\n",
            "xcode-select -p": "/Library/Developer/CommandLineTools\n",
          };
          const out = staticOutputs[key];
          if (out === undefined) {
            throw Object.assign(new Error(`missing fake command: ${key}`), { code: "ENOENT" });
          }
          return commandResult(input, out);
        },
        // bun/diffnav/delta (and wt/tmux path resolution) live in the brew prefix and
        // resolve only once their formula has been installed.
        access: async (path) => {
          const present =
            (installed.has("wt") && path === "/opt/homebrew/bin/wt") ||
            (installed.has("tmux") && path === "/opt/homebrew/bin/tmux") ||
            (installed.has("bun") && path === "/opt/homebrew/bin/bun") ||
            (installed.has("diffnav") && path === "/opt/homebrew/bin/diffnav") ||
            (installed.has("delta") && path === "/opt/homebrew/bin/delta");
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
              message.includes("Install missing required tools") ||
              message.includes("Write STATION project config")
            );
          },
          async select() {
            return "codex";
          },
        },
        writeStdout: () => undefined,
      },
    );

    expect(result.code).toBe(0);
    // The brew-install actions actually ran (not silent no-ops) — the discriminator:
    // before the fix the re-probe never sees brew, so these are never executed.
    expect(
      calls
        .filter((call) => call.command === "brew" && call.args?.[0] === "install")
        .map((call) => call.args?.[1]),
    ).toEqual(expect.arrayContaining(["worktrunk", "tmux", "bun", "diffnav", "git-delta"]));
    expect(fs.files[configPath]).toContain("[[projects]]");
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
      diffnav: "diffnav",
      "git-delta": "delta",
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
          if (key === "sh -c curl -fsSL https://chatgpt.com/codex/install.sh | sh") {
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
            "git rev-parse --show-toplevel": repo,
            "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
            "xcode-select -p": "/Library/Developer/CommandLineTools\n",
          };
          const out = staticOutputs[key];
          if (out === undefined) {
            throw Object.assign(new Error(`missing fake command: ${key}`), { code: "ENOENT" });
          }
          return commandResult(input, out);
        },
        access: async (path) => {
          const present =
            (installed.has("wt") && path === "/opt/homebrew/bin/wt") ||
            (installed.has("tmux") && path === "/opt/homebrew/bin/tmux") ||
            (installed.has("bun") && path === "/opt/homebrew/bin/bun") ||
            (installed.has("diffnav") && path === "/opt/homebrew/bin/diffnav") ||
            (installed.has("delta") && path === "/opt/homebrew/bin/delta");
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
              message.includes("Install missing required tools") ||
              message.includes("chatgpt.com/codex") ||
              message.includes("Write STATION project config")
            );
          },
          async select() {
            return "codex";
          },
        },
        writeStdout: () => undefined,
      },
    );

    // Without the brew prefix on the post-agent-install re-probe this exits 1 with no
    // config: the brew tools (resolvable only under /opt/homebrew/bin) re-read missing.
    expect(result.code).toBe(0);
    expect(calls.some((call) => call.command === "sh")).toBe(true);
    expect(fs.files[configPath]).toContain("[[projects]]");
  });
});

async function tempRoot(tempRoots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "station-setup-guided-"));
  tempRoots.push(root);
  return root;
}

function prompt(input: { confirms: boolean[]; selects?: string[] }): SetupPromptAdapter {
  const confirms = [...input.confirms];
  const selects = [...(input.selects ?? [])];
  return {
    async confirm() {
      return confirms.shift() ?? false;
    },
    async select() {
      return selects.shift() ?? "codex";
    },
  };
}

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
    access: fakeAccess([
      "/fake/bin/wt",
      "/fake/bin/tmux",
      "/fake/bin/bun",
      "/fake/bin/diffnav",
      "/fake/bin/delta",
    ]),
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

function fakeRunner(
  calls: ExternalCommandInput[],
  outputs: Record<string, string>,
): (input: ExternalCommandInput) => Promise<ExternalCommandResult> {
  return async (input) => {
    calls.push(input);
    const key = `${input.command} ${(input.args ?? []).join(" ")}`;
    // Synthetic machines have macOS Command Line Tools unless a test overrides it.
    const stdout = outputs[key] ?? fakeBinOutput(input, outputs) ?? defaultProbeOutput(key);
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
  return async (path) => {
    if (!available.has(path)) {
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
