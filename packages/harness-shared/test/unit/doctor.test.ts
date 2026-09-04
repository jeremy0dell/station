import type { ProviderHealth } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { healthDoctorCheck, hookDoctorCheck } from "../../src/doctor";

const now = "2026-05-27T12:00:00.000Z";

const text = { name: "demo.version", ok: "Demo is available.", error: "Demo is unavailable." };

function health(overrides: Partial<ProviderHealth>): ProviderHealth {
  return {
    provider: "demo",
    providerType: "harness",
    status: "healthy",
    lastCheckedAt: now,
    ...overrides,
  };
}

describe("healthDoctorCheck", () => {
  it("reports ok for a healthy probe", () => {
    expect(healthDoctorCheck(health({}), text)).toEqual({
      name: "demo.version",
      status: "ok",
      message: "Demo is available.",
    });
  });

  it("carries lastError onto the error check and omits it when absent", () => {
    const lastError = { tag: "DemoError", code: "DEMO_DOWN", message: "not installed" };

    expect(healthDoctorCheck(health({ status: "unavailable", lastError }), text)).toEqual({
      name: "demo.version",
      status: "error",
      message: "Demo is unavailable.",
      error: lastError,
    });
    expect(healthDoctorCheck(health({ status: "unavailable" }), text)).not.toHaveProperty("error");
  });
});

describe("hookDoctorCheck", () => {
  const failure = {
    tag: "DemoHookError",
    code: "DEMO_HOOK_DOCTOR_FAILED",
    message: "Demo hook doctor failed.",
    provider: "demo",
  };

  it("describes a resolved doctor result with its own status", async () => {
    await expect(
      hookDoctorCheck({
        name: "demo-hooks",
        run: async () => ({ status: "warn" as const, message: "missing" }),
        describe: (result) => `Demo hooks: ${result.message}.`,
        failure,
      }),
    ).resolves.toEqual({
      name: "demo-hooks",
      status: "warn",
      message: "Demo hooks: missing.",
    });
  });

  it("converts a thrown doctor into an error check carrying a SafeError", async () => {
    const check = await hookDoctorCheck({
      name: "demo-hooks",
      run: async () => {
        throw new Error("config unreadable");
      },
      describe: () => "unused",
      failure,
    });

    expect(check).toMatchObject({
      name: "demo-hooks",
      status: "error",
      message: "Demo hook doctor failed.",
      error: { tag: "DemoHookError", code: "DEMO_HOOK_DOCTOR_FAILED" },
    });
  });
});
