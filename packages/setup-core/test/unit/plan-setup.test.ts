import { planSetup, type SetupPlanningFacts, type SetupPlanningIntent } from "@station/setup-core";
import { describe, expect, it } from "vitest";

describe("planSetup", () => {
  it("derives a ready semantic plan without selecting optional operations", () => {
    const plan = planSetup(facts(), intent());

    expect(plan.selection).toEqual({
      outcome: "selected",
      source: "configured",
      requiredHarnessIds: ["codex"],
      defaultHarness: "codex",
    });
    expect(plan.issues).toEqual([]);
    expect(plan.operations).toEqual([
      {
        id: "prepare-worktrunk-tracking",
        kind: "prepare-worktrunk-tracking",
        tier: "recommended",
        selected: false,
      },
    ]);
    expect(plan.result).toEqual({
      readiness: { launchReady: true, workflowReady: true, requiredMissing: 0 },
      requiredIssueCount: 0,
      warningCount: 1,
      selectedOperationCount: 0,
    });
  });

  it("derives required tool issues and installer-aware operations", () => {
    const plan = planSetup(
      facts({
        tools: [
          tool("worktrunk", false, true),
          tool("tmux", false, false),
          tool("bun", true, true),
          tool("diffnav", true, true),
          tool("git-delta", true, true),
        ],
      }),
      intent(),
    );

    expect(plan.issues).toEqual([
      { code: "tool-missing", tier: "required", tool: "worktrunk" },
      { code: "tool-missing", tier: "required", tool: "tmux" },
    ]);
    expect(plan.operations.slice(0, 2)).toEqual([
      {
        id: "install:worktrunk",
        kind: "install-tool",
        tier: "required",
        selected: true,
        tool: "worktrunk",
      },
      {
        id: "install:tmux",
        kind: "install-tool",
        tier: "required",
        selected: false,
        tool: "tmux",
      },
    ]);
    expect(plan.result.readiness).toMatchObject({ workflowReady: false, requiredMissing: 2 });
    expect(plan.result.selectedOperationCount).toBe(1);
  });

  it("ignores source-only requirements for compiled installations", () => {
    const plan = planSetup(
      facts({
        compiled: true,
        xcodeTools: "missing",
        runtimeUi: "missing",
        tools: [
          tool("worktrunk", true, true),
          tool("tmux", true, true),
          tool("bun", false, true),
          tool("diffnav", true, true),
          tool("git-delta", true, true),
        ],
      }),
      intent(),
    );

    expect(plan.issues).toEqual([]);
    expect(plan.operations.some((operation) => operation.id === "install:bun")).toBe(false);
    expect(plan.result.readiness).toEqual({
      launchReady: true,
      workflowReady: true,
      requiredMissing: 0,
    });
  });

  it("preserves a configured default during explicit selection", () => {
    const plan = planSetup(
      facts(),
      intent({ harnessSelection: { kind: "explicit", harnessIds: ["opencode"] } }),
    );

    expect(plan.selection).toEqual({
      outcome: "selected",
      source: "explicit",
      requiredHarnessIds: ["opencode", "codex"],
      defaultHarness: "codex",
    });
  });

  it("does not choose among ambiguous harness discovery", () => {
    const plan = planSetup(
      facts({
        harnessSelection: {
          config: { status: "missing" },
          harnesses: [
            { id: "codex", availability: "available" },
            { id: "claude", availability: "available" },
          ],
        },
        config: { state: "missing", write: "none", diagnostics: [] },
        harnessTracking: [],
      }),
      intent(),
    );

    expect(plan.selection).toEqual({
      outcome: "ambiguous",
      candidateHarnessIds: ["codex", "claude"],
    });
    expect(plan.issues).toContainEqual({
      code: "harness-selection-ambiguous",
      tier: "required",
      candidateHarnessIds: ["codex", "claude"],
    });
    expect(plan.operations.some((operation) => operation.kind === "write-config")).toBe(false);
    expect(plan.operations.some((operation) => operation.kind === "prepare-harness-tracking")).toBe(
      false,
    );
  });

  it("keeps absent harness discovery as a typed selection failure", () => {
    const plan = planSetup(
      facts({
        harnessSelection: {
          config: { status: "missing" },
          harnesses: [{ id: "codex", availability: "unavailable" }],
        },
        config: { state: "missing", write: "none", diagnostics: [] },
        harnessTracking: [],
      }),
      intent(),
    );

    expect(plan.selection).toEqual({ outcome: "invalid", reason: "no-available-harness" });
    expect(plan.issues).toContainEqual({
      code: "harness-selection-invalid",
      tier: "required",
      reason: "no-available-harness",
    });
  });

  it.each([
    ["invalid-config", { config: { status: "invalid" } }],
    ["unsupported-configured-default", { config: { status: "valid", defaultHarness: "crush" } }],
  ] as const)("derives the %s selection failure", (reason, selectionConfig) => {
    const plan = planSetup(
      facts({
        harnessSelection: {
          config: selectionConfig.config,
          harnesses: [{ id: "codex", availability: "available" }],
        },
      }),
      intent(),
    );

    expect(plan.issues).toContainEqual({
      code: "harness-selection-invalid",
      tier: "required",
      reason,
    });
  });

  it.each([
    "git-absent",
    "git-unusable",
    "repository-unusable",
    "dubious-ownership",
  ] as const)("keeps the hostile Git reason %s typed", (reason) => {
    const plan = planSetup(facts({ git: { state: "unusable", reason } }), intent());
    expect(plan.issues).toContainEqual({ code: "git-unavailable", tier: "required", reason });
  });

  it.each([
    ["create", "create"],
    ["update", "update"],
  ] as const)("derives a selected config %s operation", (write, change) => {
    const plan = planSetup(
      facts({
        config: { state: write === "create" ? "missing" : "valid", write, diagnostics: [] },
      }),
      intent(),
    );
    expect(plan.operations).toContainEqual({
      id: "write-config",
      kind: "write-config",
      tier: "required",
      selected: true,
      change,
    });
  });

  it("represents a blocked config as an issue, never a semantic no-op", () => {
    const plan = planSetup(
      facts({ config: { state: "invalid", write: "blocked", diagnostics: [] } }),
      intent(),
    );

    expect(plan.issues).toContainEqual({
      code: "config-unready",
      tier: "required",
      state: "write-blocked",
    });
    expect(plan.operations.some((operation) => operation.kind === "write-config")).toBe(false);
  });

  it("derives required and recommended tracking repairs independently", () => {
    const plan = planSetup(
      facts({
        harnessSelection: {
          config: { status: "valid", defaultHarness: "codex" },
          harnesses: [
            { id: "codex", availability: "available" },
            { id: "opencode", availability: "available" },
          ],
        },
        harnessTracking: [
          {
            harnessId: "codex",
            assessment: {
              state: "artifact-missing-or-drifted",
              requested: true,
              installed: false,
            },
            required: true,
          },
          {
            harnessId: "opencode",
            assessment: { state: "probe-failed" },
            required: false,
          },
        ],
      }),
      intent(),
    );

    expect(plan.issues).toEqual([
      {
        code: "harness-tracking-unprepared",
        tier: "required",
        harnessId: "codex",
        state: "artifact-missing-or-drifted",
      },
      {
        code: "harness-tracking-unprepared",
        tier: "recommended",
        harnessId: "opencode",
        state: "probe-failed",
      },
    ]);
    expect(plan.operations).toContainEqual({
      id: "prepare-harness-tracking:codex",
      kind: "prepare-harness-tracking",
      tier: "required",
      selected: true,
      harnessId: "codex",
    });
    expect(plan.operations).toContainEqual({
      id: "prepare-harness-tracking:opencode",
      kind: "prepare-harness-tracking",
      tier: "recommended",
      selected: true,
      harnessId: "opencode",
    });
    expect(plan.result).toMatchObject({
      requiredIssueCount: 1,
      warningCount: 2,
      selectedOperationCount: 2,
    });
  });

  it("contains no presentation, command, config content, or serialized provider artifacts", () => {
    const semanticPlan = planSetup(
      facts({
        config: {
          state: "missing",
          write: "create",
          diagnostics: [{ code: "CONFIG_LOCAL_INVALID", severity: "warn" }],
        },
        harnessTracking: [
          {
            harnessId: "codex",
            assessment: { state: "probe-failed" },
            required: true,
          },
        ],
      }),
      intent({ installWorktrunkHooks: true }),
    );
    const forbiddenKeys = new Set([
      "label",
      "message",
      "command",
      "argv",
      "path",
      "content",
      "toml",
      "messageRef",
      "messageId",
      "data",
      "stdout",
      "stderr",
      "rawResult",
      "serializedResult",
    ]);
    const serialized = JSON.stringify(semanticPlan);

    expect(findForbiddenKeys(semanticPlan, forbiddenKeys)).toEqual([]);
    expect(serialized).not.toContain("Install Station-owned");
    expect(serialized).not.toContain("schema_version = 1");
    expect(serialized).not.toContain("hooks install codex");
    expect(serialized).not.toContain('{"provider":"codex"}');
  });
});

function facts(overrides: Partial<SetupPlanningFacts> = {}): SetupPlanningFacts {
  return {
    generatedAt: "2026-07-29T12:00:00.000Z",
    compiled: false,
    stateDirectoryWritable: true,
    socketEvidenceAvailable: true,
    xcodeTools: "available",
    tools: [
      tool("worktrunk", true, true),
      tool("tmux", true, true),
      tool("bun", true, true),
      tool("diffnav", true, true),
      tool("git-delta", true, true),
    ],
    runtimeUi: "available",
    git: { state: "usable", repository: "present" },
    harnessSelection: {
      config: { status: "valid", defaultHarness: "codex" },
      harnesses: [{ id: "codex", availability: "available" }],
    },
    config: { state: "valid", write: "none", diagnostics: [] },
    launchers: { station: "available", ingress: "available", tmuxPopup: "available" },
    worktrunkAutomation: "ready",
    worktrunkShell: "ready",
    tmuxPopup: { persisted: "ready", live: "not-applicable" },
    worktrunkHooks: "ready",
    harnessTracking: [
      {
        harnessId: "codex",
        assessment: { state: "prepared", requested: true, installed: true },
        required: true,
      },
    ],
    ...overrides,
  };
}

function intent(overrides: Partial<SetupPlanningIntent> = {}): SetupPlanningIntent {
  return {
    mode: "plan",
    harnessSelection: { kind: "automatic" },
    installWorktrunkHooks: false,
    ...overrides,
  };
}

function tool(
  id: SetupPlanningFacts["tools"][number]["id"],
  available: boolean,
  installerAvailable: boolean,
): SetupPlanningFacts["tools"][number] {
  return { id, available, installerAvailable };
}

function findForbiddenKeys(value: unknown, forbidden: ReadonlySet<string>, at = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenKeys(item, forbidden, `${at}[${index}]`));
  }
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(forbidden.has(key) ? [`${at}.${key}`] : []),
    ...findForbiddenKeys(item, forbidden, `${at}.${key}`),
  ]);
}
