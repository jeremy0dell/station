import type { HarnessReadinessFacts, HarnessReadinessProvider } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  deriveHarnessReadiness,
  summarizeHarnessReadiness,
} from "../../src/providers/readinessPolicy.js";
import type { HarnessReadinessRegistration } from "../../src/providers/registry.js";

const provider: HarnessReadinessProvider = {
  id: "codex",
  probe: async () => facts(),
};

function registration(
  overrides: Partial<HarnessReadinessRegistration> = {},
): HarnessReadinessRegistration {
  return {
    provider,
    label: "Codex",
    kind: "built_in",
    configuration: "configured",
    preparation: { prepare: true, repair: true },
    ...overrides,
  };
}

function facts(overrides: Partial<HarnessReadinessFacts> = {}): HarnessReadinessFacts {
  return {
    cli: "available",
    authentication: "ready",
    launchability: "ready",
    trackingSetup: "prepared",
    technicalDetails: [],
    ...overrides,
  } as HarnessReadinessFacts;
}

describe("deriveHarnessReadiness", () => {
  it("distinguishes prepared setup from observed tracking", () => {
    const prepared = deriveHarnessReadiness({
      registration: registration(),
      facts: facts(),
      freshness: "fresh",
      trackingObserved: false,
      checkedAt: "2026-07-12T12:00:00.000Z",
    });
    const ready = deriveHarnessReadiness({
      registration: registration(),
      facts: facts(),
      freshness: "fresh",
      trackingObserved: true,
      checkedAt: "2026-07-12T12:00:00.000Z",
    });

    expect(summarizeHarnessReadiness(prepared).status).toBe("prepared");
    expect(prepared.decision).toBe("launch_ready");
    expect(summarizeHarnessReadiness(ready).status).toBe("ready");
    expect(ready.decision).toBe("launch_ready");
    expect(ready.revision).not.toBe(prepared.revision);
  });

  it("applies blocker and freshness precedence", () => {
    const missing = deriveHarnessReadiness({
      registration: registration(),
      facts: facts({ cli: "missing" }),
      freshness: "fresh",
      trackingObserved: true,
    });
    expect(summarizeHarnessReadiness(missing).status).toBe("not_installed");
    expect(missing.decision).toBe("blocked_user_action");
    expect(missing.actions).toContain("install_cli");

    const stale = deriveHarnessReadiness({
      registration: registration(),
      facts: facts({ cli: "missing" }),
      freshness: "stale",
      trackingObserved: true,
    });
    expect(summarizeHarnessReadiness(stale).status).toBe("unknown");
    expect(stale.decision).toBe("unknown");
  });

  it("offers provider-neutral preparation actions only when supported", () => {
    const repairable = deriveHarnessReadiness({
      registration: registration(),
      facts: facts({ trackingSetup: "repair_needed" }),
      freshness: "fresh",
      trackingObserved: false,
    });
    expect(summarizeHarnessReadiness(repairable).status).toBe("repair");
    expect(repairable.decision).toBe("prepare_then_launch");
    expect(repairable.actions).toContain("repair");

    const stationRepair = deriveHarnessReadiness({
      registration: registration({ preparation: { prepare: false, repair: false } }),
      facts: facts({ trackingSetup: "repair_needed" }),
      freshness: "fresh",
      trackingObserved: false,
    });
    expect(summarizeHarnessReadiness(stationRepair).status).toBe("repair");
    expect(stationRepair.decision).toBe("blocked_user_action");
    expect(stationRepair.actions).not.toContain("repair");
  });

  it("keeps revisions stable across timestamps and display-only detail text", () => {
    const first = deriveHarnessReadiness({
      registration: registration(),
      facts: facts({ technicalDetails: [{ code: "ONE", message: "First wording." }] }),
      freshness: "fresh",
      trackingObserved: false,
      checkedAt: "2026-07-12T12:00:00.000Z",
    });
    const second = deriveHarnessReadiness({
      registration: registration(),
      facts: facts({ technicalDetails: [{ code: "TWO", message: "Second wording." }] }),
      freshness: "fresh",
      trackingObserved: false,
      checkedAt: "2026-07-12T12:00:10.000Z",
    });
    expect(second.revision).toBe(first.revision);
  });
});
