import type { StationConfig } from "@station/config";
import type {
  SafeError,
  UpdateCommandReport,
  UpdateHostConvergenceCommitment,
  UpdateReapRecoveryPreflight,
} from "@station/contracts";
import {
  STATION_SCHEMA_VERSION,
  UpdateCommandReportSchema,
  updateReapEvidenceIsComplete,
} from "@station/contracts";
import {
  type ExternalCommandInput,
  type ExternalCommandResult,
  stationBuildInfo,
} from "@station/runtime";
import { describe, expect, it, vi } from "vitest";
import type { CliRunOptions } from "../../src/cliTypes.js";
import { updateCommandResult } from "../../src/commands/update/report.js";
import * as updateCommandAdapter from "../../src/commands/update.js";
import type { UpdateChannelProbe } from "../../src/update/channelDetection.js";
import { createDefaultUpdateProbes } from "../../src/update/defaultUpdateProbes.js";
import { createPublicUpdateReport } from "../../src/update/publicUpdateReportAdapter.js";
import type { UpdateConvergencePrivateEvidence } from "../../src/update/recoveryPreflight.js";
import { runUpdateConvergence } from "../../src/update/updateConvergenceUseCase.js";
import type { UpdateHostRuntimePort } from "../../src/update/updateHostRuntimePort.js";
import { createUpdateRuntimeConvergenceAdapter } from "../../src/update/updateRuntimeConvergenceAdapter.js";
import type { UpdateRuntimeConvergencePort } from "../../src/update/updateRuntimeConvergencePort.js";
import { createUpdateSuccessorTransportAdapter } from "../../src/update/updateSuccessorTransportAdapter.js";

const config = {
  observer: { socketPath: `/tmp/station-update-command-${process.pid}/observer.sock` },
} as StationConfig;
const identityA = "a".repeat(64);
const identityB = "b".repeat(64);

function runUpdateCommand(
  args: readonly string[],
  commandOptions: ReturnType<typeof options>,
  overrides: NonNullable<CliRunOptions["updateDeps"]>,
) {
  const convergenceInspection = overrides.convergenceInspection;
  if (convergenceInspection === undefined) throw new Error("missing test convergence inspection");
  const buildInfo = overrides.buildInfo ?? stationBuildInfo;
  const adapterOptions = {
    ...(commandOptions.configPath === undefined ? {} : { configPath: commandOptions.configPath }),
    ...(overrides.commandRunner === undefined ? {} : { commandRunner: overrides.commandRunner }),
  };
  const ports = {
    convergenceInspection,
    buildInfo,
    probes:
      overrides.probes ??
      createDefaultUpdateProbes(commandOptions, {
        buildInfo,
        ...(overrides.executablePath === undefined
          ? {}
          : { executablePath: overrides.executablePath }),
        ...(overrides.commandRunner === undefined
          ? {}
          : { commandRunner: overrides.commandRunner }),
      }),
    publicReport: overrides.publicReport ?? { create: createPublicUpdateReport },
    host: overrides.host ?? successfulHostRuntime(),
    runtime: overrides.runtime ?? createUpdateRuntimeConvergenceAdapter(adapterOptions),
    successor: overrides.successor ?? createUpdateSuccessorTransportAdapter(adapterOptions),
  };
  return updateCommandAdapter.runUpdateCommand(args, {
    convergence: overrides.convergence ?? {
      run: (request) => runUpdateConvergence(request, ports),
    },
  });
}

describe("stn update convergence", () => {
  it("requires an explicit selected target for the internal successor evaluator", async () => {
    const detectAndPlan = vi.fn();
    await expect(
      runUpdateCommand(["--internal-successor-evaluator"], options(), {
        probes: [{ channel: "installer-binary", detectAndPlan }],
        convergenceInspection: inspection(preflight("1.0.0", "1.0.0")),
      }),
    ).rejects.toThrow("Usage: stn update");
    expect(detectAndPlan).not.toHaveBeenCalled();
  });

  it("rejects destructive reap execution before target detection", async () => {
    const detectAndPlan = vi.fn();
    await expect(
      runUpdateCommand(["--reap"], options(), {
        probes: [{ channel: "installer-binary", detectAndPlan }],
        convergenceInspection: inspection(preflight("1.0.0", "1.0.0")),
      }),
    ).rejects.toThrow("Use --dry-run --reap");
    expect(detectAndPlan).not.toHaveBeenCalled();
  });

  it("emits an explicit non-executed preview for a fresh selected target", async () => {
    const fixture = probe("update-available");
    const runner = vi.fn();
    const result = await runUpdateCommand(["--dry-run", "--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
      commandRunner: runner,
    });
    expect(result).toMatchObject({
      code: 0,
      output: {
        schemaVersion: 4,
        status: "planned",
        artifactApplication: { status: "preview" },
        initial: {
          evaluator: "incumbent-cli",
          plan: {
            selectedTarget: {
              artifact: { version: "2.0.0" },
              buildIdentity: { status: "not-yet-provable" },
            },
          },
        },
        result: { kind: "preview" },
      },
    });
    const output = reportFrom(result);
    expect(output.artifactApplication).not.toHaveProperty("managerCommand");
    expect(output.result).not.toHaveProperty("actionAudits");
    if (output.result.kind !== "preview") throw new Error("expected preview result");
    expect(output.result.phases).toHaveLength(7);
    expect(output.result.phases.every((phase) => phase.status === "not-executed")).toBe(true);
    const text = textFor(result);
    expect(text).toContain(nonMutatingPhaseText("not-executed"));
    expect(text).not.toContain("verified plan:");
    expect(fixture.apply).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects an incoherent public/private inspection before planning or mutation", async () => {
    const fixture = probe("current");
    const evidence = preflight("1.0.0", "1.0.0", {
      observer: matchingObserver(identityA),
    });
    const coherentPrivate = privateEvidence(evidence);
    const observer = coherentPrivate.observer;
    if (observer === undefined) throw new Error("missing coherent Observer fixture");

    await expect(
      runUpdateCommand(["--json"], options(), {
        probes: [fixture.probe],
        buildInfo: build(identityA, "1.0.0"),
        convergenceInspection: async () => ({
          preflight: evidence,
          privateEvidence: {
            ...coherentPrivate,
            observer: { ...observer, buildSelector: "different-build" },
          },
        }),
      }),
    ).rejects.toThrow("Public and private Observer build selectors must match exactly.");
    expect(fixture.apply).not.toHaveBeenCalled();
  });

  it.each([
    {
      channel: "homebrew" as const,
      command: [
        "/opt/homebrew/bin/brew",
        "upgrade",
        "--formula",
        "jeremy0dell/station/station",
      ] as const,
      rendered:
        "manager command: /opt/homebrew/bin/brew upgrade --formula jeremy0dell/station/station",
    },
    {
      channel: "npm-global" as const,
      command: ["/usr/local/bin/npm", "install", "--global", "@station/cli@2.0.0"] as const,
      rendered: "manager command: /usr/local/bin/npm install --global @station/cli@2.0.0",
    },
    {
      channel: "mise" as const,
      command: ["/opt/mise tools/bin/mise", "upgrade", "station"] as const,
      rendered: "manager command: '/opt/mise tools/bin/mise' upgrade station",
    },
  ])("retains and quotes the $channel native command for defer and preview", async (testCase) => {
    for (const args of [["--json"], ["--dry-run", "--json"]]) {
      const fixture = probe(
        "update-available",
        "1.0.0",
        "2.0.0",
        testCase.command,
        testCase.channel,
      );
      const runner = vi.fn();
      const result = await runUpdateCommand(args, options(), {
        probes: [fixture.probe],
        buildInfo: build(identityA, "1.0.0"),
        convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
        commandRunner: runner,
      });
      const report = reportFrom(result);

      expect(result.code).toBe(0);
      expect(report.artifactApplication).toEqual({
        status: args.includes("--dry-run") ? "preview" : "deferred",
        managerCommand: testCase.command,
      });
      expect(report.result.kind).toBe(args.includes("--dry-run") ? "preview" : "deferred");
      expect(textFor(result)).toContain(testCase.rendered);
      expect(textFor(result)).not.toContain("verified plan:");
      expect(fixture.apply).not.toHaveBeenCalled();
      expect(runner).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      name: "unknown runtime",
      evidence: preflight("1.0.0", "2.0.0", {
        observer: {
          status: "unknown",
          reason: "identity-unavailable",
          error: {
            tag: "UpdatePreflightError",
            code: "OBSERVER_UNKNOWN",
            message: "Observer identity unavailable.",
          },
        },
      }),
    },
    {
      name: "busy bridge Host",
      evidence: preflight("1.0.0", "2.0.0", {
        observer: matchingObserver(identityA),
        host: differentHost(identityA, [terminal("bridge-releasable")]),
        terminalDispositions: [disposition("preservable", "recoverable")],
      }),
    },
    {
      name: "reap-required Host",
      evidence: preflight("1.0.0", "2.0.0", {
        observer: matchingObserver(identityA),
        host: differentHost(identityA, [terminal("non-releasable")]),
        terminalDispositions: [disposition("non-preservable", "non-resumable")],
      }),
    },
  ])("defers package-manager application with $name evidence and executes nothing", async ({
    evidence,
  }) => {
    const fixture = probe(
      "update-available",
      "1.0.0",
      "2.0.0",
      ["brew", "upgrade", "station"],
      "homebrew",
    );
    const runner = vi.fn();
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(evidence),
      commandRunner: runner,
    });
    const report = reportFrom(result);

    expect(result.code).toBe(0);
    expect(report).toMatchObject({
      status: "deferred",
      artifactApplication: { status: "deferred" },
      initial: { preflight: evidence, plan: { status: "deferred" } },
      result: { kind: "deferred" },
    });
    if (report.result.kind !== "deferred") throw new Error("expected deferred result");
    expect(report.result.phases).toEqual(
      report.initial.plan.phases.map((phase, index) => ({
        id: phase.id,
        status: index === 0 ? "deferred" : "not-executed",
      })),
    );
    expect(report.result).not.toHaveProperty("actionAudits");
    expect(report.artifactApplication).toMatchObject({
      managerCommand: ["brew", "upgrade", "station"],
    });
    expect(fixture.apply).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(textFor(result)).toContain("status: deferred");
    expect(textFor(result)).toContain(nonMutatingPhaseText("deferred"));
    expect(textFor(result)).not.toContain("verified plan:");
  });

  it("starts an absent runtime, reconciles, and reports current only after a verified no-op plan", async () => {
    const fixture = probe("current");
    const inspect = sequenceInspection([
      preflight("1.0.0", "1.0.0"),
      preflight("1.0.0", "1.0.0", {
        observer: matchingObserver(identityA),
        evidenceComplete: false,
      }),
    ]);
    const runner = vi.fn(commandResult);
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspect,
      commandRunner: runner,
    });
    expect(result).toMatchObject({
      code: 0,
      output: {
        status: "current",
        artifactApplication: { status: "not-required" },
        result: {
          kind: "current-runtime-execution",
          actionAudits: [{ executor: "incumbent-cli" }],
          postAction: { plan: { status: "converged" } },
          verification: { status: "converged", source: "post-action" },
        },
      },
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(fixture.apply).not.toHaveBeenCalled();
    expect(runner.mock.calls.map(([input]) => (input as ExternalCommandInput).args)).toEqual([
      expect.arrayContaining(["observer", "start"]),
      expect.arrayContaining(["reconcile", "--reason", "update-convergence"]),
    ]);
  });

  it("executes a health-pinned Observer restart after installed executable replacement", async () => {
    const fixture = probe("current");
    const inspect = sequenceInspection([
      preflight("1.0.0", "1.0.0", { observer: restartableObserverDrift() }),
      preflight("1.0.0", "1.0.0", { observer: matchingObserver(identityA) }),
    ]);
    const runner = vi.fn(commandResult);
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspect,
      commandRunner: runner,
    });

    expect(result).toMatchObject({
      code: 0,
      output: {
        status: "current",
        initial: {
          preflight: { observer: { reason: "restartable-executable-drift" } },
          plan: { components: { observer: { action: "restart" } } },
        },
        result: {
          kind: "current-runtime-execution",
          postAction: { plan: { status: "converged" } },
        },
      },
    });
    expect(runner.mock.calls[0]?.[0].args).toEqual(expect.arrayContaining(["observer", "restart"]));
  });

  it("returns already-converged without running actions for a healthy matching runtime", async () => {
    const fixture = probe("current");
    const runner = vi.fn();
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(
        preflight("1.0.0", "1.0.0", {
          observer: matchingObserver(identityA),
          host: matchingHost(identityA),
        }),
      ),
      commandRunner: runner,
    });
    expect(result).toMatchObject({
      code: 0,
      output: {
        status: "current",
        result: { kind: "already-converged", verification: { source: "initial" } },
      },
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("renders artifact, component, recovery, and ordered-phase distinctions in text", async () => {
    const fixture = probe("current");
    const result = await runUpdateCommand([], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(
        preflight("1.0.0", "1.0.0", {
          observer: matchingObserver(identityA),
          host: matchingHost(identityA),
        }),
      ),
    });
    expect(result).toMatchObject({ code: 0, outputFormat: "text" });
    expect(result.output).toEqual(expect.any(String));
    for (const label of [
      "artifact application:",
      "hooks:",
      "observer:",
      "host:",
      "terminals:",
      "recovery:",
      "ordered convergence phases:",
      "artifact-application:",
      "verification:",
    ]) {
      expect(result.output).toContain(label);
    }
    expect(result.output).toContain("verified plan:");
  });

  it("executes bridge-preserving handoff without requiring reap-only recovery evidence", async () => {
    const fixture = probe("current");
    const bridge = terminal("bridge-releasable");
    const inspect = sequenceInspection([
      preflight("1.0.0", "1.0.0", {
        observer: matchingObserver(identityA, "unknown"),
        host: differentHost(identityB, [bridge]),
        terminalDispositions: [disposition("preservable", "unknown")],
      }),
      preflight("1.0.0", "1.0.0", {
        observer: matchingObserver(identityA),
        host: matchingHost(identityA, [bridge]),
        terminalDispositions: [disposition("preservable", "recoverable")],
      }),
    ]);
    const runner = vi.fn(commandResult);
    const result = await runUpdateCommand(["--handoff=screen", "--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspect,
      commandRunner: runner,
    });
    expect(result).toMatchObject({ code: 0, output: { status: "current" } });
    const report = reportFrom(result);
    if (report.result.kind !== "current-runtime-execution") {
      throw new Error("expected runtime execution");
    }
    expect(report.result.actionAudits[0].actions).toEqual([
      {
        phase: "terminal-convergence",
        action: "preserve-via-handoff",
        status: "completed",
        fidelity: "screen",
        handoffReceipt: { terminals: [terminalIdentity()] },
      },
      {
        phase: "host-convergence",
        action: "handoff",
        status: "completed",
        fidelity: "screen",
      },
      { phase: "runtime-reconcile", action: "run", status: "completed" },
      { phase: "verification", action: "reinspect", status: "completed" },
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("/tmp/station-host.sock");
    expect(serialized).not.toContain("Live handoff completed.");
    expect(report.initial.plan.components).toMatchObject({
      host: { action: "handoff", fidelity: "screen" },
      terminals: { action: "preserve-via-handoff", fidelity: "screen" },
    });
    expect(textFor(result)).toContain("host: handoff (busy-handoff) fidelity=screen");
    expect(textFor(result)).toContain(
      "terminal-convergence: preserve-via-handoff completed fidelity=screen",
    );
    const contradictoryAudit = structuredClone(report);
    if (contradictoryAudit.result.kind !== "current-runtime-execution") {
      throw new Error("expected cloned runtime execution");
    }
    const hostAudit = contradictoryAudit.result.actionAudits[0].actions.find(
      (action) => action.phase === "host-convergence",
    );
    if (hostAudit === undefined) throw new Error("missing Host handoff audit");
    hostAudit.fidelity = "processes";
    expect(UpdateCommandReportSchema.safeParse(contradictoryAudit).success).toBe(false);
    expect(
      runner.mock.calls.some(([input]) => (input as ExternalCommandInput).args?.includes("host")),
    ).toBe(false);
  });

  it("executes only the exact planned idle Host replacement commitment", async () => {
    const fixture = probe("current");
    const inspect = sequenceInspection([
      preflight("1.0.0", "1.0.0", {
        observer: matchingObserver(identityA),
        host: differentHost(identityB, []),
      }),
      preflight("1.0.0", "1.0.0", {
        observer: matchingObserver(identityA),
        host: matchingHost(identityA),
      }),
    ]);
    let hostCommitment: UpdateHostConvergenceCommitment | undefined;
    const host = successfulHostRuntime({
      replaceIdleHost: async (commitment) => {
        hostCommitment = commitment;
        return completedHostResult("replace-idle", commitment);
      },
    });
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspect,
      commandRunner: commandResult,
      host,
    });
    const report = reportFrom(result);

    expect(result.code).toBe(0);
    expect(hostCommitment).toEqual({
      incumbent: {
        buildVersion: { status: "known", value: "0.9.0" },
        buildIdentity: { status: "known", value: identityB },
        protocolVersion: 8,
        inventory: { terminals: [] },
      },
      target: { buildVersion: "1.0.0", buildIdentity: identityA },
    });
    if (report.result.kind !== "current-runtime-execution") {
      throw new Error("expected runtime execution");
    }
    expect(report.result.actionAudits[0].actions).toEqual([
      { phase: "host-convergence", action: "replace-idle", status: "completed" },
      { phase: "runtime-reconcile", action: "run", status: "completed" },
      { phase: "verification", action: "reinspect", status: "completed" },
    ]);
  });

  it("rejects Host plan drift, performs fresh aggregate inspection, and audits no switched action", async () => {
    const fixture = probe("current");
    const bridge = terminal("bridge-releasable");
    const finalEvidence = preflight("1.0.0", "1.0.0", {
      observer: matchingObserver(identityA),
      host: differentHost(identityB, []),
    });
    const inspect = sequenceInspection([
      preflight("1.0.0", "1.0.0", {
        observer: matchingObserver(identityA),
        host: differentHost(identityB, [bridge]),
        terminalDispositions: [disposition("preservable", "recoverable")],
      }),
      finalEvidence,
    ]);
    const result = await runUpdateCommand(["--handoff=screen", "--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspect,
      commandRunner: commandResult,
      host: successfulHostRuntime({
        handoffHost: async (fidelity, commitment) =>
          hostStoppedResult("handoff", "stale", commitment, fidelity),
      }),
    });
    const report = reportFrom(result);

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({
      status: "failed",
      result: {
        kind: "execution-failed",
        stage: "host-convergence",
        finalInspection: { status: "completed", evidence: { preflight: finalEvidence } },
        actionAudits: [
          {
            actions: [
              {
                phase: "host-convergence",
                action: "handoff",
                status: "failed",
                fidelity: "screen",
              },
            ],
          },
        ],
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('"action":"replace-idle","status":"completed"');
    expect(serialized).not.toContain('"action":"preserve-via-handoff","status":"completed"');
    expect(textFor(result)).toContain("host-convergence: handoff failed fidelity=screen");
  });

  it("stops and re-inspects without mutation when the planned Host disappeared", async () => {
    const fixture = probe("current");
    const inspect = sequenceInspection([
      preflight("1.0.0", "1.0.0", {
        observer: matchingObserver(identityA),
        host: differentHost(identityB, []),
      }),
      preflight("1.0.0", "1.0.0", {
        observer: matchingObserver(identityA),
        host: { status: "absent" },
      }),
    ]);
    const reconcile = vi.fn(async () => undefined);
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspect,
      runtime: {
        ...runtimePort(),
        reconcile,
      },
      host: successfulHostRuntime({
        replaceIdleHost: async (commitment) =>
          hostStoppedResult("replace-idle", "absent", commitment),
      }),
    });
    const report = reportFrom(result);

    expect(result.code).toBe(1);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(reconcile).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      status: "failed",
      result: {
        kind: "execution-failed",
        stage: "host-convergence",
        actionAudits: [
          { actions: [{ phase: "host-convergence", action: "replace-idle", status: "failed" }] },
        ],
      },
    });
  });

  it("fails the superseded plan after exact concurrent Host convergence without claiming mutation", async () => {
    const fixture = probe("current");
    const bridge = terminal("bridge-releasable");
    const inspect = sequenceInspection([
      preflight("1.0.0", "1.0.0", {
        observer: matchingObserver(identityA),
        host: differentHost(identityB, [bridge]),
        terminalDispositions: [disposition("preservable", "recoverable")],
      }),
      preflight("1.0.0", "1.0.0", {
        observer: matchingObserver(identityA),
        host: matchingHost(identityA, [bridge]),
        terminalDispositions: [disposition("preservable", "recoverable")],
      }),
    ]);
    const reconcile = vi.fn(async () => undefined);
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspect,
      runtime: { ...runtimePort(), reconcile },
      host: successfulHostRuntime({
        handoffHost: async (_fidelity, commitment) => ({
          schemaVersion: 1,
          action: "update-converge",
          requestedAction: "handoff",
          requestedFidelity: "processes",
          status: "already-converged",
          validatedCommitment: commitment,
          actualInventory: commitment.incumbent.inventory,
        }),
      }),
    });
    const report = reportFrom(result);

    expect(result.code).toBe(1);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(reconcile).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      status: "failed",
      result: {
        kind: "execution-failed",
        stage: "host-convergence",
        finalInspection: {
          status: "completed",
          evidence: { plan: { status: "converged" } },
        },
      },
    });
    if (report.result.kind !== "execution-failed") {
      throw new Error("expected superseded execution failure");
    }
    expect(report.result.actionAudits[0].actions).toEqual([
      {
        phase: "host-convergence",
        action: "handoff",
        status: "skipped",
        fidelity: "processes",
      },
    ]);
  });

  it("attributes a Host handoff failure to host convergence", async () => {
    const fixture = probe("current");
    const bridge = terminal("bridge-releasable");
    const evidence = preflight("1.0.0", "1.0.0", {
      observer: matchingObserver(identityA),
      host: differentHost(identityB, [bridge]),
      terminalDispositions: [disposition("preservable", "recoverable")],
    });
    const result = await runUpdateCommand(["--handoff=screen", "--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(evidence),
      commandRunner: commandResult,
      host: successfulHostRuntime({
        handoffHost: async (fidelity) => {
          expect(fidelity).toBe("screen");
          throw new Error("Host handoff failed");
        },
      }),
    });
    const report = reportFrom(result);
    expect(report).toMatchObject({
      status: "failed",
      result: { kind: "execution-failed", stage: "host-convergence" },
    });
    if (report.result.kind !== "execution-failed") throw new Error("expected failure result");
    expect(report.result.actionAudits[0]?.actions).toEqual([
      {
        phase: "host-convergence",
        action: "handoff",
        status: "failed",
        fidelity: "screen",
      },
    ]);
    expect(textFor(result)).toContain("host-convergence: handoff failed fidelity=screen");
  });

  it("attributes reconcile failure after Host handoff to runtime reconcile", async () => {
    const fixture = probe("current");
    const bridge = terminal("bridge-releasable");
    const evidence = preflight("1.0.0", "1.0.0", {
      observer: matchingObserver(identityA),
      host: differentHost(identityB, [bridge]),
      terminalDispositions: [disposition("preservable", "recoverable")],
    });
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(evidence),
      commandRunner: async (input) => {
        if (input.args?.includes("reconcile")) throw new Error("Runtime reconcile failed");
        return commandResult(input);
      },
    });
    const report = reportFrom(result);
    expect(report).toMatchObject({
      status: "failed",
      result: { kind: "execution-failed", stage: "runtime-reconcile" },
    });
    if (report.result.kind !== "execution-failed") throw new Error("expected failure result");
    expect(report.result.actionAudits[0]?.actions).toEqual([
      {
        phase: "terminal-convergence",
        action: "preserve-via-handoff",
        status: "completed",
        fidelity: "processes",
        handoffReceipt: { terminals: [terminalIdentity()] },
      },
      {
        phase: "host-convergence",
        action: "handoff",
        status: "completed",
        fidelity: "processes",
      },
      { phase: "runtime-reconcile", action: "run", status: "failed" },
    ]);
  });

  it.each([
    { name: "missing", kind: "missing" as const },
    {
      name: "same-count wrong",
      kind: "wrong-identity" as const,
    },
    {
      name: "duplicate",
      kind: "duplicate" as const,
    },
    { name: "action-switched", kind: "action-switched" as const },
    { name: "fidelity-switched", kind: "fidelity-switched" as const },
  ])("rejects a $name Host convergence receipt", async ({ kind }) => {
    const fixture = probe("current");
    const bridge = terminal("bridge-releasable");
    const evidence = preflight("1.0.0", "1.0.0", {
      observer: matchingObserver(identityA),
      host: differentHost(identityB, [bridge]),
      terminalDispositions: [disposition("preservable", "recoverable")],
    });
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(evidence),
      commandRunner: commandResult,
      host: successfulHostRuntime({
        handoffHost: async (_fidelity, commitment) => {
          const exact = completedHostResult("handoff", commitment);
          const terminals =
            kind === "duplicate"
              ? [terminalIdentity(), terminalIdentity()]
              : [terminalIdentity("2")];
          return (
            kind === "missing"
              ? { ...exact, receipt: undefined }
              : kind === "action-switched"
                ? { ...exact, receipt: { ...exact.receipt, ensuredBy: "idle-replace" } }
                : kind === "fidelity-switched"
                  ? { ...exact, receipt: { ...exact.receipt, fidelity: "screen" } }
                  : {
                      ...exact,
                      receipt: {
                        ...exact.receipt,
                        actualInventory: { terminals },
                        handoffReceipt: { terminals },
                      },
                    }
          ) as never;
        },
      }),
    });
    const report = reportFrom(result);
    const expectedPhase = kind === "missing" ? "host-convergence" : "terminal-convergence";
    expect(report).toMatchObject({
      status: "failed",
      result: { kind: "execution-failed", stage: expectedPhase },
    });
    if (report.result.kind !== "execution-failed") throw new Error("expected failure result");
    expect(report.result.actionAudits[0]?.actions.at(-1)).toMatchObject({
      phase: expectedPhase,
      status: "failed",
    });
  });

  it.each([
    { name: "missing", finalTerminals: [], finalDispositions: [] },
    {
      name: "same-count wrong",
      finalTerminals: [terminal("bridge-releasable", "2")],
      finalDispositions: [disposition("preservable", "recoverable", "2")],
    },
  ])("fails final verification for $name PTY lifetime identities after handoff", async ({
    finalTerminals,
    finalDispositions,
  }) => {
    const fixture = probe("current");
    const bridge = terminal("bridge-releasable");
    const inspect = sequenceInspection([
      preflight("1.0.0", "1.0.0", {
        observer: matchingObserver(identityA),
        host: differentHost(identityB, [bridge]),
        terminalDispositions: [disposition("preservable", "recoverable")],
      }),
      preflight("1.0.0", "1.0.0", {
        observer: matchingObserver(identityA),
        host: matchingHost(identityA, finalTerminals),
        terminalDispositions: finalDispositions,
      }),
    ]);
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspect,
      commandRunner: commandResult,
    });
    const report = reportFrom(result);
    expect(report).toMatchObject({
      status: "failed",
      result: { kind: "execution-failed", stage: "verification" },
      error: { code: "UPDATE_TERMINAL_CONVERGENCE_INCOMPLETE" },
    });
    if (report.result.kind !== "execution-failed") throw new Error("expected failure result");
    expect(report.result.actionAudits[0]?.actions).toContainEqual(
      expect.objectContaining({
        phase: "terminal-convergence",
        action: "preserve-via-handoff",
        status: "completed",
      }),
    );
  });

  it("audits same-version hook reconciliation against the exact provider decision", async () => {
    const fixture = probe("current");
    const inspect = sequenceInspection([
      preflight("1.0.0", "1.0.0", {
        observer: matchingObserver(identityA),
        host: matchingHost(identityA),
        hookProviderIds: ["codex"],
        hooks: [{ provider: "codex", status: "needs-repair", reason: "owned-drift" }],
      }),
      preflight("1.0.0", "1.0.0", {
        observer: matchingObserver(identityA),
        host: matchingHost(identityA),
        hookProviderIds: ["codex"],
        hooks: [{ provider: "codex", status: "healthy" }],
      }),
    ]);
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspect,
      commandRunner: async (input) =>
        input.args?.includes("hooks")
          ? externalResult(
              input,
              JSON.stringify({
                provider: "codex",
                status: "repaired",
                changed: true,
                verified: true,
              }),
              0,
            )
          : externalResult(input, "", 0),
    });
    const report = reportFrom(result);
    expect(report).toMatchObject({ status: "current" });
    if (report.result.kind !== "current-runtime-execution") {
      throw new Error("expected current runtime execution");
    }
    expect(report.result.actionAudits[0].actions[0]).toMatchObject({
      phase: "hook-reconciliation",
      action: "reconcile",
      status: "completed",
      provider: "codex",
      hookResult: { provider: "codex", status: "repaired" },
    });
  });

  it.each([
    { label: "exit 2", exitCode: 2 },
    { label: "signal-like exit 143", exitCode: 143 },
  ])("rejects hook failure JSON returned with $label", async ({ exitCode }) => {
    const fixture = probe("current");
    const evidence = preflight("1.0.0", "1.0.0", {
      observer: matchingObserver(identityA),
      host: matchingHost(identityA),
      hookProviderIds: ["codex"],
      hooks: [{ provider: "codex", status: "needs-repair", reason: "owned-drift" }],
    });
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(evidence),
      commandRunner: async (input) =>
        input.args?.includes("hooks")
          ? externalResult(
              input,
              JSON.stringify({
                provider: "codex",
                status: "write-failed",
                changed: false,
                verified: false,
                error: sensitiveSafeError("HOOK_CHILD_FAILURE", "typed hook failure"),
                followUp: { action: "retry" },
              }),
              exitCode,
            )
          : commandResult(input),
    });
    const report = reportFrom(result);

    expect(result.code).toBe(1);
    expect(report).toMatchObject({
      status: "failed",
      result: {
        kind: "execution-failed",
        stage: "hook-reconciliation",
        actionAudits: [
          {
            actions: [
              {
                phase: "hook-reconciliation",
                action: "reconcile",
                status: "failed",
                provider: "codex",
              },
            ],
          },
        ],
      },
    });
    if (report.result.kind !== "execution-failed") throw new Error("expected failed result");
    expect(report.result.actionAudits[0]?.actions[0]).not.toHaveProperty("hookResult");
  });

  it("renders a hostile hook child failure without emitting terminal controls", async () => {
    const fixture = probe("current");
    const sensitive = `hook failed${hostileControls()}forged hook line`;
    const evidence = preflight("1.0.0", "1.0.0", {
      observer: matchingObserver(identityA),
      host: matchingHost(identityA),
      hookProviderIds: ["codex"],
      hooks: [{ provider: "codex", status: "needs-repair", reason: "owned-drift" }],
    });
    const result = await runUpdateCommand([], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(evidence),
      commandRunner: async (input) =>
        input.args?.includes("hooks")
          ? externalResult(
              input,
              JSON.stringify({
                provider: "codex",
                status: "write-failed",
                changed: false,
                verified: false,
                error: sensitiveSafeError("HOOK_CHILD_CONTROL", sensitive),
                followUp: { action: "retry" },
              }),
              1,
            )
          : commandResult(input),
    });
    const text = textOutput(result);

    expect(result.code).toBe(1);
    expect(text).toContain("hook-reconciliation: reconcile failed provider=codex");
    expect(text).toContain("UPDATE_RUNTIME_CONVERGENCE_FAILED");
    expect(text).not.toContain(hostileControls());
    expect(text).not.toContain("\u001b]8;;https://example.invalid");
  });

  it("hands #641 a fresh pre-mutation reap-required target plan before artifact application", async () => {
    const fixture = probe("update-available");
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(
        preflight("1.0.0", "2.0.0", {
          observer: matchingObserver(identityA),
          host: differentHost(identityA, [terminal("non-releasable")]),
          terminalDispositions: [disposition("non-preservable", "non-resumable")],
          evidenceComplete: true,
        }),
      ),
    });
    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "reap-required",
        artifactApplication: { status: "not-attempted" },
        initial: {
          evaluator: "incumbent-cli",
          plan: {
            status: "reap-required",
            selectedTarget: {
              artifact: { version: "2.0.0" },
              buildIdentity: { status: "not-yet-provable" },
            },
          },
        },
        result: { kind: "non-mutating-stop", disposition: "reap-required" },
      },
    });
    expect(reportFrom(result).result).not.toHaveProperty("actionAudits");
    expect(textFor(result)).toContain(nonMutatingPhaseText("not-executed"));
    expect(textFor(result)).not.toContain("verified plan:");
    expect(fixture.apply).not.toHaveBeenCalled();
  });

  it("hands #641 only the recovery-complete non-preservable subset of a mixed inventory", async () => {
    const fixture = probe("update-available");
    const evidence = preflight("1.0.0", "2.0.0", {
      observer: matchingObserver(identityA),
      host: differentHost(identityA, [
        terminal("bridge-releasable", "1"),
        terminal("non-releasable", "2"),
      ]),
      terminalDispositions: [
        disposition("preservable", "unknown", "1"),
        disposition("non-preservable", "non-resumable", "2"),
      ],
    });
    const runner = vi.fn(commandResult);
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(evidence),
      commandRunner: runner,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "reap-required",
        artifactApplication: { status: "not-attempted" },
        initial: {
          preflight: { evidenceComplete: false },
          plan: {
            status: "reap-required",
            components: {
              terminals: {
                liveCount: 2,
                nonResumableCount: 1,
                unknownRecoveryCount: 1,
              },
              recovery: { relevance: "destructive-follow-up", status: "complete" },
            },
          },
        },
        result: { kind: "non-mutating-stop", disposition: "reap-required" },
      },
    });
    expect(fixture.apply).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("fails closed with a non-mutating blocked result when Observer evidence is unknown", async () => {
    const fixture = probe("current");
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(
        preflight("1.0.0", "1.0.0", {
          observer: {
            status: "unknown",
            reason: "identity-unavailable",
            error: {
              tag: "UpdatePreflightError",
              code: "OBSERVER_UNKNOWN",
              message: "Observer identity unavailable.",
            },
          },
        }),
      ),
    });
    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "blocked",
        artifactApplication: { status: "not-required" },
        result: { kind: "non-mutating-stop", disposition: "blocked" },
      },
    });
    expect(reportFrom(result).result).not.toHaveProperty("actionAudits");
    expect(textFor(result)).toContain(nonMutatingPhaseText("not-executed"));
    expect(textFor(result)).not.toContain("verified plan:");
  });

  it("represents current artifact plus busy old Host plus --no-handoff as intentionally incomplete", async () => {
    const fixture = probe("current");
    const result = await runUpdateCommand(["--no-handoff", "--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(
        preflight("1.0.0", "1.0.0", {
          observer: matchingObserver(identityA),
          host: differentHost(identityB, [terminal("bridge-releasable")]),
          terminalDispositions: [disposition("preservable", "recoverable")],
        }),
      ),
    });
    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "intentionally-incomplete",
        artifactApplication: { status: "not-required" },
        result: {
          kind: "non-mutating-stop",
          disposition: "intentionally-incomplete",
        },
      },
    });
    expect(reportFrom(result).result).not.toHaveProperty("actionAudits");
    expect(textFor(result)).toContain(nonMutatingPhaseText("not-executed"));
    expect(textFor(result)).not.toContain("verified plan:");
  });

  it("represents final aggregate inspection failure after a runtime action failure", async () => {
    const fixture = probe("current");
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({
        preflight: preflight("1.0.0", "1.0.0"),
        privateEvidence: privateEvidence(),
      })
      .mockRejectedValueOnce(new Error("inspection failed"));
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspect,
      commandRunner: async () => {
        throw new Error("observer start failed");
      },
    });
    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        result: {
          kind: "execution-failed",
          finalInspection: { status: "failed", error: { code: "UPDATE_FINAL_INSPECTION_FAILED" } },
        },
      },
    });
    expect(reportFrom(result).result).not.toHaveProperty("postAction");
  });

  it("strictly preserves sanitized Observer lifecycle evidence in JSON and text", async () => {
    const fixture = probe("current");
    const secret = "observer-secret-value";
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "1.0.0")),
      commandRunner: async (input) =>
        input.args?.includes("observer")
          ? observerFailureResult(input, secret)
          : commandResult(input),
    });
    const report = reportFrom(result);
    expect(report).toMatchObject({
      status: "failed",
      result: { kind: "execution-failed", stage: "observer-convergence" },
      cause: {
        code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
        message: "Observer executable arguments did not match. API_TOKEN=[REDACTED]",
      },
      startupEvidence: {
        bootLogPath: "/tmp/station/logs/observer-boot.log",
        bootLogTail: "startup failed API_TOKEN=[REDACTED]",
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("raw observer stack");
    const text = textFor(result);
    expect(text).toContain(
      "cause: Observer executable arguments did not match. API_TOKEN=[REDACTED] (OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH)",
    );
    expect(text).toContain("observer startup evidence:");
    expect(text).toContain("boot log: /tmp/station/logs/observer-boot.log");
    expect(text).toContain("bounded boot log tail: startup failed API_TOKEN=[REDACTED]");
    expect(text).not.toContain(secret);
  });

  it("fails a contradictory Observer command result without inventing lifecycle evidence", async () => {
    const fixture = probe("current");
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "1.0.0")),
      commandRunner: async (input) =>
        input.args?.includes("observer")
          ? externalResult(input, JSON.stringify(observerRunningResult()), 1)
          : commandResult(input),
    });
    const report = reportFrom(result);
    expect(report).toMatchObject({
      status: "failed",
      result: { kind: "execution-failed", stage: "observer-convergence" },
    });
    expect(report).not.toHaveProperty("cause");
    expect(report).not.toHaveProperty("startupEvidence");
  });

  it.each([
    { label: "exit 2", exitCode: 2 },
    { label: "signal-like exit 143", exitCode: 143 },
  ])("rejects Observer failure JSON returned with $label", async ({ exitCode }) => {
    const fixture = probe("current");
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "1.0.0")),
      commandRunner: async (input) =>
        input.args?.includes("observer")
          ? { ...observerFailureResult(input, "typed-observer-failure"), exitCode }
          : commandResult(input),
    });
    const report = reportFrom(result);

    expect(result.code).toBe(1);
    expect(report).toMatchObject({
      status: "failed",
      result: {
        kind: "execution-failed",
        stage: "observer-convergence",
        actionAudits: [
          {
            actions: [
              {
                phase: "observer-convergence",
                action: "start",
                status: "failed",
              },
            ],
          },
        ],
      },
    });
    expect(report).not.toHaveProperty("cause");
    expect(report).not.toHaveProperty("startupEvidence");
  });

  it("reports verification failure when final inspection fails after safe actions complete", async () => {
    const fixture = probe("current");
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({
        preflight: preflight("1.0.0", "1.0.0"),
        privateEvidence: privateEvidence(),
      })
      .mockRejectedValueOnce(new Error("final inspection failed"));
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspect,
      commandRunner: vi.fn(commandResult),
    });
    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        result: {
          kind: "execution-failed",
          stage: "verification",
          finalInspection: { status: "failed", error: { code: "UPDATE_FINAL_INSPECTION_FAILED" } },
        },
      },
    });
    const report = reportFrom(result);
    if (report.result.kind !== "execution-failed") throw new Error("expected failure result");
    expect(report.result.actionAudits[0]?.actions.at(-1)).toEqual({
      phase: "verification",
      action: "reinspect",
      status: "failed",
    });
    expect(
      report.result.actionAudits[0]?.actions
        .slice(0, -1)
        .every((action) => action.status === "completed"),
    ).toBe(true);
    expect(report.result).not.toHaveProperty("postAction");
  });

  it("fails when completed successor runtime actions still leave a fresh actionable plan", async () => {
    const outer = probe("update-available");
    const bridge = terminal("bridge-releasable");
    const stillActionable = preflight("2.0.0", "2.0.0", {
      observer: restartableObserverDrift(),
      host: differentHost(identityA, [bridge]),
      terminalDispositions: [disposition("preservable", "recoverable")],
    });
    const runner = vi.fn(async (input: ExternalCommandInput) =>
      input.args?.includes("update")
        ? successorResult(input, stillActionable)
        : commandResult(input),
    );
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [outer.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
      commandRunner: runner,
    });
    const report = reportFrom(result);

    expect(result.code).toBe(1);
    expect(report).toMatchObject({
      status: "failed",
      artifactApplication: { status: "applied" },
      result: {
        kind: "execution-failed",
        stage: "verification",
        successor: { evaluator: "successor-cli", plan: { status: "actionable" } },
        finalInspection: {
          status: "completed",
          evidence: { evaluator: "successor-cli", plan: { status: "actionable" } },
        },
      },
      error: { code: "UPDATE_RUNTIME_CONVERGENCE_INCOMPLETE" },
    });
    if (report.result.kind !== "execution-failed") throw new Error("expected failure result");
    expect(report.result.actionAudits[1]?.actions).toEqual([
      { phase: "observer-convergence", action: "restart", status: "completed" },
      {
        phase: "terminal-convergence",
        action: "preserve-via-handoff",
        status: "completed",
        fidelity: "processes",
        handoffReceipt: { terminals: [terminalIdentity()] },
      },
      {
        phase: "host-convergence",
        action: "handoff",
        status: "completed",
        fidelity: "processes",
      },
      { phase: "runtime-reconcile", action: "run", status: "completed" },
      { phase: "verification", action: "reinspect", status: "failed" },
    ]);
    expect(report.status).not.toBe("planned");
    expect(textFor(result)).toContain("status: failed");
    expect(textFor(result)).toContain("verified plan:");
    expect(textFor(result)).toContain("(actionable)");
    expect(textFor(result)).toContain("UPDATE_RUNTIME_CONVERGENCE_INCOMPLETE");
  });

  it("does not require post-action evidence when artifact apply cannot identify a successor", async () => {
    const fixture = probe("update-available");
    fixture.apply.mockResolvedValueOnce({
      channel: "installer-binary",
      status: "updated",
      previousVersion: "1.0.0",
      installedVersion: "2.0.0",
      warnings: [],
    });
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [fixture.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
    });
    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        artifactApplication: { status: "applied" },
        result: {
          kind: "execution-failed",
          stage: "successor-boundary",
          finalInspection: { status: "not-attempted", reason: "successor-unavailable" },
        },
      },
    });
    expect(reportFrom(result).result).not.toHaveProperty("postAction");
  });

  it.each([
    {
      name: "network failure",
      ordinaryDiscovery: async () => {
        throw new Error("latest release network unavailable");
      },
    },
    { name: "removed latest target", ordinaryDiscovery: async () => undefined },
    {
      name: "malformed latest response",
      ordinaryDiscovery: async () => {
        throw new SyntaxError("malformed latest response");
      },
    },
  ])("retains the exact successor-owned plan without latest discovery during $name", async ({
    ordinaryDiscovery,
  }) => {
    const outer = probe("update-available");
    const successor = probe("update-available", "2.0.0", "3.0.0");
    const latestDiscovery = vi.fn(ordinaryDiscovery);
    successor.probe.detectAndPlan = latestDiscovery;
    const successorInspect = sequenceInspection([
      preflight("2.0.0", "2.0.0"),
      preflight("2.0.0", "2.0.0", { observer: matchingObserver(identityB) }),
    ]);
    const successorRunner = vi.fn(commandResult);
    const outerRunner = vi.fn(async (input: ExternalCommandInput) => {
      if (input.args?.includes("update")) {
        const nested = await runUpdateCommand(
          input.args.slice(input.args.indexOf("update") + 1),
          options(),
          {
            probes: [successor.probe],
            buildInfo: build(identityB, "2.0.0"),
            convergenceInspection: successorInspect,
            commandRunner: successorRunner,
          },
        );
        return externalResult(input, JSON.stringify(nested.output), nested.code);
      }
      return commandResult(input);
    });
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [outer.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
      commandRunner: outerRunner,
    });
    expect(result).toMatchObject({
      code: 0,
      output: {
        status: "updated",
        current: { version: "1.0.0" },
        target: { version: "2.0.0" },
        artifactApplication: { status: "applied" },
        initial: { evaluator: "incumbent-cli" },
        result: {
          kind: "successor-runtime-execution",
          actionAudits: [{ executor: "incumbent-cli" }, { executor: "successor-cli" }],
          successor: { evaluator: "successor-cli" },
          postAction: { evaluator: "successor-cli", plan: { status: "converged" } },
          verification: { status: "converged" },
        },
      },
    });
    const output = reportFrom(result);
    if (output.result.kind !== "successor-runtime-execution") {
      throw new Error("expected successor execution result");
    }
    expect(output.result.actionAudits[0]?.planDigest).toBe(output.initial.plan.digest.value);
    expect(output.result.actionAudits[1]?.planDigest).toBe(
      output.result.successor.plan.digest.value,
    );
    expect(successor.apply).not.toHaveBeenCalled();
    expect(latestDiscovery).not.toHaveBeenCalled();
    const text = textFor(result);
    expect(text).toContain("status: updated");
    expect(text).toContain("artifact before: 1.0.0");
    expect(text).toContain("artifact selected: 2.0.0");
    expect(text).not.toContain("artifact installed: 1.0.0");
  });

  it("rejects a successful successor report returned with exit status 1", async () => {
    const outer = probe("update-available");
    const outerRunner = vi.fn(async (input: ExternalCommandInput) =>
      input.args?.includes("update")
        ? successorResult(
            input,
            preflight("2.0.0", "2.0.0", {
              observer: matchingObserver(identityB),
              host: matchingHost(identityB),
            }),
            1,
          )
        : commandResult(input),
    );

    const result = await runUpdateCommand(["--json"], options(), {
      probes: [outer.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
      commandRunner: outerRunner,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        artifactApplication: { status: "applied" },
        error: { code: "UPDATE_SUCCESSOR_BOUNDARY_FAILED" },
        result: {
          kind: "execution-failed",
          stage: "successor-boundary",
          actionAudits: [{ actions: [{ phase: "artifact-application", status: "completed" }] }],
        },
      },
    });
  });

  it("rejects a blocked successor report returned with exit status 0", async () => {
    const outer = probe("update-available");
    const outerRunner = vi.fn(async (input: ExternalCommandInput) =>
      input.args?.includes("update")
        ? successorResult(
            input,
            preflight("2.0.0", "2.0.0", {
              observer: {
                status: "unknown",
                reason: "identity-unavailable",
                error: {
                  tag: "UpdatePreflightError",
                  code: "OBSERVER_UNKNOWN",
                  message: "Observer identity unavailable.",
                },
              },
            }),
            0,
          )
        : commandResult(input),
    );

    const result = await runUpdateCommand(["--json"], options(), {
      probes: [outer.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
      commandRunner: outerRunner,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        artifactApplication: { status: "applied" },
        error: { code: "UPDATE_SUCCESSOR_BOUNDARY_FAILED" },
        result: { kind: "execution-failed", stage: "successor-boundary" },
      },
    });
  });

  it.each([
    {
      name: "wrong channel",
      mutate: (report: UpdateCommandReport) => {
        report.channel = "dev-checkout";
      },
    },
    {
      name: "incumbent evaluator",
      mutate: (report: UpdateCommandReport) => {
        report.initial.evaluator = "incumbent-cli";
      },
    },
    {
      name: "old installed artifact with the pinned target",
      mutate: (report: UpdateCommandReport) => {
        report.current = { version: "1.0.0" };
        report.initial.preflight.installed = { version: "1.0.0" };
        report.initial.plan.selectedTarget.buildIdentity = { status: "not-yet-provable" };
      },
    },
    {
      name: "wrong installed revision",
      mutate: (report: UpdateCommandReport) => {
        report.current = { version: "2.0.0", revision: "unexpected-revision" };
        report.initial.preflight.installed = report.current;
        report.initial.plan.selectedTarget.buildIdentity = { status: "not-yet-provable" };
      },
    },
    {
      name: "advanced child target",
      mutate: (report: UpdateCommandReport) => {
        const advanced = { version: "3.0.0" };
        report.target = advanced;
        report.initial.preflight.target = advanced;
        report.initial.plan.selectedTarget.artifact = advanced;
        report.initial.plan.selectedTarget.buildIdentity = { status: "not-yet-provable" };
      },
    },
  ])("rejects strict successor ownership with $name", async ({ mutate }) => {
    const outer = probe("update-available");
    const outerRunner = vi.fn(async (input: ExternalCommandInput) => {
      if (!input.args?.includes("update")) return commandResult(input);
      const report = await successfulSuccessorReport(input);
      mutate(report);
      return externalResult(input, JSON.stringify(report), 0);
    });

    const result = await runUpdateCommand(["--json"], options(), {
      probes: [outer.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
      commandRunner: outerRunner,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        artifactApplication: { status: "applied" },
        error: { code: "UPDATE_SUCCESSOR_BOUNDARY_FAILED" },
        result: { kind: "execution-failed", stage: "successor-boundary" },
      },
    });
  });

  it.each([
    {
      name: "old post-action installed artifact",
      mutate: (report: UpdateCommandReport) => {
        if (report.result.kind !== "current-runtime-execution") {
          throw new Error("expected successor runtime fixture");
        }
        report.result.postAction.preflight.installed = { version: "1.0.0" };
      },
    },
    {
      name: "unknown post-action build identity",
      mutate: (report: UpdateCommandReport) => {
        if (report.result.kind !== "current-runtime-execution") {
          throw new Error("expected successor runtime fixture");
        }
        report.result.postAction.plan.selectedTarget.buildIdentity = {
          status: "not-yet-provable",
        };
      },
    },
    {
      name: "contradictory post-action build identity",
      mutate: (report: UpdateCommandReport) => {
        if (report.result.kind !== "current-runtime-execution") {
          throw new Error("expected successor runtime fixture");
        }
        report.result.postAction.plan.selectedTarget.buildIdentity = {
          status: "known",
          value: identityA,
        };
      },
    },
    {
      name: "wrong post-action target and selected artifact",
      mutate: (report: UpdateCommandReport) => {
        if (report.result.kind !== "current-runtime-execution") {
          throw new Error("expected successor runtime fixture");
        }
        const wrong = { version: "3.0.0" };
        report.result.postAction.preflight.target = wrong;
        report.result.postAction.plan.selectedTarget.artifact = wrong;
      },
    },
  ])("rejects strict successor post-action evidence with $name", async ({ mutate }) => {
    const outer = probe("update-available");
    const outerRunner = vi.fn(async (input: ExternalCommandInput) => {
      if (!input.args?.includes("update")) return commandResult(input);
      const child = await successorRuntimeResult(input);
      const report = UpdateCommandReportSchema.parse(JSON.parse(child.stdout));
      mutate(report);
      return externalResult(input, JSON.stringify(report), 0);
    });

    const result = await runUpdateCommand(["--json"], options(), {
      probes: [outer.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
      commandRunner: outerRunner,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        error: { code: "UPDATE_SUCCESSOR_BOUNDARY_FAILED" },
        result: { kind: "execution-failed", stage: "successor-boundary" },
      },
    });
  });

  it("rejects a pinned successor dry-run preview even when it reports current and exits zero", async () => {
    const outer = probe("update-available");
    const outerRunner = vi.fn(async (input: ExternalCommandInput) =>
      input.args?.includes("update") ? successorPreviewResult(input) : commandResult(input),
    );

    const result = await runUpdateCommand(["--json"], options(), {
      probes: [outer.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
      commandRunner: outerRunner,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        error: { code: "UPDATE_SUCCESSOR_BOUNDARY_FAILED" },
        result: { kind: "execution-failed", stage: "successor-boundary" },
      },
    });
  });

  it("rejects a strict pinned deferred report from the successor boundary", async () => {
    const outer = probe(
      "update-available",
      "1.0.0",
      "2.0.0",
      ["brew", "upgrade", "station"],
      "homebrew",
    );
    const outerRunner = vi.fn(async (input: ExternalCommandInput) =>
      input.args?.includes("update") ? pinnedDeferredSuccessorResult(input) : commandResult(input),
    );

    const result = await runUpdateCommand(
      ["--json", "--channel", "homebrew", "--drive-package-manager"],
      options(),
      {
        probes: [outer.probe],
        buildInfo: build(identityA, "1.0.0"),
        convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
        commandRunner: outerRunner,
      },
    );

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        error: { code: "UPDATE_SUCCESSOR_BOUNDARY_FAILED" },
        result: { kind: "execution-failed", stage: "successor-boundary" },
      },
    });
  });

  it("rejects nested successor runtime execution even when every pinned fact is coherent", async () => {
    const outer = probe("update-available");
    const outerRunner = vi.fn(async (input: ExternalCommandInput) =>
      input.args?.includes("update") ? nestedSuccessorExecutionResult(input) : commandResult(input),
    );

    const result = await runUpdateCommand(["--json"], options(), {
      probes: [outer.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
      commandRunner: outerRunner,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        error: { code: "UPDATE_SUCCESSOR_BOUNDARY_FAILED" },
        result: { kind: "execution-failed", stage: "successor-boundary" },
      },
    });
  });

  it.each([
    { name: "malformed", stdout: "{not-json" },
    { name: "truncated", stdout: '{"schemaVersion":4' },
    { name: "multiple JSON values", stdout: "{}\n{}" },
  ])("rejects $name successor stdout as a boundary failure", async ({ stdout }) => {
    const outer = probe("update-available");
    const outerRunner = vi.fn(async (input: ExternalCommandInput) =>
      input.args?.includes("update") ? externalResult(input, stdout, 0) : commandResult(input),
    );

    const result = await runUpdateCommand(["--json"], options(), {
      probes: [outer.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
      commandRunner: outerRunner,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        error: { code: "UPDATE_SUCCESSOR_BOUNDARY_FAILED" },
        result: { kind: "execution-failed", stage: "successor-boundary" },
      },
    });
  });

  it.each([
    {
      name: "missing Observer audit",
      fixture: "observer" as const,
      mutate: (report: UpdateCommandReport) => {
        const audit = successorRuntimeAudit(report);
        audit.actions = audit.actions.filter((action) => action.phase !== "observer-convergence");
      },
    },
    {
      name: "missing terminal audit",
      fixture: "host" as const,
      mutate: (report: UpdateCommandReport) => {
        const audit = successorRuntimeAudit(report);
        audit.actions = audit.actions.filter((action) => action.phase !== "terminal-convergence");
      },
    },
    {
      name: "missing Host audit",
      fixture: "host" as const,
      mutate: (report: UpdateCommandReport) => {
        const audit = successorRuntimeAudit(report);
        audit.actions = audit.actions.filter((action) => action.phase !== "host-convergence");
      },
    },
    {
      name: "missing reconcile audit",
      fixture: "observer" as const,
      mutate: (report: UpdateCommandReport) => {
        const audit = successorRuntimeAudit(report);
        audit.actions = audit.actions.filter((action) => action.phase !== "runtime-reconcile");
      },
    },
    {
      name: "duplicate audit",
      fixture: "observer" as const,
      mutate: (report: UpdateCommandReport) => {
        const audit = successorRuntimeAudit(report);
        const observer = audit.actions.find((action) => action.phase === "observer-convergence");
        if (observer === undefined) throw new Error("missing Observer audit");
        audit.actions.splice(1, 0, structuredClone(observer));
      },
    },
    {
      name: "skipped audit",
      fixture: "observer" as const,
      mutate: (report: UpdateCommandReport) => {
        const observer = successorRuntimeAudit(report).actions.find(
          (action) => action.phase === "observer-convergence",
        );
        if (observer === undefined) throw new Error("missing Observer audit");
        observer.status = "skipped";
      },
    },
    {
      name: "failed audit",
      fixture: "observer" as const,
      mutate: (report: UpdateCommandReport) => {
        const observer = successorRuntimeAudit(report).actions.find(
          (action) => action.phase === "observer-convergence",
        );
        if (observer === undefined) throw new Error("missing Observer audit");
        observer.status = "failed";
      },
    },
    {
      name: "reordered audits",
      fixture: "host" as const,
      mutate: (report: UpdateCommandReport) => {
        successorRuntimeAudit(report).actions.reverse();
      },
    },
    {
      name: "fabricated converged plan",
      fixture: "observer" as const,
      mutate: (report: UpdateCommandReport) => {
        report.initial.plan.status = "converged";
      },
    },
  ])("rejects a strict successor report with $name", async ({ fixture, mutate }) => {
    const outer = probe("update-available");
    const outerRunner = vi.fn(async (input: ExternalCommandInput) => {
      if (!input.args?.includes("update")) return commandResult(input);
      const child =
        fixture === "host"
          ? await successorHostRuntimeResult(input)
          : await successorRuntimeResult(input);
      const report = UpdateCommandReportSchema.parse(JSON.parse(child.stdout));
      mutate(report);
      return externalResult(input, JSON.stringify(report), child.exitCode);
    });

    const result = await runUpdateCommand(["--json"], options(), {
      probes: [outer.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
      commandRunner: outerRunner,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        error: { code: "UPDATE_SUCCESSOR_BOUNDARY_FAILED" },
        result: { kind: "execution-failed", stage: "successor-boundary" },
      },
    });
  });

  it.each([
    {
      disposition: "blocked" as const,
      successorPreflight: preflight("2.0.0", "2.0.0", {
        observer: {
          status: "unknown",
          reason: "identity-unavailable",
          error: {
            tag: "UpdatePreflightError",
            code: "OBSERVER_UNKNOWN",
            message: "Observer identity unavailable.",
          },
        },
      }),
    },
    {
      disposition: "reap-required" as const,
      successorPreflight: preflight("2.0.0", "2.0.0", {
        observer: matchingObserver(identityB),
        host: differentHost(identityA, [terminal("non-releasable")]),
        terminalDispositions: [disposition("non-preservable", "non-resumable")],
      }),
    },
  ])("propagates a valid $disposition successor report returned with exit status 1", async (testCase) => {
    const outer = probe("update-available");
    const outerRunner = vi.fn(async (input: ExternalCommandInput) =>
      input.args?.includes("update")
        ? successorResult(input, testCase.successorPreflight)
        : commandResult(input),
    );

    const result = await runUpdateCommand(["--json"], options(), {
      probes: [outer.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
      commandRunner: outerRunner,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: testCase.disposition,
        artifactApplication: { status: "applied" },
        result: {
          kind: "successor-runtime-execution",
          successor: { evaluator: "successor-cli", plan: { status: testCase.disposition } },
          postAction: { evaluator: "successor-cli", plan: { status: testCase.disposition } },
          verification: {
            status: "not-converged",
            disposition: testCase.disposition,
          },
        },
      },
    });
  });

  it("propagates successor-owned Observer lifecycle evidence through the outer report", async () => {
    const outer = probe("update-available");
    const successor = probe("current", "2.0.0", "2.0.0");
    const secret = "successor-observer-secret";
    const outerRunner = vi.fn(async (input: ExternalCommandInput) => {
      if (input.args?.includes("update")) {
        const nested = await runUpdateCommand(
          input.args.slice(input.args.indexOf("update") + 1),
          options(),
          {
            probes: [successor.probe],
            buildInfo: build(identityB, "2.0.0"),
            convergenceInspection: inspection(preflight("2.0.0", "2.0.0")),
            commandRunner: async (successorInput) =>
              successorInput.args?.includes("observer")
                ? observerFailureResult(successorInput, secret)
                : commandResult(successorInput),
          },
        );
        return externalResult(input, JSON.stringify(nested.output), nested.code);
      }
      return commandResult(input);
    });
    const result = await runUpdateCommand(["--json"], options(), {
      probes: [outer.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
      commandRunner: outerRunner,
    });
    const report = reportFrom(result);
    expect(report).toMatchObject({
      status: "failed",
      artifactApplication: { status: "applied" },
      result: {
        kind: "execution-failed",
        stage: "observer-convergence",
        successor: { evaluator: "successor-cli" },
      },
      cause: { code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH" },
      startupEvidence: { bootLogPath: "/tmp/station/logs/observer-boot.log" },
    });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("renders hostile successor warnings without emitting terminal controls", async () => {
    const outer = probe("update-available");
    const successor = probe("current", "2.0.0", "2.0.0");
    const sensitive = `successor warning${hostileControls()}forged successor line`;
    const outerRunner = vi.fn(async (input: ExternalCommandInput) => {
      if (!input.args?.includes("update")) return commandResult(input);
      const updateIndex = input.args.indexOf("update");
      const nested = await runUpdateCommand(input.args.slice(updateIndex + 1), options(), {
        probes: [successor.probe],
        buildInfo: build(identityB, "2.0.0"),
        convergenceInspection: inspection(
          preflight("2.0.0", "2.0.0", {
            observer: matchingObserver(identityB),
            host: matchingHost(identityB),
          }),
        ),
        commandRunner: commandResult,
      });
      const childReport = reportFrom(nested);
      childReport.warnings.push(sensitiveSafeError("SUCCESSOR_CONTROL", sensitive));
      return externalResult(input, JSON.stringify(childReport), nested.code);
    });
    const result = await runUpdateCommand([], options(), {
      probes: [outer.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
      commandRunner: outerRunner,
    });
    const text = textOutput(result);

    expect(result.code).toBe(0);
    expect(text).toContain("warning: successor warning");
    expect(text).not.toContain(hostileControls());
    expect(text).not.toContain("\u001b]8;;https://example.invalid");
  });

  it("deeply sanitizes every nested successor SafeError before JSON and text presentation", async () => {
    const outer = probe("update-available");
    const successor = probe("current", "2.0.0", "2.0.0");
    const secret = "confidential-update-token";
    const privatePath = "/Users/private-user/.station/runtime.sock";
    const control = "\u001b";
    const sensitive = `API_TOKEN=${secret} path:${privatePath} control=${control}[31m`;
    outer.apply.mockResolvedValueOnce({
      channel: "installer-binary",
      status: "updated",
      previousVersion: "1.0.0",
      installedVersion: "2.0.0",
      successorCli: ["/opt/stn-successor"],
      warnings: [sensitiveSafeError("APPLY_WARNING", sensitive)],
    });
    const successorInitial = preflight("2.0.0", "2.0.0", {
      observer: matchingObserver(identityB, "unknown"),
      host: matchingHost(identityB),
      hookProviderIds: ["codex"],
      hooks: [{ provider: "codex", status: "needs-repair", reason: "missing" }],
    });
    const successorInspect = vi
      .fn()
      .mockResolvedValueOnce({
        preflight: successorInitial,
        privateEvidence: privateEvidence(successorInitial),
      })
      .mockRejectedValueOnce(sensitiveSafeError("FINAL_INSPECTION_PRIVATE", sensitive));
    const outerRunner = vi.fn(async (input: ExternalCommandInput) => {
      if (!input.args?.includes("update")) return commandResult(input);
      const updateIndex = input.args.indexOf("update");
      const nested = await runUpdateCommand(
        input.args.slice(updateIndex + 1),
        {
          ...options(),
          configPath: sensitive,
        },
        {
          probes: [successor.probe],
          buildInfo: build(identityB, "2.0.0"),
          convergenceInspection: successorInspect,
          commandRunner: async (successorInput) =>
            successorInput.args?.includes("hooks")
              ? externalResult(
                  successorInput,
                  JSON.stringify({
                    provider: "codex",
                    status: "write-failed",
                    changed: false,
                    verified: false,
                    error: sensitiveSafeError("HOOK_CHILD_PRIVATE", sensitive),
                    followUp: { action: "retry" },
                  }),
                  1,
                )
              : commandResult(successorInput),
        },
      );
      const childReport = reportFrom(nested);
      childReport.warnings.push(sensitiveSafeError("SUCCESSOR_WARNING", sensitive));
      if (
        childReport.initial.preflight.observer.status !== "exact" ||
        childReport.initial.preflight.observer.recovery.status !== "unknown"
      ) {
        throw new Error("expected nested recovery evidence");
      }
      childReport.initial.preflight.observer.recovery.error = sensitiveSafeError(
        "NESTED_RECOVERY_PRIVATE",
        sensitive,
      );
      if (childReport.result.kind !== "execution-failed") {
        throw new Error("expected nested execution failure");
      }
      const hookResult = childReport.result.actionAudits[0]?.actions[0]?.hookResult;
      if (hookResult?.status !== "write-failed") {
        throw new Error("expected nested hook failure");
      }
      hookResult.error = sensitiveSafeError("HOOK_CHILD_PRIVATE", sensitive);
      if (childReport.result.finalInspection.status !== "failed") {
        throw new Error("expected nested final inspection failure");
      }
      childReport.result.finalInspection.error = sensitiveSafeError(
        "FINAL_INSPECTION_PRIVATE",
        sensitive,
      );
      return externalResult(input, JSON.stringify(childReport), nested.code);
    });

    const result = await runUpdateCommand(["--json"], options(), {
      probes: [outer.probe],
      buildInfo: build(identityA, "1.0.0"),
      convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
      commandRunner: outerRunner,
    });
    const report = reportFrom(result);
    expect(report).toMatchObject({
      status: "failed",
      warnings: [{ code: "APPLY_WARNING" }, { code: "SUCCESSOR_WARNING" }],
      result: {
        kind: "execution-failed",
        stage: "hook-reconciliation",
        successor: {
          preflight: {
            observer: {
              recovery: { error: { code: "NESTED_RECOVERY_PRIVATE" } },
            },
          },
        },
        actionAudits: [
          expect.anything(),
          {
            actions: [
              {
                phase: "hook-reconciliation",
                status: "failed",
                hookResult: { error: { code: "HOOK_CHILD_PRIVATE" } },
              },
            ],
          },
        ],
        finalInspection: {
          status: "failed",
          error: { code: "FINAL_INSPECTION_PRIVATE" },
        },
      },
    });
    const serialized = JSON.stringify(report);
    const sanitizedSensitive =
      "API_TOKEN=[REDACTED] path:[REDACTED_PATH] control=[REDACTED_CONTROL][31m";
    expect(report.warnings[0]).toMatchObject({
      code: "APPLY_WARNING",
      message: sanitizedSensitive,
      hint: `retry after ${sanitizedSensitive}`,
    });
    expect(report.recoveryCommands).toEqual([
      [
        "[REDACTED_PATH]",
        "--config",
        sanitizedSensitive,
        "update",
        "--channel",
        "installer-binary",
      ],
    ]);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain(control);
    expect(serialized).not.toContain("\\u001b");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("[REDACTED_PATH]");
    expect(serialized).toContain("[REDACTED_CONTROL]");

    const text = textFor(result);
    expect(text).toContain("result: execution-failed");
    expect(text).toContain("hook-reconciliation: reconcile failed provider=codex");
    expect(text).toContain(`warning: ${sanitizedSensitive}`);
    expect(text).toContain("recovery commands:");
    expect(text).not.toContain(secret);
    expect(text).not.toContain(privatePath);
    expect(text).not.toContain(control);
    expect(text).not.toContain("\\u001b");
  });
});

function options() {
  return { config, configPath: "/tmp/config.toml", cliEntryPath: "/repo/apps/cli/dist/main.js" };
}

function reportFrom(result: Awaited<ReturnType<typeof runUpdateCommand>>) {
  return UpdateCommandReportSchema.parse(result.output);
}

function textFor(result: Awaited<ReturnType<typeof runUpdateCommand>>): string {
  const rendered = updateCommandResult(reportFrom(result), "text").output;
  if (typeof rendered !== "string") throw new Error("expected update text output");
  return rendered;
}

function textOutput(result: Awaited<ReturnType<typeof runUpdateCommand>>): string {
  if (typeof result.output !== "string") throw new Error("expected default update text output");
  return result.output;
}

function nonMutatingPhaseText(artifactStatus: "not-executed" | "deferred"): string {
  return [
    "result convergence phases:",
    `  artifact-application: ${artifactStatus}`,
    "  hook-reconciliation: not-executed",
    "  observer-convergence: not-executed",
    "  terminal-convergence: not-executed",
    "  host-convergence: not-executed",
    "  runtime-reconcile: not-executed",
    "  verification: not-executed",
  ].join("\n");
}

function build(buildIdentity: string, version: string) {
  return () => ({ compiled: false, version, buildIdentity });
}

function probe(
  status: "current" | "update-available",
  current = "1.0.0",
  target = "2.0.0",
  managerCommand?: readonly [string, ...string[]],
  channel: UpdateChannelProbe["channel"] = "installer-binary",
) {
  const apply = vi.fn(async () => ({
    channel,
    status: "updated" as const,
    previousVersion: current,
    installedVersion: target,
    successorCli: ["/opt/stn-successor"] as const,
    warnings: [],
  }));
  const probe: UpdateChannelProbe = {
    channel,
    detectAndPlan: async () => ({
      channel,
      plan: {
        channel,
        status,
        currentVersion: current,
        targetVersion: status === "current" ? current : target,
        currentCli: ["/opt/stn-current"],
        ...(managerCommand === undefined ? {} : { managerCommand }),
      },
      apply,
    }),
    proveInstalledTarget: async (selectedTarget) => ({
      channel,
      plan: {
        channel,
        status: "current",
        currentVersion: selectedTarget.version,
        targetVersion: selectedTarget.version,
        currentCli: ["/opt/stn-current"],
        ...(selectedTarget.revision === undefined
          ? {}
          : {
              currentRevision: selectedTarget.revision,
              targetRevision: selectedTarget.revision,
            }),
      },
      apply,
    }),
  };
  return { probe, apply };
}

function inspection(evidence: UpdateReapRecoveryPreflight) {
  return vi.fn(async () => ({ preflight: evidence, privateEvidence: privateEvidence(evidence) }));
}

function sequenceInspection(evidence: UpdateReapRecoveryPreflight[]) {
  let index = 0;
  return vi.fn(async () => {
    const selected = evidence[Math.min(index, evidence.length - 1)];
    index += 1;
    if (selected === undefined) throw new Error("missing inspection fixture");
    return { preflight: selected, privateEvidence: privateEvidence(selected) };
  });
}

function privateEvidence(
  preflight?: UpdateReapRecoveryPreflight,
): UpdateConvergencePrivateEvidence {
  const observer = preflight?.observer;
  const buildSelector =
    observer?.status === "exact" ||
    (observer?.status === "unknown" && observer.reason === "restartable-executable-drift")
      ? observer.buildVersion
      : undefined;
  const selectedRecoveryHandles =
    observer?.status === "exact" && observer.recovery.status === "assessed"
      ? observer.recovery.assessment.sessions.flatMap((session) =>
          session.handleResolution.kind === "selected"
            ? [{ sessionId: session.sessionId, selectedHandleId: `private-${session.sessionId}` }]
            : [],
        )
      : [];
  const evidence: UpdateConvergencePrivateEvidence = { selectedRecoveryHandles };
  if (buildSelector !== undefined) {
    evidence.observer = {
      pid: 4242,
      osStartTime: "Fri Aug 21 12:00:00 2026",
      processToken: "123e4567-e89b-42d3-a456-426614174000",
      buildSelector,
    };
  }
  return evidence;
}

function preflight(
  installed: string,
  target: string,
  overrides: Partial<UpdateReapRecoveryPreflight> = {},
): UpdateReapRecoveryPreflight {
  const evidence: UpdateReapRecoveryPreflight = {
    schemaVersion: 1,
    boundary: { authorization: "none", actions: "not-included", digest: "not-included" },
    installed: { version: installed },
    target: { version: target },
    observer: { status: "absent" },
    host: { status: "absent" },
    hookProviderIds: [],
    hooks: [],
    terminalDispositions: [],
    evidenceComplete: false,
    ...overrides,
  };
  evidence.evidenceComplete = updateReapEvidenceIsComplete(evidence);
  return evidence;
}

function matchingObserver(
  identity: string,
  recovery: "assessed" | "unknown" = "assessed",
): UpdateReapRecoveryPreflight["observer"] {
  return {
    status: "exact",
    buildVersion: `1.0.0+station.${identity}`,
    relation: "matching-target",
    health: "healthy",
    recovery:
      recovery === "assessed"
        ? {
            status: "assessed",
            assessment: {
              schemaVersion: 1,
              resumeEnabled: true,
              providerCapabilities: [],
              sessions: [],
            },
          }
        : {
            status: "unknown",
            reason: "api-unavailable",
            error: { tag: "UpdatePreflightError", code: "RECOVERY_UNKNOWN", message: "Unknown." },
          },
  };
}

function restartableObserverDrift(): UpdateReapRecoveryPreflight["observer"] {
  return {
    status: "unknown",
    reason: "restartable-executable-drift",
    buildVersion: `1.0.0+station.${identityA}`,
    error: {
      tag: "UpdatePreflightError",
      code: "UPDATE_PREFLIGHT_OBSERVER_EXECUTABLE_DRIFT_RESTARTABLE",
      message: "The incumbent is pinned for explicit restart.",
    },
  };
}

function matchingHost(
  identity: string,
  terminals: Extract<
    UpdateReapRecoveryPreflight["host"],
    { status: "inspected" }
  >["terminals"] = [],
): UpdateReapRecoveryPreflight["host"] {
  return {
    status: "inspected",
    buildVersion: "1.0.0",
    buildIdentity: identity,
    protocolVersion: 8,
    relation: "matching-target",
    compatibility: "reuse",
    terminals,
  };
}

function differentHost(
  identity: string,
  terminals: Extract<UpdateReapRecoveryPreflight["host"], { status: "inspected" }>["terminals"],
): UpdateReapRecoveryPreflight["host"] {
  return {
    status: "inspected",
    buildVersion: "0.9.0",
    buildIdentity: identity,
    protocolVersion: 8,
    relation: "different",
    compatibility: "replace",
    terminals,
  };
}

function terminal(handoffSupport: "bridge-releasable" | "non-releasable", identity = "1") {
  return {
    kind: "agent" as const,
    terminalTargetId: `terminal-${identity}`,
    ptyId: `pty-${identity}`,
    ptyInstanceId: `pty-instance-${identity}`,
    projectId: `project-${identity}`,
    worktreeId: `worktree-${identity}`,
    sessionId: `session-${identity}`,
    harnessProvider: "codex",
    alive: true,
    handoffSupport,
  };
}

function disposition(
  handoff: "preservable" | "non-preservable",
  reapRecovery: "recoverable" | "non-resumable" | "unknown",
  identity = "1",
) {
  return {
    terminalTargetId: `terminal-${identity}`,
    ptyId: `pty-${identity}`,
    ptyInstanceId: `pty-instance-${identity}`,
    sessionId: `session-${identity}`,
    handoff,
    reapRecovery,
    reasons:
      reapRecovery === "unknown"
        ? (["session_recovery_unknown"] as const)
        : reapRecovery === "non-resumable"
          ? (["session_non_resumable"] as const)
          : [],
  };
}

function commandResult(input: ExternalCommandInput): Promise<ExternalCommandResult> {
  return Promise.resolve(
    input.args?.includes("observer")
      ? externalResult(input, JSON.stringify(observerRunningResult()), 0)
      : externalResult(input, "", 0),
  );
}

function terminalIdentity(identity = "1") {
  return {
    terminalTargetId: `terminal-${identity}`,
    ptyId: `pty-${identity}`,
    ptyInstanceId: `pty-instance-${identity}`,
  };
}

function completedHostResult(
  action: "replace-idle" | "handoff",
  commitment: UpdateHostConvergenceCommitment,
  fidelity: "processes" | "screen" = "processes",
) {
  const terminals = commitment.incumbent.inventory.terminals;
  return {
    schemaVersion: 1 as const,
    action: "update-converge" as const,
    requestedAction: action,
    ...(action === "handoff" ? { requestedFidelity: fidelity } : {}),
    status: "completed" as const,
    receipt: {
      ensuredBy: action === "handoff" ? ("handoff" as const) : ("idle-replace" as const),
      ...(action === "handoff" ? { fidelity } : {}),
      validatedCommitment: commitment,
      actualInventory: { terminals },
      ...(action === "handoff" ? { handoffReceipt: { terminals } } : {}),
    },
  };
}

function hostStoppedResult(
  requestedAction: "replace-idle" | "handoff",
  status: "absent" | "stale" | "failed",
  _commitment: UpdateHostConvergenceCommitment,
  fidelity: "processes" | "screen" = "processes",
) {
  return {
    schemaVersion: 1 as const,
    action: "update-converge" as const,
    requestedAction,
    ...(requestedAction === "handoff" ? { requestedFidelity: fidelity } : {}),
    status,
    error: {
      tag: "TerminalProviderError",
      provider: "native",
      code: status === "failed" ? "HOST_UNREACHABLE" : "HOST_CONVERGENCE_PLAN_DRIFT",
      message: "The committed Host state changed.",
    },
  };
}

function successfulHostRuntime(
  overrides: Partial<Pick<UpdateHostRuntimePort, "replaceIdleHost" | "handoffHost">> = {},
): UpdateHostRuntimePort {
  return {
    inspect: async () => ({ status: "absent" as const }),
    replaceIdleHost:
      overrides.replaceIdleHost ??
      (async (commitment: UpdateHostConvergenceCommitment) =>
        completedHostResult("replace-idle", commitment)),
    handoffHost:
      overrides.handoffHost ??
      (async (fidelity: "processes" | "screen", commitment: UpdateHostConvergenceCommitment) =>
        completedHostResult("handoff", commitment, fidelity)),
  };
}

function runtimePort(): UpdateRuntimeConvergencePort {
  return {
    reconcileHook: async (_cli, provider) => ({
      provider,
      status: "verified",
      changed: false,
      verified: true,
    }),
    convergeObserver: async () => undefined,
    reconcile: async () => undefined,
    recoveryCommands: () => [],
  };
}

function observerRunningResult() {
  return {
    status: "running" as const,
    socketPath: "/tmp/station/observer.sock",
    health: { schemaVersion: STATION_SCHEMA_VERSION, status: "healthy" as const },
  };
}

function observerFailureResult(input: ExternalCommandInput, secret: string): ExternalCommandResult {
  return {
    ...externalResult(
      input,
      JSON.stringify({
        status: "unhealthy",
        paths: observerCommandPaths(),
        error: {
          tag: "ObserverStartupError",
          code: "OBSERVER_HANDOFF_REFUSED",
          message: "Observer build handoff was refused.",
        },
        cause: {
          tag: "ObserverProcessIdentityError",
          code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
          message: `Observer executable arguments did not match. API_TOKEN=${secret}`,
        },
        startupEvidence: {
          bootLogPath: "/tmp/station/logs/observer-boot.log",
          bootLogTail: `startup failed API_TOKEN=${secret}`,
        },
      }),
      1,
    ),
    stderr: `raw observer stack API_TOKEN=${secret}`,
  };
}

function sensitiveSafeError(code: string, sensitive: string): SafeError {
  return {
    tag: "UpdateConfidentialityError",
    code,
    message: sensitive,
    hint: `retry after ${sensitive}`,
  };
}

function hostileControls(): string {
  return "\n\u0000\u0007\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007\u001b[31m\u007f\u0085\u009b31m\u2028\u2029";
}

async function successorResult(
  input: ExternalCommandInput,
  successorPreflight: UpdateReapRecoveryPreflight,
  forcedExitCode?: 0 | 1,
): Promise<ExternalCommandResult> {
  return successorResultFromInspections(input, [successorPreflight], forcedExitCode);
}

async function successorResultFromInspections(
  input: ExternalCommandInput,
  successorPreflights: UpdateReapRecoveryPreflight[],
  forcedExitCode?: 0 | 1,
): Promise<ExternalCommandResult> {
  const successor = probe("current", "2.0.0", "2.0.0");
  const updateIndex = input.args?.indexOf("update") ?? -1;
  if (updateIndex < 0 || input.args === undefined) throw new Error("missing successor update argv");
  const nested = await runUpdateCommand(input.args.slice(updateIndex + 1), options(), {
    probes: [successor.probe],
    buildInfo: build(identityB, "2.0.0"),
    convergenceInspection: sequenceInspection(successorPreflights),
    commandRunner: commandResult,
  });
  return externalResult(
    input,
    JSON.stringify(nested.output),
    forcedExitCode === undefined ? nested.code : forcedExitCode,
  );
}

async function successfulSuccessorReport(
  input: ExternalCommandInput,
): Promise<UpdateCommandReport> {
  const child = await successorResult(
    input,
    preflight("2.0.0", "2.0.0", {
      observer: matchingObserver(identityB),
      host: matchingHost(identityB),
    }),
  );
  return UpdateCommandReportSchema.parse(JSON.parse(child.stdout));
}

function successorRuntimeResult(input: ExternalCommandInput): Promise<ExternalCommandResult> {
  return successorResultFromInspections(input, [
    preflight("2.0.0", "2.0.0", {
      observer: {
        ...matchingObserver(identityA),
        relation: "different",
      },
      host: matchingHost(identityB),
    }),
    preflight("2.0.0", "2.0.0", {
      observer: matchingObserver(identityB),
      host: matchingHost(identityB),
    }),
  ]);
}

function successorHostRuntimeResult(input: ExternalCommandInput): Promise<ExternalCommandResult> {
  const bridge = terminal("bridge-releasable");
  const terminalDisposition = disposition("preservable", "recoverable");
  return successorResultFromInspections(input, [
    preflight("2.0.0", "2.0.0", {
      observer: matchingObserver(identityB),
      host: differentHost(identityA, [bridge]),
      terminalDispositions: [terminalDisposition],
    }),
    preflight("2.0.0", "2.0.0", {
      observer: matchingObserver(identityB),
      host: matchingHost(identityB, [bridge]),
      terminalDispositions: [terminalDisposition],
    }),
  ]);
}

function successorRuntimeAudit(report: UpdateCommandReport) {
  if (report.result.kind !== "current-runtime-execution") {
    throw new Error("expected successor runtime execution fixture");
  }
  return report.result.actionAudits[0];
}

async function successorPreviewResult(input: ExternalCommandInput): Promise<ExternalCommandResult> {
  const successor = probe("current", "2.0.0", "2.0.0");
  const updateIndex = input.args?.indexOf("update") ?? -1;
  if (updateIndex < 0 || input.args === undefined) throw new Error("missing successor update argv");
  const nested = await runUpdateCommand(
    [...input.args.slice(updateIndex + 1), "--dry-run"],
    options(),
    {
      probes: [successor.probe],
      buildInfo: build(identityB, "2.0.0"),
      convergenceInspection: inspection(
        preflight("2.0.0", "2.0.0", {
          observer: matchingObserver(identityB),
          host: matchingHost(identityB),
        }),
      ),
      commandRunner: commandResult,
    },
  );
  return externalResult(input, JSON.stringify(nested.output), nested.code);
}

async function pinnedDeferredSuccessorResult(
  input: ExternalCommandInput,
): Promise<ExternalCommandResult> {
  const deferred = probe(
    "update-available",
    "1.0.0",
    "2.0.0",
    ["brew", "upgrade", "station"],
    "homebrew",
  );
  const nested = await runUpdateCommand(["--json", "--channel", "homebrew"], options(), {
    probes: [deferred.probe],
    buildInfo: build(identityA, "1.0.0"),
    convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
    commandRunner: commandResult,
  });
  const report = reportFrom(nested);
  const pinned = { version: "2.0.0" };
  report.current = pinned;
  report.target = pinned;
  report.initial.evaluator = "successor-cli";
  report.initial.preflight.installed = pinned;
  report.initial.preflight.target = pinned;
  report.initial.plan.selectedTarget.artifact = pinned;
  report.initial.plan.selectedTarget.buildIdentity = { status: "known", value: identityB };
  return externalResult(
    input,
    JSON.stringify(UpdateCommandReportSchema.parse(report)),
    nested.code,
  );
}

async function nestedSuccessorExecutionResult(
  input: ExternalCommandInput,
): Promise<ExternalCommandResult> {
  const nestedOuter = probe("update-available");
  const nested = await runUpdateCommand(["--json"], options(), {
    probes: [nestedOuter.probe],
    buildInfo: build(identityA, "1.0.0"),
    convergenceInspection: inspection(preflight("1.0.0", "2.0.0")),
    commandRunner: async (nestedInput) =>
      nestedInput.args?.includes("update")
        ? successorResult(
            nestedInput,
            preflight("2.0.0", "2.0.0", {
              observer: matchingObserver(identityB),
              host: matchingHost(identityB),
            }),
          )
        : commandResult(nestedInput),
  });
  const report = reportFrom(nested);
  if (report.result.kind !== "successor-runtime-execution") {
    throw new Error("expected nested successor execution fixture");
  }
  const pinned = { version: "2.0.0" };
  report.current = pinned;
  report.initial.evaluator = "successor-cli";
  report.initial.preflight.installed = pinned;
  report.initial.plan.selectedTarget.buildIdentity = { status: "known", value: identityB };
  const artifactAudit = report.result.actionAudits[0];
  if (artifactAudit === undefined) throw new Error("missing artifact audit fixture");
  artifactAudit.executor = "successor-cli";
  return externalResult(
    input,
    JSON.stringify(UpdateCommandReportSchema.parse(report)),
    nested.code,
  );
}

function observerCommandPaths() {
  return {
    stateDir: "/tmp/station",
    socketPath: "/tmp/station/observer.sock",
    dbPath: "/tmp/station/observer.sqlite",
    logDir: "/tmp/station/logs",
    diagnosticsDir: "/tmp/station/diagnostics",
    hookSpoolDir: "/tmp/station/spool/hooks",
  };
}

function externalResult(
  input: ExternalCommandInput,
  stdout: string,
  exitCode: number,
): ExternalCommandResult {
  return { command: input.command, args: input.args ?? [], stdout, stderr: "", exitCode };
}
