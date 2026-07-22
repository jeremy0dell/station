import { join } from "node:path";
import { runProviderIngressCommand } from "@station/cli/ingress";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertDebugBundleContains } from "../../support/real-station/assertions";
import {
  type RealStationConfigFixture,
  writeRealStationConfig,
} from "../../support/real-station/config";
import {
  type RealE2eEnvironment,
  realE2eEnabled,
  requireRealE2eEnvironment,
} from "../../support/real-station/env";
import { CleanupStack, runStationJson } from "../../support/real-station/process";
import { createRealTempRepo } from "../../support/real-station/repo";
import { killTmuxSession } from "../../support/real-station/tmux";

const describeReal = realE2eEnabled() ? describe : describe.skip;

type ProviderHookReceipt = {
  hookId: string;
  status: "ingested" | "spooled" | "rejected";
};

describeReal("real Worktrunk hook ingestion", () => {
  let env: RealE2eEnvironment;
  let cleanup: CleanupStack;

  beforeAll(async () => {
    env = await requireRealE2eEnvironment({ worktrunk: true, tmux: true, codex: true });
  });

  afterEach(async () => {
    await cleanup?.run();
  });

  it("installs, doctors, and uninstalls real Worktrunk hooks", async () => {
    cleanup = new CleanupStack();
    const repo = await createRealTempRepo(env);
    cleanup.defer(repo.cleanup);
    const config = await writeRealStationConfig({ env, repo, useLifecycleHooks: true });
    cleanup.defer(async () => {
      await runStationJson(env, {
        configPath: config.configPath,
        args: ["hooks", "uninstall", "worktrunk", "--yes"],
      }).catch(() => undefined);
    });
    cleanup.defer(async () => {
      await killTmuxSession(env, config.tmuxSession);
    });

    await expect(
      runStationJson(env, {
        configPath: config.configPath,
        args: ["hooks", "install", "worktrunk", "--yes"],
        timeoutMs: 30_000,
      }),
    ).resolves.toMatchObject({ installed: true });
    await expect(
      runStationJson(env, {
        configPath: config.configPath,
        args: ["hooks", "doctor", "worktrunk"],
      }),
    ).resolves.toMatchObject({ status: "ok" });
    await expect(
      runStationJson(env, {
        configPath: config.configPath,
        args: ["hooks", "uninstall", "worktrunk", "--yes"],
      }),
    ).resolves.toMatchObject({ installed: false });
  }, 120_000);

  it("delivers online, auto-starts offline, spools when disabled, and drains on startup", async () => {
    cleanup = new CleanupStack();
    const repo = await createRealTempRepo(env);
    cleanup.defer(repo.cleanup);
    const config = await writeRealStationConfig({ env, repo });
    cleanup.defer(async () => {
      await runStationJson(env, {
        configPath: config.configPath,
        args: ["observer", "stop"],
      }).catch(() => undefined);
    });
    cleanup.defer(async () => {
      await killTmuxSession(env, config.tmuxSession);
    });

    await runStationJson(env, {
      configPath: config.configPath,
      args: ["observer", "start", "--timeout-ms", "30000"],
      timeoutMs: 45_000,
    });
    const online = await runWorktrunkIngress(env, config, {
      event: "post-create",
      stdin: JSON.stringify({ branch: "station/hook-online" }),
    });
    expect(online.status).toBe("ingested");

    await runStationJson(env, { configPath: config.configPath, args: ["observer", "stop"] });
    const offline = await runWorktrunkIngress(env, config, {
      event: "post-create",
      stdin: JSON.stringify({ branch: "station/hook-offline" }),
    });
    expect(offline.status).toBe("ingested");
    await runStationJson(env, { configPath: config.configPath, args: ["observer", "stop"] });

    const spoolRepo = await createRealTempRepo(env);
    cleanup.defer(spoolRepo.cleanup);
    const spoolConfig = await writeRealStationConfig({
      env,
      repo: spoolRepo,
      autoStartFromHooks: false,
    });
    cleanup.defer(async () => {
      await runStationJson(env, {
        configPath: spoolConfig.configPath,
        args: ["observer", "stop"],
      }).catch(() => undefined);
    });
    cleanup.defer(async () => {
      await killTmuxSession(env, spoolConfig.tmuxSession);
    });

    const spooled = await runWorktrunkIngress(env, spoolConfig, {
      event: "post-create",
      stdin: JSON.stringify({ branch: "station/hook-spooled" }),
      autoStart: false,
    });
    expect(spooled.status).toBe("spooled");
    await runStationJson(env, {
      configPath: spoolConfig.configPath,
      args: ["reconcile", "--reason", "real-hook-drain"],
      timeoutMs: 60_000,
    });
    const bundle = await runStationJson<{ bundlePath: string }>(env, {
      configPath: spoolConfig.configPath,
      args: ["debug", "bundle"],
      timeoutMs: 30_000,
    });
    await assertDebugBundleContains(bundle.bundlePath, "logs/observer.jsonl", spooled.hookId);
  }, 180_000);
});

async function runWorktrunkIngress(
  env: RealE2eEnvironment,
  config: RealStationConfigFixture,
  input: {
    event: string;
    stdin: string;
    autoStart?: boolean;
  },
): Promise<ProviderHookReceipt> {
  const receipt = await runProviderIngressCommand(
    [
      "--socket",
      config.socketPath,
      "--state-dir",
      config.stateDir,
      "--spool-dir",
      join(config.stateDir, "spool", "hooks"),
      "--config",
      config.configPath,
      ...(input.autoStart === false ? ["--no-auto-start"] : []),
      "worktrunk",
      input.event,
    ],
    {
      stdin: input.stdin,
      observerEntryPath: join(env.repoRoot, "apps", "cli", "dist", "observerMain.js"),
    },
  );
  if (receipt.status === "ignored") {
    throw new Error("Worktrunk ingress cannot ignore a lifecycle event.");
  }
  return {
    hookId: receipt.hookId,
    status: receipt.status,
  };
}
