import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { arch, cpus, loadavg, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { StationEvent, StationSnapshot, WorktreeRow } from "@station/contracts";
import {
  createStationHostClient,
  HOST_PROTOCOL_VERSION,
  type HostAttachment,
  type HostFrame,
  type HostListEntry,
  STATION_HOST_PROVIDER_ID,
} from "@station/host";
import {
  createObserverClient,
  IDLE_RESPONSE_DELIVERY_REQUEST_ID_PREFIX,
  type ObserverClient,
} from "@station/protocol";
import {
  createStationHostController,
  type SpawnStationHostInput,
  type StationHostHandle,
} from "@station/terminal";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildRemoveWorktreeCommand } from "../../../packages/dashboard-core/src/entrypoints/runtime.js";
import type { RealE2eEnvironment } from "../../support/real-station/env.js";
import {
  type AttachedTmuxPtyClient,
  captureTmuxPane,
  killTmuxSession,
  startAttachedTmuxPtyClient,
  tmuxSessionExists,
} from "../../support/real-station/tmux.js";
import { distribution } from "./statistics.js";

const execFileAsync = promisify(execFile);
const runFocusComparison =
  process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_FOCUS_COMPARE === "1";
const runSafetyAudit = process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_SAFETY_AUDIT === "1";
const runExp016Control =
  process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_EXP_016_CONTROL === "1";
const runExp016Candidate =
  process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_EXP_016_CANDIDATE === "1";
const runBench040ImmediateInput =
  process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_BENCH_040_IMMEDIATE_INPUT === "1";
const runBench041PhaseAttribution =
  process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_BENCH_041_PHASE_ATTRIBUTION === "1";
const runBench042ObserverPhaseAttribution =
  process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_BENCH_042_OBSERVER_PHASE_ATTRIBUTION === "1";
const runBench043ProtocolResidualAttribution =
  process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_BENCH_043_PROTOCOL_RESIDUAL === "1";
const runBench044WireAttribution =
  process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_BENCH_044_WIRE_ATTRIBUTION === "1";
const runBench045TransportDeliveryAttribution =
  process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_BENCH_045_TRANSPORT_DELIVERY === "1";
const runBench046StandaloneTransportControl =
  process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_BENCH_046_STANDALONE_CONTROL === "1";
const runBench046StandaloneTransportSmoke =
  process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_BENCH_046_STANDALONE_SMOKE === "1";
const runBench047NativeTuiIdleControl =
  process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_BENCH_047_NATIVE_IDLE === "1";
const runBench047NativeTuiIdleSmoke =
  process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_BENCH_047_NATIVE_IDLE_SMOKE === "1";
const runBench047NativeTuiIdleExperiment =
  runBench047NativeTuiIdleControl || runBench047NativeTuiIdleSmoke;
const runProtocolPhaseAttribution =
  runBench043ProtocolResidualAttribution ||
  runBench044WireAttribution ||
  runBench045TransportDeliveryAttribution ||
  runBench046StandaloneTransportControl ||
  runBench047NativeTuiIdleExperiment;
const runObserverPhaseDiagnostic =
  runBench042ObserverPhaseAttribution || runProtocolPhaseAttribution;
const runManagedLaunchPhaseDiagnostic = runBench041PhaseAttribution || runObserverPhaseDiagnostic;
const runImmediateAutomaticInput =
  runBench040ImmediateInput ||
  runBench041PhaseAttribution ||
  runBench042ObserverPhaseAttribution ||
  runProtocolPhaseAttribution;
const runReal =
  process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI === "1" ||
  runFocusComparison ||
  runSafetyAudit ||
  runExp016Control ||
  runExp016Candidate ||
  runBench040ImmediateInput ||
  runBench041PhaseAttribution ||
  runBench042ObserverPhaseAttribution ||
  runProtocolPhaseAttribution;
const describeReal = runReal ? describe : describe.skip;
const describeStandaloneTransportSmoke = runBench046StandaloneTransportSmoke
  ? describe
  : describe.skip;
const outputPath = resolve(
  z
    .string()
    .min(1)
    .parse(
      process.env.STATION_REAL_COMPILED_QUICK_SESSION_TUI_OUTPUT ??
        (runBench047NativeTuiIdleSmoke
          ? ".dev-state/performance/quick-session/bench-047-native-tui-idle-control-smoke.real.json"
          : runBench047NativeTuiIdleControl
            ? ".dev-state/performance/quick-session/bench-047-native-tui-idle-control.real.json"
            : runBench046StandaloneTransportControl
              ? ".dev-state/performance/quick-session/bench-046-standalone-transport-control.real.json"
              : runBench045TransportDeliveryAttribution
                ? ".dev-state/performance/quick-session/bench-045-transport-delivery.real.json"
                : runBench044WireAttribution
                  ? ".dev-state/performance/quick-session/bench-044-wire-attribution.real.json"
                  : runBench043ProtocolResidualAttribution
                    ? ".dev-state/performance/quick-session/bench-043-protocol-residual.real.json"
                    : runBench042ObserverPhaseAttribution
                      ? ".dev-state/performance/quick-session/bench-042-observer-launch-phases.real.json"
                      : runBench041PhaseAttribution
                        ? ".dev-state/performance/quick-session/bench-041-managed-launch-phases.real.json"
                        : runBench040ImmediateInput
                          ? ".dev-state/performance/quick-session/bench-040-immediate-input.real.json"
                          : runExp016Control
                            ? ".dev-state/performance/quick-session/exp-016-control.real.json"
                            : runExp016Candidate
                              ? ".dev-state/performance/quick-session/exp-016-candidate.real.json"
                              : runFocusComparison
                                ? ".dev-state/performance/quick-session/compiled-quick-session-focus.real.json"
                                : runSafetyAudit
                                  ? ".dev-state/performance/quick-session/compiled-quick-session-safety.real.json"
                                  : ".dev-state/performance/quick-session/compiled-quick-session-tui.real.json"),
    ),
);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const binaryPath = fileURLToPath(new URL("../../../station/dist/bin/stn", import.meta.url));
const buildIdentityPath = fileURLToPath(
  new URL("../../../packages/runtime/dist/station-build-id", import.meta.url),
);
const packageJsonPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
const worktrunkCommand = process.env.STATION_WORKTRUNK_BIN ?? "wt";
const tmuxCommand = process.env.STATION_TMUX_BIN ?? "tmux";
const repetitions = runBench047NativeTuiIdleSmoke
  ? 1
  : runBench041PhaseAttribution ||
      runBench042ObserverPhaseAttribution ||
      runProtocolPhaseAttribution
    ? 20
    : runFocusComparison || runExp016Control || runExp016Candidate || runBench040ImmediateInput
      ? 10
      : runSafetyAudit
        ? 1
        : 5;
const ordinaryLinkedWorktrees = 48;
const initialInventoryCount = ordinaryLinkedWorktrees + 1;
const projectId = "compiled-tui-project";
const projectLabel = "Compiled TUI benchmark";
const readyPrefix = "__STATION_COMPILED_TUI_READY__:";
const acknowledgementPrefix = "__STATION_COMPILED_TUI_ACK__:";
const dimensions = { columns: 160, rows: 50 } as const;
const thresholds = {
  launchToDashboardMedianMs: 1_500,
  launchToDashboardP95Ms: 2_500,
  intentToOptimisticP95Ms: 50,
  intentToInteractiveMedianMs: 100,
  intentToInteractiveP95Ms: 200,
  intentToCanonicalUiP95Ms: 350,
  launchToInteractiveP95Ms: 2_700,
} as const;
const focusThresholds = {
  focusToInputAckP95Ms: 100,
  focusToInputAckMinimumImprovementFraction: 0.75,
  intentToInteractiveMedianMs: 250,
  intentToInteractiveP95Ms: 350,
} as const;
const exp016Thresholds = {
  intentToInteractiveMedianMs: 200,
  intentToInteractiveP95Ms: 350,
  overlayDismissedToInputAckP95Ms: 100,
} as const;
const bench040Thresholds = {
  intentToInteractiveMedianMs: 200,
  intentToInteractiveP95Ms: 320,
  minimumP95ImprovementFraction: 0.1,
  dismissalToInputAckP95Ms: 120,
  dismissalToInputWriteMaxMs: 10,
  minimumPreReadyWriteMs: 25,
} as const;
const bench041Thresholds = {
  intentToInteractiveP95Ms: 380,
  attachmentResolutionP95Ms: 25,
  tailIntervalMs: 75,
  minimumTailIntervals: 2,
  dominantP95Fraction: 0.6,
  dominantTailFraction: 0.5,
  minimumDominantTailIntervals: 2,
} as const;
const bench041Prediction = {
  prepareExternalLaunchP95Fraction: 0.7,
  prepareExternalLaunchTailFraction: 0.5,
  attachmentResolutionP95Ms: 10,
} as const;
const bench042Thresholds = {
  intentToInteractiveP95Ms: 380,
  attachmentResolutionP95Ms: 30,
  transportResidualP95Ms: 15,
  tailIntervalMs: 40,
  minimumTailIntervals: 2,
  dominantP95Fraction: 0.5,
  dominantTailFraction: 0.5,
  minimumDominantTailIntervals: 2,
} as const;
const bench042Prediction = {
  hostProcessLaunchP95Fraction: 0.6,
  hostProcessLaunchTailFraction: 0.5,
  targetInventoryP95Ms: 10,
  sessionPersistenceP95Ms: 10,
  canonicalProjectionP95Ms: 5,
  transportResidualP95Ms: 10,
} as const;
const bench043Thresholds = {
  intentToInteractiveP95Ms: 380,
  attachmentResolutionP95Ms: 30,
  transportResidualP95Ms: 35,
  residualTailIntervalMs: 20,
  minimumTailIntervals: 2,
  dominantP95Fraction: 0.4,
  dominantTailFraction: 0.5,
  minimumDominantTailIntervals: 2,
  phaseCoherenceToleranceMs: 0.1,
  residualCoherenceToleranceMs: 1,
} as const;
const bench043Prediction = {
  expectedObserverHealthP95Fraction: 0.5,
  expectedObserverHealthTailFraction: 0.5,
  socketConnectP95Ms: 5,
  actualRequestWireClientP95Ms: 5,
  observerProtocolPreUseCaseP95Ms: 5,
  observerProtocolPostUseCaseP95Ms: 5,
  outerClientSettlementP95Ms: 3,
} as const;
const bench044Thresholds = {
  intentToInteractiveP95Ms: 380,
  attachmentResolutionP95Ms: 30,
  transportResidualP95Ms: 35,
  actualWireTailIntervalMs: 10,
  minimumTailIntervals: 2,
  dominantP95Fraction: 0.5,
  dominantTailFraction: 0.5,
  minimumDominantTailIntervals: 2,
  phaseCoherenceToleranceMs: 0.1,
  reconstructionToleranceMs: 1,
  immediateTurnP95Ms: 1,
  processLaunchP95Ms: 5,
  stabilityAdmissionTimeoutMs: 300_000,
} as const;
const bench044Prediction = {
  clientResponseValidationP95Fraction: 0.5,
  clientResponseValidationTailFraction: 0.5,
  requestConstructionP95Ms: 2,
  requestSendP95Ms: 2,
  requestIngressSchedulingP95Ms: 5,
  responseEgressSchedulingP95Ms: 5,
  expectedObserverHealthP95Ms: 10,
  serverResponseConstructionP95Ms: 5,
  serverResponseSendP95Ms: 5,
} as const;
const bench045Thresholds = {
  ...bench044Thresholds,
  responseEgressP95Ms: 15,
  responseEgressTailIntervalMs: 6,
  dominantP95Fraction: 0.6,
} as const;
const bench045Prediction = {
  preCallbackDeliveryP95Fraction: 0.7,
  preCallbackDeliveryTailFraction: 0.5,
  individualPostCallbackP95Ms: 1,
  combinedPostCallbackP95Ms: 2,
} as const;
const bench046Thresholds = {
  ...bench045Thresholds,
  minimumPairedTuiSlowerSamples: 15,
  minimumPairedDifferenceMs: 4,
  minimumStandaloneP95ImprovementFraction: 0.6,
} as const;
const bench046Prediction = {
  standaloneMedianMs: 1,
  standaloneP95Ms: 2,
  standaloneP95ImprovementFraction: 0.7,
  callbackToValidatedP95Ms: 0.2,
} as const;
const bench047Thresholds = {
  ...bench045Thresholds,
  minimumPairedTuiSlowerSamples: 15,
  minimumPairedDifferenceMs: 2,
  minimumIdleP95ImprovementFraction: 0.4,
} as const;
const bench047Prediction = {
  idleMedianMs: 3,
  idleP95Ms: 5,
  minimumPairedTuiSlowerSamples: 15,
  idleP95ImprovementFraction: 0.5,
  callbackToValidatedP95Ms: 0.2,
} as const;
const exp016CandidateIntentP95Ms = 357.7810000000027;
const exp016CandidateBuildIdentity =
  "35acc427d7a27d641d8b0295a07faf73e78270230eed4fff0d19e0ab3f9fa744";
const expectedUiProgress = "Launching STATION TUI…\n";
const expectedObserverAndUiProgress = "Starting STATION observer…\nLaunching STATION TUI…\n";
const managedLaunchPhaseDiagnosticPrefix = "__STATION_QUICK_SESSION_MANAGED_LAUNCH_PHASES__:";
const managedLaunchDiagnosticPhases = [
  "hostedLaunchStarted",
  "commandCompleted",
  "worktreeObserved",
  "attemptStarted",
  "preflightCompleted",
  "prepareStarted",
  "prepareCompleted",
  "attachmentResolveStarted",
  "attachmentResolveCompleted",
  "terminalPlaced",
  "panePublished",
  "attemptCompleted",
  "hostedLaunchCompleted",
  "quickResultReceived",
  "overlayCloseRequested",
  "canonicalWaitStarted",
  "canonicalWaitCompleted",
] as const;
const managedLaunchPhaseTraceSchema = z
  .object({
    events: z.array(
      z
        .object({
          phase: z.enum(managedLaunchDiagnosticPhases),
          atMs: z.number().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
const managedLaunchPhaseSegments = [
  {
    key: "commandCompletionToWorktreeObservationMs",
    from: "commandCompleted",
    to: "worktreeObserved",
  },
  {
    key: "worktreeObservationToAttemptStartMs",
    from: "worktreeObserved",
    to: "attemptStarted",
  },
  {
    key: "managedPreflightMs",
    from: "attemptStarted",
    to: "preflightCompleted",
  },
  {
    key: "preflightToPrepareStartMs",
    from: "preflightCompleted",
    to: "prepareStarted",
  },
  {
    key: "prepareExternalLaunchMs",
    from: "prepareStarted",
    to: "prepareCompleted",
  },
  {
    key: "prepareToAttachmentResolveStartMs",
    from: "prepareCompleted",
    to: "attachmentResolveStarted",
  },
  {
    key: "attachmentResolutionMs",
    from: "attachmentResolveStarted",
    to: "attachmentResolveCompleted",
  },
  {
    key: "attachmentToTerminalPlacementMs",
    from: "attachmentResolveCompleted",
    to: "terminalPlaced",
  },
  {
    key: "terminalPlacementToPanePublicationMs",
    from: "terminalPlaced",
    to: "panePublished",
  },
  {
    key: "panePublicationToAttemptCompletionMs",
    from: "panePublished",
    to: "attemptCompleted",
  },
  {
    key: "attemptToHostedLaunchCompletionMs",
    from: "attemptCompleted",
    to: "hostedLaunchCompleted",
  },
  {
    key: "hostedLaunchToQuickResultMs",
    from: "hostedLaunchCompleted",
    to: "quickResultReceived",
  },
  {
    key: "quickResultToOverlayCloseMs",
    from: "quickResultReceived",
    to: "overlayCloseRequested",
  },
] as const;
const observerExternalLaunchDiagnosticPhases = [
  "prepareEntered",
  "mutationEntered",
  "targetInventoryStarted",
  "targetInventoryCompleted",
  "harnessPreflightStarted",
  "harnessPreflightCompleted",
  "sessionPersistenceStarted",
  "sessionPersistenceCompleted",
  "workspaceOpenStarted",
  "workspaceOpenCompleted",
  "launchPlanStarted",
  "launchPlanCompleted",
  "hostProcessLaunchStarted",
  "hostProcessLaunchCompleted",
  "canonicalProjectionStarted",
  "canonicalProjectionCompleted",
  "prepareCompleted",
] as const;
const observerExternalLaunchPhaseTraceSchema = z
  .object({
    events: z.array(
      z
        .object({
          phase: z.enum(observerExternalLaunchDiagnosticPhases),
          atMs: z.number().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
const observerExternalLaunchPhaseSegments = [
  { key: "mutationAdmissionMs", from: "prepareEntered", to: "mutationEntered" },
  {
    key: "mutationToTargetInventoryStartMs",
    from: "mutationEntered",
    to: "targetInventoryStarted",
  },
  {
    key: "targetInventoryMs",
    from: "targetInventoryStarted",
    to: "targetInventoryCompleted",
  },
  {
    key: "inventoryToHarnessPreflightMs",
    from: "targetInventoryCompleted",
    to: "harnessPreflightStarted",
  },
  {
    key: "harnessPreflightMs",
    from: "harnessPreflightStarted",
    to: "harnessPreflightCompleted",
  },
  {
    key: "preflightToSessionPersistenceMs",
    from: "harnessPreflightCompleted",
    to: "sessionPersistenceStarted",
  },
  {
    key: "sessionPersistenceMs",
    from: "sessionPersistenceStarted",
    to: "sessionPersistenceCompleted",
  },
  {
    key: "persistenceToWorkspaceOpenMs",
    from: "sessionPersistenceCompleted",
    to: "workspaceOpenStarted",
  },
  {
    key: "managedWorkspaceOpenMs",
    from: "workspaceOpenStarted",
    to: "workspaceOpenCompleted",
  },
  {
    key: "workspaceToLaunchPlanMs",
    from: "workspaceOpenCompleted",
    to: "launchPlanStarted",
  },
  {
    key: "harnessLaunchPlanMs",
    from: "launchPlanStarted",
    to: "launchPlanCompleted",
  },
  {
    key: "launchPlanToHostProcessMs",
    from: "launchPlanCompleted",
    to: "hostProcessLaunchStarted",
  },
  {
    key: "hostProcessLaunchMs",
    from: "hostProcessLaunchStarted",
    to: "hostProcessLaunchCompleted",
  },
  {
    key: "hostProcessToCanonicalProjectionMs",
    from: "hostProcessLaunchCompleted",
    to: "canonicalProjectionStarted",
  },
  {
    key: "canonicalProjectionMs",
    from: "canonicalProjectionStarted",
    to: "canonicalProjectionCompleted",
  },
  {
    key: "projectionToPrepareCompletionMs",
    from: "canonicalProjectionCompleted",
    to: "prepareCompleted",
  },
] as const;
const prepareExternalLaunchClientProtocolDiagnosticPhases = [
  "protocolEntered",
  "boundaryTaskEntered",
  "socketConnectStarted",
  "socketConnected",
  "expectedObserverHealthStarted",
  "expectedObserverHealthCompleted",
  "prepareRequestStarted",
  "responseDeliveryDiagnosticArmed",
  "prepareRequestConstructed",
  "prepareRequestSent",
  "responseIteratorWaitStarted",
  "responseSocketDataCallbackEntered",
  "responseFrameExtracted",
  "responseJsonParsed",
  "responseQueued",
  "responseWaiterResolutionStarted",
  "responseWaiterResolutionCompleted",
  "responseIteratorWaitResumed",
  "responseDequeued",
  "responseYieldStarted",
  "prepareResponseFrameReceived",
  "prepareResponseEnvelopeParsed",
  "prepareResponseCompleted",
  "boundaryTaskCompleted",
  "protocolCompleted",
] as const;
const prepareExternalLaunchServerProtocolDiagnosticPhases = [
  "expectedObserverHealthRequestParsed",
  "expectedObserverHealthResponseSent",
  "prepareRequestParsed",
  "prepareHandlerStarted",
  "prepareUseCaseDispatchStarted",
  "prepareUseCaseDispatchCompleted",
  "prepareHandlerCompleted",
  "prepareResponseConstructed",
  "prepareResponseSent",
] as const;
const idleResponseDeliveryClientProtocolDiagnosticPhases = [
  "protocolEntered",
  "boundaryTaskEntered",
  "socketConnectStarted",
  "socketConnected",
  "requestStarted",
  "responseDeliveryDiagnosticArmed",
  "requestConstructed",
  "requestSent",
  "responseIteratorWaitStarted",
  "responseSocketDataCallbackEntered",
  "responseFrameExtracted",
  "responseJsonParsed",
  "responseQueued",
  "responseWaiterResolutionStarted",
  "responseWaiterResolutionCompleted",
  "responseIteratorWaitResumed",
  "responseDequeued",
  "responseYieldStarted",
  "responseFrameReceived",
  "responseEnvelopeParsed",
  "responseValidated",
  "boundaryTaskCompleted",
  "protocolCompleted",
] as const;
const idleResponseDeliveryServerProtocolDiagnosticPhases = [
  "requestParsed",
  "handlerStarted",
  "handlerCompleted",
  "responseConstructed",
  "responseSent",
] as const;
const prepareExternalLaunchClientProtocolTraceSchema = diagnosticTraceSchema(
  prepareExternalLaunchClientProtocolDiagnosticPhases,
  idleResponseDeliveryClientProtocolDiagnosticPhases,
);
const prepareExternalLaunchServerProtocolTraceSchema = diagnosticTraceSchema(
  prepareExternalLaunchServerProtocolDiagnosticPhases,
  idleResponseDeliveryServerProtocolDiagnosticPhases,
);
const prepareExternalLaunchClientProtocolSegments = [
  { key: "protocolBoundaryAdmissionMs", from: "protocolEntered", to: "boundaryTaskEntered" },
  { key: "boundaryToSocketConnectMs", from: "boundaryTaskEntered", to: "socketConnectStarted" },
  { key: "socketConnectMs", from: "socketConnectStarted", to: "socketConnected" },
  {
    key: "socketToExpectedObserverHealthMs",
    from: "socketConnected",
    to: "expectedObserverHealthStarted",
  },
  {
    key: "expectedObserverHealthMs",
    from: "expectedObserverHealthStarted",
    to: "expectedObserverHealthCompleted",
  },
  {
    key: "healthToPrepareRequestMs",
    from: "expectedObserverHealthCompleted",
    to: "prepareRequestStarted",
  },
  {
    key: "responseDiagnosticArmMs",
    from: "prepareRequestStarted",
    to: "responseDeliveryDiagnosticArmed",
  },
  {
    key: "prepareRequestConstructionMs",
    from: "responseDeliveryDiagnosticArmed",
    to: "prepareRequestConstructed",
  },
  {
    key: "prepareRequestSendMs",
    from: "prepareRequestConstructed",
    to: "prepareRequestSent",
  },
  {
    key: "requestSendToIteratorWaitMs",
    from: "prepareRequestSent",
    to: "responseIteratorWaitStarted",
  },
  {
    key: "iteratorWaitToSocketDataMs",
    from: "responseIteratorWaitStarted",
    to: "responseSocketDataCallbackEntered",
  },
  {
    key: "socketDataToFrameExtractionMs",
    from: "responseSocketDataCallbackEntered",
    to: "responseFrameExtracted",
  },
  {
    key: "frameExtractionToJsonParseMs",
    from: "responseFrameExtracted",
    to: "responseJsonParsed",
  },
  {
    key: "jsonParseToQueueMs",
    from: "responseJsonParsed",
    to: "responseQueued",
  },
  {
    key: "queueToWaiterResolutionMs",
    from: "responseQueued",
    to: "responseWaiterResolutionStarted",
  },
  {
    key: "waiterResolutionMs",
    from: "responseWaiterResolutionStarted",
    to: "responseWaiterResolutionCompleted",
  },
  {
    key: "waiterToIteratorResumeMs",
    from: "responseWaiterResolutionCompleted",
    to: "responseIteratorWaitResumed",
  },
  {
    key: "iteratorResumeToDequeueMs",
    from: "responseIteratorWaitResumed",
    to: "responseDequeued",
  },
  {
    key: "dequeueToYieldMs",
    from: "responseDequeued",
    to: "responseYieldStarted",
  },
  {
    key: "yieldToOuterFrameReceiptMs",
    from: "responseYieldStarted",
    to: "prepareResponseFrameReceived",
  },
  {
    key: "prepareResponseEnvelopeValidationMs",
    from: "prepareResponseFrameReceived",
    to: "prepareResponseEnvelopeParsed",
  },
  {
    key: "prepareResponseResultValidationMs",
    from: "prepareResponseEnvelopeParsed",
    to: "prepareResponseCompleted",
  },
  {
    key: "responseToBoundaryCompletionMs",
    from: "prepareResponseCompleted",
    to: "boundaryTaskCompleted",
  },
  {
    key: "boundaryToProtocolCompletionMs",
    from: "boundaryTaskCompleted",
    to: "protocolCompleted",
  },
] as const;
const prepareExternalLaunchServerProtocolSegments = [
  {
    key: "requestToHandlerAdmissionMs",
    from: "prepareRequestParsed",
    to: "prepareHandlerStarted",
  },
  {
    key: "handlerToUseCaseDispatchMs",
    from: "prepareHandlerStarted",
    to: "prepareUseCaseDispatchStarted",
  },
  {
    key: "useCaseDispatchMs",
    from: "prepareUseCaseDispatchStarted",
    to: "prepareUseCaseDispatchCompleted",
  },
  {
    key: "useCaseToHandlerCompletionMs",
    from: "prepareUseCaseDispatchCompleted",
    to: "prepareHandlerCompleted",
  },
  {
    key: "handlerToResponseConstructionMs",
    from: "prepareHandlerCompleted",
    to: "prepareResponseConstructed",
  },
  {
    key: "responseSendMs",
    from: "prepareResponseConstructed",
    to: "prepareResponseSent",
  },
] as const;
const protocolResidualPhaseKeys = [
  "serviceToProtocolEntryMs",
  "protocolBoundaryAdmissionMs",
  "boundaryToSocketConnectMs",
  "socketConnectMs",
  "socketToExpectedObserverHealthMs",
  "expectedObserverHealthMs",
  "healthToPrepareRequestMs",
  "actualRequestWireClientMs",
  "observerProtocolPreUseCaseMs",
  "observerProtocolPostUseCaseMs",
  "responseToBoundaryCompletionMs",
  "boundaryToProtocolCompletionMs",
  "protocolToServiceCompletionMs",
] as const;
const wireAttributionPhaseKeys = [
  "requestConstructionMs",
  "requestSendMs",
  "requestIngressSchedulingMs",
  "responseEgressSchedulingMs",
  "clientResponseEnvelopeValidationMs",
  "clientResponseResultValidationMs",
] as const;
const transportDeliveryPhaseKeys = [
  "serverSendToSocketDataCallbackMs",
  "socketDataToFrameExtractionMs",
  "frameExtractionToJsonParseMs",
  "jsonParseToQueueMs",
  "queueToWaiterResolutionMs",
  "waiterResolutionMs",
  "waiterToIteratorResumeMs",
  "iteratorResumeToDequeueMs",
  "dequeueToYieldMs",
  "yieldToOuterFrameReceiptMs",
] as const;
const transportPostCallbackPhaseKeys = [
  "socketDataToFrameExtractionMs",
  "frameExtractionToJsonParseMs",
  "jsonParseToQueueMs",
  "queueToWaiterResolutionMs",
  "waiterResolutionMs",
  "waiterToIteratorResumeMs",
  "iteratorResumeToDequeueMs",
  "dequeueToYieldMs",
  "yieldToOuterFrameReceiptMs",
] as const;

type FocusStrategy = "automatic" | "escape" | "toggle";
type StabilityAdmissionAttempt = {
  attemptedAt: string;
  immediateTurnMs: ReturnType<typeof distribution>;
  processLaunchMs: ReturnType<typeof distribution>;
  loadAverage: number[];
  passed: boolean;
};
type StabilityAdmission = {
  passed: boolean;
  waitedMs: number;
  attempts: StabilityAdmissionAttempt[];
};

type BenchmarkFixture = Awaited<ReturnType<typeof createBenchmarkFixture>>;
type BenchmarkRun = Awaited<ReturnType<typeof runRepetition>>;
type StandaloneTransportControl = Awaited<ReturnType<typeof runStandaloneTransportControl>>;

describeStandaloneTransportSmoke("standalone Bun transport control", () => {
  it("strictly measures one test-owned Unix-socket response", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "station-transport-smoke-"));
    const runtimeRoot = await mkdtemp(join("/tmp", "st-qtu-smoke-"));
    const fixture = { temporaryRoot, runtimeRoot };
    let server: Awaited<ReturnType<typeof startStandaloneTransportServer>> | undefined;
    try {
      server = await startStandaloneTransportServer(fixture);
      const control = await runStandaloneTransportControl(fixture, 0, "before");
      expect(control.safe).toBe(true);
      expect(control.stderrEmpty).toBe(true);
      expect(control.serverSendToCallbackMs).toBeGreaterThanOrEqual(0);
      expect(control.callbackToValidatedMs).toBeGreaterThanOrEqual(0);
      const closed = await server.close();
      server = undefined;
      expect(closed.requests).toBe(1);
    } finally {
      if (server !== undefined) await server.close().catch(() => undefined);
      await Promise.all([
        rm(temporaryRoot, { recursive: true, force: true }),
        rm(runtimeRoot, { recursive: true, force: true }),
      ]);
    }
  }, 30_000);
});

describeReal("compiled CLI native Quick Session product boundary", () => {
  it("measures cold CLI startup and raw native Quick Session input independently", async () => {
    const report = {
      schemaVersion: 1,
      benchmark: runBench047NativeTuiIdleSmoke
        ? "station-quick-session-bench-047-native-tui-idle-control-smoke"
        : runBench047NativeTuiIdleControl
          ? "station-quick-session-bench-047-native-tui-idle-control"
          : runBench046StandaloneTransportControl
            ? "station-quick-session-bench-046-standalone-transport-control"
            : runBench045TransportDeliveryAttribution
              ? "station-quick-session-bench-045-transport-delivery-attribution"
              : runBench044WireAttribution
                ? "station-quick-session-bench-044-wire-attribution"
                : runBench043ProtocolResidualAttribution
                  ? "station-quick-session-bench-043-protocol-residual-attribution"
                  : runBench042ObserverPhaseAttribution
                    ? "station-quick-session-bench-042-observer-launch-phase-attribution"
                    : runBench041PhaseAttribution
                      ? "station-quick-session-bench-041-managed-launch-phase-attribution"
                      : runBench040ImmediateInput
                        ? "station-quick-session-bench-040-immediate-input"
                        : runExp016Control
                          ? "station-quick-session-exp-016-control"
                          : runExp016Candidate
                            ? "station-quick-session-exp-016-candidate"
                            : runFocusComparison
                              ? "station-quick-session-compiled-cli-native-focus-comparison"
                              : runSafetyAudit
                                ? "station-quick-session-compiled-cli-native-safety-audit"
                                : "station-quick-session-compiled-cli-native-tui",
      generatedAt: new Date().toISOString(),
      machine: {
        platform: platform(),
        arch: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
      },
      tools: {
        bun: "",
        worktrunk: "",
        tmux: "",
        hostProtocolVersion: HOST_PROTOCOL_VERSION,
        displayBuildVersion: "",
        observerBuildVersion: "",
      },
      binary: {
        buildMs: 0,
        bytes: 0,
        buildExcludedFromTiming: true,
        prebuiltExactCandidate: runBench040ImmediateInput,
      },
      repositoryShape: {
        worktrees: initialInventoryCount,
        repetitions,
        lifecycleHooks: false,
        ordinaryObserverRestartPerRun: true,
        ptyUsedHostPreservedAcrossRuns: true,
      },
      thresholds: runBench047NativeTuiIdleExperiment
        ? bench047Thresholds
        : runBench046StandaloneTransportControl
          ? bench046Thresholds
          : runBench045TransportDeliveryAttribution
            ? bench045Thresholds
            : runBench044WireAttribution
              ? bench044Thresholds
              : runBench043ProtocolResidualAttribution
                ? bench043Thresholds
                : runBench042ObserverPhaseAttribution
                  ? bench042Thresholds
                  : runBench041PhaseAttribution
                    ? bench041Thresholds
                    : runBench040ImmediateInput
                      ? bench040Thresholds
                      : runExp016Control
                        ? null
                        : runExp016Candidate
                          ? exp016Thresholds
                          : runFocusComparison
                            ? focusThresholds
                            : thresholds,
      setup: {
        repositoryShapeMs: 0,
        hostSeedMs: 0,
        hostSeedSafe: false,
        hostStoppedCleanly: false,
        hostStderrEmpty: false,
        standaloneTransportServerClosed: false,
        standaloneTransportRequests: 0,
        rootRemoved: false,
      },
      runs: [] as BenchmarkRun[],
      standaloneTransportControls: [] as StandaloneTransportControl[],
      distributions: emptyDistributions(),
      focusComparison: null as ReturnType<typeof summarizeFocusComparison> | null,
      phaseAttribution: null as ReturnType<typeof summarizeManagedLaunchPhaseAttribution> | null,
      observerPhaseAttribution: null as ReturnType<
        typeof summarizeObserverExternalLaunchPhaseAttribution
      > | null,
      protocolResidualAttribution: null as ReturnType<
        typeof summarizeProtocolResidualAttribution
      > | null,
      wireAttribution: null as ReturnType<typeof summarizeWireAttribution> | null,
      transportDeliveryAttribution: null as ReturnType<
        typeof summarizeTransportDeliveryAttribution
      > | null,
      standaloneTransportControl: null as ReturnType<
        typeof summarizeStandaloneTransportControl
      > | null,
      nativeTuiIdleTransportControl: null as ReturnType<
        typeof summarizeNativeTuiIdleTransportControl
      > | null,
      stabilityAdmission: null as ReturnType<typeof summarizeStabilityAdmission> | null,
      stabilityAdmissions: [] as StabilityAdmission[],
      falseSafetyPredicates: [] as string[],
      safetyAuditPassed: false,
      predictionPassed: false,
      allSafe: false,
      thresholdsPassed: false,
      failure: null as string | null,
    };
    let fixture: BenchmarkFixture | undefined;
    let hostRuntime: ReturnType<typeof createHostRuntime> | undefined;
    let standaloneTransportServer:
      | Awaited<ReturnType<typeof startStandaloneTransportServer>>
      | undefined;
    try {
      await Promise.all([access(worktrunkCommand), access(tmuxCommand)]).catch(async () => {
        await execFileAsync(worktrunkCommand, ["--version"], { timeout: 15_000 });
        await execFileAsync(tmuxCommand, ["-V"], { timeout: 10_000 });
      });
      const packageJson = z
        .object({ version: z.string().min(1) })
        .passthrough()
        .parse(JSON.parse(await readFile(packageJsonPath, "utf8")));
      report.tools.displayBuildVersion = packageJson.version;
      if (!runBench040ImmediateInput) {
        const buildStartedAt = performance.now();
        await execFileAsync("pnpm", ["build:binary", "--version", packageJson.version], {
          cwd: repoRoot,
          maxBuffer: 16 * 1024 * 1024,
          timeout: 300_000,
        });
        report.binary.buildMs = performance.now() - buildStartedAt;
      }
      report.binary.bytes = (await stat(binaryPath)).size;
      const buildIdentity = z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .parse((await readFile(buildIdentityPath, "utf8")).trim());
      if (runBench040ImmediateInput && buildIdentity !== exp016CandidateBuildIdentity) {
        throw new Error("BENCH-040 did not find the exact preserved EXP-016 candidate binary.");
      }
      report.tools.observerBuildVersion = `${packageJson.version}+station.${buildIdentity}`;
      const [bunVersion, worktrunkVersion, tmuxVersion] = await Promise.all([
        execFileAsync(process.env.STATION_BUN ?? "bun", ["--version"]),
        execFileAsync(worktrunkCommand, ["--version"]),
        execFileAsync(tmuxCommand, ["-V"]),
      ]);
      report.tools.bun = bunVersion.stdout.trim();
      report.tools.worktrunk = worktrunkVersion.stdout.trim();
      report.tools.tmux = tmuxVersion.stdout.trim();

      const temporaryRoot = await mkdtemp(join(tmpdir(), "st-qtu-"));
      const shapeStartedAt = performance.now();
      fixture = await createBenchmarkFixture(temporaryRoot);
      report.setup.repositoryShapeMs = performance.now() - shapeStartedAt;
      if (runBench046StandaloneTransportControl) {
        standaloneTransportServer = await startStandaloneTransportServer(fixture);
      }
      hostRuntime = createHostRuntime(fixture, packageJson.version);
      const seed = await seedHost(hostRuntime, fixture);
      report.setup.hostSeedMs = seed.durationMs;
      report.setup.hostSeedSafe = seed.safe;

      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        if (runBench046StandaloneTransportControl && repetition % 2 === 0) {
          const control = await runStandaloneTransportControlWithAdmission(
            fixture,
            repetition,
            "before",
          );
          report.stabilityAdmissions.push(control.stabilityAdmission);
          report.standaloneTransportControls.push(control);
        }
        const stabilityAdmission =
          runBench044WireAttribution ||
          runBench045TransportDeliveryAttribution ||
          runBench046StandaloneTransportControl
            ? await awaitStabilityAdmission()
            : null;
        if (stabilityAdmission !== null) {
          report.stabilityAdmissions.push(stabilityAdmission);
          if (!stabilityAdmission.passed) {
            throw new Error("BENCH-044 stability admission timed out before a valid repetition.");
          }
        }
        report.runs.push(
          await runRepetition({
            fixture,
            hostRuntime,
            repetition,
            expectedObserverBuildVersion: report.tools.observerBuildVersion,
            stabilityAdmission,
            recordStabilityAdmission: (admission) => {
              report.stabilityAdmissions.push(admission);
            },
          }),
        );
        if (runBench046StandaloneTransportControl && repetition % 2 === 1) {
          const control = await runStandaloneTransportControlWithAdmission(
            fixture,
            repetition,
            "after",
          );
          report.stabilityAdmissions.push(control.stabilityAdmission);
          report.standaloneTransportControls.push(control);
        }
      }
      if (standaloneTransportServer !== undefined) {
        const closedTransport = await standaloneTransportServer.close();
        standaloneTransportServer = undefined;
        report.setup.standaloneTransportServerClosed = true;
        report.setup.standaloneTransportRequests = closedTransport.requests;
      }
      const stopped = await hostRuntime.client.stopIfIdle(packageJson.version);
      const hostExit = await waitForExit(hostRuntime.child(), 7_000);
      report.setup.hostStoppedCleanly =
        stopped.stopping && hostExit.code === 0 && hostExit.signal === null;
      report.setup.hostStderrEmpty = hostRuntime.stderr().length === 0;
    } catch (error) {
      report.failure = diagnosticError(error);
    } finally {
      if (standaloneTransportServer !== undefined) {
        await standaloneTransportServer.close().catch(() => undefined);
      }
      if (hostRuntime !== undefined) {
        await stopHostRuntime(hostRuntime).catch(() => undefined);
      }
      if (fixture !== undefined) {
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
        await rm(fixture.runtimeRoot, { recursive: true, force: true });
        report.setup.rootRemoved =
          !(await pathExists(fixture.temporaryRoot)) && !(await pathExists(fixture.runtimeRoot));
      }
    }

    report.distributions = summarizeRuns(report.runs);
    report.focusComparison = summarizeFocusComparison(report.runs);
    report.phaseAttribution = summarizeManagedLaunchPhaseAttribution(report.runs);
    report.observerPhaseAttribution = summarizeObserverExternalLaunchPhaseAttribution(report.runs);
    report.protocolResidualAttribution = summarizeProtocolResidualAttribution(report.runs);
    report.wireAttribution = summarizeWireAttribution(report.runs);
    report.transportDeliveryAttribution = summarizeTransportDeliveryAttribution(report.runs);
    report.standaloneTransportControl = summarizeStandaloneTransportControl(
      report.runs,
      report.standaloneTransportControls,
    );
    report.nativeTuiIdleTransportControl = summarizeNativeTuiIdleTransportControl(report.runs);
    report.stabilityAdmission = summarizeStabilityAdmission(report.stabilityAdmissions);
    report.falseSafetyPredicates = report.runs.flatMap((run) =>
      Object.entries(run.safetyPredicates)
        .filter(([, passed]) => !passed)
        .map(([predicate]) => predicate),
    );
    report.allSafe =
      report.failure === null &&
      report.runs.length === repetitions &&
      report.runs.every((run) => run.safe) &&
      report.setup.hostSeedSafe &&
      report.setup.hostStoppedCleanly &&
      report.setup.hostStderrEmpty &&
      (!runBench046StandaloneTransportControl ||
        (report.setup.standaloneTransportServerClosed &&
          report.setup.standaloneTransportRequests === repetitions)) &&
      report.setup.rootRemoved;
    report.safetyAuditPassed =
      runSafetyAudit &&
      report.failure === null &&
      report.runs.length === repetitions &&
      report.falseSafetyPredicates.length === 0 &&
      report.runs.every((run) => run.phaseCoherent && run.safe) &&
      report.setup.hostSeedSafe &&
      report.setup.hostStoppedCleanly &&
      report.setup.hostStderrEmpty &&
      report.setup.rootRemoved;
    report.predictionPassed = runBench047NativeTuiIdleSmoke
      ? report.allSafe && report.nativeTuiIdleTransportControl.validRuns === repetitions
      : runBench047NativeTuiIdleControl
        ? report.nativeTuiIdleTransportControl.idleServerSendToCallbackMs.median <=
            bench047Prediction.idleMedianMs &&
          report.nativeTuiIdleTransportControl.idleServerSendToCallbackMs.p95 <=
            bench047Prediction.idleP95Ms &&
          report.nativeTuiIdleTransportControl.pairedTuiSlowerSamples >=
            bench047Prediction.minimumPairedTuiSlowerSamples &&
          report.nativeTuiIdleTransportControl.idleP95ImprovementFraction >=
            bench047Prediction.idleP95ImprovementFraction &&
          report.nativeTuiIdleTransportControl.idleCallbackToValidatedMs.p95 <=
            bench047Prediction.callbackToValidatedP95Ms
        : runBench046StandaloneTransportControl
          ? report.standaloneTransportControl.standaloneServerSendToCallbackMs.median <=
              bench046Prediction.standaloneMedianMs &&
            report.standaloneTransportControl.standaloneServerSendToCallbackMs.p95 <=
              bench046Prediction.standaloneP95Ms &&
            report.standaloneTransportControl.standaloneP95ImprovementFraction >=
              bench046Prediction.standaloneP95ImprovementFraction &&
            report.standaloneTransportControl.callbackToValidatedMs.p95 <=
              bench046Prediction.callbackToValidatedP95Ms
          : runBench045TransportDeliveryAttribution
            ? report.transportDeliveryAttribution.preCallbackDeliveryP95Fraction >=
                bench045Prediction.preCallbackDeliveryP95Fraction &&
              report.transportDeliveryAttribution.preCallbackDeliveryDominatesEveryTail &&
              transportPostCallbackPhaseKeys.every(
                (key) =>
                  report.transportDeliveryAttribution.phaseDistributions[key].p95 <=
                  bench045Prediction.individualPostCallbackP95Ms,
              ) &&
              report.transportDeliveryAttribution.postCallbackMs.p95 <=
                bench045Prediction.combinedPostCallbackP95Ms
            : runBench044WireAttribution
              ? report.wireAttribution.clientResponseValidationP95Fraction >=
                  bench044Prediction.clientResponseValidationP95Fraction &&
                report.wireAttribution.clientResponseValidationDominatesEveryTail &&
                report.wireAttribution.phaseDistributions.requestConstructionMs.p95 <=
                  bench044Prediction.requestConstructionP95Ms &&
                report.wireAttribution.phaseDistributions.requestSendMs.p95 <=
                  bench044Prediction.requestSendP95Ms &&
                report.wireAttribution.phaseDistributions.requestIngressSchedulingMs.p95 <=
                  bench044Prediction.requestIngressSchedulingP95Ms &&
                report.wireAttribution.phaseDistributions.responseEgressSchedulingMs.p95 <=
                  bench044Prediction.responseEgressSchedulingP95Ms &&
                report.protocolResidualAttribution.phaseDistributions.expectedObserverHealthMs
                  .p95 <= bench044Prediction.expectedObserverHealthP95Ms &&
                report.protocolResidualAttribution.serverPhaseDistributions
                  .handlerToResponseConstructionMs.p95 <=
                  bench044Prediction.serverResponseConstructionP95Ms &&
                report.protocolResidualAttribution.serverPhaseDistributions.responseSendMs.p95 <=
                  bench044Prediction.serverResponseSendP95Ms
              : runBench043ProtocolResidualAttribution
                ? report.protocolResidualAttribution.expectedObserverHealthP95Fraction >=
                    bench043Prediction.expectedObserverHealthP95Fraction &&
                  report.protocolResidualAttribution.expectedObserverHealthDominatesEveryTail &&
                  report.protocolResidualAttribution.phaseDistributions.socketConnectMs.p95 <=
                    bench043Prediction.socketConnectP95Ms &&
                  report.protocolResidualAttribution.phaseDistributions.actualRequestWireClientMs
                    .p95 <= bench043Prediction.actualRequestWireClientP95Ms &&
                  report.protocolResidualAttribution.phaseDistributions.observerProtocolPreUseCaseMs
                    .p95 <= bench043Prediction.observerProtocolPreUseCaseP95Ms &&
                  report.protocolResidualAttribution.phaseDistributions
                    .observerProtocolPostUseCaseMs.p95 <=
                    bench043Prediction.observerProtocolPostUseCaseP95Ms &&
                  report.protocolResidualAttribution.outerClientSettlementMs.p95 <=
                    bench043Prediction.outerClientSettlementP95Ms
                : runBench042ObserverPhaseAttribution
                  ? report.observerPhaseAttribution.hostProcessLaunchP95Fraction >=
                      bench042Prediction.hostProcessLaunchP95Fraction &&
                    report.observerPhaseAttribution.hostProcessLaunchDominatesEveryTail &&
                    report.observerPhaseAttribution.phaseDistributions.targetInventoryMs.p95 <=
                      bench042Prediction.targetInventoryP95Ms &&
                    report.observerPhaseAttribution.phaseDistributions.sessionPersistenceMs.p95 <=
                      bench042Prediction.sessionPersistenceP95Ms &&
                    report.observerPhaseAttribution.phaseDistributions.canonicalProjectionMs.p95 <=
                      bench042Prediction.canonicalProjectionP95Ms &&
                    report.observerPhaseAttribution.transportResidualMs.p95 <=
                      bench042Prediction.transportResidualP95Ms
                  : runBench041PhaseAttribution &&
                    report.phaseAttribution.prepareExternalLaunchP95Fraction >=
                      bench041Prediction.prepareExternalLaunchP95Fraction &&
                    report.phaseAttribution.prepareExternalLaunchDominatesEveryTail &&
                    report.phaseAttribution.phaseDistributions.attachmentResolutionMs.p95 <=
                      bench041Prediction.attachmentResolutionP95Ms;
    report.thresholdsPassed = runBench047NativeTuiIdleSmoke
      ? report.allSafe &&
        report.stabilityAdmission.validRuns === repetitions * 2 &&
        report.nativeTuiIdleTransportControl.validRuns === repetitions &&
        report.nativeTuiIdleTransportControl.maximumReconstructionErrorMs <=
          bench047Thresholds.reconstructionToleranceMs
      : runBench047NativeTuiIdleControl
        ? report.allSafe &&
          report.predictionPassed &&
          report.stabilityAdmission.validRuns === repetitions * 2 &&
          report.nativeTuiIdleTransportControl.validRuns === repetitions &&
          report.distributions.intentToInteractiveMs.p95 <=
            bench047Thresholds.intentToInteractiveP95Ms &&
          report.phaseAttribution.phaseDistributions.attachmentResolutionMs.p95 <=
            bench047Thresholds.attachmentResolutionP95Ms &&
          report.protocolResidualAttribution.transportResidualMs.p95 >= 0 &&
          report.protocolResidualAttribution.transportResidualMs.p95 <=
            bench047Thresholds.transportResidualP95Ms &&
          report.transportDeliveryAttribution.responseEgressMs.p95 <=
            bench047Thresholds.responseEgressP95Ms &&
          report.nativeTuiIdleTransportControl.pairedTuiSlowerSamples >=
            bench047Thresholds.minimumPairedTuiSlowerSamples &&
          report.nativeTuiIdleTransportControl.idleP95ImprovementFraction >=
            bench047Thresholds.minimumIdleP95ImprovementFraction &&
          report.nativeTuiIdleTransportControl.maximumReconstructionErrorMs <=
            bench047Thresholds.reconstructionToleranceMs
        : runBench046StandaloneTransportControl
          ? report.allSafe &&
            report.stabilityAdmission.validRuns === repetitions * 2 &&
            report.standaloneTransportControl.validControls === repetitions &&
            report.standaloneTransportControl.pairedRuns === repetitions &&
            report.standaloneTransportControl.uniqueRepetitions === repetitions &&
            report.standaloneTransportControl.beforeControls === repetitions / 2 &&
            report.standaloneTransportControl.afterControls === repetitions / 2 &&
            report.distributions.intentToInteractiveMs.p95 <=
              bench046Thresholds.intentToInteractiveP95Ms &&
            report.phaseAttribution.phaseDistributions.attachmentResolutionMs.p95 <=
              bench046Thresholds.attachmentResolutionP95Ms &&
            report.protocolResidualAttribution.transportResidualMs.p95 <=
              bench046Thresholds.transportResidualP95Ms &&
            report.transportDeliveryAttribution.responseEgressMs.p95 <=
              bench046Thresholds.responseEgressP95Ms &&
            report.standaloneTransportControl.pairedTuiSlowerSamples >=
              bench046Thresholds.minimumPairedTuiSlowerSamples &&
            report.standaloneTransportControl.standaloneP95ImprovementFraction >=
              bench046Thresholds.minimumStandaloneP95ImprovementFraction
          : runBench045TransportDeliveryAttribution
            ? report.allSafe &&
              report.stabilityAdmission.validRuns === repetitions &&
              report.distributions.intentToInteractiveMs.p95 <=
                bench045Thresholds.intentToInteractiveP95Ms &&
              report.phaseAttribution.phaseDistributions.attachmentResolutionMs.p95 <=
                bench045Thresholds.attachmentResolutionP95Ms &&
              report.protocolResidualAttribution.transportResidualMs.p95 >= 0 &&
              report.protocolResidualAttribution.transportResidualMs.p95 <=
                bench045Thresholds.transportResidualP95Ms &&
              report.transportDeliveryAttribution.responseEgressMs.p95 <=
                bench045Thresholds.responseEgressP95Ms &&
              report.transportDeliveryAttribution.tailIntervals >=
                bench045Thresholds.minimumTailIntervals &&
              report.transportDeliveryAttribution.dominantP95Fraction >=
                bench045Thresholds.dominantP95Fraction &&
              report.transportDeliveryAttribution.dominantTailIntervals >=
                bench045Thresholds.minimumDominantTailIntervals &&
              report.transportDeliveryAttribution.maximumReconstructionErrorMs <=
                bench045Thresholds.reconstructionToleranceMs
            : runBench044WireAttribution
              ? report.allSafe &&
                report.stabilityAdmission.validRuns === repetitions &&
                report.distributions.intentToInteractiveMs.p95 <=
                  bench044Thresholds.intentToInteractiveP95Ms &&
                report.phaseAttribution.phaseDistributions.attachmentResolutionMs.p95 <=
                  bench044Thresholds.attachmentResolutionP95Ms &&
                report.protocolResidualAttribution.transportResidualMs.p95 >= 0 &&
                report.protocolResidualAttribution.transportResidualMs.p95 <=
                  bench044Thresholds.transportResidualP95Ms &&
                report.wireAttribution.tailIntervals >= bench044Thresholds.minimumTailIntervals &&
                report.wireAttribution.dominantP95Fraction >=
                  bench044Thresholds.dominantP95Fraction &&
                report.wireAttribution.dominantTailIntervals >=
                  bench044Thresholds.minimumDominantTailIntervals &&
                report.wireAttribution.maximumReconstructionErrorMs <=
                  bench044Thresholds.reconstructionToleranceMs
              : runBench043ProtocolResidualAttribution
                ? report.allSafe &&
                  report.distributions.intentToInteractiveMs.p95 <=
                    bench043Thresholds.intentToInteractiveP95Ms &&
                  report.phaseAttribution.phaseDistributions.attachmentResolutionMs.p95 <=
                    bench043Thresholds.attachmentResolutionP95Ms &&
                  report.protocolResidualAttribution.transportResidualMs.p95 >= 0 &&
                  report.protocolResidualAttribution.transportResidualMs.p95 <=
                    bench043Thresholds.transportResidualP95Ms &&
                  report.protocolResidualAttribution.tailIntervals >=
                    bench043Thresholds.minimumTailIntervals &&
                  report.protocolResidualAttribution.dominantP95Fraction >=
                    bench043Thresholds.dominantP95Fraction &&
                  report.protocolResidualAttribution.dominantTailIntervals >=
                    bench043Thresholds.minimumDominantTailIntervals
                : runBench042ObserverPhaseAttribution
                  ? report.allSafe &&
                    report.distributions.intentToInteractiveMs.p95 <=
                      bench042Thresholds.intentToInteractiveP95Ms &&
                    report.phaseAttribution.phaseDistributions.attachmentResolutionMs.p95 <=
                      bench042Thresholds.attachmentResolutionP95Ms &&
                    report.observerPhaseAttribution.transportResidualMs.p95 >= 0 &&
                    report.observerPhaseAttribution.transportResidualMs.p95 <=
                      bench042Thresholds.transportResidualP95Ms &&
                    report.observerPhaseAttribution.tailIntervals >=
                      bench042Thresholds.minimumTailIntervals &&
                    report.observerPhaseAttribution.dominantP95Fraction >=
                      bench042Thresholds.dominantP95Fraction &&
                    report.observerPhaseAttribution.dominantTailIntervals >=
                      bench042Thresholds.minimumDominantTailIntervals
                  : runBench041PhaseAttribution
                    ? report.allSafe &&
                      report.distributions.intentToInteractiveMs.p95 <=
                        bench041Thresholds.intentToInteractiveP95Ms &&
                      report.phaseAttribution.phaseDistributions.attachmentResolutionMs.p95 <=
                        bench041Thresholds.attachmentResolutionP95Ms &&
                      report.phaseAttribution.tailIntervals >=
                        bench041Thresholds.minimumTailIntervals &&
                      report.phaseAttribution.dominantP95Fraction >=
                        bench041Thresholds.dominantP95Fraction &&
                      report.phaseAttribution.dominantTailIntervals >=
                        bench041Thresholds.minimumDominantTailIntervals
                    : runBench040ImmediateInput
                      ? report.allSafe &&
                        report.runs.every(
                          (run) =>
                            !run.dismissalInputSent &&
                            run.acknowledgementCount === 1 &&
                            run.overlayDismissedToInputSentMs <=
                              bench040Thresholds.dismissalToInputWriteMaxMs,
                        ) &&
                        report.runs.some(
                          (run) =>
                            !run.readyWasReplay &&
                            run.inputSentToHostReadyMs >= bench040Thresholds.minimumPreReadyWriteMs,
                        ) &&
                        report.distributions.intentToInteractiveMs.median <=
                          bench040Thresholds.intentToInteractiveMedianMs &&
                        report.distributions.intentToInteractiveMs.p95 <=
                          bench040Thresholds.intentToInteractiveP95Ms &&
                        improvement(
                          exp016CandidateIntentP95Ms,
                          report.distributions.intentToInteractiveMs.p95,
                        ) >= bench040Thresholds.minimumP95ImprovementFraction &&
                        report.distributions.focusToInputAckMs.p95 <=
                          bench040Thresholds.dismissalToInputAckP95Ms
                      : runExp016Control
                        ? report.allSafe && report.runs.every((run) => run.dismissalInputSent)
                        : runExp016Candidate
                          ? report.allSafe &&
                            report.runs.every((run) => !run.dismissalInputSent) &&
                            report.distributions.intentToInteractiveMs.median <=
                              exp016Thresholds.intentToInteractiveMedianMs &&
                            report.distributions.intentToInteractiveMs.p95 <=
                              exp016Thresholds.intentToInteractiveP95Ms &&
                            report.distributions.focusToInputAckMs.p95 <=
                              exp016Thresholds.overlayDismissedToInputAckP95Ms
                          : runSafetyAudit
                            ? report.safetyAuditPassed
                            : runFocusComparison
                              ? report.runs.length === repetitions &&
                                report.runs.every((run) => run.phaseCoherent) &&
                                report.focusComparison.escape.runs === 5 &&
                                report.focusComparison.toggle.runs === 5 &&
                                report.focusComparison.toggle.focusToInputAckMs.p95 <=
                                  focusThresholds.focusToInputAckP95Ms &&
                                report.focusComparison.focusToInputAckP95ImprovementFraction >=
                                  focusThresholds.focusToInputAckMinimumImprovementFraction &&
                                report.focusComparison.toggle.intentToInteractiveMs.median <=
                                  focusThresholds.intentToInteractiveMedianMs &&
                                report.focusComparison.toggle.intentToInteractiveMs.p95 <=
                                  focusThresholds.intentToInteractiveP95Ms
                              : report.runs.length === repetitions &&
                                report.distributions.launchToDashboardMs.median <=
                                  thresholds.launchToDashboardMedianMs &&
                                report.distributions.launchToDashboardMs.p95 <=
                                  thresholds.launchToDashboardP95Ms &&
                                report.distributions.intentToOptimisticMs.p95 <=
                                  thresholds.intentToOptimisticP95Ms &&
                                report.distributions.intentToInteractiveMs.median <=
                                  thresholds.intentToInteractiveMedianMs &&
                                report.distributions.intentToInteractiveMs.p95 <=
                                  thresholds.intentToInteractiveP95Ms &&
                                report.distributions.intentToCanonicalUiMs.p95 <=
                                  thresholds.intentToCanonicalUiP95Ms &&
                                report.distributions.launchToInteractiveMs.p95 <=
                                  thresholds.launchToInteractiveP95Ms;

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`[compiled native Quick Session benchmark] ${outputPath}\n`);

    expect(report.failure).toBeNull();
    if (runSafetyAudit) {
      expect(report.safetyAuditPassed).toBe(true);
    } else {
      expect(report.allSafe).toBe(true);
    }
    expect(report.thresholdsPassed).toBe(true);
  }, 7_200_000);
});

const standaloneTransportProbeSchema = z
  .object({
    serverSendEpochMs: z.number().positive(),
    socketCallbackEpochMs: z.number().positive(),
    validatedEpochMs: z.number().positive(),
  })
  .strict();
const idleTransportProbeCompletionSchema = z
  .object({
    status: z.enum(["complete", "failed"]),
    requestId: z.string().startsWith(IDLE_RESPONSE_DELIVERY_REQUEST_ID_PREFIX),
  })
  .strict();

async function startStandaloneTransportServer(
  fixture: Pick<BenchmarkFixture, "runtimeRoot" | "temporaryRoot">,
) {
  const socketPath = join(fixture.runtimeRoot, "standalone-transport.sock");
  const clientPath = join(fixture.temporaryRoot, "standalone-transport-client.mjs");
  await writeFile(
    clientPath,
    `import { createConnection } from "node:net";
const socketPath = process.argv[2];
if (socketPath === undefined || socketPath.length === 0) throw new Error("Missing socket path.");
const socket = createConnection(socketPath);
let buffer = "";
let socketCallbackEpochMs;
socket.setEncoding("utf8");
socket.once("connect", () => socket.write("ping\\n"));
socket.on("data", (chunk) => {
  socketCallbackEpochMs ??= performance.timeOrigin + performance.now();
  buffer += chunk;
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  const serverSendEpochMs = Number(buffer.slice(0, newline));
  if (!Number.isFinite(serverSendEpochMs) || socketCallbackEpochMs === undefined) {
    throw new Error("Invalid standalone transport response.");
  }
  const validatedEpochMs = performance.timeOrigin + performance.now();
  process.stdout.write(JSON.stringify({ serverSendEpochMs, socketCallbackEpochMs, validatedEpochMs }) + "\\n");
  socket.end();
});
socket.once("error", (error) => { throw error; });
`,
    "utf8",
  );
  let requests = 0;
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      if (buffer.slice(0, newline) !== "ping") {
        socket.destroy(new Error("Invalid standalone transport request."));
        return;
      }
      requests += 1;
      const serverSendEpochMs = performance.timeOrigin + performance.now();
      socket.end(`${serverSendEpochMs}\n`);
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  return {
    close: async () => {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
      });
      await rm(socketPath, { force: true });
      return { requests };
    },
  };
}

async function runStandaloneTransportControlWithAdmission(
  fixture: BenchmarkFixture,
  repetition: number,
  order: "before" | "after",
) {
  const stabilityAdmission = await awaitStabilityAdmission();
  if (!stabilityAdmission.passed) {
    throw new Error("BENCH-046 standalone stability admission timed out.");
  }
  return {
    ...(await runStandaloneTransportControl(fixture, repetition, order)),
    stabilityAdmission,
  };
}

async function runStandaloneTransportControl(
  fixture: Pick<BenchmarkFixture, "runtimeRoot" | "temporaryRoot">,
  repetition: number,
  order: "before" | "after",
) {
  const result = await execFileAsync(
    process.env.STATION_BUN ?? "bun",
    [
      join(fixture.temporaryRoot, "standalone-transport-client.mjs"),
      join(fixture.runtimeRoot, "standalone-transport.sock"),
    ],
    { timeout: 15_000 },
  );
  const trace = standaloneTransportProbeSchema.parse(JSON.parse(result.stdout));
  const serverSendToCallbackMs = trace.socketCallbackEpochMs - trace.serverSendEpochMs;
  const callbackToValidatedMs = trace.validatedEpochMs - trace.socketCallbackEpochMs;
  return {
    repetition,
    order,
    trace,
    serverSendToCallbackMs,
    callbackToValidatedMs,
    stderrEmpty: result.stderr.length === 0,
    safe: result.stderr.length === 0 && serverSendToCallbackMs >= 0 && callbackToValidatedMs >= 0,
  };
}

async function createBenchmarkFixture(temporaryRootInput: string) {
  const temporaryRoot = await realpath(temporaryRootInput);
  // Unix-domain sockets retain the short /tmp spelling while repository paths
  // stay canonical for exact Worktrunk/Git identity checks.
  const runtimeRoot = await mkdtemp(join("/tmp", "st-qtu-run-"));
  const repositoryRoot = join(temporaryRoot, "repo");
  const managedRoot = join(temporaryRoot, "worktrees");
  const stateDir = join(temporaryRoot, "state");
  const runDir = join(runtimeRoot, "run");
  const observerSocketPath = join(runDir, "observer.sock");
  const hostSocketPath = join(runDir, "station-host.sock");
  const configPath = join(temporaryRoot, "station.toml");
  const worktrunkConfigPath = join(temporaryRoot, "worktrunk.toml");
  const harnessPath = join(temporaryRoot, "benchmark-scripted.sh");
  await Promise.all([
    mkdir(repositoryRoot, { recursive: true }),
    mkdir(managedRoot, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(runDir, { recursive: true }),
    writeFile(worktrunkConfigPath, "", "utf8"),
  ]);
  await runCommand("git", ["init", "--initial-branch=main", "--quiet"], repositoryRoot);
  await runCommand("git", ["config", "user.name", "Station Benchmark"], repositoryRoot);
  await runCommand(
    "git",
    ["config", "user.email", "station-benchmark@example.invalid"],
    repositoryRoot,
  );
  await runCommand(
    "git",
    ["commit", "--allow-empty", "--message=baseline", "--quiet"],
    repositoryRoot,
  );
  for (let index = 0; index < ordinaryLinkedWorktrees; index += 1) {
    await runCommand(
      "git",
      [
        "worktree",
        "add",
        "--quiet",
        "-b",
        `shape-${index}`,
        join(managedRoot, `shape-${index}`),
        "main",
      ],
      repositoryRoot,
    );
  }
  await writeFile(
    harnessPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
      '  printf "Logged in\\n"',
      "  exit 0",
      "fi",
      `printf '${readyPrefix}%s\\n' "$STATION_SESSION_ID"`,
      "while IFS= read -r line; do",
      `  printf '${acknowledgementPrefix}%s:%s\\n' "$STATION_SESSION_ID" "$line"`,
      "done",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(harnessPath, 0o755);
  await writeFile(
    configPath,
    [
      "schema_version = 1",
      "",
      "[observer]",
      `socket_path = ${JSON.stringify(observerSocketPath)}`,
      `state_dir = ${JSON.stringify(stateDir)}`,
      "auto_start_from_hooks = false",
      "",
      "[defaults]",
      'worktree_provider = "worktrunk"',
      'terminal = "tmux"',
      'harness = "scripted"',
      'layout = "agent-shell"',
      'default_branch = "main"',
      "",
      "[worktree.worktrunk]",
      `command = ${JSON.stringify(worktrunkCommand)}`,
      `config_path = ${JSON.stringify(worktrunkConfigPath)}`,
      "use_lifecycle_hooks = false",
      'hook_mode = "disabled"',
      "",
      "[terminal.tmux]",
      `command = ${JSON.stringify(tmuxCommand)}`,
      `workbench_session = ${JSON.stringify(`st-qtu-workbench-${process.pid}`)}`,
      "",
      "[harness.scripted]",
      "enabled = true",
      `command = ${JSON.stringify(harnessPath)}`,
      "",
      "[feature_flags]",
      "station_persistent_agents = true",
      "",
      "[[projects]]",
      `id = ${JSON.stringify(projectId)}`,
      `label = ${JSON.stringify(projectLabel)}`,
      `root = ${JSON.stringify(repositoryRoot)}`,
      'default_branch = "main"',
      "",
      "[projects.defaults]",
      'harness = "scripted"',
      'terminal = "tmux"',
      'layout = "agent-shell"',
      "",
      "[projects.worktrunk]",
      "enabled = true",
      'base = "main"',
      `managed_root = ${JSON.stringify(managedRoot)}`,
      "include_main = true",
      "include_external = true",
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    temporaryRoot,
    runtimeRoot,
    repositoryRoot,
    managedRoot,
    stateDir,
    observerSocketPath,
    hostSocketPath,
    configPath,
  };
}

function createHostRuntime(fixture: BenchmarkFixture, expectedBuildVersion: string) {
  const client = createStationHostClient({
    socketPath: fixture.hostSocketPath,
    expectedBuildVersion,
    timeoutMs: 5_000,
  });
  let childProcess: ChildProcess | undefined;
  let stderr = "";
  const controller = createStationHostController(
    {
      socketPath: fixture.hostSocketPath,
      stateDir: fixture.stateDir,
      hostCommand: [binaryPath, "__station-host"],
      expectedBuildVersion,
      timeoutMs: 7_000,
    },
    {
      clientFactory: () => client,
      spawnHost: (input: SpawnStationHostInput) => {
        childProcess = spawn(input.argv[0], input.argv.slice(1), {
          stdio: ["ignore", "ignore", "pipe"],
          env: { ...process.env, STATION_PTY_IMPL: "bun" },
        });
        childProcess.stderr?.on("data", (data: Buffer) => {
          if (stderr.length < 64 * 1024) stderr += data.toString("utf8");
        });
        return childProcess;
      },
    },
  );
  return {
    controller,
    client,
    child: () => childProcess,
    stderr: () => stderr,
    expectedBuildVersion,
  };
}

async function seedHost(runtime: ReturnType<typeof createHostRuntime>, fixture: BenchmarkFixture) {
  const startedAt = performance.now();
  const handle = await runtime.controller.ensure();
  if (handle.status !== "running") throw unavailableHostError(handle);
  const health = await handle.client.health();
  const identity = {
    kind: "agent" as const,
    terminalTargetId: "station:compiled-tui-seed",
    worktreeId: "wt-compiled-tui-seed",
    projectId,
    sessionId: "session-compiled-tui-seed",
    worktreePath: fixture.repositoryRoot,
    harnessProvider: "scripted",
  };
  const readyMarker = "__STATION_COMPILED_TUI_SEED_READY__";
  const acknowledgement = "__STATION_COMPILED_TUI_SEED_ACK__";
  const spawned = await handle.client.spawn({
    ...identity,
    command: "/bin/sh",
    args: [
      "-c",
      'printf "%s\\n" "$1"; IFS= read -r line || exit 31; printf "%s:%s\\n" "$2" "$line"; while :; do sleep 60; done',
      "station-compiled-tui-seed",
      readyMarker,
      acknowledgement,
    ],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color", LC_ALL: "C" },
    cwd: fixture.repositoryRoot,
    cols: 80,
    rows: 24,
  });
  const attachment = await handle.client.attach({ ...identity, ...spawned }, "controller");
  const iterator = attachment.frames[Symbol.asyncIterator]();
  let output = replayData(attachment);
  output = await readUntilMarker(iterator, output, readyMarker, 5_000);
  await attachment.write("seed-input\n");
  output = await readUntilMarker(iterator, output, `${acknowledgement}:seed-input`, 5_000);
  await iterator.return?.();
  await attachment.detach();
  const closed = await handle.client.close(spawned.ptyId);
  const empty = (await handle.client.list()).length === 0;
  return {
    durationMs: performance.now() - startedAt,
    safe:
      health.ok &&
      health.protocolVersion === HOST_PROTOCOL_VERSION &&
      health.buildVersion === runtime.expectedBuildVersion &&
      output.includes(readyMarker) &&
      output.includes(`${acknowledgement}:seed-input`) &&
      closed.closed &&
      empty,
  };
}

async function runRepetition(input: {
  fixture: BenchmarkFixture;
  hostRuntime: ReturnType<typeof createHostRuntime>;
  repetition: number;
  expectedObserverBuildVersion: string;
  stabilityAdmission: StabilityAdmission | null;
  recordStabilityAdmission: (admission: StabilityAdmission) => void;
}) {
  const {
    fixture,
    hostRuntime,
    repetition,
    expectedObserverBuildVersion,
    stabilityAdmission,
    recordStabilityAdmission,
  } = input;
  const focusStrategy: FocusStrategy =
    runExp016Candidate || runImmediateAutomaticInput
      ? "automatic"
      : runExp016Control || runSafetyAudit || (runFocusComparison && repetition % 2 === 1)
        ? "toggle"
        : "escape";
  const sessionName = `st-qtu-${process.pid}-${repetition}`;
  const inputToken = `compiled-tui-input-${repetition}`;
  const uiStderrPath = join(fixture.temporaryRoot, `ui-${repetition}.stderr`);
  const observerPhaseTracePath = join(
    fixture.temporaryRoot,
    `observer-external-launch-phases-${repetition}.json`,
  );
  const clientProtocolTracePath = join(
    fixture.temporaryRoot,
    `client-prepare-external-launch-protocol-phases-${repetition}.json`,
  );
  const serverProtocolTracePath = join(
    fixture.temporaryRoot,
    `server-prepare-external-launch-protocol-phases-${repetition}.json`,
  );
  const idleTransportProbeCompletionPath = join(
    fixture.temporaryRoot,
    `native-idle-transport-probe-${repetition}.json`,
  );
  const env: RealE2eEnvironment = {
    repoRoot,
    stationBin: binaryPath,
    stationIngressBin: binaryPath,
    worktrunkBin: worktrunkCommand,
    tmuxBin: tmuxCommand,
  };
  const usageBefore = process.resourceUsage();
  const loadBefore = loadavg();
  const launchStartedAt = performance.now();
  let dashboardReadyAt: number | undefined;
  let intentAt: number | undefined;
  let optimisticAt: number | undefined;
  let commandAcceptedAt: number | undefined;
  let commandCompletedAt: number | undefined;
  let hostReadyAt: number | undefined;
  let canonicalUiAt: number | undefined;
  let focusAt: number | undefined;
  let overlayDismissedAt: number | undefined;
  let inputSentAt: number | undefined;
  let inputAcknowledgedAt: number | undefined;
  let commandId: string | undefined;
  let traceId: string | undefined;
  let branch: string | undefined;
  let worktree: WorktreeRow | undefined;
  let sessionId: string | undefined;
  let hostEntry: HostListEntry | undefined;
  let uiPid = -1;
  let nativeRendererPid = -1;
  let observerPid = -1;
  let observerStoppedCleanly = false;
  let uiStoppedCleanly = false;
  let cleanupInventoryCount = -1;
  let gitCleanupInventoryCount = -1;
  let uiStderr = "";
  let uiStderrBeforeExit = "";
  let automaticOverlayDismissed: Promise<number> | undefined;
  let immediateInput: Promise<{ overlayDismissedAt: number; inputSentAt: number }> | undefined;
  let readyWasReplay = false;
  let acknowledgementCount = 0;
  let dismissalInputSent = false;
  let idleTransportProbeAbsentBeforeSignal = false;
  let idleTransportProbeCompletion: z.infer<typeof idleTransportProbeCompletionSchema> | undefined;
  let idleStabilityAdmission: StabilityAdmission | null = null;
  let activeStabilityAdmission: StabilityAdmission | null = null;
  let subscription: AsyncIterator<StationEvent> | undefined;
  let ptyClient: AttachedTmuxPtyClient | undefined;
  let viewer: HostAttachment | undefined;
  try {
    const initialHostHealth = await hostRuntime.client.health();
    const initialHostInventory = await hostRuntime.client.list();
    if (
      !initialHostHealth.ok ||
      initialHostHealth.buildVersion !== hostRuntime.expectedBuildVersion ||
      initialHostInventory.length !== 0
    ) {
      throw new Error("Compiled TUI run did not begin with the exact warm empty Host.");
    }
    const launched = await launchNativeStation({
      env,
      fixture,
      sessionName,
      stderrPath: uiStderrPath,
      observerPhaseTracePath,
      clientProtocolTracePath,
      serverProtocolTracePath,
      idleTransportProbeCompletionPath,
    });
    uiPid = launched.panePid;
    ptyClient = await startAttachedTmuxPtyClient({
      env,
      sessionName,
      dimensions,
    });
    const entryFrame = await waitForFrame(
      env,
      launched.target,
      (frame) => frame.includes(projectLabel) || frame.includes("Open project view"),
      30_000,
      "Compiled native Station did not expose its entry surface.",
    );
    if (entryFrame.includes("Open project view")) {
      await writeSgrClick(ptyClient, cellForText(entryFrame, "Open project view"));
    }
    const dashboardFrame = await waitForFrame(
      env,
      launched.target,
      (frame) => frame.includes(projectLabel) && frame.includes("[quick session]"),
      30_000,
      "Compiled native dashboard did not become ready.",
    );
    dashboardReadyAt = performance.now();
    if (runBench047NativeTuiIdleExperiment) {
      nativeRendererPid = await resolveNativeRendererPid(uiPid);
    }
    const observerProbe = createObserverClient({
      socketPath: fixture.observerSocketPath,
      timeoutMs: 7_000,
    });
    const health = await observerProbe.health();
    observerPid = health.pid ?? -1;
    const observer = createObserverClient({
      socketPath: fixture.observerSocketPath,
      expectedBuildVersion: expectedObserverBuildVersion,
      timeoutMs: 15_000,
      requestId: requestIdFactory(repetition),
    });
    const initialSnapshot = await observer.getSnapshot({ includeDebug: true });
    if (
      health.status !== "healthy" ||
      health.version !== expectedObserverBuildVersion ||
      initialSnapshot.counts.worktrees !== initialInventoryCount
    ) {
      throw new Error(
        `Compiled TUI Observer did not expose the exact startup snapshot: ${JSON.stringify({
          status: health.status,
          version: health.version,
          expectedObserverBuildVersion,
          lastReconcileReason: health.lastReconcile?.reason,
          worktrees: initialSnapshot.counts.worktrees,
          expectedWorktrees: initialInventoryCount,
        })}`,
      );
    }
    subscription = observer
      .subscribe({
        type: ["command.accepted", "command.started", "command.succeeded", "command.failed"],
      })
      [Symbol.asyncIterator]();
    await delay(100);
    if (runBench047NativeTuiIdleExperiment) {
      idleTransportProbeAbsentBeforeSignal = !(await pathExists(idleTransportProbeCompletionPath));
      if (!idleTransportProbeAbsentBeforeSignal) {
        throw new Error("Native idle transport probe completion existed before its signal.");
      }
      idleStabilityAdmission = await awaitStabilityAdmission();
      recordStabilityAdmission(idleStabilityAdmission);
      if (!idleStabilityAdmission.passed) {
        throw new Error("BENCH-047 idle stability admission timed out.");
      }
      process.kill(nativeRendererPid, "SIGUSR2");
      idleTransportProbeCompletion = await waitForIdleTransportProbeCompletion(
        idleTransportProbeCompletionPath,
        `${IDLE_RESPONSE_DELIVERY_REQUEST_ID_PREFIX}${nativeRendererPid}`,
        10_000,
      );
      activeStabilityAdmission = await awaitStabilityAdmission();
      recordStabilityAdmission(activeStabilityAdmission);
      if (!activeStabilityAdmission.passed) {
        throw new Error("BENCH-047 active stability admission timed out.");
      }
    }
    const acceptedPromise = waitForEvent(
      subscription,
      (event) => event.type === "command.accepted" && event.command.type === "worktree.create",
      10_000,
      "Native Quick Session did not emit a worktree.create acceptance.",
    );
    const optimisticPromise = waitForOutput(ptyClient, "starting session...", 2_000).then(() =>
      performance.now(),
    );
    const quickCell = cellForText(dashboardFrame, "[quick session]");
    intentAt = performance.now();
    await writeSgrClick(ptyClient, quickCell);
    if (focusStrategy === "automatic") {
      automaticOverlayDismissed = waitForFrame(
        env,
        launched.target,
        (frame) => !frame.includes("[quick session]") && !frame.includes("[shell]"),
        10_000,
        "Native Quick Session did not dismiss its overlay after a successful landing.",
      ).then(() => performance.now());
      if (runImmediateAutomaticInput) {
        const inputClient = ptyClient;
        if (inputClient === undefined) {
          throw new Error("Immediate-input diagnostic lost its attached native input client.");
        }
        immediateInput = automaticOverlayDismissed.then(async (dismissedAt) => {
          const sentAt = performance.now();
          await inputClient.write(Buffer.from(`${inputToken}\r`, "utf8"));
          return { overlayDismissedAt: dismissedAt, inputSentAt: sentAt };
        });
      }
    }
    const accepted = await acceptedPromise;
    commandAcceptedAt = performance.now();
    commandId = accepted.commandId;
    traceId = accepted.traceId;
    branch = accepted.command.payload.branch;
    optimisticAt = await optimisticPromise;
    const completed = await waitForEvent(
      subscription,
      (event) =>
        (event.type === "command.succeeded" || event.type === "command.failed") &&
        event.commandId === commandId,
      30_000,
      "Native Quick Session command did not settle.",
    );
    commandCompletedAt = performance.now();
    if (completed.type !== "command.succeeded") {
      throw new Error(`Native Quick Session command failed: ${completed.error.code}`);
    }
    const command = await observer.waitForCommand(accepted.commandId, { timeoutMs: 30_000 });
    if (command.status !== "succeeded" || command.traceId !== traceId) {
      throw new Error("Native Quick Session command record lost its successful trace identity.");
    }
    const canonical = await waitForSnapshot(
      observer,
      (snapshot) => {
        const row = snapshot.rows.find(
          (candidate) => candidate.projectId === projectId && candidate.branch === branch,
        );
        const session = snapshot.sessions.find((candidate) => candidate.worktreeId === row?.id);
        return row !== undefined && session !== undefined ? { snapshot, row, session } : undefined;
      },
      30_000,
      "Native Quick Session did not reach canonical session projection.",
    );
    worktree = canonical.row;
    sessionId = canonical.session.id;
    hostEntry = await waitForHostEntry(
      hostRuntime.client,
      (entry) =>
        entry.alive &&
        entry.kind === "agent" &&
        entry.projectId === projectId &&
        entry.worktreeId === worktree?.id &&
        entry.sessionId === sessionId,
      15_000,
    );
    viewer = await hostRuntime.client.attach(hostEntry, "viewer");
    const viewerIterator = viewer.frames[Symbol.asyncIterator]();
    let output = replayData(viewer);
    if (runImmediateAutomaticInput) {
      if (immediateInput === undefined) {
        throw new Error("Immediate-input diagnostic did not arm its input write.");
      }
      const markersPromise = readUntilReadyAndAcknowledgement(
        viewerIterator,
        output,
        `${readyPrefix}${sessionId}`,
        `${acknowledgementPrefix}${sessionId}:${inputToken}`,
        10_000,
      );
      const [immediate, markers] = await Promise.all([immediateInput, markersPromise]);
      overlayDismissedAt = immediate.overlayDismissedAt;
      focusAt = overlayDismissedAt;
      inputSentAt = immediate.inputSentAt;
      output = markers.output;
      hostReadyAt = markers.readyAt;
      inputAcknowledgedAt = markers.acknowledgedAt;
      readyWasReplay = markers.readyWasReplay;
      acknowledgementCount = countOccurrences(
        output,
        `${acknowledgementPrefix}${sessionId}:${inputToken}`,
      );
    } else {
      output = await readUntilMarker(viewerIterator, output, `${readyPrefix}${sessionId}`, 10_000);
      hostReadyAt = performance.now();
      if (focusStrategy === "automatic") {
        if (automaticOverlayDismissed === undefined) {
          throw new Error("Automatic overlay observation was not armed at Quick Session intent.");
        }
        overlayDismissedAt = await automaticOverlayDismissed;
        focusAt = overlayDismissedAt;
      } else {
        await waitForFrame(
          env,
          launched.target,
          (frame) => frame.includes(branch ?? "") && !frame.includes("starting session..."),
          10_000,
          "Native dashboard did not replace its optimistic row with the canonical session.",
        );
        canonicalUiAt = performance.now();
        focusAt = performance.now();
        dismissalInputSent = true;
        await ptyClient.write(Buffer.from(focusStrategy === "toggle" ? "\x0f" : "\x1b", "binary"));
        await waitForFrame(
          env,
          launched.target,
          (frame) => !frame.includes("[quick session]") && !frame.includes("[shell]"),
          10_000,
          "Native Quick Session row activation did not focus its pane.",
        );
        overlayDismissedAt = performance.now();
      }
      inputSentAt = performance.now();
      await ptyClient.write(Buffer.from(`${inputToken}\r`, "utf8"));
      output = await readUntilMarker(
        viewerIterator,
        output,
        `${acknowledgementPrefix}${sessionId}:${inputToken}`,
        10_000,
      );
      inputAcknowledgedAt = performance.now();
      acknowledgementCount = countOccurrences(
        output,
        `${acknowledgementPrefix}${sessionId}:${inputToken}`,
      );
    }
    if (focusStrategy === "automatic") {
      await ptyClient.write(Buffer.from("\x0f", "binary"));
      await waitForFrame(
        env,
        launched.target,
        (frame) => frame.includes(branch ?? "") && !frame.includes("starting session..."),
        10_000,
        "Reopened native dashboard did not expose the canonical Quick Session.",
      );
      canonicalUiAt = performance.now();
    }
    if (runImmediateAutomaticInput) {
      await delay(25);
      const auditViewer = await hostRuntime.client.attach(hostEntry, "viewer");
      try {
        acknowledgementCount = countOccurrences(
          replayData(auditViewer),
          `${acknowledgementPrefix}${sessionId}:${inputToken}`,
        );
      } finally {
        await auditViewer.detach();
      }
    }
    await viewerIterator.return?.();
    await viewer.detach();
    viewer = undefined;

    const removalReceipt = await observer.dispatch(buildRemoveWorktreeCommand(worktree, true));
    const removal = await observer.waitForCommand(removalReceipt.commandId, { timeoutMs: 30_000 });
    if (removal.status !== "succeeded") {
      throw new Error(
        `Native Quick Session cleanup failed: ${removal.error?.code ?? removal.status}`,
      );
    }
    await waitForSnapshot(
      observer,
      (snapshot) =>
        snapshot.counts.worktrees === initialInventoryCount &&
        !snapshot.rows.some((row) => row.branch === branch)
          ? snapshot
          : undefined,
      30_000,
      "Observer did not converge to the exact post-removal inventory.",
    );
    cleanupInventoryCount = (await hostRuntime.client.list()).length;
    gitCleanupInventoryCount = await gitWorktreeCount(fixture.repositoryRoot);
    uiStderrBeforeExit = await readFile(uiStderrPath, "utf8").catch(() => "");
    const clientProtocolTraceAbsentBeforeUiExit = !(await pathExists(clientProtocolTracePath));
    await ptyClient.write(Buffer.from("\x11", "binary"));
    uiStoppedCleanly = await waitForTmuxExit(env, sessionName, 10_000);
    const observerPhaseTraceAbsentBeforeStop = !(await pathExists(observerPhaseTracePath));
    const serverProtocolTraceAbsentBeforeObserverStop =
      !(await pathExists(serverProtocolTracePath));
    await observer.stop();
    observerStoppedCleanly = await waitForPidExit(observerPid, 10_000);
    uiStderr = await readFile(uiStderrPath, "utf8").catch(() => "");
    const managedLaunchPhaseAnalysis = analyzeManagedLaunchPhaseTrace(
      runManagedLaunchPhaseDiagnostic ? parseManagedLaunchPhaseTrace(uiStderr) : undefined,
    );
    const observerExternalLaunchPhaseAnalysis = analyzeObserverExternalLaunchPhaseTrace(
      runObserverPhaseDiagnostic
        ? await parseObserverExternalLaunchPhaseTrace(observerPhaseTracePath)
        : undefined,
    );
    const clientProtocolPhaseAnalysis = analyzePrepareExternalLaunchClientProtocolTrace(
      runProtocolPhaseAttribution
        ? await parseDiagnosticTrace(
            clientProtocolTracePath,
            prepareExternalLaunchClientProtocolTraceSchema,
          )
        : undefined,
    );
    const serverProtocolPhaseAnalysis = analyzePrepareExternalLaunchServerProtocolTrace(
      runProtocolPhaseAttribution
        ? await parseDiagnosticTrace(
            serverProtocolTracePath,
            prepareExternalLaunchServerProtocolTraceSchema,
          )
        : undefined,
    );
    const protocolResidualAnalysis = analyzeProtocolResidual({
      managedLaunch: managedLaunchPhaseAnalysis,
      observerExternalLaunch: observerExternalLaunchPhaseAnalysis,
      clientProtocol: clientProtocolPhaseAnalysis,
      serverProtocol: serverProtocolPhaseAnalysis,
    });
    const wireAttributionAnalysis = analyzeWireAttribution({
      clientProtocol: clientProtocolPhaseAnalysis,
      serverProtocol: serverProtocolPhaseAnalysis,
    });
    const transportDeliveryAnalysis = analyzeTransportDelivery({
      clientProtocol: clientProtocolPhaseAnalysis,
      serverProtocol: serverProtocolPhaseAnalysis,
    });
    const idleTransportDeliveryAnalysis = analyzeIdleTransportDelivery({
      clientProtocol: clientProtocolPhaseAnalysis,
      serverProtocol: serverProtocolPhaseAnalysis,
    });
    const safetyPredicates = {
      dashboardProjectVisible: dashboardFrame.includes(projectLabel),
      commandProjectMatches: accepted.command.payload.projectId === projectId,
      commandHarnessMatches: accepted.command.payload.launchHarness === "scripted",
      worktreeProjectMatches: worktree.projectId === projectId,
      worktreeBranchMatches: worktree.branch === branch,
      worktreeUsesManagedRoot: worktree.path.startsWith(`${fixture.managedRoot}/`),
      worktreeHasRegistrationIdentity: worktree.registrationIdentity !== undefined,
      sessionHarnessMatches: canonical.session.harness.provider === "scripted",
      sessionTerminalMatches: canonical.session.terminal?.provider === STATION_HOST_PROVIDER_ID,
      hostWorktreeMatches: hostEntry.worktreePath === worktree.path,
      hostHarnessMatches: hostEntry.harnessProvider === "scripted",
      hostSessionMatches: hostEntry.sessionId === sessionId,
      readyMarkerObserved: output.includes(`${readyPrefix}${sessionId}`),
      inputAcknowledged: output.includes(`${acknowledgementPrefix}${sessionId}:${inputToken}`),
      inputAcknowledgedExactlyOnce: acknowledgementCount === 1,
      hostInventoryEmpty: cleanupInventoryCount === 0,
      gitInventoryRestored: gitCleanupInventoryCount === initialInventoryCount,
      uiStoppedCleanly,
      observerStoppedCleanly,
      managedLaunchPhaseTraceValid:
        !runManagedLaunchPhaseDiagnostic || managedLaunchPhaseAnalysis.valid,
      managedLaunchPhaseTraceExitOnly:
        !runManagedLaunchPhaseDiagnostic ||
        !uiStderrBeforeExit.includes(managedLaunchPhaseDiagnosticPrefix),
      observerExternalLaunchPhaseTraceValid:
        !runObserverPhaseDiagnostic || observerExternalLaunchPhaseAnalysis.valid,
      observerExternalLaunchPhaseTraceExitOnly:
        !runObserverPhaseDiagnostic || observerPhaseTraceAbsentBeforeStop,
      clientProtocolPhaseTraceValid:
        !runProtocolPhaseAttribution || clientProtocolPhaseAnalysis.valid,
      clientProtocolPhaseTraceExitOnly:
        !runProtocolPhaseAttribution || clientProtocolTraceAbsentBeforeUiExit,
      serverProtocolPhaseTraceValid:
        !runProtocolPhaseAttribution || serverProtocolPhaseAnalysis.valid,
      serverProtocolPhaseTraceExitOnly:
        !runProtocolPhaseAttribution || serverProtocolTraceAbsentBeforeObserverStop,
      protocolResidualPhaseTraceValid:
        !runProtocolPhaseAttribution || protocolResidualAnalysis.valid,
      wireAttributionTraceValid:
        (!runBench044WireAttribution &&
          !runBench045TransportDeliveryAttribution &&
          !runBench046StandaloneTransportControl &&
          !runBench047NativeTuiIdleExperiment) ||
        wireAttributionAnalysis.valid,
      transportDeliveryTraceValid:
        (!runBench045TransportDeliveryAttribution &&
          !runBench046StandaloneTransportControl &&
          !runBench047NativeTuiIdleExperiment) ||
        transportDeliveryAnalysis.valid,
      idleTransportDeliveryTraceValid:
        !runBench047NativeTuiIdleExperiment || idleTransportDeliveryAnalysis.valid,
      idleTransportProbeAbsentBeforeSignal:
        !runBench047NativeTuiIdleExperiment || idleTransportProbeAbsentBeforeSignal,
      idleTransportProbeCompletionExact:
        !runBench047NativeTuiIdleExperiment ||
        (idleTransportProbeCompletion?.status === "complete" &&
          idleTransportProbeCompletion.requestId ===
            `${IDLE_RESPONSE_DELIVERY_REQUEST_ID_PREFIX}${nativeRendererPid}`),
      nativeRendererProcessExact:
        !runBench047NativeTuiIdleExperiment ||
        (nativeRendererPid > 0 && nativeRendererPid !== uiPid),
      stabilityAdmissionPassed: runBench047NativeTuiIdleExperiment
        ? idleStabilityAdmission?.passed === true && activeStabilityAdmission?.passed === true
        : (!runBench044WireAttribution &&
            !runBench045TransportDeliveryAttribution &&
            !runBench046StandaloneTransportControl) ||
          stabilityAdmission?.passed === true,
      uiStderrMatches: runManagedLaunchPhaseDiagnostic
        ? managedLaunchUiStderrMatches(uiStderr)
        : runFocusComparison ||
            runSafetyAudit ||
            runExp016Control ||
            runExp016Candidate ||
            runBench040ImmediateInput
          ? uiStderr === expectedUiProgress || uiStderr === expectedObserverAndUiProgress
          : uiStderr.length === 0,
    };
    const boundarySafe = Object.values(safetyPredicates).every(Boolean);
    const focusToInputAckMs = inputAcknowledgedAt - focusAt;
    const phaseSumMs =
      overlayDismissedAt -
      focusAt +
      (inputSentAt - overlayDismissedAt) +
      (inputAcknowledgedAt - inputSentAt);
    const phaseCoherent =
      overlayDismissedAt >= focusAt &&
      inputSentAt >= overlayDismissedAt &&
      inputAcknowledgedAt >= inputSentAt &&
      Math.abs(focusToInputAckMs - phaseSumMs) <= 10;
    const safe = boundarySafe && phaseCoherent;
    return {
      repetition,
      stabilityAdmission,
      idleStabilityAdmission,
      activeStabilityAdmission,
      focusStrategy,
      dismissalInputSent,
      readyWasReplay,
      acknowledgementCount,
      safe,
      safetyPredicates,
      phaseCoherent,
      commandId,
      traceId,
      branch,
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      sessionId,
      terminalTargetId: hostEntry.terminalTargetId,
      ptyId: hostEntry.ptyId,
      ptyInstanceId: hostEntry.ptyInstanceId,
      observerPid,
      sampledReconcileReason: health.lastReconcile?.reason ?? null,
      uiPid,
      nativeRendererPid,
      launchToDashboardMs: dashboardReadyAt - launchStartedAt,
      intentToOptimisticMs: optimisticAt - intentAt,
      intentToCommandAcceptedMs: commandAcceptedAt - intentAt,
      intentToCommandCompletedMs: commandCompletedAt - intentAt,
      intentToHostReadyMs: hostReadyAt - intentAt,
      intentToCanonicalUiMs: canonicalUiAt - intentAt,
      intentToFocusMs: focusAt - intentAt,
      focusToOverlayDismissedMs: overlayDismissedAt - focusAt,
      overlayDismissedToInputSentMs: inputSentAt - overlayDismissedAt,
      inputSentToHostReadyMs: hostReadyAt - inputSentAt,
      inputSentToAckMs: inputAcknowledgedAt - inputSentAt,
      focusToInputAckMs,
      phaseSumMs,
      intentToInteractiveMs: inputAcknowledgedAt - intentAt,
      launchToInteractiveMs: inputAcknowledgedAt - launchStartedAt,
      cleanupInventoryCount,
      gitCleanupInventoryCount,
      uiStoppedCleanly,
      observerStoppedCleanly,
      uiStderrEmpty: uiStderr.length === 0,
      uiStderr,
      uiStderrBeforeExit,
      managedLaunchPhaseTrace: managedLaunchPhaseAnalysis.trace,
      managedLaunchPhaseDurations: managedLaunchPhaseAnalysis.phaseDurations,
      commandCompletionToOverlayCloseMs:
        managedLaunchPhaseAnalysis.commandCompletionToOverlayCloseMs,
      managedLaunchPhaseSumMs: managedLaunchPhaseAnalysis.phaseSumMs,
      managedLaunchPhaseCoherent: managedLaunchPhaseAnalysis.coherent,
      observerExternalLaunchPhaseTrace: observerExternalLaunchPhaseAnalysis.trace,
      observerExternalLaunchPhaseDurations: observerExternalLaunchPhaseAnalysis.phaseDurations,
      observerExternalLaunchInternalMs:
        observerExternalLaunchPhaseAnalysis.prepareEntryToCompletionMs,
      observerExternalLaunchPhaseSumMs: observerExternalLaunchPhaseAnalysis.phaseSumMs,
      observerExternalLaunchPhaseCoherent: observerExternalLaunchPhaseAnalysis.coherent,
      clientRpcMinusObserverInternalMs:
        managedLaunchPhaseAnalysis.phaseDurations === null ||
        observerExternalLaunchPhaseAnalysis.prepareEntryToCompletionMs === null
          ? null
          : managedLaunchPhaseAnalysis.phaseDurations.prepareExternalLaunchMs -
            observerExternalLaunchPhaseAnalysis.prepareEntryToCompletionMs,
      clientProtocolPhaseTrace: clientProtocolPhaseAnalysis.trace,
      clientProtocolPhaseDurations: clientProtocolPhaseAnalysis.phaseDurations,
      clientProtocolTotalMs: clientProtocolPhaseAnalysis.totalMs,
      clientProtocolPhaseSumMs: clientProtocolPhaseAnalysis.phaseSumMs,
      clientProtocolPhaseCoherent: clientProtocolPhaseAnalysis.coherent,
      serverProtocolPhaseTrace: serverProtocolPhaseAnalysis.trace,
      serverProtocolPhaseDurations: serverProtocolPhaseAnalysis.phaseDurations,
      serverProtocolTotalMs: serverProtocolPhaseAnalysis.totalMs,
      serverProtocolPhaseSumMs: serverProtocolPhaseAnalysis.phaseSumMs,
      serverProtocolPhaseCoherent: serverProtocolPhaseAnalysis.coherent,
      protocolResidualPhaseDurations: protocolResidualAnalysis.phaseDurations,
      protocolResidualPhaseSumMs: protocolResidualAnalysis.phaseSumMs,
      protocolResidualReconstructionErrorMs: protocolResidualAnalysis.reconstructionErrorMs,
      protocolResidualPhaseCoherent: protocolResidualAnalysis.coherent,
      wireAttributionPhaseDurations: wireAttributionAnalysis.phaseDurations,
      wireAttributionPhaseSumMs: wireAttributionAnalysis.phaseSumMs,
      wireAttributionHealthPhaseSumMs: wireAttributionAnalysis.healthPhaseSumMs,
      wireAttributionHealthReconstructionErrorMs:
        wireAttributionAnalysis.healthReconstructionErrorMs,
      wireAttributionActualRequestReconstructionErrorMs:
        wireAttributionAnalysis.actualRequestReconstructionErrorMs,
      wireAttributionWireClientReconstructionErrorMs:
        wireAttributionAnalysis.wireClientReconstructionErrorMs,
      wireAttributionCrossProcessOrderValid: wireAttributionAnalysis.crossProcessOrderValid,
      transportDeliveryPhaseDurations: transportDeliveryAnalysis.phaseDurations,
      transportDeliveryPhaseSumMs: transportDeliveryAnalysis.phaseSumMs,
      transportDeliveryReconstructionErrorMs: transportDeliveryAnalysis.reconstructionErrorMs,
      transportDeliveryCrossProcessOrderValid: transportDeliveryAnalysis.crossProcessOrderValid,
      idleTransportDeliveryPhaseDurations: idleTransportDeliveryAnalysis.phaseDurations,
      idleTransportDeliveryPhaseSumMs: idleTransportDeliveryAnalysis.phaseSumMs,
      idleTransportDeliveryResponseEgressMs: idleTransportDeliveryAnalysis.responseEgressMs,
      idleTransportDeliveryCallbackToValidatedMs:
        idleTransportDeliveryAnalysis.callbackToValidatedMs,
      idleTransportDeliveryReconstructionErrorMs:
        idleTransportDeliveryAnalysis.reconstructionErrorMs,
      idleTransportDeliveryCrossProcessOrderValid:
        idleTransportDeliveryAnalysis.crossProcessOrderValid,
      loadAverage: { before: loadBefore, after: loadavg() },
      resourceUsage: resourceDelta(usageBefore, process.resourceUsage()),
    };
  } finally {
    await subscription?.return?.().catch(() => undefined);
    await viewer?.detach().catch(() => undefined);
    await ptyClient?.close().catch(() => undefined);
    await killTmuxSession(env, sessionName).catch(() => undefined);
    if (!observerStoppedCleanly) {
      const cleanupClient = createObserverClient({
        socketPath: fixture.observerSocketPath,
        timeoutMs: 3_000,
      });
      await cleanupClient.stop().catch(() => undefined);
    }
  }
}

type ManagedLaunchPhaseTrace = z.infer<typeof managedLaunchPhaseTraceSchema>;
type ManagedLaunchPhaseDurations = Record<
  (typeof managedLaunchPhaseSegments)[number]["key"],
  number
>;

function parseManagedLaunchPhaseTrace(stderr: string): ManagedLaunchPhaseTrace | undefined {
  const lines = stderr
    .split("\n")
    .filter((line) => line.startsWith(managedLaunchPhaseDiagnosticPrefix));
  if (lines.length !== 1 || lines[0] === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(lines[0].slice(managedLaunchPhaseDiagnosticPrefix.length));
    const result = managedLaunchPhaseTraceSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function managedLaunchUiStderrMatches(stderr: string): boolean {
  const lines = stderr.split("\n");
  const diagnosticLines = lines.filter((line) =>
    line.startsWith(managedLaunchPhaseDiagnosticPrefix),
  );
  const progressLines = lines.filter(
    (line) => line.length > 0 && !line.startsWith(managedLaunchPhaseDiagnosticPrefix),
  );
  const progress = progressLines.length === 0 ? "" : `${progressLines.join("\n")}\n`;
  return (
    diagnosticLines.length === 1 &&
    (progress === expectedUiProgress || progress === expectedObserverAndUiProgress)
  );
}

function analyzeManagedLaunchPhaseTrace(trace: ManagedLaunchPhaseTrace | undefined) {
  if (trace === undefined) {
    return {
      valid: false,
      coherent: false,
      trace: null,
      phaseDurations: null,
      commandCompletionToOverlayCloseMs: null,
      phaseSumMs: null,
    };
  }
  const exactOrder =
    trace.events.length === managedLaunchDiagnosticPhases.length &&
    trace.events.every((event, index) => event.phase === managedLaunchDiagnosticPhases[index]);
  const monotonic = trace.events.every(
    (event, index) => index === 0 || event.atMs >= (trace.events[index - 1]?.atMs ?? 0),
  );
  if (!exactOrder || !monotonic) {
    return {
      valid: false,
      coherent: false,
      trace,
      phaseDurations: null,
      commandCompletionToOverlayCloseMs: null,
      phaseSumMs: null,
    };
  }
  const timestamps = new Map(trace.events.map((event) => [event.phase, event.atMs]));
  const phaseDurations = Object.fromEntries(
    managedLaunchPhaseSegments.map((segment) => [
      segment.key,
      (timestamps.get(segment.to) ?? 0) - (timestamps.get(segment.from) ?? 0),
    ]),
  ) as ManagedLaunchPhaseDurations;
  const commandCompletionToOverlayCloseMs =
    (timestamps.get("overlayCloseRequested") ?? 0) - (timestamps.get("commandCompleted") ?? 0);
  const phaseSumMs = Object.values(phaseDurations).reduce((sum, value) => sum + value, 0);
  const coherent =
    Object.values(phaseDurations).every((value) => value >= 0) &&
    Math.abs(phaseSumMs - commandCompletionToOverlayCloseMs) <= 0.1;
  return {
    valid: coherent,
    coherent,
    trace,
    phaseDurations: coherent ? phaseDurations : null,
    commandCompletionToOverlayCloseMs: coherent ? commandCompletionToOverlayCloseMs : null,
    phaseSumMs: coherent ? phaseSumMs : null,
  };
}

type ObserverExternalLaunchPhaseTrace = z.infer<typeof observerExternalLaunchPhaseTraceSchema>;
type ObserverExternalLaunchPhaseDurations = Record<
  (typeof observerExternalLaunchPhaseSegments)[number]["key"],
  number
>;

async function parseObserverExternalLaunchPhaseTrace(
  path: string,
): Promise<ObserverExternalLaunchPhaseTrace | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = observerExternalLaunchPhaseTraceSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function analyzeObserverExternalLaunchPhaseTrace(
  trace: ObserverExternalLaunchPhaseTrace | undefined,
) {
  if (trace === undefined) {
    return {
      valid: false,
      coherent: false,
      trace: null,
      phaseDurations: null,
      prepareEntryToCompletionMs: null,
      phaseSumMs: null,
    };
  }
  const exactOrder =
    trace.events.length === observerExternalLaunchDiagnosticPhases.length &&
    trace.events.every(
      (event, index) => event.phase === observerExternalLaunchDiagnosticPhases[index],
    );
  const monotonic = trace.events.every(
    (event, index) => index === 0 || event.atMs >= (trace.events[index - 1]?.atMs ?? 0),
  );
  if (!exactOrder || !monotonic) {
    return {
      valid: false,
      coherent: false,
      trace,
      phaseDurations: null,
      prepareEntryToCompletionMs: null,
      phaseSumMs: null,
    };
  }
  const timestamps = new Map(trace.events.map((event) => [event.phase, event.atMs]));
  const phaseDurations = Object.fromEntries(
    observerExternalLaunchPhaseSegments.map((segment) => [
      segment.key,
      (timestamps.get(segment.to) ?? 0) - (timestamps.get(segment.from) ?? 0),
    ]),
  ) as ObserverExternalLaunchPhaseDurations;
  const prepareEntryToCompletionMs =
    (timestamps.get("prepareCompleted") ?? 0) - (timestamps.get("prepareEntered") ?? 0);
  const phaseSumMs = Object.values(phaseDurations).reduce((sum, value) => sum + value, 0);
  const coherent =
    Object.values(phaseDurations).every((value) => value >= 0) &&
    Math.abs(phaseSumMs - prepareEntryToCompletionMs) <= 0.1;
  return {
    valid: coherent,
    coherent,
    trace,
    phaseDurations: coherent ? phaseDurations : null,
    prepareEntryToCompletionMs: coherent ? prepareEntryToCompletionMs : null,
    phaseSumMs: coherent ? phaseSumMs : null,
  };
}

function diagnosticTraceSchema<
  const TPhases extends readonly [string, ...string[]],
  const TIdlePhases extends readonly [string, ...string[]],
>(phases: TPhases, idlePhases: TIdlePhases) {
  return z
    .object({
      events: z.array(
        z
          .object({
            phase: z.enum(phases),
            atMs: z.number().nonnegative(),
            epochMs: z.number().nonnegative(),
          })
          .strict(),
      ),
      idleEvents: z
        .array(
          z
            .object({
              phase: z.enum(idlePhases),
              atMs: z.number().nonnegative(),
              epochMs: z.number().nonnegative(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict();
}

async function parseDiagnosticTrace<TSchema extends z.ZodTypeAny>(
  path: string,
  schema: TSchema,
): Promise<z.infer<TSchema> | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

type ClientProtocolTrace = z.infer<typeof prepareExternalLaunchClientProtocolTraceSchema>;
type ClientProtocolPhaseDurations = Record<
  (typeof prepareExternalLaunchClientProtocolSegments)[number]["key"],
  number
>;

function analyzePrepareExternalLaunchClientProtocolTrace(trace: ClientProtocolTrace | undefined) {
  if (trace === undefined) {
    return {
      valid: false,
      coherent: false,
      trace: null,
      phaseDurations: null,
      totalMs: null,
      phaseSumMs: null,
    };
  }
  const exactOrder =
    trace.events.length === prepareExternalLaunchClientProtocolDiagnosticPhases.length &&
    trace.events.every(
      (event, index) => event.phase === prepareExternalLaunchClientProtocolDiagnosticPhases[index],
    );
  const monotonic = trace.events.every(
    (event, index) => index === 0 || event.atMs >= (trace.events[index - 1]?.atMs ?? 0),
  );
  if (!exactOrder || !monotonic) {
    return {
      valid: false,
      coherent: false,
      trace,
      phaseDurations: null,
      totalMs: null,
      phaseSumMs: null,
    };
  }
  const timestamps = new Map(trace.events.map((event) => [event.phase, event.atMs] as const));
  const phaseDurations = Object.fromEntries(
    prepareExternalLaunchClientProtocolSegments.map((segment) => [
      segment.key,
      (timestamps.get(segment.to) ?? 0) - (timestamps.get(segment.from) ?? 0),
    ]),
  ) as ClientProtocolPhaseDurations;
  const totalMs =
    (timestamps.get("protocolCompleted") ?? 0) - (timestamps.get("protocolEntered") ?? 0);
  const phaseSumMs = Object.values(phaseDurations).reduce((sum, value) => sum + value, 0);
  const coherent =
    Object.values(phaseDurations).every((value) => value >= 0) &&
    Math.abs(phaseSumMs - totalMs) <= bench043Thresholds.phaseCoherenceToleranceMs;
  return {
    valid: coherent,
    coherent,
    trace,
    phaseDurations: coherent ? phaseDurations : null,
    totalMs: coherent ? totalMs : null,
    phaseSumMs: coherent ? phaseSumMs : null,
  };
}

type ServerProtocolTrace = z.infer<typeof prepareExternalLaunchServerProtocolTraceSchema>;
type ServerProtocolPhaseDurations = Record<
  (typeof prepareExternalLaunchServerProtocolSegments)[number]["key"],
  number
>;

function analyzePrepareExternalLaunchServerProtocolTrace(trace: ServerProtocolTrace | undefined) {
  if (trace === undefined) {
    return {
      valid: false,
      coherent: false,
      trace: null,
      phaseDurations: null,
      totalMs: null,
      phaseSumMs: null,
    };
  }
  const exactOrder =
    trace.events.length === prepareExternalLaunchServerProtocolDiagnosticPhases.length &&
    trace.events.every(
      (event, index) => event.phase === prepareExternalLaunchServerProtocolDiagnosticPhases[index],
    );
  const monotonic = trace.events.every(
    (event, index) => index === 0 || event.atMs >= (trace.events[index - 1]?.atMs ?? 0),
  );
  if (!exactOrder || !monotonic) {
    return {
      valid: false,
      coherent: false,
      trace,
      phaseDurations: null,
      totalMs: null,
      phaseSumMs: null,
    };
  }
  const timestamps = new Map(trace.events.map((event) => [event.phase, event.atMs] as const));
  const phaseDurations = Object.fromEntries(
    prepareExternalLaunchServerProtocolSegments.map((segment) => [
      segment.key,
      (timestamps.get(segment.to) ?? 0) - (timestamps.get(segment.from) ?? 0),
    ]),
  ) as ServerProtocolPhaseDurations;
  const totalMs =
    (timestamps.get("prepareResponseSent") ?? 0) - (timestamps.get("prepareRequestParsed") ?? 0);
  const phaseSumMs = Object.values(phaseDurations).reduce((sum, value) => sum + value, 0);
  const coherent =
    Object.values(phaseDurations).every((value) => value >= 0) &&
    Math.abs(phaseSumMs - totalMs) <= bench043Thresholds.phaseCoherenceToleranceMs;
  return {
    valid: coherent,
    coherent,
    trace,
    phaseDurations: coherent ? phaseDurations : null,
    totalMs: coherent ? totalMs : null,
    phaseSumMs: coherent ? phaseSumMs : null,
  };
}

type ProtocolResidualPhaseDurations = Record<(typeof protocolResidualPhaseKeys)[number], number>;

function analyzeProtocolResidual(input: {
  managedLaunch: ReturnType<typeof analyzeManagedLaunchPhaseTrace>;
  observerExternalLaunch: ReturnType<typeof analyzeObserverExternalLaunchPhaseTrace>;
  clientProtocol: ReturnType<typeof analyzePrepareExternalLaunchClientProtocolTrace>;
  serverProtocol: ReturnType<typeof analyzePrepareExternalLaunchServerProtocolTrace>;
}) {
  const { managedLaunch, observerExternalLaunch, clientProtocol, serverProtocol } = input;
  if (
    managedLaunch.phaseDurations === null ||
    managedLaunch.trace === null ||
    observerExternalLaunch.prepareEntryToCompletionMs === null ||
    observerExternalLaunch.trace === null ||
    clientProtocol.phaseDurations === null ||
    clientProtocol.trace === null ||
    serverProtocol.totalMs === null ||
    serverProtocol.trace === null
  ) {
    return {
      valid: false,
      coherent: false,
      phaseDurations: null,
      phaseSumMs: null,
      transportResidualMs: null,
      reconstructionErrorMs: null,
      outerClientSettlementMs: null,
    };
  }
  const managedTimestamps = new Map(
    managedLaunch.trace.events.map((event) => [event.phase, event.atMs] as const),
  );
  const observerTimestamps = new Map(
    observerExternalLaunch.trace.events.map((event) => [event.phase, event.atMs] as const),
  );
  const clientTimestamps = new Map(
    clientProtocol.trace.events.map((event) => [event.phase, event.atMs] as const),
  );
  const serverTimestamps = new Map(
    serverProtocol.trace.events.map((event) => [event.phase, event.atMs] as const),
  );
  const serviceToProtocolEntryMs =
    (clientTimestamps.get("protocolEntered") ?? 0) - (managedTimestamps.get("prepareStarted") ?? 0);
  const protocolToServiceCompletionMs =
    (managedTimestamps.get("prepareCompleted") ?? 0) -
    (clientTimestamps.get("protocolCompleted") ?? 0);
  const phaseDurations: ProtocolResidualPhaseDurations = {
    serviceToProtocolEntryMs,
    protocolBoundaryAdmissionMs: clientProtocol.phaseDurations.protocolBoundaryAdmissionMs,
    boundaryToSocketConnectMs: clientProtocol.phaseDurations.boundaryToSocketConnectMs,
    socketConnectMs: clientProtocol.phaseDurations.socketConnectMs,
    socketToExpectedObserverHealthMs:
      clientProtocol.phaseDurations.socketToExpectedObserverHealthMs,
    expectedObserverHealthMs: clientProtocol.phaseDurations.expectedObserverHealthMs,
    healthToPrepareRequestMs: clientProtocol.phaseDurations.healthToPrepareRequestMs,
    actualRequestWireClientMs:
      (clientTimestamps.get("prepareResponseCompleted") ?? 0) -
      (clientTimestamps.get("prepareRequestStarted") ?? 0) -
      serverProtocol.totalMs,
    observerProtocolPreUseCaseMs:
      (observerTimestamps.get("prepareEntered") ?? 0) -
      (serverTimestamps.get("prepareRequestParsed") ?? 0),
    observerProtocolPostUseCaseMs:
      (serverTimestamps.get("prepareResponseSent") ?? 0) -
      (observerTimestamps.get("prepareCompleted") ?? 0),
    responseToBoundaryCompletionMs: clientProtocol.phaseDurations.responseToBoundaryCompletionMs,
    boundaryToProtocolCompletionMs: clientProtocol.phaseDurations.boundaryToProtocolCompletionMs,
    protocolToServiceCompletionMs,
  };
  const transportResidualMs =
    managedLaunch.phaseDurations.prepareExternalLaunchMs -
    observerExternalLaunch.prepareEntryToCompletionMs;
  const phaseSumMs = Object.values(phaseDurations).reduce((sum, value) => sum + value, 0);
  const reconstructionErrorMs = Math.abs(phaseSumMs - transportResidualMs);
  const outerClientSettlementMs = serviceToProtocolEntryMs + protocolToServiceCompletionMs;
  const coherent =
    Object.values(phaseDurations).every((value) => value >= 0) &&
    transportResidualMs >= 0 &&
    reconstructionErrorMs <= bench043Thresholds.residualCoherenceToleranceMs;
  return {
    valid: coherent,
    coherent,
    phaseDurations: coherent ? phaseDurations : null,
    phaseSumMs: coherent ? phaseSumMs : null,
    transportResidualMs: coherent ? transportResidualMs : null,
    reconstructionErrorMs: coherent ? reconstructionErrorMs : null,
    outerClientSettlementMs: coherent ? outerClientSettlementMs : null,
  };
}

type WireAttributionPhaseDurations = Record<(typeof wireAttributionPhaseKeys)[number], number>;

function analyzeWireAttribution(input: {
  clientProtocol: ReturnType<typeof analyzePrepareExternalLaunchClientProtocolTrace>;
  serverProtocol: ReturnType<typeof analyzePrepareExternalLaunchServerProtocolTrace>;
}) {
  const { clientProtocol, serverProtocol } = input;
  if (
    clientProtocol.trace === null ||
    clientProtocol.phaseDurations === null ||
    serverProtocol.trace === null ||
    serverProtocol.totalMs === null
  ) {
    return {
      valid: false,
      coherent: false,
      crossProcessOrderValid: false,
      phaseDurations: null,
      phaseSumMs: null,
      healthPhaseSumMs: null,
      healthReconstructionErrorMs: null,
      actualRequestReconstructionErrorMs: null,
      wireClientReconstructionErrorMs: null,
    };
  }
  const clientLocal = new Map(
    clientProtocol.trace.events.map((event) => [event.phase, event.atMs] as const),
  );
  const clientEpoch = new Map(
    clientProtocol.trace.events.map((event) => [event.phase, event.epochMs] as const),
  );
  const serverEpoch = new Map(
    serverProtocol.trace.events.map((event) => [event.phase, event.epochMs] as const),
  );
  const phaseDurations: WireAttributionPhaseDurations = {
    requestConstructionMs:
      (clientLocal.get("prepareRequestConstructed") ?? 0) -
      (clientLocal.get("prepareRequestStarted") ?? 0),
    requestSendMs:
      (clientLocal.get("prepareRequestSent") ?? 0) -
      (clientLocal.get("prepareRequestConstructed") ?? 0),
    requestIngressSchedulingMs:
      (serverEpoch.get("prepareRequestParsed") ?? 0) - (clientEpoch.get("prepareRequestSent") ?? 0),
    responseEgressSchedulingMs:
      (clientEpoch.get("prepareResponseFrameReceived") ?? 0) -
      (serverEpoch.get("prepareResponseSent") ?? 0),
    clientResponseEnvelopeValidationMs:
      (clientLocal.get("prepareResponseEnvelopeParsed") ?? 0) -
      (clientLocal.get("prepareResponseFrameReceived") ?? 0),
    clientResponseResultValidationMs:
      (clientLocal.get("prepareResponseCompleted") ?? 0) -
      (clientLocal.get("prepareResponseEnvelopeParsed") ?? 0),
  };
  const healthIngressMs =
    (serverEpoch.get("expectedObserverHealthRequestParsed") ?? 0) -
    (clientEpoch.get("expectedObserverHealthStarted") ?? 0);
  const healthServerMs =
    (serverEpoch.get("expectedObserverHealthResponseSent") ?? 0) -
    (serverEpoch.get("expectedObserverHealthRequestParsed") ?? 0);
  const healthEgressMs =
    (clientEpoch.get("expectedObserverHealthCompleted") ?? 0) -
    (serverEpoch.get("expectedObserverHealthResponseSent") ?? 0);
  const healthPhaseSumMs = healthIngressMs + healthServerMs + healthEgressMs;
  const healthClientMs = clientProtocol.phaseDurations.expectedObserverHealthMs;
  const healthReconstructionErrorMs = Math.abs(healthPhaseSumMs - healthClientMs);
  const phaseSumMs = Object.values(phaseDurations).reduce((sum, value) => sum + value, 0);
  const actualRequestClientMs =
    (clientLocal.get("prepareResponseCompleted") ?? 0) -
    (clientLocal.get("prepareRequestStarted") ?? 0);
  const actualRequestReconstructionErrorMs = Math.abs(
    phaseSumMs + serverProtocol.totalMs - actualRequestClientMs,
  );
  const wireClientMs = actualRequestClientMs - serverProtocol.totalMs;
  const wireClientReconstructionErrorMs = Math.abs(phaseSumMs - wireClientMs);
  const crossProcessOrderValid = [
    healthIngressMs,
    healthServerMs,
    healthEgressMs,
    phaseDurations.requestIngressSchedulingMs,
    phaseDurations.responseEgressSchedulingMs,
  ].every((value) => value >= 0);
  const coherent =
    crossProcessOrderValid &&
    Object.values(phaseDurations).every((value) => value >= 0) &&
    healthReconstructionErrorMs <= bench044Thresholds.reconstructionToleranceMs &&
    actualRequestReconstructionErrorMs <= bench044Thresholds.reconstructionToleranceMs &&
    wireClientReconstructionErrorMs <= bench044Thresholds.reconstructionToleranceMs;
  return {
    valid: coherent,
    coherent,
    crossProcessOrderValid,
    phaseDurations: coherent ? phaseDurations : null,
    phaseSumMs: coherent ? phaseSumMs : null,
    healthPhaseSumMs: coherent ? healthPhaseSumMs : null,
    healthReconstructionErrorMs: coherent ? healthReconstructionErrorMs : null,
    actualRequestReconstructionErrorMs: coherent ? actualRequestReconstructionErrorMs : null,
    wireClientReconstructionErrorMs: coherent ? wireClientReconstructionErrorMs : null,
  };
}

type TransportDeliveryPhaseDurations = Record<(typeof transportDeliveryPhaseKeys)[number], number>;

function analyzeTransportDelivery(input: {
  clientProtocol: ReturnType<typeof analyzePrepareExternalLaunchClientProtocolTrace>;
  serverProtocol: ReturnType<typeof analyzePrepareExternalLaunchServerProtocolTrace>;
}) {
  const { clientProtocol, serverProtocol } = input;
  if (clientProtocol.trace === null || serverProtocol.trace === null) {
    return {
      valid: false,
      coherent: false,
      crossProcessOrderValid: false,
      phaseDurations: null,
      phaseSumMs: null,
      responseEgressMs: null,
      reconstructionErrorMs: null,
    };
  }
  const clientLocal = new Map(
    clientProtocol.trace.events.map((event) => [event.phase, event.atMs] as const),
  );
  const clientEpoch = new Map(
    clientProtocol.trace.events.map((event) => [event.phase, event.epochMs] as const),
  );
  const serverEpoch = new Map(
    serverProtocol.trace.events.map((event) => [event.phase, event.epochMs] as const),
  );
  const phaseDurations: TransportDeliveryPhaseDurations = {
    serverSendToSocketDataCallbackMs:
      (clientEpoch.get("responseSocketDataCallbackEntered") ?? 0) -
      (serverEpoch.get("prepareResponseSent") ?? 0),
    socketDataToFrameExtractionMs:
      (clientLocal.get("responseFrameExtracted") ?? 0) -
      (clientLocal.get("responseSocketDataCallbackEntered") ?? 0),
    frameExtractionToJsonParseMs:
      (clientLocal.get("responseJsonParsed") ?? 0) -
      (clientLocal.get("responseFrameExtracted") ?? 0),
    jsonParseToQueueMs:
      (clientLocal.get("responseQueued") ?? 0) - (clientLocal.get("responseJsonParsed") ?? 0),
    queueToWaiterResolutionMs:
      (clientLocal.get("responseWaiterResolutionStarted") ?? 0) -
      (clientLocal.get("responseQueued") ?? 0),
    waiterResolutionMs:
      (clientLocal.get("responseWaiterResolutionCompleted") ?? 0) -
      (clientLocal.get("responseWaiterResolutionStarted") ?? 0),
    waiterToIteratorResumeMs:
      (clientLocal.get("responseIteratorWaitResumed") ?? 0) -
      (clientLocal.get("responseWaiterResolutionCompleted") ?? 0),
    iteratorResumeToDequeueMs:
      (clientLocal.get("responseDequeued") ?? 0) -
      (clientLocal.get("responseIteratorWaitResumed") ?? 0),
    dequeueToYieldMs:
      (clientLocal.get("responseYieldStarted") ?? 0) - (clientLocal.get("responseDequeued") ?? 0),
    yieldToOuterFrameReceiptMs:
      (clientLocal.get("prepareResponseFrameReceived") ?? 0) -
      (clientLocal.get("responseYieldStarted") ?? 0),
  };
  const phaseSumMs = Object.values(phaseDurations).reduce((sum, value) => sum + value, 0);
  const responseEgressMs =
    (clientEpoch.get("prepareResponseFrameReceived") ?? 0) -
    (serverEpoch.get("prepareResponseSent") ?? 0);
  const reconstructionErrorMs = Math.abs(phaseSumMs - responseEgressMs);
  const crossProcessOrderValid = phaseDurations.serverSendToSocketDataCallbackMs >= 0;
  const coherent =
    crossProcessOrderValid &&
    Object.values(phaseDurations).every((value) => value >= 0) &&
    reconstructionErrorMs <= bench045Thresholds.reconstructionToleranceMs;
  return {
    valid: coherent,
    coherent,
    crossProcessOrderValid,
    phaseDurations: coherent ? phaseDurations : null,
    phaseSumMs: coherent ? phaseSumMs : null,
    responseEgressMs: coherent ? responseEgressMs : null,
    reconstructionErrorMs: coherent ? reconstructionErrorMs : null,
  };
}

function analyzeIdleTransportDelivery(input: {
  clientProtocol: ReturnType<typeof analyzePrepareExternalLaunchClientProtocolTrace>;
  serverProtocol: ReturnType<typeof analyzePrepareExternalLaunchServerProtocolTrace>;
}) {
  const clientEvents = input.clientProtocol.trace?.idleEvents;
  const serverEvents = input.serverProtocol.trace?.idleEvents;
  const invalid = {
    valid: false,
    coherent: false,
    crossProcessOrderValid: false,
    phaseDurations: null,
    phaseSumMs: null,
    responseEgressMs: null,
    callbackToValidatedMs: null,
    reconstructionErrorMs: null,
  } as const;
  if (clientEvents === undefined || serverEvents === undefined) return invalid;

  const clientExact =
    clientEvents.length === idleResponseDeliveryClientProtocolDiagnosticPhases.length &&
    clientEvents.every(
      (event, index) => event.phase === idleResponseDeliveryClientProtocolDiagnosticPhases[index],
    );
  const serverExact =
    serverEvents.length === idleResponseDeliveryServerProtocolDiagnosticPhases.length &&
    serverEvents.every(
      (event, index) => event.phase === idleResponseDeliveryServerProtocolDiagnosticPhases[index],
    );
  const clientMonotonic = clientEvents.every(
    (event, index) => index === 0 || event.atMs >= (clientEvents[index - 1]?.atMs ?? 0),
  );
  const serverMonotonic = serverEvents.every(
    (event, index) => index === 0 || event.atMs >= (serverEvents[index - 1]?.atMs ?? 0),
  );
  if (!clientExact || !serverExact || !clientMonotonic || !serverMonotonic) return invalid;

  const clientLocal = new Map(clientEvents.map((event) => [event.phase, event.atMs] as const));
  const clientEpoch = new Map(clientEvents.map((event) => [event.phase, event.epochMs] as const));
  const serverEpoch = new Map(serverEvents.map((event) => [event.phase, event.epochMs] as const));
  const phaseDurations: TransportDeliveryPhaseDurations = {
    serverSendToSocketDataCallbackMs:
      (clientEpoch.get("responseSocketDataCallbackEntered") ?? 0) -
      (serverEpoch.get("responseSent") ?? 0),
    socketDataToFrameExtractionMs:
      (clientLocal.get("responseFrameExtracted") ?? 0) -
      (clientLocal.get("responseSocketDataCallbackEntered") ?? 0),
    frameExtractionToJsonParseMs:
      (clientLocal.get("responseJsonParsed") ?? 0) -
      (clientLocal.get("responseFrameExtracted") ?? 0),
    jsonParseToQueueMs:
      (clientLocal.get("responseQueued") ?? 0) - (clientLocal.get("responseJsonParsed") ?? 0),
    queueToWaiterResolutionMs:
      (clientLocal.get("responseWaiterResolutionStarted") ?? 0) -
      (clientLocal.get("responseQueued") ?? 0),
    waiterResolutionMs:
      (clientLocal.get("responseWaiterResolutionCompleted") ?? 0) -
      (clientLocal.get("responseWaiterResolutionStarted") ?? 0),
    waiterToIteratorResumeMs:
      (clientLocal.get("responseIteratorWaitResumed") ?? 0) -
      (clientLocal.get("responseWaiterResolutionCompleted") ?? 0),
    iteratorResumeToDequeueMs:
      (clientLocal.get("responseDequeued") ?? 0) -
      (clientLocal.get("responseIteratorWaitResumed") ?? 0),
    dequeueToYieldMs:
      (clientLocal.get("responseYieldStarted") ?? 0) - (clientLocal.get("responseDequeued") ?? 0),
    yieldToOuterFrameReceiptMs:
      (clientLocal.get("responseFrameReceived") ?? 0) -
      (clientLocal.get("responseYieldStarted") ?? 0),
  };
  const phaseSumMs = Object.values(phaseDurations).reduce((sum, value) => sum + value, 0);
  const responseEgressMs =
    (clientEpoch.get("responseFrameReceived") ?? 0) - (serverEpoch.get("responseSent") ?? 0);
  const callbackToValidatedMs =
    (clientLocal.get("responseValidated") ?? 0) -
    (clientLocal.get("responseSocketDataCallbackEntered") ?? 0);
  const reconstructionErrorMs = Math.abs(phaseSumMs - responseEgressMs);
  const crossProcessOrderValid = phaseDurations.serverSendToSocketDataCallbackMs >= 0;
  const coherent =
    crossProcessOrderValid &&
    Object.values(phaseDurations).every((value) => value >= 0) &&
    callbackToValidatedMs >= 0 &&
    reconstructionErrorMs <= bench047Thresholds.reconstructionToleranceMs;
  return {
    valid: coherent,
    coherent,
    crossProcessOrderValid,
    phaseDurations: coherent ? phaseDurations : null,
    phaseSumMs: coherent ? phaseSumMs : null,
    responseEgressMs: coherent ? responseEgressMs : null,
    callbackToValidatedMs: coherent ? callbackToValidatedMs : null,
    reconstructionErrorMs: coherent ? reconstructionErrorMs : null,
  };
}

const processTableRowSchema = z
  .object({
    pid: z.coerce.number().int().positive(),
    parentPid: z.coerce.number().int().positive(),
    command: z.string().min(1),
  })
  .strict();

async function resolveNativeRendererPid(launcherPid: number): Promise<number> {
  const processTable = await execFileAsync(
    "/bin/ps",
    ["-ax", "-o", "pid=", "-o", "ppid=", "-o", "command="],
    { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const children = processTable.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (match === null) return [];
    const parsed = processTableRowSchema.safeParse({
      pid: match[1],
      parentPid: match[2],
      command: match[3],
    });
    return parsed.success ? [parsed.data] : [];
  });
  const exactRenderers = children.filter(
    (row) => row.parentPid === launcherPid && row.command === `${binaryPath} __tui`,
  );
  if (exactRenderers.length !== 1 || exactRenderers[0] === undefined) {
    throw new Error(
      `Compiled Station launcher ${launcherPid} did not own exactly one native renderer: ${JSON.stringify(
        children.filter((row) => row.parentPid === launcherPid),
      )}`,
    );
  }
  process.kill(exactRenderers[0].pid, 0);
  return exactRenderers[0].pid;
}

async function launchNativeStation(input: {
  env: RealE2eEnvironment;
  fixture: BenchmarkFixture;
  sessionName: string;
  stderrPath: string;
  observerPhaseTracePath: string;
  clientProtocolTracePath: string;
  serverProtocolTracePath: string;
  idleTransportProbeCompletionPath: string;
}) {
  const command = [
    "exec",
    "env",
    "-u",
    "TMUX",
    "-u",
    "TMUX_PANE",
    "-u",
    "STATION_PANE",
    "-u",
    "STATION_TUI_POPUP",
    "-u",
    "STATION_TUI_PERSISTENT",
    `STATION_CONFIG_PATH=${shellQuote(input.fixture.configPath)}`,
    `STATION_OBSERVER_SOCKET_PATH=${shellQuote(input.fixture.observerSocketPath)}`,
    `STATION_HOST_SOCKET_PATH=${shellQuote(input.fixture.hostSocketPath)}`,
    `STATION_LAYOUT_PATH=${shellQuote(join(input.fixture.stateDir, "station", "layout.json"))}`,
    ...(runManagedLaunchPhaseDiagnostic
      ? ["STATION_QUICK_SESSION_MANAGED_LAUNCH_PHASE_DIAGNOSTIC=1"]
      : []),
    ...(runObserverPhaseDiagnostic
      ? [
          `STATION_QUICK_SESSION_EXTERNAL_LAUNCH_PHASE_DIAGNOSTIC_PATH=${shellQuote(input.observerPhaseTracePath)}`,
        ]
      : []),
    ...(runProtocolPhaseAttribution
      ? [
          `STATION_QUICK_SESSION_PROTOCOL_CLIENT_PHASE_DIAGNOSTIC_PATH=${shellQuote(input.clientProtocolTracePath)}`,
          `STATION_QUICK_SESSION_PROTOCOL_SERVER_PHASE_DIAGNOSTIC_PATH=${shellQuote(input.serverProtocolTracePath)}`,
        ]
      : []),
    ...(runBench047NativeTuiIdleExperiment
      ? [
          `STATION_QUICK_SESSION_IDLE_TRANSPORT_PROBE_PATH=${shellQuote(input.idleTransportProbeCompletionPath)}`,
        ]
      : []),
    shellQuote(binaryPath),
    "--config",
    shellQuote(input.fixture.configPath),
    `2>>${shellQuote(input.stderrPath)}`,
  ].join(" ");
  await execFileAsync(
    tmuxCommand,
    [
      "new-session",
      "-d",
      "-s",
      input.sessionName,
      "-x",
      String(dimensions.columns),
      "-y",
      String(dimensions.rows),
      "-c",
      input.fixture.repositoryRoot,
      command,
    ],
    { timeout: 10_000 },
  );
  await execFileAsync(tmuxCommand, ["set-option", "-t", input.sessionName, "mouse", "on"], {
    timeout: 10_000,
  });
  const pane = await execFileAsync(
    tmuxCommand,
    ["display-message", "-p", "-t", input.sessionName, "#{pane_pid}\t#{pane_id}"],
    { timeout: 10_000 },
  );
  const [panePidText, target] = pane.stdout.trim().split("\t");
  const panePid = Number(panePidText);
  if (!Number.isInteger(panePid) || panePid <= 0 || target === undefined) {
    throw new Error("Compiled native TUI tmux pane did not expose process identity.");
  }
  return { panePid, target };
}

async function waitForEvent(
  iterator: AsyncIterator<StationEvent>,
  predicate: (event: StationEvent) => boolean,
  timeoutMs: number,
  message: string,
) {
  return withTimeout(
    (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new Error("Observer event subscription ended unexpectedly.");
        if (predicate(next.value)) return next.value;
      }
    })(),
    timeoutMs,
    message,
  );
}

async function waitForSnapshot<T>(
  client: ObserverClient,
  project: (snapshot: StationSnapshot) => T | undefined,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() <= deadline) {
    const value = project(await client.getSnapshot({ includeDebug: true }));
    if (value !== undefined) return value;
    await delay(5);
  }
  throw new Error(message);
}

async function waitForHostEntry(
  client: ReturnType<typeof createStationHostClient>,
  predicate: (entry: HostListEntry) => boolean,
  timeoutMs: number,
) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() <= deadline) {
    const matches = (await client.list()).filter(predicate);
    if (matches.length === 1 && matches[0] !== undefined) return matches[0];
    if (matches.length > 1) throw new Error("Multiple Host PTYs matched one Quick Session.");
    await delay(5);
  }
  throw new Error("Compiled native Quick Session did not publish its exact Host PTY.");
}

async function waitForFrame(
  env: RealE2eEnvironment,
  target: string,
  predicate: (frame: string) => boolean,
  timeoutMs: number,
  message: string,
) {
  const deadline = performance.now() + timeoutMs;
  let lastFrame = "";
  while (performance.now() <= deadline) {
    lastFrame = await captureTmuxPane({
      env,
      target,
      preserveTrailingSpaces: true,
      visibleOnly: true,
    }).catch(() => "");
    if (predicate(lastFrame)) return lastFrame;
    await delay(10);
  }
  throw new Error(`${message}\nLast frame:\n${lastFrame}`);
}

async function waitForOutput(client: AttachedTmuxPtyClient, marker: string, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() <= deadline) {
    if (client.outputTail().includes(marker)) return;
    await delay(1);
  }
  throw new Error(`Compiled native TUI did not render ${JSON.stringify(marker)}.`);
}

function cellForText(frame: string, needle: string) {
  const lines = frame.split("\n");
  const row = lines.findIndex((line) => line.includes(needle));
  const column = row < 0 ? -1 : (lines[row]?.indexOf(needle) ?? -1);
  if (row < 0 || column < 0) {
    throw new Error(`Native frame does not contain ${JSON.stringify(needle)}.`);
  }
  return { column: column + Math.floor(needle.length / 2) + 1, row: row + 1 };
}

function sgrMouse(code: number, cell: { column: number; row: number }, final: "M" | "m" = "M") {
  return Buffer.from(`\u001B[<${code};${cell.column};${cell.row}${final}`, "utf8");
}

async function writeSgrClick(client: AttachedTmuxPtyClient, cell: { column: number; row: number }) {
  await client.write(sgrMouse(0, cell));
  await client.write(sgrMouse(0, cell, "m"));
}

function replayData(attachment: HostAttachment) {
  return attachment.ack.replay.events
    .filter((event) => event.type === "data")
    .map((event) => event.data)
    .join("");
}

async function readUntilMarker(
  iterator: AsyncIterator<HostFrame>,
  initial: string,
  marker: string,
  timeoutMs: number,
) {
  let output = initial;
  const deadline = performance.now() + timeoutMs;
  while (!output.includes(marker) && performance.now() <= deadline) {
    const remaining = Math.max(1, deadline - performance.now());
    const next = await withTimeout(iterator.next(), remaining, `Timed out waiting for ${marker}.`);
    if (next.done) break;
    if (next.value.type === "data") output += next.value.data;
  }
  if (!output.includes(marker)) throw new Error(`Host output did not contain ${marker}.`);
  return output;
}

async function readUntilReadyAndAcknowledgement(
  iterator: AsyncIterator<HostFrame>,
  initial: string,
  readyMarker: string,
  acknowledgementMarker: string,
  timeoutMs: number,
) {
  let output = initial;
  const startedAt = performance.now();
  const readyWasReplay = output.includes(readyMarker);
  let readyAt = readyWasReplay ? startedAt : undefined;
  let acknowledgedAt = output.includes(acknowledgementMarker) ? startedAt : undefined;
  const deadline = startedAt + timeoutMs;
  while ((readyAt === undefined || acknowledgedAt === undefined) && performance.now() <= deadline) {
    const remaining = Math.max(1, deadline - performance.now());
    const next = await withTimeout(
      iterator.next(),
      remaining,
      "Timed out waiting for Host readiness and buffered input acknowledgement.",
    );
    if (next.done) break;
    if (next.value.type !== "data") continue;
    output += next.value.data;
    const observedAt = performance.now();
    if (readyAt === undefined && output.includes(readyMarker)) readyAt = observedAt;
    if (acknowledgedAt === undefined && output.includes(acknowledgementMarker)) {
      acknowledgedAt = observedAt;
    }
  }
  if (readyAt === undefined || acknowledgedAt === undefined) {
    throw new Error("Host output did not contain readiness and acknowledgement markers.");
  }
  return { output, readyAt, acknowledgedAt, readyWasReplay };
}

function countOccurrences(value: string, marker: string) {
  let count = 0;
  let offset = 0;
  for (;;) {
    const match = value.indexOf(marker, offset);
    if (match < 0) return count;
    count += 1;
    offset = match + marker.length;
  }
}

async function waitForTmuxExit(env: RealE2eEnvironment, sessionName: string, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() <= deadline) {
    if (!(await tmuxSessionExists(env, sessionName))) return true;
    await delay(20);
  }
  return false;
}

async function waitForPidExit(pid: number, timeoutMs: number) {
  if (pid <= 0) return false;
  const deadline = performance.now() + timeoutMs;
  while (performance.now() <= deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await delay(20);
  }
  return false;
}

async function waitForExit(child: ChildProcess | undefined, timeoutMs: number) {
  if (child === undefined) throw new Error("Station Host child process was not captured.");
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return withTimeout(
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    }),
    timeoutMs,
    "Station Host did not exit before timeout.",
  );
}

async function stopHostRuntime(runtime: ReturnType<typeof createHostRuntime>) {
  const live = await runtime.client.list().catch(() => []);
  for (const entry of live) {
    await runtime.client.close(entry.ptyId).catch(() => undefined);
  }
  await runtime.client.stopIfIdle(runtime.expectedBuildVersion).catch(() => undefined);
  const child = runtime.child();
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await waitForExit(child, 2_000).catch(async () => {
      child.kill("SIGKILL");
      await waitForExit(child, 2_000).catch(() => undefined);
    });
  }
  runtime.client.dispose();
}

function summarizeRuns(runs: BenchmarkRun[]) {
  return {
    launchToDashboardMs: distribution(runs.map((run) => run.launchToDashboardMs)),
    intentToOptimisticMs: distribution(runs.map((run) => run.intentToOptimisticMs)),
    intentToCommandAcceptedMs: distribution(runs.map((run) => run.intentToCommandAcceptedMs)),
    intentToCommandCompletedMs: distribution(runs.map((run) => run.intentToCommandCompletedMs)),
    intentToHostReadyMs: distribution(runs.map((run) => run.intentToHostReadyMs)),
    intentToCanonicalUiMs: distribution(runs.map((run) => run.intentToCanonicalUiMs)),
    intentToFocusMs: distribution(runs.map((run) => run.intentToFocusMs)),
    focusToOverlayDismissedMs: distribution(runs.map((run) => run.focusToOverlayDismissedMs)),
    overlayDismissedToInputSentMs: distribution(
      runs.map((run) => run.overlayDismissedToInputSentMs),
    ),
    inputSentToHostReadyMs: distribution(runs.map((run) => run.inputSentToHostReadyMs)),
    inputSentToAckMs: distribution(runs.map((run) => run.inputSentToAckMs)),
    focusToInputAckMs: distribution(runs.map((run) => run.focusToInputAckMs)),
    intentToInteractiveMs: distribution(runs.map((run) => run.intentToInteractiveMs)),
    launchToInteractiveMs: distribution(runs.map((run) => run.launchToInteractiveMs)),
  };
}

function summarizeManagedLaunchPhaseAttribution(runs: BenchmarkRun[]) {
  const validRuns = runs.filter(
    (
      run,
    ): run is BenchmarkRun & {
      managedLaunchPhaseDurations: ManagedLaunchPhaseDurations;
      commandCompletionToOverlayCloseMs: number;
    } => run.managedLaunchPhaseDurations !== null && run.commandCompletionToOverlayCloseMs !== null,
  );
  const phaseDistributions = Object.fromEntries(
    managedLaunchPhaseSegments.map((segment) => [
      segment.key,
      distribution(validRuns.map((run) => run.managedLaunchPhaseDurations[segment.key])),
    ]),
  ) as Record<keyof ManagedLaunchPhaseDurations, ReturnType<typeof distribution>>;
  const commandCompletionToOverlayCloseMs = distribution(
    validRuns.map((run) => run.commandCompletionToOverlayCloseMs),
  );
  const dominant = managedLaunchPhaseSegments.reduce((current, segment) =>
    phaseDistributions[segment.key].p95 > phaseDistributions[current.key].p95 ? segment : current,
  );
  const totalP95 = commandCompletionToOverlayCloseMs.p95;
  const dominantP95 = phaseDistributions[dominant.key].p95;
  const tailRuns = validRuns.filter(
    (run) => run.commandCompletionToOverlayCloseMs > bench041Thresholds.tailIntervalMs,
  );
  const dominantTailIntervals = tailRuns.filter(
    (run) =>
      run.managedLaunchPhaseDurations[dominant.key] / run.commandCompletionToOverlayCloseMs >=
      bench041Thresholds.dominantTailFraction,
  ).length;
  const prepareExternalLaunchP95Fraction =
    totalP95 === 0 ? 0 : phaseDistributions.prepareExternalLaunchMs.p95 / totalP95;
  const prepareExternalLaunchTailFractions = tailRuns.map(
    (run) =>
      run.managedLaunchPhaseDurations.prepareExternalLaunchMs /
      run.commandCompletionToOverlayCloseMs,
  );
  return {
    validRuns: validRuns.length,
    phaseDistributions,
    commandCompletionToOverlayCloseMs,
    dominantPhase: dominant.key,
    dominantP95Fraction: totalP95 === 0 ? 0 : dominantP95 / totalP95,
    tailIntervals: tailRuns.length,
    dominantTailIntervals,
    prepareExternalLaunchP95Fraction,
    prepareExternalLaunchTailFractions,
    prepareExternalLaunchDominatesEveryTail:
      tailRuns.length >= bench041Thresholds.minimumTailIntervals &&
      prepareExternalLaunchTailFractions.every(
        (fraction) => fraction >= bench041Prediction.prepareExternalLaunchTailFraction,
      ),
  };
}

function summarizeObserverExternalLaunchPhaseAttribution(runs: BenchmarkRun[]) {
  const validRuns = runs.filter(
    (
      run,
    ): run is BenchmarkRun & {
      observerExternalLaunchPhaseDurations: ObserverExternalLaunchPhaseDurations;
      observerExternalLaunchInternalMs: number;
      clientRpcMinusObserverInternalMs: number;
    } =>
      run.observerExternalLaunchPhaseDurations !== null &&
      run.observerExternalLaunchInternalMs !== null &&
      run.clientRpcMinusObserverInternalMs !== null,
  );
  const phaseDistributions = Object.fromEntries(
    observerExternalLaunchPhaseSegments.map((segment) => [
      segment.key,
      distribution(validRuns.map((run) => run.observerExternalLaunchPhaseDurations[segment.key])),
    ]),
  ) as Record<keyof ObserverExternalLaunchPhaseDurations, ReturnType<typeof distribution>>;
  const observerExternalLaunchInternalMs = distribution(
    validRuns.map((run) => run.observerExternalLaunchInternalMs),
  );
  const transportResidualMs = distribution(
    validRuns.map((run) => run.clientRpcMinusObserverInternalMs),
  );
  const dominant = observerExternalLaunchPhaseSegments.reduce((current, segment) =>
    phaseDistributions[segment.key].p95 > phaseDistributions[current.key].p95 ? segment : current,
  );
  const totalP95 = observerExternalLaunchInternalMs.p95;
  const dominantP95 = phaseDistributions[dominant.key].p95;
  const tailRuns = validRuns.filter(
    (run) => run.observerExternalLaunchInternalMs > bench042Thresholds.tailIntervalMs,
  );
  const dominantTailIntervals = tailRuns.filter(
    (run) =>
      run.observerExternalLaunchPhaseDurations[dominant.key] /
        run.observerExternalLaunchInternalMs >=
      bench042Thresholds.dominantTailFraction,
  ).length;
  const hostProcessLaunchP95Fraction =
    totalP95 === 0 ? 0 : phaseDistributions.hostProcessLaunchMs.p95 / totalP95;
  const hostProcessLaunchTailFractions = tailRuns.map(
    (run) =>
      run.observerExternalLaunchPhaseDurations.hostProcessLaunchMs /
      run.observerExternalLaunchInternalMs,
  );
  return {
    validRuns: validRuns.length,
    phaseDistributions,
    observerExternalLaunchInternalMs,
    transportResidualMs,
    dominantPhase: dominant.key,
    dominantP95Fraction: totalP95 === 0 ? 0 : dominantP95 / totalP95,
    tailIntervals: tailRuns.length,
    dominantTailIntervals,
    hostProcessLaunchP95Fraction,
    hostProcessLaunchTailFractions,
    hostProcessLaunchDominatesEveryTail:
      tailRuns.length >= bench042Thresholds.minimumTailIntervals &&
      hostProcessLaunchTailFractions.every(
        (fraction) => fraction >= bench042Prediction.hostProcessLaunchTailFraction,
      ),
  };
}

function summarizeProtocolResidualAttribution(runs: BenchmarkRun[]) {
  const validRuns = runs.filter(
    (
      run,
    ): run is BenchmarkRun & {
      clientProtocolPhaseDurations: ClientProtocolPhaseDurations;
      clientProtocolTotalMs: number;
      serverProtocolPhaseDurations: ServerProtocolPhaseDurations;
      serverProtocolTotalMs: number;
      protocolResidualPhaseDurations: ProtocolResidualPhaseDurations;
      protocolResidualPhaseSumMs: number;
      protocolResidualReconstructionErrorMs: number;
      clientRpcMinusObserverInternalMs: number;
    } =>
      run.clientProtocolPhaseDurations !== null &&
      run.clientProtocolTotalMs !== null &&
      run.serverProtocolPhaseDurations !== null &&
      run.serverProtocolTotalMs !== null &&
      run.protocolResidualPhaseDurations !== null &&
      run.protocolResidualPhaseSumMs !== null &&
      run.protocolResidualReconstructionErrorMs !== null &&
      run.clientRpcMinusObserverInternalMs !== null,
  );
  const phaseDistributions = Object.fromEntries(
    protocolResidualPhaseKeys.map((key) => [
      key,
      distribution(validRuns.map((run) => run.protocolResidualPhaseDurations[key])),
    ]),
  ) as Record<keyof ProtocolResidualPhaseDurations, ReturnType<typeof distribution>>;
  const clientPhaseDistributions = Object.fromEntries(
    prepareExternalLaunchClientProtocolSegments.map((segment) => [
      segment.key,
      distribution(validRuns.map((run) => run.clientProtocolPhaseDurations[segment.key])),
    ]),
  ) as Record<keyof ClientProtocolPhaseDurations, ReturnType<typeof distribution>>;
  const serverPhaseDistributions = Object.fromEntries(
    prepareExternalLaunchServerProtocolSegments.map((segment) => [
      segment.key,
      distribution(validRuns.map((run) => run.serverProtocolPhaseDurations[segment.key])),
    ]),
  ) as Record<keyof ServerProtocolPhaseDurations, ReturnType<typeof distribution>>;
  const transportResidualMs = distribution(
    validRuns.map((run) => run.clientRpcMinusObserverInternalMs),
  );
  const clientProtocolTotalMs = distribution(validRuns.map((run) => run.clientProtocolTotalMs));
  const serverProtocolTotalMs = distribution(validRuns.map((run) => run.serverProtocolTotalMs));
  const reconstructionErrorMs = distribution(
    validRuns.map((run) => run.protocolResidualReconstructionErrorMs),
  );
  const outerClientSettlementMs = distribution(
    validRuns.map(
      (run) =>
        run.protocolResidualPhaseDurations.serviceToProtocolEntryMs +
        run.protocolResidualPhaseDurations.protocolToServiceCompletionMs,
    ),
  );
  const dominantPhase = protocolResidualPhaseKeys.reduce((current, key) =>
    phaseDistributions[key].p95 > phaseDistributions[current].p95 ? key : current,
  );
  const totalP95 = transportResidualMs.p95;
  const dominantP95 = phaseDistributions[dominantPhase].p95;
  const tailRuns = validRuns.filter(
    (run) => run.clientRpcMinusObserverInternalMs > bench043Thresholds.residualTailIntervalMs,
  );
  const dominantTailIntervals = tailRuns.filter(
    (run) =>
      run.protocolResidualPhaseDurations[dominantPhase] / run.clientRpcMinusObserverInternalMs >=
      bench043Thresholds.dominantTailFraction,
  ).length;
  const expectedObserverHealthP95Fraction =
    totalP95 === 0 ? 0 : phaseDistributions.expectedObserverHealthMs.p95 / totalP95;
  const expectedObserverHealthTailFractions = tailRuns.map(
    (run) =>
      run.protocolResidualPhaseDurations.expectedObserverHealthMs /
      run.clientRpcMinusObserverInternalMs,
  );
  return {
    validRuns: validRuns.length,
    phaseDistributions,
    clientPhaseDistributions,
    serverPhaseDistributions,
    transportResidualMs,
    clientProtocolTotalMs,
    serverProtocolTotalMs,
    reconstructionErrorMs,
    outerClientSettlementMs,
    dominantPhase,
    dominantP95Fraction: totalP95 === 0 ? 0 : dominantP95 / totalP95,
    tailIntervals: tailRuns.length,
    dominantTailIntervals,
    expectedObserverHealthP95Fraction,
    expectedObserverHealthTailFractions,
    expectedObserverHealthDominatesEveryTail:
      tailRuns.length >= bench043Thresholds.minimumTailIntervals &&
      expectedObserverHealthTailFractions.every(
        (fraction) => fraction >= bench043Prediction.expectedObserverHealthTailFraction,
      ),
  };
}

function summarizeWireAttribution(runs: BenchmarkRun[]) {
  const validRuns = runs.filter(
    (
      run,
    ): run is BenchmarkRun & {
      wireAttributionPhaseDurations: WireAttributionPhaseDurations;
      wireAttributionPhaseSumMs: number;
      wireAttributionHealthReconstructionErrorMs: number;
      wireAttributionActualRequestReconstructionErrorMs: number;
      wireAttributionWireClientReconstructionErrorMs: number;
      protocolResidualPhaseDurations: ProtocolResidualPhaseDurations;
      protocolResidualReconstructionErrorMs: number;
      clientProtocolTotalMs: number;
      clientProtocolPhaseSumMs: number;
      serverProtocolTotalMs: number;
      serverProtocolPhaseSumMs: number;
    } =>
      run.wireAttributionPhaseDurations !== null &&
      run.wireAttributionPhaseSumMs !== null &&
      run.wireAttributionHealthReconstructionErrorMs !== null &&
      run.wireAttributionActualRequestReconstructionErrorMs !== null &&
      run.wireAttributionWireClientReconstructionErrorMs !== null &&
      run.protocolResidualPhaseDurations !== null &&
      run.protocolResidualReconstructionErrorMs !== null &&
      run.clientProtocolTotalMs !== null &&
      run.clientProtocolPhaseSumMs !== null &&
      run.serverProtocolTotalMs !== null &&
      run.serverProtocolPhaseSumMs !== null,
  );
  const phaseDistributions = Object.fromEntries(
    wireAttributionPhaseKeys.map((key) => [
      key,
      distribution(validRuns.map((run) => run.wireAttributionPhaseDurations[key])),
    ]),
  ) as Record<keyof WireAttributionPhaseDurations, ReturnType<typeof distribution>>;
  const wireClientMs = distribution(
    validRuns.map((run) => run.protocolResidualPhaseDurations.actualRequestWireClientMs),
  );
  const clientResponseValidationMs = distribution(
    validRuns.map(
      (run) =>
        run.wireAttributionPhaseDurations.clientResponseEnvelopeValidationMs +
        run.wireAttributionPhaseDurations.clientResponseResultValidationMs,
    ),
  );
  const dominantPhase = wireAttributionPhaseKeys.reduce((current, key) =>
    phaseDistributions[key].p95 > phaseDistributions[current].p95 ? key : current,
  );
  const tailRuns = validRuns.filter(
    (run) =>
      run.protocolResidualPhaseDurations.actualRequestWireClientMs >
      bench044Thresholds.actualWireTailIntervalMs,
  );
  const dominantTailIntervals = tailRuns.filter(
    (run) =>
      run.wireAttributionPhaseDurations[dominantPhase] /
        run.protocolResidualPhaseDurations.actualRequestWireClientMs >=
      bench044Thresholds.dominantTailFraction,
  ).length;
  const clientResponseValidationTailFractions = tailRuns.map(
    (run) =>
      (run.wireAttributionPhaseDurations.clientResponseEnvelopeValidationMs +
        run.wireAttributionPhaseDurations.clientResponseResultValidationMs) /
      run.protocolResidualPhaseDurations.actualRequestWireClientMs,
  );
  const reconstructionErrors = validRuns.flatMap((run) => [
    Math.abs(run.clientProtocolTotalMs - run.clientProtocolPhaseSumMs),
    Math.abs(run.serverProtocolTotalMs - run.serverProtocolPhaseSumMs),
    run.wireAttributionHealthReconstructionErrorMs,
    run.wireAttributionActualRequestReconstructionErrorMs,
    run.wireAttributionWireClientReconstructionErrorMs,
    run.protocolResidualReconstructionErrorMs,
  ]);
  return {
    validRuns: validRuns.length,
    phaseDistributions,
    wireClientMs,
    clientResponseValidationMs,
    dominantPhase,
    dominantP95Fraction:
      wireClientMs.p95 === 0 ? 0 : phaseDistributions[dominantPhase].p95 / wireClientMs.p95,
    tailIntervals: tailRuns.length,
    dominantTailIntervals,
    clientResponseValidationP95Fraction:
      wireClientMs.p95 === 0 ? 0 : clientResponseValidationMs.p95 / wireClientMs.p95,
    clientResponseValidationTailFractions,
    clientResponseValidationDominatesEveryTail:
      tailRuns.length >= bench044Thresholds.minimumTailIntervals &&
      clientResponseValidationTailFractions.every(
        (fraction) => fraction >= bench044Prediction.clientResponseValidationTailFraction,
      ),
    reconstructionErrorMs: distribution(reconstructionErrors),
    maximumReconstructionErrorMs: Math.max(0, ...reconstructionErrors),
    crossProcessOrderValid: validRuns.every((run) => run.wireAttributionCrossProcessOrderValid),
  };
}

function summarizeTransportDeliveryAttribution(runs: BenchmarkRun[]) {
  const validRuns = runs.filter(
    (
      run,
    ): run is BenchmarkRun & {
      transportDeliveryPhaseDurations: TransportDeliveryPhaseDurations;
      transportDeliveryPhaseSumMs: number;
      transportDeliveryReconstructionErrorMs: number;
    } =>
      run.transportDeliveryPhaseDurations !== null &&
      run.transportDeliveryPhaseSumMs !== null &&
      run.transportDeliveryReconstructionErrorMs !== null,
  );
  const phaseDistributions = Object.fromEntries(
    transportDeliveryPhaseKeys.map((key) => [
      key,
      distribution(validRuns.map((run) => run.transportDeliveryPhaseDurations[key])),
    ]),
  ) as Record<keyof TransportDeliveryPhaseDurations, ReturnType<typeof distribution>>;
  const responseEgressMs = distribution(validRuns.map((run) => run.transportDeliveryPhaseSumMs));
  const postCallbackMs = distribution(
    validRuns.map((run) =>
      transportPostCallbackPhaseKeys.reduce(
        (sum, key) => sum + run.transportDeliveryPhaseDurations[key],
        0,
      ),
    ),
  );
  const dominantPhase = transportDeliveryPhaseKeys.reduce((current, key) =>
    phaseDistributions[key].p95 > phaseDistributions[current].p95 ? key : current,
  );
  const tailRuns = validRuns.filter(
    (run) => run.transportDeliveryPhaseSumMs > bench045Thresholds.responseEgressTailIntervalMs,
  );
  const dominantTailIntervals = tailRuns.filter(
    (run) =>
      run.transportDeliveryPhaseDurations[dominantPhase] / run.transportDeliveryPhaseSumMs >=
      bench045Thresholds.dominantTailFraction,
  ).length;
  const preCallbackDeliveryTailFractions = tailRuns.map(
    (run) =>
      run.transportDeliveryPhaseDurations.serverSendToSocketDataCallbackMs /
      run.transportDeliveryPhaseSumMs,
  );
  const reconstructionErrors = validRuns.map((run) => run.transportDeliveryReconstructionErrorMs);
  return {
    validRuns: validRuns.length,
    phaseDistributions,
    responseEgressMs,
    postCallbackMs,
    dominantPhase,
    dominantP95Fraction:
      responseEgressMs.p95 === 0 ? 0 : phaseDistributions[dominantPhase].p95 / responseEgressMs.p95,
    tailIntervals: tailRuns.length,
    dominantTailIntervals,
    preCallbackDeliveryP95Fraction:
      responseEgressMs.p95 === 0
        ? 0
        : phaseDistributions.serverSendToSocketDataCallbackMs.p95 / responseEgressMs.p95,
    preCallbackDeliveryTailFractions,
    preCallbackDeliveryDominatesEveryTail:
      tailRuns.length >= bench045Thresholds.minimumTailIntervals &&
      preCallbackDeliveryTailFractions.every(
        (fraction) => fraction >= bench045Prediction.preCallbackDeliveryTailFraction,
      ),
    reconstructionErrorMs: distribution(reconstructionErrors),
    maximumReconstructionErrorMs: Math.max(0, ...reconstructionErrors),
    crossProcessOrderValid: validRuns.every((run) => run.transportDeliveryCrossProcessOrderValid),
  };
}

function summarizeStandaloneTransportControl(
  runs: BenchmarkRun[],
  controls: StandaloneTransportControl[],
) {
  const validControls = controls.filter((control) => control.safe && control.stderrEmpty);
  const activeByRepetition = new Map(
    runs.flatMap((run) => {
      const activeMs = run.transportDeliveryPhaseDurations?.serverSendToSocketDataCallbackMs;
      return activeMs === undefined ? [] : [[run.repetition, activeMs] as const];
    }),
  );
  const pairs = validControls.flatMap((control) => {
    const activeTuiServerSendToCallbackMs = activeByRepetition.get(control.repetition);
    if (activeTuiServerSendToCallbackMs === undefined) return [];
    return [
      {
        repetition: control.repetition,
        order: control.order,
        activeTuiServerSendToCallbackMs,
        standaloneServerSendToCallbackMs: control.serverSendToCallbackMs,
        activeMinusStandaloneMs: activeTuiServerSendToCallbackMs - control.serverSendToCallbackMs,
      },
    ];
  });
  const activeTuiServerSendToCallbackMs = distribution(
    pairs.map((pair) => pair.activeTuiServerSendToCallbackMs),
  );
  const standaloneServerSendToCallbackMs = distribution(
    validControls.map((control) => control.serverSendToCallbackMs),
  );
  return {
    controls: controls.length,
    validControls: validControls.length,
    pairedRuns: pairs.length,
    uniqueRepetitions: new Set(validControls.map((control) => control.repetition)).size,
    beforeControls: validControls.filter((control) => control.order === "before").length,
    afterControls: validControls.filter((control) => control.order === "after").length,
    activeTuiServerSendToCallbackMs,
    standaloneServerSendToCallbackMs,
    callbackToValidatedMs: distribution(
      validControls.map((control) => control.callbackToValidatedMs),
    ),
    activeMinusStandaloneMs: distribution(pairs.map((pair) => pair.activeMinusStandaloneMs)),
    pairedTuiSlowerSamples: pairs.filter(
      (pair) => pair.activeMinusStandaloneMs >= bench046Thresholds.minimumPairedDifferenceMs,
    ).length,
    standaloneP95ImprovementFraction: improvement(
      activeTuiServerSendToCallbackMs.p95,
      standaloneServerSendToCallbackMs.p95,
    ),
    pairs,
  };
}

function summarizeNativeTuiIdleTransportControl(runs: BenchmarkRun[]) {
  const validRuns = runs.filter(
    (
      run,
    ): run is BenchmarkRun & {
      transportDeliveryPhaseDurations: TransportDeliveryPhaseDurations;
      transportDeliveryReconstructionErrorMs: number;
      idleTransportDeliveryPhaseDurations: TransportDeliveryPhaseDurations;
      idleTransportDeliveryResponseEgressMs: number;
      idleTransportDeliveryCallbackToValidatedMs: number;
      idleTransportDeliveryReconstructionErrorMs: number;
    } =>
      run.transportDeliveryPhaseDurations !== null &&
      run.transportDeliveryReconstructionErrorMs !== null &&
      run.idleTransportDeliveryPhaseDurations !== null &&
      run.idleTransportDeliveryResponseEgressMs !== null &&
      run.idleTransportDeliveryCallbackToValidatedMs !== null &&
      run.idleTransportDeliveryReconstructionErrorMs !== null,
  );
  const pairs = validRuns.map((run) => {
    const activeTuiServerSendToCallbackMs =
      run.transportDeliveryPhaseDurations.serverSendToSocketDataCallbackMs;
    const idleTuiServerSendToCallbackMs =
      run.idleTransportDeliveryPhaseDurations.serverSendToSocketDataCallbackMs;
    return {
      repetition: run.repetition,
      activeTuiServerSendToCallbackMs,
      idleTuiServerSendToCallbackMs,
      activeMinusIdleMs: activeTuiServerSendToCallbackMs - idleTuiServerSendToCallbackMs,
    };
  });
  const activeServerSendToCallbackMs = distribution(
    pairs.map((pair) => pair.activeTuiServerSendToCallbackMs),
  );
  const idleServerSendToCallbackMs = distribution(
    pairs.map((pair) => pair.idleTuiServerSendToCallbackMs),
  );
  const reconstructionErrors = validRuns.flatMap((run) => [
    run.transportDeliveryReconstructionErrorMs,
    run.idleTransportDeliveryReconstructionErrorMs,
  ]);
  return {
    validRuns: validRuns.length,
    uniqueRepetitions: new Set(validRuns.map((run) => run.repetition)).size,
    activeServerSendToCallbackMs,
    idleServerSendToCallbackMs,
    idleResponseEgressMs: distribution(
      validRuns.map((run) => run.idleTransportDeliveryResponseEgressMs),
    ),
    idleCallbackToValidatedMs: distribution(
      validRuns.map((run) => run.idleTransportDeliveryCallbackToValidatedMs),
    ),
    activeMinusIdleMs: distribution(pairs.map((pair) => pair.activeMinusIdleMs)),
    pairedTuiSlowerSamples: pairs.filter(
      (pair) => pair.activeMinusIdleMs >= bench047Thresholds.minimumPairedDifferenceMs,
    ).length,
    idleP95ImprovementFraction: improvement(
      activeServerSendToCallbackMs.p95,
      idleServerSendToCallbackMs.p95,
    ),
    reconstructionErrorMs: distribution(reconstructionErrors),
    maximumReconstructionErrorMs: Math.max(0, ...reconstructionErrors),
    crossProcessOrderValid: validRuns.every(
      (run) =>
        run.transportDeliveryCrossProcessOrderValid &&
        run.idleTransportDeliveryCrossProcessOrderValid,
    ),
    pairs,
  };
}

function summarizeStabilityAdmission(admissions: StabilityAdmission[]) {
  const passedAdmissions = admissions.filter((admission) => admission.passed);
  return {
    admissions: admissions.length,
    validRuns: passedAdmissions.length,
    totalAttempts: admissions.reduce((total, admission) => total + admission.attempts.length, 0),
    waitedMs: distribution(admissions.map((admission) => admission.waitedMs)),
    admittedImmediateTurnP95Ms: distribution(
      passedAdmissions.map((admission) => admission.attempts.at(-1)?.immediateTurnMs.p95 ?? 0),
    ),
    admittedProcessLaunchP95Ms: distribution(
      passedAdmissions.map((admission) => admission.attempts.at(-1)?.processLaunchMs.p95 ?? 0),
    ),
  };
}

function summarizeFocusComparison(runs: BenchmarkRun[]) {
  const escapeRuns = runs.filter((run) => run.focusStrategy === "escape");
  const toggleRuns = runs.filter((run) => run.focusStrategy === "toggle");
  const summarizeStrategy = (strategyRuns: BenchmarkRun[]) => ({
    runs: strategyRuns.length,
    focusToOverlayDismissedMs: distribution(
      strategyRuns.map((run) => run.focusToOverlayDismissedMs),
    ),
    inputSentToAckMs: distribution(strategyRuns.map((run) => run.inputSentToAckMs)),
    focusToInputAckMs: distribution(strategyRuns.map((run) => run.focusToInputAckMs)),
    intentToInteractiveMs: distribution(strategyRuns.map((run) => run.intentToInteractiveMs)),
  });
  const escapeSummary = summarizeStrategy(escapeRuns);
  const toggleSummary = summarizeStrategy(toggleRuns);
  return {
    escape: escapeSummary,
    toggle: toggleSummary,
    focusToInputAckP95ImprovementFraction: improvement(
      escapeSummary.focusToInputAckMs.p95,
      toggleSummary.focusToInputAckMs.p95,
    ),
  };
}

function emptyDistributions() {
  return summarizeRuns([]);
}

function improvement(baseline: number, candidate: number) {
  return baseline === 0 ? 0 : (baseline - candidate) / baseline;
}

async function gitWorktreeCount(root: string) {
  const result = await runCommand("git", ["worktree", "list", "--porcelain"], root);
  return result.stdout.split("\n").filter((line) => line.startsWith("worktree ")).length;
}

async function runCommand(command: string, args: string[], cwd?: string) {
  return execFileAsync(command, args, {
    ...(cwd === undefined ? {} : { cwd }),
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000,
  });
}

async function awaitStabilityAdmission(): Promise<StabilityAdmission> {
  const startedAt = performance.now();
  const deadline = startedAt + bench044Thresholds.stabilityAdmissionTimeoutMs;
  const attempts: StabilityAdmissionAttempt[] = [];
  for (;;) {
    const immediateTurnSamples: number[] = [];
    for (let index = 0; index < 50; index += 1) {
      const turnStartedAt = performance.now();
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      immediateTurnSamples.push(performance.now() - turnStartedAt);
    }
    const processLaunchSamples: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const processStartedAt = performance.now();
      await execFileAsync("/usr/bin/true", [], { timeout: 5_000 });
      processLaunchSamples.push(performance.now() - processStartedAt);
    }
    const immediateTurnMs = distribution(immediateTurnSamples);
    const processLaunchMs = distribution(processLaunchSamples);
    const passed =
      immediateTurnMs.p95 <= bench044Thresholds.immediateTurnP95Ms &&
      processLaunchMs.p95 <= bench044Thresholds.processLaunchP95Ms;
    attempts.push({
      attemptedAt: new Date().toISOString(),
      immediateTurnMs,
      processLaunchMs,
      loadAverage: loadavg(),
      passed,
    });
    if (passed || performance.now() >= deadline) {
      return {
        passed,
        waitedMs: performance.now() - startedAt,
        attempts,
      };
    }
    await delay(1_000);
  }
}

function requestIdFactory(repetition: number) {
  let sequence = 0;
  return () => `req_compiled_tui_${repetition}_${++sequence}`;
}

function resourceDelta(before: NodeJS.ResourceUsage, after: NodeJS.ResourceUsage) {
  return {
    userCpuMs: (after.userCPUTime - before.userCPUTime) / 1000,
    systemCpuMs: (after.systemCPUTime - before.systemCPUTime) / 1000,
    fsReads: after.fsRead - before.fsRead,
    fsWrites: after.fsWrite - before.fsWrite,
    voluntaryContextSwitches: after.voluntaryContextSwitches - before.voluntaryContextSwitches,
    involuntaryContextSwitches:
      after.involuntaryContextSwitches - before.involuntaryContextSwitches,
  };
}

function unavailableHostError(handle: Exclude<StationHostHandle, { status: "running" }>) {
  return new Error(handle.error.message);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForIdleTransportProbeCompletion(
  path: string,
  expectedRequestId: string,
  timeoutMs: number,
) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const raw = await readFile(path, "utf8").catch(() => undefined);
    if (raw !== undefined) {
      const parsedJson = (() => {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return undefined;
        }
      })();
      const parsed = idleTransportProbeCompletionSchema.safeParse(parsedJson);
      if (parsed.success) {
        if (parsed.data.requestId !== expectedRequestId || parsed.data.status !== "complete") {
          throw new Error(
            `Native idle transport probe did not complete with exact identity: ${JSON.stringify(parsed.data)}`,
          );
        }
        return parsed.data;
      }
    }
    if (performance.now() >= deadline) {
      throw new Error("Native idle transport probe did not write a strict completion sentinel.");
    }
    await delay(5);
  }
}

function delay(ms: number) {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function pathExists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

function diagnosticError(error: unknown) {
  const parsed = z.object({ message: z.string().min(1) }).safeParse(error);
  return parsed.success ? parsed.data.message : "Unknown compiled native TUI benchmark failure.";
}
