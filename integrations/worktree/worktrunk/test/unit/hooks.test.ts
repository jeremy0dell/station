import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderHookArtifactOwner } from "@station/contracts";
import {
  doctorWorktrunkHooks,
  installWorktrunkHooks,
  planWorktrunkHooks,
  uninstallWorktrunkHooks,
  type WorktrunkHookExpectation,
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

  it("requires takeover before replacing unmarked commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-hooks-"));
    const configPath = join(root, "config.toml");
    await installWorktrunkHooks({
      worktrunkConfigPath: configPath,
      expectation: hookExpectation(),
    });
    const owner = artifactOwner("/opt/station/stn-ingress", "compiled", "a");
    const expectation = hookExpectation(owner.launcher, owner);
    const unmarked = await readFile(configPath, "utf8");

    await expect(
      doctorWorktrunkHooks({
        worktrunkConfigPath: configPath,
        expectation,
      }),
    ).resolves.toMatchObject({
      status: "warn",
      installed: false,
      ownership: { status: "unknown-owner", requested: owner },
    });

    await expect(
      installWorktrunkHooks({ worktrunkConfigPath: configPath, expectation }),
    ).rejects.toMatchObject({ code: "PROVIDER_HOOK_OWNERSHIP_CONFLICT" });
    await expect(readFile(configPath, "utf8")).resolves.toBe(unmarked);
    await installWorktrunkHooks({ worktrunkConfigPath: configPath, expectation, takeover: true });
    const contents = await readFile(configPath, "utf8");
    expect(contents).toContain("/opt/station/stn-ingress");
    expect(contents).not.toMatch(/= "stn-ingress --socket/);
    await expect(
      doctorWorktrunkHooks({ worktrunkConfigPath: configPath, expectation }),
    ).resolves.toMatchObject({ status: "ok", installed: true });
  });

  it("refuses an occupied Station slot without removing unrelated Worktrunk commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-hooks-reserved-slot-"));
    const configPath = join(root, "config.toml");
    const owner = artifactOwner("/source/bin/stn-ingress", "source", "a");
    const expectation = hookExpectation(owner.launcher, owner);
    const before = '[post-create]\nstation = "echo user"\nkeep = "echo keep"\n';
    await writeFile(configPath, before, "utf8");

    await expect(
      installWorktrunkHooks({ worktrunkConfigPath: configPath, expectation }),
    ).rejects.toMatchObject({
      code: "PROVIDER_HOOK_OWNERSHIP_CONFLICT",
      ownership: { status: "unknown-owner" },
    });
    await expect(
      uninstallWorktrunkHooks({ worktrunkConfigPath: configPath, expectation }),
    ).rejects.toMatchObject({ code: "PROVIDER_HOOK_OWNERSHIP_CONFLICT" });
    await expect(readFile(configPath, "utf8")).resolves.toBe(before);

    await installWorktrunkHooks({
      worktrunkConfigPath: configPath,
      expectation,
      takeover: true,
    });
    const after = await readFile(configPath, "utf8");
    expect(after).toContain('keep = "echo keep"');
    expect(after).not.toContain('station = "echo user"');
    expect(after).toContain("station-provider-artifact-owner:v1:");
  });

  it("requires takeover before replacing or removing another runtime's lifecycle hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-hooks-owner-"));
    const configPath = join(root, "config.toml");
    const installedOwner = artifactOwner("/installed/stn-ingress", "compiled", "a");
    const sourceOwner = artifactOwner("/source/bin/stn-ingress", "source", "b");
    const installedExpectation = hookExpectation(installedOwner.launcher, installedOwner);
    const sourceExpectation = hookExpectation(sourceOwner.launcher, sourceOwner);

    await installWorktrunkHooks({
      worktrunkConfigPath: configPath,
      expectation: installedExpectation,
    });
    const beforeConflict = await readFile(configPath, "utf8");

    await expect(
      installWorktrunkHooks({ worktrunkConfigPath: configPath, expectation: sourceExpectation }),
    ).rejects.toMatchObject({ code: "PROVIDER_HOOK_OWNERSHIP_CONFLICT" });
    await expect(readFile(configPath, "utf8")).resolves.toBe(beforeConflict);
    await expect(
      doctorWorktrunkHooks({ worktrunkConfigPath: configPath, expectation: sourceExpectation }),
    ).resolves.toMatchObject({
      status: "warn",
      installed: false,
      ownership: { status: "different-owner" },
    });

    await installWorktrunkHooks({
      worktrunkConfigPath: configPath,
      expectation: sourceExpectation,
      takeover: true,
    });
    await expect(
      uninstallWorktrunkHooks({
        worktrunkConfigPath: configPath,
        expectation: installedExpectation,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_HOOK_OWNERSHIP_CONFLICT" });
    await uninstallWorktrunkHooks({
      worktrunkConfigPath: configPath,
      expectation: sourceExpectation,
    });
    await expect(readFile(configPath, "utf8")).resolves.not.toContain("stn-ingress");
  });

  it("requires takeover when lifecycle commands have mixed marker validity", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-wt-hooks-mixed-owner-"));
    const configPath = join(root, "config.toml");
    const owner = artifactOwner("/source/bin/stn-ingress", "source", "a");
    const expectation = hookExpectation(owner.launcher, owner);
    await installWorktrunkHooks({ worktrunkConfigPath: configPath, expectation });
    const installed = await readFile(configPath, "utf8");
    const mixed = installed.replace(
      /station-provider-artifact-owner:v1:[A-Za-z0-9_-]+/u,
      "station-provider-artifact-owner:v1:malformed",
    );
    await writeFile(configPath, mixed, "utf8");

    await expect(
      doctorWorktrunkHooks({ worktrunkConfigPath: configPath, expectation }),
    ).resolves.toMatchObject({
      status: "warn",
      installed: false,
      ownership: { status: "unknown-owner", requested: owner },
    });
    await expect(
      installWorktrunkHooks({ worktrunkConfigPath: configPath, expectation }),
    ).rejects.toMatchObject({ code: "PROVIDER_HOOK_OWNERSHIP_CONFLICT" });
    await expect(readFile(configPath, "utf8")).resolves.toBe(mixed);
    expect((await readdir(root)).some((name) => name.includes(".bak"))).toBe(false);

    await installWorktrunkHooks({ worktrunkConfigPath: configPath, expectation, takeover: true });
    await expect(
      doctorWorktrunkHooks({ worktrunkConfigPath: configPath, expectation }),
    ).resolves.toMatchObject({ status: "ok", ownership: { status: "same-owner" } });
  });
});

function hookExpectation(
  hookBin = "stn-ingress",
  artifactOwner?: ProviderHookArtifactOwner,
): WorktrunkHookExpectation {
  const expectation: WorktrunkHookExpectation = {
    hookBin,
    stationConfigPath: "/tmp/station/config.toml",
    observerSocketPath: "/tmp/station/run/observer.sock",
    stateDir: "/tmp/station/state",
    hookSpoolDir: "/tmp/station/state/spool/hooks",
    autoStartFromHooks: true,
  };
  if (artifactOwner !== undefined) expectation.artifactOwner = artifactOwner;
  return expectation;
}

function artifactOwner(
  launcher: string,
  runtimeKind: "compiled" | "source",
  digit: string,
): ProviderHookArtifactOwner {
  return {
    schemaVersion: 1,
    launcher,
    runtimeKind,
    version: runtimeKind === "compiled" ? "0.7.1" : "0.0.0-pre-alpha.9",
    buildIdentity: digit.repeat(64),
  };
}
