import type { StationSnapshot } from "@station/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertDebugBundleContains,
  assertProviderHealth,
} from "../../support/real-station/assertions";
import { writeRealStationConfig } from "../../support/real-station/config";
import {
  type RealE2eEnvironment,
  realE2eEnabled,
  requireRealE2eEnvironment,
} from "../../support/real-station/env";
import { CleanupStack, runStationJson } from "../../support/real-station/process";
import { createRealTempRepo } from "../../support/real-station/repo";
import { killTmuxSession } from "../../support/real-station/tmux";

const describeReal = realE2eEnabled() ? describe : describe.skip;

describeReal("real station process", () => {
  let env: RealE2eEnvironment;
  let cleanup: CleanupStack;

  beforeAll(async () => {
    env = await requireRealE2eEnvironment({ worktrunk: true, tmux: true, codex: true });
  });

  afterEach(async () => {
    await cleanup?.run();
  });

  it("starts, reconciles, snapshots, writes a debug bundle, and stops with real config", async () => {
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

    await expect(
      runStationJson(env, {
        configPath: config.configPath,
        args: ["observer", "start", "--timeout-ms", "30000"],
        timeoutMs: 45_000,
      }),
    ).resolves.toMatchObject({ status: "running" });

    await expect(
      runStationJson(env, {
        configPath: config.configPath,
        args: ["observer", "status"],
      }),
    ).resolves.toMatchObject({ status: "running" });

    await expect(
      runStationJson(env, {
        configPath: config.configPath,
        args: ["reconcile", "--reason", "real-e2e-process"],
        timeoutMs: 60_000,
      }),
    ).resolves.toMatchObject({
      snapshot: { projects: [expect.objectContaining({ id: config.projectId })] },
    });

    const snapshot = await runStationJson<StationSnapshot>(env, {
      configPath: config.configPath,
      args: ["snapshot", "--json", "--include-debug"],
      timeoutMs: 30_000,
    });
    assertProviderHealth(snapshot, "worktrunk");
    assertProviderHealth(snapshot, "tmux");
    assertProviderHealth(snapshot, "codex");

    const bundle = await runStationJson<{ bundlePath: string }>(env, {
      configPath: config.configPath,
      args: ["debug", "bundle"],
      timeoutMs: 30_000,
    });
    await assertDebugBundleContains(bundle.bundlePath, "provider-health.json", "worktrunk");

    await expect(
      runStationJson(env, {
        configPath: config.configPath,
        args: ["observer", "stop"],
      }),
    ).resolves.toMatchObject({ stopped: true });
  }, 180_000);
});
