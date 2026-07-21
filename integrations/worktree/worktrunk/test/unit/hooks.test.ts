import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doctorWorktrunkHooks,
  installWorktrunkHooks,
  planWorktrunkHooks,
  uninstallWorktrunkHooks,
} from "@station/worktrunk";
import { describe, expect, it } from "vitest";

describe("Worktrunk hook setup", () => {
  it("plans tiny hook commands without writing config", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-hooks-"));
    const configPath = join(root, "config.toml");

    const plan = await planWorktrunkHooks({
      worktrunkConfigPath: configPath,
      expectation: hookExpectation("/usr/local/bin/stn-ingress"),
    });

    expect(plan.changed).toBe(true);
    expect(plan.missing).toEqual(["post-create", "post-switch", "pre-remove", "post-remove"]);
    expect(plan.commands["post-create"]).toBe(
      "/usr/local/bin/stn-ingress --socket /tmp/station/run/observer.sock --state-dir /tmp/station/state --spool-dir /tmp/station/state/spool/hooks --config /tmp/station/config.toml worktrunk post-create",
    );
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
  });

  it("installs idempotently, backs up existing config, and preserves unrelated hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-hooks-"));
    const configPath = join(root, "config.toml");
    await mkdir(root, { recursive: true });
    await writeFile(
      configPath,
      await readFile(new URL("../fixtures/worktrunk-before.toml", import.meta.url), "utf8"),
    );

    const installed = await installWorktrunkHooks({
      worktrunkConfigPath: configPath,
      expectation: hookExpectation(),
    });
    const second = await installWorktrunkHooks({
      worktrunkConfigPath: configPath,
      expectation: hookExpectation(),
    });
    const contents = await readFile(configPath, "utf8");

    expect(installed.backupPath).toBeDefined();
    expect(second.changed).toBe(false);
    expect(contents).toContain("echo existing");
    expect(contents).toContain("stn-ingress");
    expect(contents).not.toContain("station-hook");
    await expect(
      doctorWorktrunkHooks({
        worktrunkConfigPath: configPath,
        expectation: hookExpectation(),
      }),
    ).resolves.toMatchObject({
      status: "ok",
      installed: true,
    });
  });

  it("uninstalls generated hooks without removing unrelated commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-hooks-"));
    const configPath = join(root, "config.toml");
    await installWorktrunkHooks({
      worktrunkConfigPath: configPath,
      expectation: hookExpectation(),
    });

    const removed = await uninstallWorktrunkHooks({
      worktrunkConfigPath: configPath,
      expectation: hookExpectation(),
    });
    const contents = await readFile(configPath, "utf8");

    expect(removed.installed).toBe(false);
    expect(contents).not.toContain("stn-ingress");
  });

  it("maps invalid hook config TOML to a typed setup error", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-hooks-"));
    const configPath = join(root, "config.toml");
    await writeFile(configPath, "not = [valid");

    await expect(
      planWorktrunkHooks({
        worktrunkConfigPath: configPath,
        expectation: hookExpectation(),
      }),
    ).rejects.toMatchObject({
      tag: "WorktrunkHookSetupError",
      code: "WORKTRUNK_HOOK_INVALID_TOML",
      provider: "worktrunk",
    });
  });

  it("repairs exact legacy bare commands to the canonical absolute launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-hooks-"));
    const configPath = join(root, "config.toml");
    await installWorktrunkHooks({
      worktrunkConfigPath: configPath,
      expectation: hookExpectation(),
    });

    await expect(
      doctorWorktrunkHooks({
        worktrunkConfigPath: configPath,
        expectation: hookExpectation("/opt/station/stn-ingress"),
      }),
    ).resolves.toMatchObject({ status: "warn", installed: false });

    await installWorktrunkHooks({
      worktrunkConfigPath: configPath,
      expectation: hookExpectation("/opt/station/stn-ingress"),
    });
    const contents = await readFile(configPath, "utf8");
    expect(contents).toContain("/opt/station/stn-ingress");
    expect(contents).not.toMatch(/= "stn-ingress --socket/);
    await expect(
      doctorWorktrunkHooks({
        worktrunkConfigPath: configPath,
        expectation: hookExpectation("/opt/station/stn-ingress"),
      }),
    ).resolves.toMatchObject({ status: "ok", installed: true });
  });
});

function hookExpectation(hookBin = "stn-ingress") {
  return {
    hookBin,
    stationConfigPath: "/tmp/station/config.toml",
    observerSocketPath: "/tmp/station/run/observer.sock",
    stateDir: "/tmp/station/state",
    hookSpoolDir: "/tmp/station/state/spool/hooks",
    autoStartFromHooks: true,
  };
}
