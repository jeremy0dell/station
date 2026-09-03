import type { StationConfig } from "@station/config";
import {
  HOST_PROTOCOL_VERSION,
  STATION_SCHEMA_VERSION,
  type UpdateArtifact,
  UpdateConvergencePlanningInputSchema,
  type UpdateFinalInspection,
  type UpdateReapRecoveryPreflight,
  UpdateReapRecoveryPreflightSchema,
  type UpdateReapTerminalEvidence,
  updateReapEvidenceIsComplete,
} from "@station/contracts";
import type { ProviderRegistry } from "@station/observer/internal";
import { type StationBuildInfo, stationObserverBuildVersion } from "@station/runtime";
import { describe, expect, it, vi } from "vitest";
import { createTempState } from "../../../../tests/support/temp-projects";
import { runUpdateCommand } from "../../src/commands/update.js";
import type { ExactObserverBuildStatus } from "../../src/observerProcess/types.js";
import { resolveObserverPaths } from "../../src/paths.js";
import { selectUpdateChannel, type UpdateChannelProbe } from "../../src/update/channelDetection.js";
import { deriveUpdateConvergencePlan } from "../../src/update/convergencePlan.js";
import { updateRecoveryPreflightCommitments } from "../../src/update/recoveryPreflight.js";
import type {
  UpdateApplyReportBase,
  UpdateChannelId,
  UpdatePlanBase,
} from "../../src/update/updateChannel.js";

const buildInfo: StationBuildInfo = {
  compiled: false,
  version: "1.0.0",
  buildIdentity: "a".repeat(64),
};
const targetBuildInfo: StationBuildInfo = {
  compiled: false,
  version: "1.1.0",
  buildIdentity: "b".repeat(64),
};
const providers = {} as ProviderRegistry;

describe("stn update command", () => {
  it("rejects non-dry-run --reap before update detection or mutation", async () => {
    const state = await createTempState();
    const detectAndPlan = vi.fn();

    await expect(
      runUpdateCommand(["--reap"], commandOptions(state), {
        probes: [{ channel: "installer-binary", detectAndPlan }],
      }),
    ).rejects.toThrow("Use --dry-run --reap");
    expect(detectAndPlan).not.toHaveBeenCalled();
  });

  it("publishes a v5 preview without applying or crossing runtime boundaries", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary", { status: "current" });
    const preflight = vi.fn(async ({ installed, target }: PreflightInput) =>
      preflightEvidence({ installed, target, observer: matchingObserver(), host: matchingHost() }),
    );
    const convergeObserver = vi.fn();
    const result = await runUpdateCommand(["--dry-run", "--json"], commandOptions(state), {
      probes: [fixture.probe],
      buildInfo: () => buildInfo,
      recoveryPreflight: preflight,
      convergeObserver,
    });

    expect(result).toMatchObject({
      code: 0,
      output: {
        schemaVersion: 5,
        kind: "preview",
        plan: { outcome: "converged" },
      },
    });
    expect(preflight).toHaveBeenCalledOnce();
    expect(fixture.apply).not.toHaveBeenCalled();
    expect(convergeObserver).not.toHaveBeenCalled();
  });

  it("executes same-artifact convergence in hook, Observer, Host, and persisted-state order", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary", { status: "current" });
    const initial = preflightEvidence({
      installed: { version: "1.0.0" },
      target: { version: "1.0.0" },
      observer: { status: "absent" },
      host: { status: "absent" },
      hookProviderIds: ["codex"],
      hooks: [{ provider: "codex", status: "needs-repair", reason: "owned-drift" }],
    });
    const final = preflightEvidence({
      installed: { version: "1.0.0" },
      target: { version: "1.0.0" },
      observer: matchingObserver(),
      host: matchingHost(),
      hookProviderIds: ["codex"],
      hooks: [{ provider: "codex", status: "healthy" }],
    });
    const events: string[] = [];
    const recoveryPreflight = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(final);
    const reconcileHook = vi.fn(async () => {
      events.push("hook");
      return {
        provider: "codex" as const,
        status: "repaired" as const,
        changed: true,
        verified: true,
      };
    });
    const convergeObserver = vi.fn(async () => {
      events.push("observer");
      return runningObserver(state.config);
    });
    const reconcilePersisted = vi.fn(async () => {
      events.push("persisted");
    });

    const result = await runUpdateCommand(["--json"], commandOptions(state), {
      probes: [fixture.probe],
      buildInfo: () => buildInfo,
      providers,
      recoveryPreflight,
      reconcileHook,
      convergeObserver,
      reconcilePersisted,
    });

    expect(result).toMatchObject({ code: 0, output: { kind: "result", status: "current" } });
    expect(events).toEqual(["hook", "observer", "persisted"]);
    expect(reconcileHook).toHaveBeenCalledWith("codex", providers, "/tmp/config.toml");
    expect(convergeObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "start",
        targetSelector: stationObserverBuildVersion(buildInfo),
      }),
    );
    expect(recoveryPreflight).toHaveBeenCalledTimes(2);
    expect(result.output).toMatchObject({
      finalInspection: { status: "completed", plan: { outcome: "converged" } },
    });
  });

  it("fails final verification when the installed artifact changes during the final aggregate", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary", { status: "current" });
    const inspectInstalled = vi
      .fn()
      .mockResolvedValueOnce({ version: "1.0.0" })
      .mockResolvedValueOnce({ version: "1.0.0" })
      .mockResolvedValueOnce({ version: "9.9.9" });
    const selected = await fixture.probe.detectAndPlan();
    if (selected === undefined) throw new Error("expected selected update channel");
    selected.inspectInstalled = inspectInstalled;
    fixture.probe.detectAndPlan = async () => selected;
    const recoveryPreflight = vi.fn(async ({ installed, target }: PreflightInput) =>
      preflightEvidence({
        installed,
        target,
        observer: matchingObserver(),
        host: matchingHost(),
      }),
    );

    const result = await runUpdateCommand(["--json"], commandOptions(state), {
      probes: [fixture.probe],
      buildInfo: () => buildInfo,
      recoveryPreflight,
      convergeObserver: vi.fn(async () => runningObserver(state.config)),
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        finalInspection: {
          status: "failed",
          error: { code: "UPDATE_FINAL_VERIFICATION_FAILED" },
        },
      },
    });
    expect(inspectInstalled).toHaveBeenCalledTimes(3);
  });

  it("rejects same-artifact success when final verification loses a live Host terminal", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary", { status: "current" });
    const initial = preflightEvidence({
      installed: { version: "1.0.0" },
      target: { version: "1.0.0" },
      observer: matchingObserver(),
      host: { ...matchingHost(), terminals: oldBusyHost().terminals },
      terminalDispositions: [preservableDisposition()],
    });
    const final = preflightEvidence({
      installed: { version: "1.0.0" },
      target: { version: "1.0.0" },
      observer: matchingObserver(),
      host: { status: "absent" },
    });
    const recoveryPreflight = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(final);

    const result = await runUpdateCommand(["--no-handoff", "--json"], commandOptions(state), {
      probes: [fixture.probe],
      buildInfo: () => buildInfo,
      recoveryPreflight,
      convergeObserver: vi.fn(async () => runningObserver(state.config)),
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        error: { code: "UPDATE_TERMINAL_PRESERVATION_FAILED" },
        finalInspection: { status: "completed", aggregate: { host: { status: "absent" } } },
        steps: expect.arrayContaining([
          expect.objectContaining({ id: "final-verification", status: "failed" }),
        ]),
      },
    });
  });

  it("updates the artifact but preserves the incumbent Host when --no-handoff is explicit", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary");
    const target = { version: "1.1.0" };
    const initial = preflightEvidence({
      installed: { version: "1.0.0" },
      target,
      observer: matchingObserver(),
      host: oldBusyHost(),
      terminalDispositions: [preservableDisposition()],
    });
    const final = preflightEvidence({
      installed: target,
      target,
      observer: matchingObserver(targetBuildInfo),
      host: oldBusyHost(),
      terminalDispositions: [preservableDisposition()],
    });
    const successor = vi.fn(async () => ({
      status: "completed" as const,
      finalInspection: finalInspection(final, target, targetBuildInfo, {
        action: "leave-in-place",
      }),
      hookReconciliations: [],
      steps: [
        {
          id: "host-handoff" as const,
          status: "skipped" as const,
          detail: "Host handoff was disabled; the incumbent Host was left in place.",
        },
      ],
    }));
    const result = await runUpdateCommand(["--no-handoff", "--json"], commandOptions(state), {
      probes: [fixture.probe],
      buildInfo: () => buildInfo,
      recoveryPreflight: vi.fn().mockResolvedValue(initial),
      runSuccessor: successor,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        kind: "result",
        status: "intentionally-incomplete",
        warnings: [{ code: "UPDATE_HOST_HANDOFF_DISABLED" }],
        recoveryCommands: [],
      },
    });
    expect(fixture.apply).toHaveBeenCalledOnce();
    expect(successor).toHaveBeenCalledWith(expect.objectContaining({ handoff: undefined, target }));
  });

  it("rejects successor convergence that loses no-handoff Host terminals", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary");
    const target = { version: "1.1.0" };
    const initial = preflightEvidence({
      installed: { version: "1.0.0" },
      target,
      observer: matchingObserver(),
      host: oldBusyHost(),
      terminalDispositions: [preservableDisposition()],
    });
    const final = preflightEvidence({
      installed: target,
      target,
      observer: matchingObserver(targetBuildInfo),
      host: { status: "absent" },
    });
    const successor = vi.fn(async () => ({
      status: "completed" as const,
      finalInspection: finalInspection(final, target, targetBuildInfo, {
        action: "leave-in-place",
      }),
      hookReconciliations: [],
      steps: [],
    }));

    const result = await runUpdateCommand(["--no-handoff", "--json"], commandOptions(state), {
      probes: [fixture.probe],
      buildInfo: () => buildInfo,
      recoveryPreflight: vi.fn().mockResolvedValue(initial),
      runSuccessor: successor,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        error: { code: "UPDATE_TERMINAL_PRESERVATION_FAILED" },
        initial: { host: { status: "inspected", terminals: [expect.any(Object)] } },
        finalInspection: { status: "completed", aggregate: { host: { status: "absent" } } },
      },
    });
    expect(fixture.apply).toHaveBeenCalledOnce();
  });

  it("rejects successor convergence that loses terminals during requested handoff", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary");
    const target = { version: "1.1.0" };
    const initial = preflightEvidence({
      installed: { version: "1.0.0" },
      target,
      observer: matchingObserver(),
      host: oldBusyHost(),
      terminalDispositions: [preservableDisposition()],
    });
    const final = preflightEvidence({
      installed: target,
      target,
      observer: matchingObserver(targetBuildInfo),
      host: { status: "absent" },
    });
    const successor = vi.fn(async () => ({
      status: "completed" as const,
      finalInspection: finalInspection(final, target, targetBuildInfo),
      hookReconciliations: [],
      steps: [],
    }));

    const result = await runUpdateCommand(["--json"], commandOptions(state), {
      probes: [fixture.probe],
      buildInfo: () => buildInfo,
      recoveryPreflight: vi.fn().mockResolvedValue(initial),
      runSuccessor: successor,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        error: { code: "UPDATE_TERMINAL_PRESERVATION_FAILED" },
        finalInspection: { status: "completed", aggregate: { host: { status: "absent" } } },
      },
    });
    expect(fixture.apply).toHaveBeenCalledOnce();
  });

  it("rejects an unrelated terminal substituted for a required parked-bridge adoption", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary");
    const target = { version: "1.1.0" };
    const initial = preflightEvidence({
      installed: { version: "1.0.0" },
      target,
      observer: { status: "absent" },
      host: { status: "absent" },
      parkedBridges: {
        status: "assessed",
        totalParkedCount: 1,
        unownedParkedCount: 1,
        adoptionRequiredCount: 1,
      },
      parkedTerminals: [parkedTerminalEvidence()],
    });
    const final = preflightEvidence({
      installed: target,
      target,
      observer: matchingObserver(targetBuildInfo),
      host: {
        ...matchingHost(targetBuildInfo),
        terminals: [
          {
            kind: "agent",
            terminalTargetId: "other-target",
            ptyId: "other-pty",
            ptyInstanceId: "other-instance",
            projectId: "project-1",
            worktreeId: "worktree-1",
            sessionId: "session-1",
            harnessProvider: "codex",
            alive: true,
            handoffSupport: "bridge-releasable",
          },
        ],
      },
      terminalDispositions: [
        {
          terminalTargetId: "other-target",
          ptyId: "other-pty",
          ptyInstanceId: "other-instance",
          sessionId: "session-1",
          handoff: "preservable",
          reapRecovery: "non-resumable",
          reasons: ["retained_session_missing"],
        },
      ],
    });
    const successor = vi.fn(async () => ({
      status: "completed" as const,
      finalInspection: finalInspection(final, target, targetBuildInfo),
      hookReconciliations: [],
      steps: [],
    }));

    const result = await runUpdateCommand(["--json"], commandOptions(state), {
      probes: [fixture.probe],
      buildInfo: () => buildInfo,
      recoveryPreflight: vi.fn().mockResolvedValue(initial),
      runSuccessor: successor,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        error: { code: "UPDATE_TERMINAL_PRESERVATION_FAILED" },
        finalInspection: { status: "completed", aggregate: { host: { status: "inspected" } } },
      },
    });
    expect(fixture.apply).toHaveBeenCalledOnce();
  });

  it("does not require parked adoption when no-handoff leaves the incumbent Host in place", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary");
    const target = { version: "1.1.0" };
    const parkedTerminal = parkedTerminalEvidence();
    const parkedBridges = {
      status: "assessed" as const,
      totalParkedCount: 1,
      unownedParkedCount: 1,
      adoptionRequiredCount: 1,
    };
    const initial = preflightEvidence({
      installed: { version: "1.0.0" },
      target,
      observer: matchingObserver(),
      host: oldBusyHost(),
      terminalDispositions: [preservableDisposition()],
      parkedBridges,
      parkedTerminals: [parkedTerminal],
    });
    const final = preflightEvidence({
      installed: target,
      target,
      observer: matchingObserver(targetBuildInfo),
      host: oldBusyHost(),
      terminalDispositions: [preservableDisposition()],
      parkedBridges,
    });
    const successor = vi.fn(async () => ({
      status: "completed" as const,
      finalInspection: finalInspection(final, target, targetBuildInfo, {
        action: "leave-in-place",
      }),
      hookReconciliations: [],
      parkedTerminals: [parkedTerminal],
      steps: [],
    }));

    const result = await runUpdateCommand(["--no-handoff", "--json"], commandOptions(state), {
      probes: [fixture.probe],
      buildInfo: () => buildInfo,
      recoveryPreflight: vi.fn().mockResolvedValue(initial),
      runSuccessor: successor,
    });

    expect(result).toMatchObject({
      code: 1,
      output: { status: "intentionally-incomplete", recoveryCommands: [] },
    });
  });

  it("inspects the installed artifact without replanning the selected target", async () => {
    const state = await createTempState();
    const inspectInstalled = vi.fn(async () => ({ version: "9.9.9" }));
    const detectAndPlan = vi.fn(async () => ({
      channel: "installer-binary" as const,
      plan: {
        channel: "installer-binary" as const,
        status: "current" as const,
        currentVersion: "1.0.0",
        targetVersion: "1.0.0",
        currentCli: ["/opt/stn"] as const,
      },
      apply: vi.fn(),
      inspectInstalled,
    }));
    const recoveryPreflight = vi.fn(async ({ installed, target }: PreflightInput) =>
      preflightEvidence({
        installed,
        target,
        observer: matchingObserver(),
        host: matchingHost(),
      }),
    );

    const result = await runUpdateCommand(["--json"], commandOptions(state), {
      probes: [{ channel: "installer-binary", detectAndPlan }],
      buildInfo: () => buildInfo,
      recoveryPreflight,
      convergeObserver: vi.fn(async () => runningObserver(state.config)),
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        finalInspection: { status: "completed", aggregate: { installed: { version: "9.9.9" } } },
      },
    });
    expect(recoveryPreflight).toHaveBeenLastCalledWith(
      expect.objectContaining({ installed: { version: "9.9.9" } }),
    );
    expect(detectAndPlan).toHaveBeenCalledOnce();
    expect(inspectInstalled).toHaveBeenCalledTimes(3);
  });

  it("preserves channel-specific recovery commands after artifact application is cancelled", async () => {
    const state = await createTempState();
    const applyFailure = {
      tag: "CancellationError",
      code: "EXTERNAL_COMMAND_ABORTED",
      message: "The checkout preparation was cancelled.",
    } as const;
    const recoveryCommand = ["pnpm", "install", "--frozen-lockfile"] as const;
    const apply = vi.fn(async () => {
      throw applyFailure;
    });
    const probe: UpdateChannelProbe = {
      channel: "dev-checkout",
      inspectInstalled: async () => ({ version: "1.1.0" }),
      detectAndPlan: async () => ({
        channel: "dev-checkout",
        installedScopeDigest: "b".repeat(64),
        plan: {
          channel: "dev-checkout",
          status: "update-available",
          currentVersion: "1.0.0",
          targetVersion: "1.1.0",
          currentCli: ["/repo/node", "/repo/apps/cli/dist/main.js"],
        },
        apply,
        inspectInstalled: async () => ({ version: "1.1.0" }),
        applyRecoveryCommands: (error) => (error === applyFailure ? [recoveryCommand] : undefined),
      }),
    };
    const recoveryPreflight = vi.fn(async ({ installed, target }: PreflightInput) =>
      preflightEvidence({
        installed,
        target,
        observer: { status: "absent" },
        host: { status: "absent" },
      }),
    );

    const result = await runUpdateCommand(["--json"], commandOptions(state), {
      probes: [probe],
      buildInfo: () => buildInfo,
      recoveryPreflight,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        recoveryCommands: [recoveryCommand],
        finalInspection: {
          status: "completed",
          aggregate: { installed: { version: "1.1.0" } },
          plan: { outcome: expect.not.stringMatching(/^converged$/u) },
        },
      },
    });
    expect(apply).toHaveBeenCalledOnce();
  });

  it("refuses artifact mutation when current evidence cannot fit the successor transport", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary");
    const sessions = Array.from({ length: 2_000 }, (_, index) => {
      const suffix = String(index).padStart(4, "0");
      return {
        sessionId: `session-${suffix}`,
        projectId: `project-${suffix}`,
        worktreeId: `worktree-${suffix}`,
        lifecycle: "ended" as const,
        disposition: "not-applicable" as const,
        reasons: ["station_session_ended" as const],
        handleResolution: {
          kind: "none" as const,
          eligibleHandleCount: 0 as const,
          rejectedHandleCount: 0,
          reasons: ["no_recovery_handles" as const],
        },
      };
    });
    const observer = {
      ...matchingObserver(),
      relation: "different" as const,
      recovery: {
        status: "assessed" as const,
        assessment: {
          schemaVersion: 1 as const,
          resumeEnabled: true,
          providerCapabilities: [],
          sessions,
        },
      },
    };
    const initial = preflightEvidence({
      installed: { version: "1.0.0" },
      target: { version: "1.1.0" },
      observer,
      host: { status: "absent" },
    });

    const result = await runUpdateCommand(["--json"], commandOptions(state), {
      probes: [fixture.probe],
      buildInfo: () => buildInfo,
      recoveryPreflight: vi.fn().mockResolvedValue(initial),
    });

    expect(result).toMatchObject({
      code: 1,
      output: { status: "failed", error: { code: "UPDATE_SUCCESSOR_EVIDENCE_TOO_LARGE" } },
    });
    expect(fixture.apply).not.toHaveBeenCalled();
  });

  it("refuses artifact mutation when private parked identities exceed the successor bound", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary");
    const parkedTerminals = Array.from({ length: 1_025 }, (_, index) =>
      parkedTerminalEvidence(String(index).padStart(4, "0")),
    );
    const initial = preflightEvidence({
      installed: { version: "1.0.0" },
      target: { version: "1.1.0" },
      observer: { status: "absent" },
      host: { status: "absent" },
      parkedBridges: {
        status: "assessed",
        totalParkedCount: parkedTerminals.length,
        unownedParkedCount: parkedTerminals.length,
        adoptionRequiredCount: parkedTerminals.length,
      },
      parkedTerminals,
    });

    const result = await runUpdateCommand(["--json"], commandOptions(state), {
      probes: [fixture.probe],
      buildInfo: () => buildInfo,
      recoveryPreflight: vi.fn().mockResolvedValue(initial),
    });

    expect(result).toMatchObject({
      code: 1,
      output: { status: "failed", error: { code: "UPDATE_SUCCESSOR_EVIDENCE_TOO_LARGE" } },
    });
    expect(fixture.apply).not.toHaveBeenCalled();
  });

  it("returns reap-required for a busy non-preservable Host without mutating or signaling", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary");
    const preflight = vi.fn(async ({ installed, target }: PreflightInput) =>
      preflightEvidence({
        installed,
        target,
        observer: matchingObserver(),
        host: oldBusyHost("non-releasable"),
        terminalDispositions: [
          {
            ...preservableDisposition(),
            handoff: "non-preservable",
            reapRecovery: "non-resumable",
            reasons: ["retained_session_missing"],
          },
        ],
      }),
    );
    const convergeObserver = vi.fn();
    const convergeHost = vi.fn();
    const result = await runUpdateCommand(["--json"], commandOptions(state), {
      probes: [fixture.probe],
      buildInfo: () => buildInfo,
      recoveryPreflight: preflight,
      convergeObserver,
      hostDeps: { convergeHost },
    });

    expect(result).toMatchObject({ code: 1, output: { status: "reap-required" } });
    expect(fixture.apply).not.toHaveBeenCalled();
    expect(convergeObserver).not.toHaveBeenCalled();
    expect(convergeHost).not.toHaveBeenCalled();
  });

  it("crosses exactly once into the target launcher for an artifact change", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary");
    const target = { version: "1.1.0" };
    const initial = preflightEvidence({
      installed: { version: "1.0.0" },
      target,
      observer: { status: "absent" },
      host: { status: "absent" },
      hookProviderIds: ["codex"],
      hooks: [{ provider: "codex", status: "healthy" }],
    });
    const final = preflightEvidence({
      installed: target,
      target,
      observer: matchingObserver(targetBuildInfo),
      host: matchingHost(targetBuildInfo),
      hookProviderIds: ["codex"],
      hooks: [{ provider: "codex", status: "healthy" }],
    });
    const successor = vi.fn(async (input: { target: UpdateArtifact }) => ({
      status: "completed" as const,
      finalInspection: finalInspection(final, input.target, targetBuildInfo),
      hookReconciliations: [
        { provider: "codex" as const, status: "healthy" as const, changed: false, verified: true },
      ],
      steps: [
        {
          id: "observer-restart" as const,
          status: "completed" as const,
          detail: "Target Observer running.",
        },
      ],
    }));
    const recoveryPreflight = vi.fn().mockResolvedValue(initial);

    const result = await runUpdateCommand(["--json"], commandOptions(state), {
      probes: [fixture.probe],
      buildInfo: () => buildInfo,
      recoveryPreflight,
      runSuccessor: successor,
    });

    expect(result).toMatchObject({
      code: 0,
      output: { status: "updated", target, finalInspection: { status: "completed" } },
    });
    expect(fixture.apply).toHaveBeenCalledOnce();
    expect(successor).toHaveBeenCalledOnce();
    expect(successor).toHaveBeenCalledWith(
      expect.objectContaining({ target, channel: "installer-binary", hookProviderIds: ["codex"] }),
    );
    expect(recoveryPreflight).toHaveBeenCalledOnce();
  });

  it("retains hook recovery guidance when a failed successor already supplied a retry", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary");
    const target = { version: "1.1.0" };
    const initial = preflightEvidence({
      installed: { version: "1.0.0" },
      target,
      observer: { status: "absent" },
      host: { status: "absent" },
      hookProviderIds: ["codex"],
      hooks: [{ provider: "codex", status: "healthy" }],
    });
    const error = {
      tag: "UpdateError" as const,
      code: "UPDATE_RUNTIME_CROSSOVER_FAILED",
      message: "Successor hook inspection failed.",
    };
    const retry = ["/target/stn", "update", "--channel", "installer-binary"] as const;
    const successor = vi.fn(async () => ({
      status: "failed" as const,
      finalInspection: { status: "failed" as const, error },
      hookReconciliations: [
        {
          provider: "codex" as const,
          status: "inspection-failed" as const,
          changed: false,
          verified: false,
          error,
          followUp: { action: "run-doctor" as const },
        },
      ],
      steps: [],
      recoveryCommands: [retry],
      error,
    }));

    const result = await runUpdateCommand(["--json"], commandOptions(state), {
      probes: [fixture.probe],
      buildInfo: () => buildInfo,
      recoveryPreflight: vi.fn().mockResolvedValue(initial),
      runSuccessor: successor,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        recoveryCommands: [
          ["/opt/stn", "--config", "/tmp/config.toml", "hooks", "doctor", "codex"],
          retry,
        ],
      },
    });
  });

  it("stops before Observer and Host when a correlated hook reconciliation fails", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary", { status: "current" });
    const initial = preflightEvidence({
      installed: { version: "1.0.0" },
      target: { version: "1.0.0" },
      observer: matchingObserver(),
      host: matchingHost(),
      hookProviderIds: ["codex"],
      hooks: [{ provider: "codex", status: "needs-repair", reason: "missing" }],
    });
    const reconcileHook = vi.fn(async () => ({
      provider: "codex" as const,
      status: "write-failed" as const,
      changed: false,
      verified: false,
      error: {
        tag: "HarnessProviderError" as const,
        code: "HOOK_WRITE_FAILED",
        message: "No write.",
      },
      followUp: { action: "retry" as const },
    }));
    const convergeObserver = vi.fn();
    const convergeHost = vi.fn();
    const result = await runUpdateCommand(["--json"], commandOptions(state), {
      probes: [fixture.probe],
      buildInfo: () => buildInfo,
      providers,
      recoveryPreflight: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(initial),
      reconcileHook,
      convergeObserver,
      hostDeps: { convergeHost },
    });

    expect(result).toMatchObject({ code: 1, output: { status: "failed" } });
    expect(reconcileHook).toHaveBeenCalledOnce();
    expect(convergeObserver).not.toHaveBeenCalled();
    expect(convergeHost).not.toHaveBeenCalled();
    expect(result.output).toMatchObject({
      recoveryCommands: [
        ["/opt/stn", "--config", "/tmp/config.toml", "update", "--handoff=processes"],
      ],
    });
  });

  it("requires a converged final aggregate before reporting success", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary", { status: "current" });
    const evidence = preflightEvidence({
      installed: { version: "1.0.0" },
      target: { version: "1.0.0" },
      observer: { status: "absent" },
      host: { status: "absent" },
    });
    const result = await runUpdateCommand(["--json"], commandOptions(state), {
      probes: [fixture.probe],
      buildInfo: () => buildInfo,
      recoveryPreflight: vi.fn().mockResolvedValueOnce(evidence).mockResolvedValueOnce(evidence),
      convergeObserver: vi.fn(async () => runningObserver(state.config)),
    });

    expect(result).toMatchObject({ code: 1, output: { status: "failed" } });
    expect(result.output).toMatchObject({
      finalInspection: {
        status: "completed",
        plan: { outcome: expect.not.stringMatching(/^converged$/u) },
      },
    });
  });

  it("rejects manager driving for non-manager channels before preflight", async () => {
    const state = await createTempState();
    const fixture = probeFixture("installer-binary");
    const recoveryPreflight = vi.fn();
    await expect(
      runUpdateCommand(["--dry-run", "--drive-package-manager"], commandOptions(state), {
        probes: [fixture.probe],
        buildInfo: () => buildInfo,
        recoveryPreflight,
      }),
    ).rejects.toMatchObject({ code: "UPDATE_FLAG_INVALID" });
    expect(recoveryPreflight).not.toHaveBeenCalled();
  });

  it("rejects unknown and duplicate flags before detection", async () => {
    const state = await createTempState();
    const detectAndPlan = vi.fn();
    await expect(runUpdateCommand(["--channel", "other"], commandOptions(state))).rejects.toThrow(
      "Usage: stn update",
    );
    await expect(
      runUpdateCommand(["--handoff", "--no-handoff"], commandOptions(state), {
        probes: [{ channel: "installer-binary", detectAndPlan }],
      }),
    ).rejects.toThrow("Host handoff may be configured only once");
    expect(detectAndPlan).not.toHaveBeenCalled();
  });
});

describe("update channel selection", () => {
  it("requires one unambiguous owner and honors explicit selection", async () => {
    const installer = probeFixture("installer-binary").probe;
    const npm = probeFixture("npm-global").probe;
    await expect(selectUpdateChannel({ probes: [installer, npm] })).rejects.toMatchObject({
      code: "UPDATE_CHANNEL_AMBIGUOUS",
    });
    await expect(
      selectUpdateChannel({ probes: [installer, npm], requested: "npm-global" }),
    ).resolves.toMatchObject({ channel: "npm-global" });
    await expect(
      selectUpdateChannel({
        probes: [{ channel: "mise", detectAndPlan: async () => undefined }],
        requested: "mise",
      }),
    ).rejects.toMatchObject({ code: "UPDATE_CHANNEL_NOT_DETECTED" });
  });
});

type PreflightInput = {
  installed: UpdateArtifact;
  target: UpdateArtifact;
  currentBuildInfo: StationBuildInfo;
};

function commandOptions(state: Awaited<ReturnType<typeof createTempState>>) {
  return {
    config: state.config,
    configPath: "/tmp/config.toml",
    cliEntryPath: "/repo/apps/cli/dist/main.js",
  };
}

function probeFixture(
  channel: UpdateChannelId,
  overrides: { status?: UpdatePlanBase["status"]; targetVersion?: string } = {},
) {
  const plan: UpdatePlanBase = {
    channel,
    status: overrides.status ?? "update-available",
    currentVersion: "1.0.0",
    targetVersion: overrides.targetVersion ?? (overrides.status === "current" ? "1.0.0" : "1.1.0"),
    currentCli: ["/opt/stn"],
    ...(channel === "npm-global"
      ? { managerCommand: ["npm", "install", "-g", "station"] as const }
      : {}),
  };
  const apply = vi.fn(
    async () =>
      ({
        channel,
        status: "installed" as const,
        previousVersion: plan.currentVersion,
        installedVersion: plan.targetVersion,
        successorCli: ["/opt/stn"] as [string, ...string[]],
        warnings: [],
      }) satisfies UpdateApplyReportBase,
  );
  const probe: UpdateChannelProbe = {
    channel,
    inspectInstalled: async () => ({
      version: plan.targetVersion,
      ...(plan.targetRevision === undefined ? {} : { revision: plan.targetRevision }),
    }),
    detectAndPlan: async () => ({
      channel,
      installedScopeDigest: "b".repeat(64),
      plan,
      apply,
      inspectInstalled: async () => ({
        version: plan.targetVersion,
        ...(plan.targetRevision === undefined ? {} : { revision: plan.targetRevision }),
      }),
    }),
  };
  return { probe, apply };
}

function preflightEvidence(input: {
  installed: UpdateArtifact;
  target: UpdateArtifact;
  observer?: unknown;
  host?: unknown;
  hookProviderIds?: readonly string[];
  hooks?: readonly unknown[];
  terminalDispositions?: readonly unknown[];
  parkedBridges?: unknown;
  parkedTerminals?: readonly UpdateReapTerminalEvidence[];
}): UpdateReapRecoveryPreflight {
  const evidence = {
    observer: input.observer ?? { status: "absent" },
    host: input.host ?? { status: "absent" },
    hookProviderIds: input.hookProviderIds ?? [],
    hooks: input.hooks ?? [],
    parkedBridges: input.parkedBridges ?? {
      status: "assessed",
      totalParkedCount: 0,
      unownedParkedCount: 0,
      adoptionRequiredCount: 0,
    },
    terminalDispositions: input.terminalDispositions ?? [],
  };
  const preflight = UpdateReapRecoveryPreflightSchema.parse({
    schemaVersion: 1,
    boundary: { authorization: "none", actions: "not-included", digest: "not-included" },
    installed: input.installed,
    target: input.target,
    ...evidence,
    evidenceComplete: updateReapEvidenceIsComplete(evidence),
  });
  if (input.parkedTerminals !== undefined) {
    Object.defineProperty(preflight, updateRecoveryPreflightCommitments, {
      value: { parkedTerminals: input.parkedTerminals },
      enumerable: false,
    });
  }
  return preflight;
}

function matchingObserver(
  runtime: StationBuildInfo = buildInfo,
): UpdateReapRecoveryPreflight["observer"] {
  return {
    status: "exact",
    buildVersion: stationObserverBuildVersion(runtime),
    relation: "matching-target",
    health: "healthy",
    recovery: {
      status: "assessed",
      assessment: {
        schemaVersion: 1,
        resumeEnabled: true,
        providerCapabilities: [],
        sessions: [],
      },
    },
  };
}

function matchingHost(runtime: StationBuildInfo = buildInfo): UpdateReapRecoveryPreflight["host"] {
  return {
    status: "inspected",
    buildVersion: runtime.version,
    buildIdentity: runtime.buildIdentity,
    protocolVersion: HOST_PROTOCOL_VERSION,
    relation: "matching-target",
    compatibility: "reuse",
    terminals: [],
  };
}

function oldBusyHost(handoffSupport: "bridge-releasable" | "non-releasable" = "bridge-releasable") {
  return {
    status: "inspected" as const,
    buildVersion: "0.9.0",
    buildIdentity: "b".repeat(64),
    protocolVersion: HOST_PROTOCOL_VERSION,
    relation: "different" as const,
    compatibility: "replace" as const,
    terminals: [
      {
        kind: "agent" as const,
        terminalTargetId: "target-1",
        ptyId: "pty-1",
        ptyInstanceId: "instance-1",
        projectId: "project-1",
        worktreeId: "worktree-1",
        sessionId: "session-1",
        harnessProvider: "codex" as const,
        alive: true,
        handoffSupport,
      },
    ],
  };
}

function preservableDisposition() {
  return {
    terminalTargetId: "target-1",
    ptyId: "pty-1",
    ptyInstanceId: "instance-1",
    sessionId: "session-1",
    handoff: "preservable" as const,
    reapRecovery: "non-resumable" as const,
    reasons: ["retained_session_missing" as const],
  };
}

function parkedTerminalEvidence(suffix = "parked"): UpdateReapTerminalEvidence {
  return {
    kind: "agent",
    terminalTargetId: `target-${suffix}`,
    ptyId: `pty-${suffix}`,
    ptyInstanceId: `instance-${suffix}`,
    projectId: `project-${suffix}`,
    worktreeId: `worktree-${suffix}`,
    sessionId: `session-${suffix}`,
    harnessProvider: "codex",
    alive: true,
    handoffSupport: "bridge-releasable",
  };
}

function runningObserver(config: StationConfig): ExactObserverBuildStatus {
  const paths = resolveObserverPaths(config);
  return {
    status: "running",
    paths,
    health: {
      schemaVersion: STATION_SCHEMA_VERSION,
      status: "healthy",
      pid: 42,
      startedAt: "2026-09-02T00:00:00.000Z",
      version: stationObserverBuildVersion(buildInfo),
      socketPath: paths.socketPath,
    },
    lifecycle: "started",
  };
}

function finalInspection(
  aggregate: UpdateReapRecoveryPreflight,
  target: UpdateArtifact,
  runtime: StationBuildInfo = buildInfo,
  handoff:
    | { action: "preserve"; fidelity: "processes" | "screen" }
    | { action: "leave-in-place" } = {
    action: "preserve",
    fidelity: "processes",
  },
): UpdateFinalInspection {
  const plan = deriveUpdateConvergencePlan(
    UpdateConvergencePlanningInputSchema.parse({
      preflight: aggregate,
      targetRuntime: {
        status: "known",
        buildIdentity: runtime.buildIdentity,
        observerSelector: stationObserverBuildVersion(runtime),
      },
      installation: {
        whenRequired: "apply",
        owner: "installer-binary",
        command: { kind: "none" },
      },
      handoff,
    }),
  );
  if (aggregate.target.version !== target.version) throw new Error("Test target mismatch.");
  return { status: "completed", aggregate, plan };
}
