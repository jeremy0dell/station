import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { describe, expect, it } from "vitest";
import {
  mergeReadinessTechnicalDetails,
  probeHarnessCli,
  probeReadinessCommand,
  withIsolatedReadinessEnvironment,
} from "../../src/readiness";

describe("harness readiness command probes", () => {
  it("parses installed and optional latest versions", async () => {
    const calls: ExternalCommandInput[] = [];
    const readiness = await probeHarnessCli({
      command: "agent-test",
      latestPackage: "@example/agent",
      runner: async (input) => {
        calls.push(input);
        return result(input, input.command === "npm" ? "2.4.0\n" : "agent 2.3.1 (abc)\n");
      },
    });

    expect(readiness).toEqual({
      cli: "available",
      installedVersion: "2.3.1",
      latestVersion: "2.4.0",
      technicalDetails: [],
    });
    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      ["agent-test", ["--version"]],
      ["npm", ["view", "@example/agent", "version"]],
    ]);
  });

  it("treats only executable-not-found as missing", async () => {
    await expect(
      probeHarnessCli({
        command: "missing-agent",
        runner: async () => {
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        },
      }),
    ).resolves.toEqual({ cli: "missing", technicalDetails: [] });

    await expect(
      probeHarnessCli({
        command: "denied-agent",
        runner: async () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
      }),
    ).resolves.toMatchObject({
      cli: "unknown",
      technicalDetails: [{ code: "EACCES" }],
    });
  });

  it("keeps malformed version output unknown and ignores latest lookup failure", async () => {
    await expect(
      probeHarnessCli({
        command: "agent-test",
        latestPackage: "@example/agent",
        runner: async (input) => {
          if (input.command === "npm") throw new Error("offline");
          return result(input, "development build\n");
        },
      }),
    ).resolves.toEqual({
      cli: "unknown",
      technicalDetails: [
        {
          code: "HARNESS_READINESS_VERSION_INVALID",
          message: "The harness version output could not be recognized.",
        },
      ],
    });
  });

  it("caps installed and latest command budgets below the provider deadline", async () => {
    const calls: ExternalCommandInput[] = [];
    await probeHarnessCli(
      {
        command: "agent-test",
        latestPackage: "@example/agent",
        timeoutMs: 9_000,
        runner: async (input) => {
          calls.push(input);
          return result(input, input.command === "npm" ? "1.2.4\n" : "agent 1.2.3\n");
        },
      },
      { timeoutMs: 15_000 },
    );

    expect(calls.map((call) => call.timeoutMs)).toEqual([5_000, 5_000]);
  });

  it("preserves allowed nonzero exits and deduplicates safe details", async () => {
    const outcome = await probeReadinessCommand(
      { command: "agent-test", args: ["login", "status"], allowedExitCodes: [1] },
      async () => {
        throw Object.assign(new Error("sign in required"), {
          exitCode: 1,
          stdout: "signed out\n",
        });
      },
    );
    expect(outcome).toMatchObject({ status: "succeeded", result: { exitCode: 1 } });
    expect(
      mergeReadinessTechnicalDetails(
        [{ code: "X", message: "failed" }],
        [
          { code: "X", message: "failed" },
          { code: "Y", message: "also failed" },
        ],
      ),
    ).toEqual([
      { code: "X", message: "failed" },
      { code: "Y", message: "also failed" },
    ]);
  });

  it("uses and removes a disposable provider environment", async () => {
    let home = "";
    let cwd = "";
    const readiness = await withIsolatedReadinessEnvironment(
      { env: { PATH: "/bin" }, providerHomeEnv: "AGENT_HOME" },
      async (environment) => {
        ({ cwd, homeDir: home } = environment);
        const { env, providerHomeDir } = environment;
        expect(env).toMatchObject({
          PATH: "/bin",
          HOME: home,
          USERPROFILE: home,
          AGENT_HOME: providerHomeDir,
          APPDATA: expect.stringContaining("appdata/roaming"),
          LOCALAPPDATA: expect.stringContaining("appdata/local"),
          NODE_COMPILE_CACHE: expect.stringContaining("cache/node"),
          npm_config_cache: expect.stringContaining("cache/npm"),
          npm_config_update_notifier: "false",
          npm_config_userconfig: expect.stringContaining("/npmrc"),
          TMPDIR: expect.stringContaining("/tmp"),
          XDG_CACHE_HOME: expect.stringContaining("/cache"),
          XDG_CONFIG_HOME: expect.stringContaining("/config"),
          XDG_DATA_HOME: expect.stringContaining("/data"),
          XDG_STATE_HOME: expect.stringContaining("/state"),
        });
        await writeFile(`${providerHomeDir}/created-by-cli`, "temporary");
        return "ready";
      },
    );

    expect(readiness).toBe("ready");
    await expect(access(home)).rejects.toThrow();
    await expect(access(cwd)).rejects.toThrow();
  });

  it("cleans the disposable environment after probe failure", async () => {
    let home = "";
    await expect(
      withIsolatedReadinessEnvironment({}, async ({ homeDir }) => {
        home = homeDir;
        throw new Error("probe failed");
      }),
    ).rejects.toThrow("probe failed");
    await expect(access(home)).rejects.toThrow();
  });

  it("reaps only disposable environments whose owning process is dead", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      stdio: "ignore",
    });
    const deadPid = child.pid;
    if (deadPid === undefined) throw new Error("Child process did not receive a PID.");
    child.kill("SIGKILL");
    await once(child, "exit");

    const deadRoot = await mkdtemp(join(tmpdir(), `station-readiness-${deadPid}-`));
    const liveRoot = await mkdtemp(join(tmpdir(), `station-readiness-${process.pid}-`));
    const ownerlessRoot = await mkdtemp(join(tmpdir(), "station-readiness-"));
    try {
      await withIsolatedReadinessEnvironment({}, async () => undefined);

      await expect(access(deadRoot)).rejects.toThrow();
      await expect(access(liveRoot)).resolves.toBeUndefined();
      await expect(access(ownerlessRoot)).resolves.toBeUndefined();
    } finally {
      await Promise.all(
        [deadRoot, liveRoot, ownerlessRoot].map((path) =>
          rm(path, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("resolves relative commands before switching to the disposable cwd", async () => {
    let call: ExternalCommandInput | undefined;
    await withIsolatedReadinessEnvironment({}, ({ cwd, env }) =>
      probeHarnessCli({
        command: "./bin/agent-test",
        cwd,
        env,
        runner: async (input) => {
          call = input;
          return result(input, "agent 1.2.3\n");
        },
      }),
    );

    expect(call?.cwd).toContain("station-readiness-");
    expect(isAbsolute(call?.command ?? "")).toBe(true);
  });
});

function result(input: ExternalCommandInput, stdout: string): ExternalCommandResult {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout,
    stderr: "",
    exitCode: 0,
  };
}
