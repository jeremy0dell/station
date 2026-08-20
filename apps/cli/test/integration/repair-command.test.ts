import { runCli } from "@station/cli";
import { describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";

describe("repair CLI integration", () => {
  it("returns a partial read-only inventory without starting an absent Observer or Host", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const spawnObserver = vi.fn();
    const inspectObserver = vi.fn(async ({ socketPath }) => ({
      component: "observer" as const,
      status: "absent" as const,
      socketPath,
      holderPids: [],
    }));
    const inspectHost = vi.fn(async ({ socketPath }) => ({
      ownership: {
        component: "host" as const,
        status: "absent" as const,
        socketPath,
        holderPids: [],
      },
      terminalGroups: [],
    }));

    const result = await runCli(["--config", configPath, "repair", "inventory", "--json"], {
      repairDeps: {
        observer: {
          probeSocket: async () => ({ status: "absent" }),
          spawnObserver,
        },
        runtimeEvidence: { inspectObserver, inspectHost },
        now: () => new Date("2026-08-20T12:00:00.000Z"),
      },
    });

    expect(result).toMatchObject({
      code: 1,
      outputFormat: "json",
      output: {
        schemaVersion: 1,
        completeness: "partial",
        observer: { status: "absent" },
        host: { status: "absent" },
        findings: [expect.objectContaining({ code: "OBSERVER_REPAIR_INVENTORY_UNAVAILABLE" })],
      },
    });
    expect(spawnObserver).not.toHaveBeenCalled();
    expect(inspectObserver).toHaveBeenCalledOnce();
    expect(inspectHost).toHaveBeenCalledOnce();
  });

  it("resolves repair help without reading config or runtime state", async () => {
    const result = await runCli([
      "--config",
      "/definitely/missing/station-config.toml",
      "repair",
      "--help",
    ]);
    expect(result).toMatchObject({ code: 0, outputFormat: "text" });
    expect(String(result.output)).toContain("stn repair inventory [--json]");
    expect(String(result.output)).toContain("preview-only");
  });
});
