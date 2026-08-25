import type { ExactObserverOwnershipEvidence } from "@station/observer/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  convergeExactObserverBuild,
  type ExactObserverConvergenceCommand,
  ensureExactObserverBuild,
  parseExactObserverConvergenceCommand,
} from "../../../src/observerProcess/convergeExactObserverBuild.js";

const ensureAdapters = vi.hoisted(() => ({
  inspect: vi.fn(),
  start: vi.fn(),
  withSession: vi.fn(),
}));

vi.mock("../../../src/observerProcess/inspectExactObserverOwner.js", async (importActual) => ({
  ...(await importActual()),
  inspectExactObserverOwnerWithLocalAdapters: (...args: unknown[]) =>
    ensureAdapters.inspect(...args),
}));
vi.mock("../../../src/observerProcess.js", async (importActual) => ({
  ...(await importActual()),
  startObserverPreservingIncumbent: (...args: unknown[]) => ensureAdapters.start(...args),
}));
vi.mock("@station/protocol", async (importActual) => ({
  ...(await importActual()),
  withExactObserverLifecycleSession: (...args: unknown[]) => ensureAdapters.withSession(...args),
}));

const socketPath = "/tmp/station/observer.sock";
const targetSelector = `1.2.3+station.${"a".repeat(64)}`;
const processToken = "00000000-0000-4000-8000-000000000001";
const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
type ExactObserverConvergenceDependencies = Parameters<typeof convergeExactObserverBuild>[1];
type ExactEvidence = Extract<ExactObserverOwnershipEvidence, { status: "exact" }>;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(nowMs);
  ensureAdapters.inspect.mockReset();
  ensureAdapters.start.mockReset();
  ensureAdapters.withSession.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("exact Observer convergence command", () => {
  it("parses current start and restart commands", () => {
    expect(parse(startCommand())).toEqual(startCommand());
    expect(parse(restartCommand())).toEqual(restartCommand());
  });

  it("strictly rejects unknown, historical, explicit-undefined, and cross-action fields", () => {
    expect(() => parse({ ...startCommand(), schemaVersion: 1 })).toThrow();
    expect(() => parse({ ...startCommand(), compatibility: "legacy" })).toThrow();
    expect(() => parse({ ...startCommand(), targetSelector: undefined })).toThrow();
    expect(() =>
      parse({
        ...startCommand(),
        expected: { status: "absent", process: restartCommand().expected.process },
      }),
    ).toThrow();
  });

  it.each([
    ["null", null],
    ["array", []],
    ["missing action", { targetSelector, deadlineMs: nowMs + 10_000 }],
    ["unknown action", { ...startCommand(), action: "ensure" }],
    ["non-integer deadline", { ...startCommand(), deadlineMs: nowMs + 0.5 }],
    ["unsafe deadline", { ...startCommand(), deadlineMs: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects a %s command boundary", (_name, command) => {
    expect(() => parse(command)).toThrow();
  });

  it.each([
    ["health", (command: RestartInput) => Object.assign(command.expected.health, { legacy: true })],
    [
      "pidfile identity",
      (command: RestartInput) => Object.assign(command.expected.processIdentity, { legacy: true }),
    ],
    [
      "process",
      (command: RestartInput) => Object.assign(command.expected.process, { legacy: true }),
    ],
    [
      "recovery",
      (command: RestartInput) => Object.assign(command.expected.recovery, { legacy: true }),
    ],
    [
      "selected handle",
      (command: RestartInput) =>
        Object.assign(command.expected.recovery.selectedHandles[0] ?? {}, { legacy: true }),
    ],
  ])("rejects unknown nested %s evidence", (_name, extend) => {
    const command = restartCommand();
    extend(command);
    expect(() => parse(command)).toThrow();
  });

  it("rejects invalid targets, target substitution, and expired deadlines", () => {
    expect(() => parse({ ...startCommand(), targetSelector: "1.2.3" })).toThrow();
    const malformed = `not-semver+station.${"a".repeat(64)}`;
    expect(() => parse({ ...startCommand(), targetSelector: malformed }, malformed)).toThrow();
    expect(() => parse(startCommand(), `1.2.3+station.${"b".repeat(64)}`)).toThrow();
    expect(() => parse({ ...startCommand(), deadlineMs: nowMs })).toThrow();
  });

  it.each([
    ["PID", (command: RestartInput) => (command.expected.process.pid += 1)],
    ["build", (command: RestartInput) => (command.expected.process.buildVersion = otherBuild())],
    ["socket", (command: RestartInput) => (command.expected.process.socketPath += ".other")],
    ["OS start", (command: RestartInput) => (command.expected.process.startToken += " drift")],
    [
      "process token",
      (command: RestartInput) => (command.expected.process.processToken = otherToken()),
    ],
  ])("rejects cross-correlated %s evidence drift", (_name, mutate) => {
    const command = restartCommand();
    mutate(command);
    expect(() => parse(command)).toThrow();
  });

  it("requires complete process and assessed, canonically selected recovery evidence", () => {
    const missingStartup = restartCommand();
    Reflect.deleteProperty(missingStartup.expected.process, "startupTimeoutMs");
    expect(() => parse(missingStartup)).toThrow();

    const unknownRecovery = restartCommand();
    expect(() =>
      parse({
        ...unknownRecovery,
        expected: {
          ...unknownRecovery.expected,
          recovery: { status: "unknown", selectedHandles: [] },
        },
      }),
    ).toThrow();

    const duplicateSessions = restartCommand();
    duplicateSessions.expected.recovery.selectedHandles.push({
      sessionId: "session-1",
      selectedHandleId: "handle-2",
    });
    expect(() => parse(duplicateSessions)).toThrow();

    const unsortedSessions = restartCommand();
    unsortedSessions.expected.recovery.selectedHandles.unshift({
      sessionId: "session-2",
      selectedHandleId: "handle-2",
    });
    expect(() => parse(unsortedSessions)).toThrow();
  });

  it("uses a detached clone as the only command authority", () => {
    const input = restartCommand();
    const parsed = parse(input);
    input.expected.process.argv[0] = "/tmp/substituted";
    const selected = input.expected.recovery.selectedHandles[0];
    if (selected === undefined) throw new Error("expected selected recovery handle");
    selected.selectedHandleId = "substituted";

    expect(parsed).not.toBe(input);
    expect(parsed.expected).not.toBe(input.expected);
    expect(parsed).toMatchObject({
      expected: {
        process: { argv: ["/opt/station/stn", "__observer"] },
        recovery: {
          selectedHandles: [{ sessionId: "session-1", selectedHandleId: "handle-1" }],
        },
      },
    });
  });
});

describe("exact Observer convergence lifecycle", () => {
  it("preserves standalone exact reuse without stop or spawn", async () => {
    const start = vi.fn();
    ensureAdapters.inspect.mockResolvedValue(exactEvidence());
    ensureAdapters.start.mockImplementation(start);
    const result = await ensureExactObserverBuild(
      { paths: dependencies({}).paths, timeoutMs: 10_000 },
      { buildVersion: targetSelector },
    );

    expect(result).toMatchObject({ status: "running", lifecycle: "reused" });
    expect(ensureAdapters.start).not.toHaveBeenCalled();
    expect(ensureAdapters.withSession).not.toHaveBeenCalled();
  });

  it("refuses standalone reuse when its inspection crosses the absolute deadline", async () => {
    ensureAdapters.inspect.mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(nowMs + 10_000);
      return exactEvidence();
    });

    await expect(
      ensureExactObserverBuild(
        { paths: dependencies({}).paths, timeoutMs: 10_000 },
        { buildVersion: targetSelector },
      ),
    ).resolves.toMatchObject({
      status: "unhealthy",
      phase: "inspection",
      cause: { code: "OBSERVER_EXACT_DEADLINE_EXCEEDED" },
    });
    expect(ensureAdapters.start).not.toHaveBeenCalled();
    expect(ensureAdapters.withSession).not.toHaveBeenCalled();
  });

  it("preserves stale child-owned startup and independently verifies it", async () => {
    const start = vi.fn(async () => runningStatus(exactEvidence()));
    ensureAdapters.start.mockImplementation(start);
    ensureAdapters.inspect
      .mockResolvedValueOnce({ status: "blocked", reason: "stale-socket" })
      .mockResolvedValueOnce(exactEvidence());
    const result = await ensureExactObserverBuild(
      { paths: dependencies({}).paths, timeoutMs: 10_000 },
      { buildVersion: targetSelector },
    );

    expect(result).toMatchObject({ status: "running", lifecycle: "started" });
    expect(ensureAdapters.start).toHaveBeenCalledOnce();
    expect(ensureAdapters.inspect).toHaveBeenCalledTimes(2);
  });

  it("delegates standalone absence through fresh admission, preserved startup, and final proof", async () => {
    const successor = exactEvidence();
    ensureAdapters.inspect
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce(successor);
    ensureAdapters.start.mockResolvedValue(runningStatus(successor));

    await expect(
      ensureExactObserverBuild(
        { paths: dependencies({}).paths, timeoutMs: 10_000 },
        { buildVersion: targetSelector },
      ),
    ).resolves.toMatchObject({ status: "running", lifecycle: "started" });
    expect(ensureAdapters.inspect).toHaveBeenCalledTimes(3);
    expect(ensureAdapters.start).toHaveBeenCalledOnce();
    expect(ensureAdapters.start.mock.calls[0]?.[0]).toMatchObject({
      startupDeadlineMs: nowMs + 10_000,
    });
    expect(ensureAdapters.withSession).not.toHaveBeenCalled();
  });

  it("delegates standalone replacement through one pinned stop and preserved startup", async () => {
    const incumbent = nonTargetEvidence();
    const successor = newGeneration(exactEvidence());
    const stop = vi.fn();
    ensureAdapters.inspect
      .mockResolvedValueOnce(incumbent)
      .mockResolvedValueOnce(incumbent)
      .mockResolvedValueOnce(successor);
    ensureAdapters.start.mockResolvedValue(runningStatus(successor));
    ensureAdapters.withSession.mockImplementation(sessionRunner(stop));

    await expect(
      ensureExactObserverBuild(
        { paths: dependencies({}).paths, timeoutMs: 10_000 },
        { buildVersion: targetSelector },
      ),
    ).resolves.toMatchObject({ status: "running", lifecycle: "replaced" });
    expect(ensureAdapters.inspect).toHaveBeenCalledTimes(3);
    expect(ensureAdapters.withSession).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(ensureAdapters.start).toHaveBeenCalledOnce();
  });

  it("deep-clones a constructed standalone restart before its pinned-session await", async () => {
    const initial = nonTargetEvidence();
    const admitted = nonTargetEvidence();
    const successor = newGeneration(exactEvidence());
    const stop = vi.fn();
    ensureAdapters.inspect
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(admitted)
      .mockResolvedValueOnce(successor);
    ensureAdapters.start.mockResolvedValue(runningStatus(successor));
    ensureAdapters.withSession.mockImplementation(
      sessionRunner(stop, () => {
        Object.assign(initial.processIdentity, { pid: 99 });
        Object.assign(initial.process, { pid: 99, argv: ["/tmp/substituted"] });
      }),
    );

    await expect(
      ensureExactObserverBuild(
        { paths: dependencies({}).paths, timeoutMs: 10_000 },
        { buildVersion: targetSelector },
      ),
    ).resolves.toMatchObject({ status: "running", lifecycle: "replaced" });
    expect(stop).toHaveBeenCalledOnce();
    expect(ensureAdapters.start).toHaveBeenCalledOnce();
  });

  it("starts only after a fresh exact absence proof and independently proves the target", async () => {
    const start = vi.fn(async () => runningStatus(exactEvidence()));
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce(exactEvidence());

    await expect(
      convergeExactObserverBuild(startCommand(), dependencies({ inspect, start })),
    ).resolves.toMatchObject({ status: "running", lifecycle: "started" });
    expect(inspect.mock.invocationCallOrder[0]).toBeLessThan(
      start.mock.invocationCallOrder[0] ?? 0,
    );
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("independently re-proves a target that wins after the expected absence", async () => {
    const winner = exactEvidence();
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce(winner)
      .mockResolvedValueOnce(winner);
    const start = vi.fn();

    await expect(
      convergeExactObserverBuild(startCommand(), dependencies({ inspect, start })),
    ).resolves.toMatchObject({ status: "running", lifecycle: "started" });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
  });

  it("preserves a non-target that replaces a target admission race before final proof", async () => {
    const target = exactEvidence();
    const winner = nonTargetEvidence();
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(winner);
    const start = vi.fn();
    const withSession = vi.fn();

    await expect(
      convergeExactObserverBuild(startCommand(), dependencies({ inspect, start, withSession })),
    ).resolves.toMatchObject({
      status: "unhealthy",
      phase: "verification",
      incumbentDisposition: "unknown",
      cause: { code: "OBSERVER_EXACT_TARGET_MISMATCH" },
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
    expect(withSession).not.toHaveBeenCalled();
  });

  it("retains blocked admission errors without claiming a preserved incumbent", async () => {
    const error = {
      tag: "ObserverInspectionError",
      code: "OBSERVER_IDENTITY_UNAVAILABLE",
      message: "Observer identity could not be inspected.",
    };
    const start = vi.fn();
    const withSession = vi.fn();
    const result = await convergeExactObserverBuild(
      startCommand(),
      dependencies({
        inspect: async () => ({ status: "blocked", reason: "identity-unavailable", error }),
        start,
        withSession,
      }),
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      phase: "inspection",
      incumbentDisposition: "unknown",
      cause: { code: error.code },
    });
    expect(start).not.toHaveBeenCalled();
    expect(withSession).not.toHaveBeenCalled();
  });

  it.each([
    ["stale-socket", "OBSERVER_EXACT_INSPECTION_STALE_SOCKET"],
    ["unhealthy", "OBSERVER_EXACT_INSPECTION_UNHEALTHY"],
    ["identity-missing", "OBSERVER_EXACT_INSPECTION_IDENTITY_MISSING"],
    ["identity-unavailable", "OBSERVER_EXACT_INSPECTION_IDENTITY_UNAVAILABLE"],
    ["identity-mismatch", "OBSERVER_EXACT_INSPECTION_IDENTITY_MISMATCH"],
    ["identity-drift", "OBSERVER_EXACT_INSPECTION_IDENTITY_DRIFT"],
    ["process-without-socket", "OBSERVER_EXACT_INSPECTION_PROCESS_WITHOUT_SOCKET"],
  ] as const)("maps reason-only delegated %s admission to %s", async (reason, code) => {
    const start = vi.fn();
    const withSession = vi.fn();
    const result = await convergeExactObserverBuild(
      startCommand(),
      dependencies({ inspect: async () => ({ status: "blocked", reason }), start, withSession }),
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      phase: "inspection",
      incumbentDisposition: "unknown",
      cause: { code },
    });
    expect(start).not.toHaveBeenCalled();
    expect(withSession).not.toHaveBeenCalled();
  });

  it.each([
    ["identity-missing", "OBSERVER_EXACT_INSPECTION_IDENTITY_MISSING"],
    ["identity-mismatch", "OBSERVER_EXACT_INSPECTION_IDENTITY_MISMATCH"],
    ["identity-drift", "OBSERVER_EXACT_INSPECTION_IDENTITY_DRIFT"],
    ["process-without-socket", "OBSERVER_EXACT_INSPECTION_PROCESS_WITHOUT_SOCKET"],
  ] as const)("maps reason-only standalone %s inspection to %s", async (reason, code) => {
    ensureAdapters.inspect.mockResolvedValue({ status: "blocked", reason });

    await expect(
      ensureExactObserverBuild(
        { paths: dependencies({}).paths, timeoutMs: 10_000 },
        { buildVersion: targetSelector },
      ),
    ).resolves.toMatchObject({
      status: "unhealthy",
      phase: "inspection",
      incumbentDisposition: "unknown",
      cause: { code },
    });
    expect(ensureAdapters.start).not.toHaveBeenCalled();
    expect(ensureAdapters.withSession).not.toHaveBeenCalled();
  });

  it("retains unknown exact admission errors without spawning", async () => {
    const error = {
      tag: "ObserverInspectionError",
      code: "OBSERVER_RECOVERY_ASSESSMENT_FAILED",
      message: "Observer recovery evidence could not be inspected.",
    };
    const exact = exactEvidence();
    const start = vi.fn();
    const withSession = vi.fn();
    const result = await convergeExactObserverBuild(
      startCommand(),
      dependencies({
        inspect: async () => ({ ...exact, recovery: { status: "unknown" as const, error } }),
        start,
        withSession,
      }),
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      phase: "inspection",
      incumbentDisposition: "unknown",
      cause: { code: error.code },
    });
    expect(start).not.toHaveBeenCalled();
    expect(withSession).not.toHaveBeenCalled();
  });

  it("reports preserved only for a complete exact non-target generation", async () => {
    const nonTarget = nonTargetEvidence();
    const inspect = vi.fn(async () => nonTarget);
    const start = vi.fn();
    const withSession = vi.fn();
    const result = await convergeExactObserverBuild(
      startCommand(),
      dependencies({ inspect, start, withSession }),
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      phase: "inspection",
      incumbentDisposition: "preserved",
      cause: { code: "OBSERVER_EXACT_EVIDENCE_DRIFT" },
    });
    expect(inspect).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(withSession).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid command", { ...startCommand(), unexpected: true }, "OBSERVER_EXACT_COMMAND_INVALID"],
    [
      "expired deadline",
      { ...startCommand(), deadlineMs: nowMs },
      "OBSERVER_EXACT_DEADLINE_EXCEEDED",
    ],
  ])("returns a stable cause for %s", async (_case, command, code) => {
    const inspect = vi.fn();
    const start = vi.fn();
    const withSession = vi.fn();
    await expect(
      convergeExactObserverBuild(command, dependencies({ inspect, start, withSession })),
    ).resolves.toMatchObject({
      status: "unhealthy",
      phase: "inspection",
      incumbentDisposition: "unknown",
      cause: { code },
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(withSession).not.toHaveBeenCalled();
  });

  it("classifies pinned connection uncertainty without starting", async () => {
    const command = restartCommand();
    const incumbent = exactEvidence(command);
    const start = vi.fn();
    const result = await convergeExactObserverBuild(
      command,
      dependencies({
        inspect: async () => incumbent,
        start,
        withSession: (async () => {
          throw new Error("connection closed before stop receipt");
        }) as ExactObserverConvergenceDependencies["withSession"],
      }),
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      phase: "stop",
      incumbentDisposition: "unknown",
      cause: { code: "OBSERVER_EXACT_STOP_UNCERTAIN" },
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects provenance-only drift of the admitted process after stop uncertainty", async () => {
    const command = restartCommand();
    const incumbent = exactEvidence(command);
    const inspect = vi.fn(async () =>
      withProcess(incumbent, { executableProvenance: "installed-path-replaced" }),
    );
    const start = vi.fn();

    await expect(
      convergeExactObserverBuild(
        command,
        dependencies({
          inspect,
          start,
          withSession: async () => {
            throw new Error("connection closed before stop");
          },
        }),
      ),
    ).resolves.toMatchObject({
      status: "unhealthy",
      phase: "stop",
      incumbentDisposition: "unknown",
      cause: { code: "OBSERVER_EXACT_STOP_UNCERTAIN" },
    });
    expect(inspect).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });

  it("classifies a failed independent winner proof as target mismatch", async () => {
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce(exactEvidence())
      .mockResolvedValueOnce({ status: "absent" });
    const start = vi.fn();
    const result = await convergeExactObserverBuild(
      startCommand(),
      dependencies({ inspect, start }),
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      phase: "verification",
      incumbentDisposition: "unknown",
      cause: { code: "OBSERVER_EXACT_TARGET_MISMATCH" },
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
  });

  it("retains a returned blocked final inspection cause", async () => {
    const error = {
      tag: "ObserverInspectionError",
      code: "OBSERVER_FINAL_IDENTITY_UNAVAILABLE",
      message: "Final Observer identity could not be inspected.",
    };
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "blocked", reason: "identity-unavailable", error });
    const start = vi.fn(async () => runningStatus(exactEvidence()));

    await expect(
      convergeExactObserverBuild(startCommand(), dependencies({ inspect, start })),
    ).resolves.toMatchObject({
      status: "unhealthy",
      phase: "verification",
      cause: { code: error.code },
    });
    expect(start).toHaveBeenCalledOnce();
  });

  it("retains a thrown final inspection cause", async () => {
    const error = {
      tag: "ObserverInspectionError",
      code: "OBSERVER_FINAL_INSPECTION_FAILED",
      message: "Final Observer inspection failed.",
    };
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce({ status: "absent" })
      .mockRejectedValueOnce(error);
    const start = vi.fn(async () => runningStatus(exactEvidence()));

    await expect(
      convergeExactObserverBuild(startCommand(), dependencies({ inspect, start })),
    ).resolves.toMatchObject({
      status: "unhealthy",
      phase: "verification",
      cause: { code: error.code },
    });
    expect(start).toHaveBeenCalledOnce();
  });

  it("retains the actual child startup cause and evidence without a stop", async () => {
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "absent" });
    const start = vi.fn(async () => ({
      status: "unhealthy" as const,
      paths: dependencies({}).paths,
      error: {
        tag: "ObserverStartupError",
        code: "OBSERVER_START_FAILED",
        message: "Observer startup failed.",
        traceId: "trc_start",
      },
      cause: {
        tag: "ObserverProcessEvidenceError",
        code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
        message: "Observer executable evidence drifted.",
      },
      startupEvidence: { bootLogPath: "/tmp/station/logs/observer-boot.log" },
    }));

    await expect(
      convergeExactObserverBuild(startCommand(), dependencies({ inspect, start })),
    ).resolves.toMatchObject({
      status: "unhealthy",
      error: { code: "OBSERVER_EXACT_BUILD_ACTIVATION_FAILED" },
      cause: { code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH" },
      startupEvidence: { bootLogPath: "/tmp/station/logs/observer-boot.log" },
      phase: "start",
      incumbentDisposition: "none",
    });
    expect(start).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("keeps the detached parsed restart command authoritative across the first await", async () => {
    const input = restartCommand();
    const admitted = exactEvidence(restartCommand());
    const successor = newGeneration(admitted);
    const stop = vi.fn();
    const start = vi.fn(async () => runningStatus(successor));
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce(admitted)
      .mockResolvedValueOnce(successor);
    const withSession = sessionRunner(stop, () => {
      input.expected.health.pid = 99;
      input.expected.processIdentity.pid = 99;
      input.expected.process.pid = 99;
    });

    await expect(
      convergeExactObserverBuild(input, dependencies({ inspect, start, withSession })),
    ).resolves.toMatchObject({ status: "running", lifecycle: "replaced" });
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it.each([
    "status",
    "startedAt",
  ] as const)("keeps %s authority detached from a mutating lifecycle port", async (field) => {
    const command = restartCommand();
    const incumbent = exactEvidence(command);
    const changedStartedAt = "2026-08-24T12:00:02.000Z";
    const drift =
      field === "status" ? { status: "degraded" as const } : { startedAt: changedStartedAt };
    const stop = vi.fn();
    const start = vi.fn();
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce(withHealth(incumbent, drift))
      .mockResolvedValueOnce(incumbent);
    const withSession: ExactObserverConvergenceDependencies["withSession"] = async (
      request,
      task,
    ) => {
      Object.assign(request.health, drift);
      return task({ health: vi.fn(), getSessionRecoveryAssessment: vi.fn(), stop });
    };

    await expect(
      convergeExactObserverBuild(command, dependencies({ inspect, start, withSession })),
    ).resolves.toMatchObject({
      status: "unhealthy",
      phase: "stop",
      incumbentDisposition: "unknown",
      cause: { code: "OBSERVER_EXACT_EVIDENCE_DRIFT" },
    });
    expect(command.expected.health).toMatchObject({
      status: "healthy",
      startedAt: "2026-08-24T11:59:00.000Z",
    });
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("preserves a later non-target winner after one admitted start", async () => {
    const target = exactEvidence();
    const winner = {
      ...target,
      health: { ...target.health, version: otherBuild() },
      processIdentity: { ...target.processIdentity, version: otherBuild() },
      process: { ...target.process, buildVersion: otherBuild() },
    };
    const start = vi.fn(async () => runningStatus(winner));
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce(winner);

    const result = await convergeExactObserverBuild(
      startCommand(),
      dependencies({ inspect, start }),
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      phase: "verification",
      incumbentDisposition: "none",
      cause: { code: "OBSERVER_EXACT_TARGET_MISMATCH" },
    });
    expect(start).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["health status", (value: ExactEvidence) => withHealth(value, { status: "degraded" })],
    ["health pid", (value: ExactEvidence) => withHealth(value, { pid: 99 })],
    [
      "health startedAt",
      (value: ExactEvidence) => withHealth(value, { startedAt: "2026-08-24T12:00:02.000Z" }),
    ],
    ["health version", (value: ExactEvidence) => withHealth(value, { version: otherBuild() })],
    [
      "health socketPath",
      (value: ExactEvidence) => withHealth(value, { socketPath: `${socketPath}.other` }),
    ],
    ["pidfile pid", (value: ExactEvidence) => withIdentity(value, { pid: 99 })],
    [
      "pidfile osStartTime",
      (value: ExactEvidence) => withIdentity(value, { osStartTime: "Mon Aug 24 12:00:02 2026" }),
    ],
    [
      "pidfile processToken",
      (value: ExactEvidence) => withIdentity(value, { processToken: otherToken() }),
    ],
    ["pidfile version", (value: ExactEvidence) => withIdentity(value, { version: otherBuild() })],
    [
      "pidfile socketPath",
      (value: ExactEvidence) => withIdentity(value, { socketPath: `${socketPath}.other` }),
    ],
    ["process pid", (value: ExactEvidence) => withProcess(value, { pid: 99 })],
    [
      "process argv",
      (value: ExactEvidence) => withProcess(value, { argv: [...value.process.argv, "--drift"] }),
    ],
    [
      "process executablePath",
      (value: ExactEvidence) => withProcess(value, { executablePath: "/other/stn" }),
    ],
    [
      "process startToken",
      (value: ExactEvidence) => withProcess(value, { startToken: "Mon Aug 24 12:00:02 2026" }),
    ],
    [
      "process processToken",
      (value: ExactEvidence) => withProcess(value, { processToken: otherToken() }),
    ],
    [
      "process buildVersion",
      (value: ExactEvidence) => withProcess(value, { buildVersion: otherBuild() }),
    ],
    [
      "process socketPath",
      (value: ExactEvidence) => withProcess(value, { socketPath: `${socketPath}.other` }),
    ],
    [
      "process startupTimeoutMs",
      (value: ExactEvidence) => withProcess(value, { startupTimeoutMs: 9_999 }),
    ],
    [
      "executable provenance",
      (value: ExactEvidence) =>
        withProcess(value, { executableProvenance: "installed-path-replaced" }),
    ],
    ["selected sessionId", (value: ExactEvidence) => driftSelected(value, "session")],
    ["selected handleId", (value: ExactEvidence) => driftSelected(value, "handle")],
    ["missing selected handle", (value: ExactEvidence) => driftSelected(value, "missing")],
    ["additional selected handle", (value: ExactEvidence) => driftSelected(value, "extra")],
  ])("refuses current %s drift before stop", async (_field, drift) => {
    const command = restartCommand();
    const incumbent = exactEvidence(command);
    const stop = vi.fn();
    const start = vi.fn();
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce(drift(incumbent))
      .mockResolvedValueOnce(incumbent);

    const result = await convergeExactObserverBuild(
      command,
      dependencies({ inspect, start, withSession: sessionRunner(stop) }),
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      phase: "stop",
      incumbentDisposition: "unknown",
      cause: { code: "OBSERVER_EXACT_EVIDENCE_DRIFT" },
    });
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("accepts a complete target generation that independently wins before stop", async () => {
    const command = restartCommand();
    const successor = newGeneration(exactEvidence(command));
    const stop = vi.fn();
    const start = vi.fn();
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce(successor)
      .mockResolvedValueOnce(successor);

    await expect(
      convergeExactObserverBuild(
        command,
        dependencies({ inspect, start, withSession: sessionRunner(stop) }),
      ),
    ).resolves.toMatchObject({
      status: "running",
      lifecycle: "replaced",
      health: { pid: successor.health.pid },
    });
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("preserves a complete non-target generation that wins before stop", async () => {
    const command = restartCommand();
    const winner = newGeneration(nonTargetEvidence());
    const stop = vi.fn();
    const start = vi.fn();
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce(winner)
      .mockResolvedValueOnce(winner);

    await expect(
      convergeExactObserverBuild(
        command,
        dependencies({ inspect, start, withSession: sessionRunner(stop) }),
      ),
    ).resolves.toMatchObject({
      status: "unhealthy",
      phase: "stop",
      incumbentDisposition: "unknown",
      cause: { code: "OBSERVER_EXACT_EVIDENCE_DRIFT" },
    });
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("stops on the inspected session, starts once, and accepts only a new target generation", async () => {
    const command = restartCommand();
    const incumbent = exactEvidence(command);
    const successor = newGeneration(incumbent);
    const stop = vi.fn(async () => ({
      schemaVersion: "0.11.0",
      stopped: true,
      at: "2026-08-24T12:00:01.000Z",
    }));
    const start = vi.fn(async () => runningStatus(successor));
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce(incumbent)
      .mockResolvedValueOnce(successor);
    const withSession = vi.fn(sessionRunner(stop));

    await expect(
      convergeExactObserverBuild(command, dependencies({ inspect, start, withSession })),
    ).resolves.toMatchObject({
      status: "running",
      lifecycle: "replaced",
      health: { pid: 43 },
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(withSession.mock.calls[0]?.[0]).toEqual({
      health: command.expected.health,
      deadlineMs: command.deadlineMs,
    });
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0] ?? 0);
  });

  it("refuses the unchanged admitted generation after a successful stop and start attempt", async () => {
    const command = restartCommand();
    const incumbent = exactEvidence(command);
    const stop = vi.fn();
    const start = vi.fn(async () => runningStatus(newGeneration(incumbent)));
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce(incumbent)
      .mockResolvedValueOnce(incumbent);

    await expect(
      convergeExactObserverBuild(
        command,
        dependencies({ inspect, start, withSession: sessionRunner(stop) }),
      ),
    ).resolves.toMatchObject({
      status: "unhealthy",
      phase: "verification",
      incumbentDisposition: "stopped",
      cause: { code: "OBSERVER_EXACT_TARGET_MISMATCH" },
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("preserves a later non-target winner after a successful exact restart mutation", async () => {
    const command = restartCommand();
    const incumbent = exactEvidence(command);
    const winner = newGeneration(nonTargetEvidence());
    const stop = vi.fn();
    const start = vi.fn(async () => runningStatus(winner));
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce(incumbent)
      .mockResolvedValueOnce(winner);

    await expect(
      convergeExactObserverBuild(
        command,
        dependencies({ inspect, start, withSession: sessionRunner(stop) }),
      ),
    ).resolves.toMatchObject({
      status: "unhealthy",
      phase: "verification",
      incumbentDisposition: "stopped",
      cause: { code: "OBSERVER_EXACT_TARGET_MISMATCH" },
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["inspection", "inspection", "unknown", 0],
    ["pre-start", "start", "none", 0],
    ["final proof", "verification", "none", 1],
  ] as const)("maps absolute deadline exhaustion at %s without extra mutation", async (stage, phase, disposition, starts) => {
    const deadlineMs = startCommand().deadlineMs;
    const inspect = vi.fn<ExactObserverConvergenceDependencies["inspect"]>();
    const start = vi.fn(async () => {
      if (stage === "final proof")
        vi.mocked(Date.now).mockReturnValueOnce(nowMs).mockReturnValue(deadlineMs);
      return runningStatus(exactEvidence());
    });
    if (stage === "inspection") {
      inspect.mockImplementationOnce(async () => {
        vi.mocked(Date.now).mockReturnValue(deadlineMs);
        throw new Error("inspection crossed the deadline");
      });
    } else {
      inspect.mockImplementationOnce(async () => {
        if (stage === "pre-start")
          vi.mocked(Date.now).mockReturnValueOnce(nowMs).mockReturnValue(deadlineMs);
        return { status: "absent" };
      });
    }

    await expect(
      convergeExactObserverBuild(startCommand(), dependencies({ inspect, start })),
    ).resolves.toMatchObject({
      status: "unhealthy",
      phase,
      incumbentDisposition: disposition,
      cause: { code: "OBSERVER_EXACT_DEADLINE_EXCEEDED" },
    });
    expect(start).toHaveBeenCalledTimes(starts);
  });

  it("refuses a final exact proof that resolves after the absolute deadline", async () => {
    const inspect = vi
      .fn<ExactObserverConvergenceDependencies["inspect"]>()
      .mockResolvedValueOnce({ status: "absent" })
      .mockImplementationOnce(async () => {
        vi.mocked(Date.now).mockReturnValue(startCommand().deadlineMs);
        return exactEvidence();
      });
    const start = vi.fn(async () => runningStatus(exactEvidence()));

    await expect(
      convergeExactObserverBuild(startCommand(), dependencies({ inspect, start })),
    ).resolves.toMatchObject({
      status: "unhealthy",
      phase: "verification",
      cause: { code: "OBSERVER_EXACT_DEADLINE_EXCEEDED" },
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledOnce();
  });

  it("maps pinned-session deadline exhaustion before stop without spawning", async () => {
    const command = restartCommand();
    const inspect = vi.fn(async () => exactEvidence(command));
    const start = vi.fn();
    const withSession = vi.fn(async () => {
      vi.mocked(Date.now).mockReturnValue(command.deadlineMs);
      throw new Error("pinned session crossed the deadline");
    });

    await expect(
      convergeExactObserverBuild(command, dependencies({ inspect, start, withSession })),
    ).resolves.toMatchObject({
      status: "unhealthy",
      phase: "stop",
      incumbentDisposition: "unknown",
      cause: { code: "OBSERVER_EXACT_DEADLINE_EXCEEDED" },
    });
    expect(withSession).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });
});

type RestartInput = ReturnType<typeof restartCommand>;

function parse(value: unknown, executingTarget = targetSelector): ExactObserverConvergenceCommand {
  return parseExactObserverConvergenceCommand(value, {
    targetSelector: executingTarget,
    nowMs,
  });
}

function startCommand() {
  return {
    action: "start-if-absent" as const,
    targetSelector,
    deadlineMs: nowMs + 10_000,
    expected: { status: "absent" as const },
  };
}

function restartCommand() {
  return {
    action: "restart-exact" as const,
    targetSelector,
    deadlineMs: nowMs + 10_000,
    expected: {
      status: "exact" as const,
      health: {
        status: "healthy" as const,
        pid: 42,
        startedAt: "2026-08-24T11:59:00.000Z",
        version: targetSelector,
        socketPath,
      },
      processIdentity: {
        pid: 42,
        osStartTime: "Mon Aug 24 11:59:00 2026",
        processToken,
        version: targetSelector,
        socketPath,
      },
      process: {
        pid: 42,
        argv: ["/opt/station/stn", "__observer"],
        executablePath: "/opt/station/stn",
        startToken: "Mon Aug 24 11:59:00 2026",
        processToken,
        buildVersion: targetSelector,
        socketPath,
        startupTimeoutMs: 10_000,
        executableProvenance: "exact" as const,
      },
      recovery: {
        status: "assessed" as const,
        selectedHandles: [{ sessionId: "session-1", selectedHandleId: "handle-1" }],
      },
    },
  };
}

function otherBuild(): string {
  return `1.2.3+station.${"b".repeat(64)}`;
}

function otherToken(): string {
  return "00000000-0000-4000-8000-000000000002";
}

function dependencies(
  overrides: Partial<ExactObserverConvergenceDependencies>,
): ExactObserverConvergenceDependencies {
  return {
    paths: {
      stateDir: "/tmp/station",
      socketPath,
      dbPath: "/tmp/station/station.db",
      logDir: "/tmp/station/logs",
      diagnosticsDir: "/tmp/station/diagnostics",
      hookSpoolDir: "/tmp/station/hooks",
    },
    targetSelector,
    inspect: async () => ({ status: "absent" }),
    start: async () => runningStatus(exactEvidence()),
    withSession: vi.fn() as ExactObserverConvergenceDependencies["withSession"],
    ...overrides,
  };
}

function sessionRunner(stop: ReturnType<typeof vi.fn>, beforeTask: () => void = () => undefined) {
  const session = {
    health: vi.fn(),
    getSessionRecoveryAssessment: vi.fn(),
    stop,
  };
  return (async (_options: unknown, task: (value: typeof session) => Promise<unknown>) => {
    beforeTask();
    return task(session);
  }) as ExactObserverConvergenceDependencies["withSession"];
}

function exactEvidence(
  command = restartCommand(),
  selectedHandleId = command.expected.recovery.selectedHandles[0]?.selectedHandleId,
): ExactEvidence {
  const sessions =
    selectedHandleId === undefined
      ? []
      : [
          {
            sessionId: "session-1",
            projectId: "project-1",
            worktreeId: "worktree-1",
            lifecycle: "open" as const,
            harnessProvider: "codex",
            disposition: "recoverable" as const,
            reasons: [],
            handleResolution: {
              kind: "selected" as const,
              selectedHandleId,
              eligibleHandleCount: 1,
              rejectedHandleCount: 0,
              rejectedReasons: [],
            },
          },
        ];
  return {
    status: "exact",
    health: command.expected.health,
    processIdentity: command.expected.processIdentity,
    process: command.expected.process,
    recovery: {
      status: "assessed",
      assessment: {
        schemaVersion: 1,
        inventory: { schemaVersion: 1, sessions: [], recoveryHandles: [] },
        resumeEnabled: true,
        providerCapabilities: [],
        sessions,
      },
    },
  };
}

function nonTargetEvidence(): ExactEvidence {
  const command = restartCommand();
  command.expected.health.version = otherBuild();
  command.expected.processIdentity.version = otherBuild();
  command.expected.process.buildVersion = otherBuild();
  return exactEvidence(command);
}

function withHealth(value: ExactEvidence, health: Partial<ExactEvidence["health"]>): ExactEvidence {
  return { ...value, health: { ...value.health, ...health } };
}

function withIdentity(
  value: ExactEvidence,
  processIdentity: Partial<ExactEvidence["processIdentity"]>,
): ExactEvidence {
  return { ...value, processIdentity: { ...value.processIdentity, ...processIdentity } };
}

function withProcess(
  value: ExactEvidence,
  process: Partial<ExactEvidence["process"]>,
): ExactEvidence {
  return { ...value, process: { ...value.process, ...process } };
}

function driftSelected(
  value: ExactEvidence,
  drift: "session" | "handle" | "missing" | "extra",
): ExactEvidence {
  if (value.recovery.status !== "assessed") throw new Error("expected assessed recovery");
  const session = value.recovery.assessment.sessions[0];
  if (session?.handleResolution.kind !== "selected") throw new Error("expected selected handle");
  const changed = {
    ...session,
    ...(drift === "session" ? { sessionId: "session-2" } : {}),
    handleResolution: {
      ...session.handleResolution,
      ...(drift === "handle" ? { selectedHandleId: "handle-2" } : {}),
    },
  };
  const sessions =
    drift === "missing"
      ? []
      : drift === "extra"
        ? [changed, { ...changed, sessionId: "session-2" }]
        : [changed];
  return {
    ...value,
    recovery: {
      status: "assessed",
      assessment: { ...value.recovery.assessment, sessions },
    },
  };
}

function newGeneration(incumbent: ExactEvidence): ExactEvidence {
  return {
    ...incumbent,
    health: { ...incumbent.health, pid: 43, startedAt: "2026-08-24T12:00:01.000Z" },
    processIdentity: {
      ...incumbent.processIdentity,
      pid: 43,
      osStartTime: "Mon Aug 24 12:00:01 2026",
      processToken: otherToken(),
    },
    process: {
      ...incumbent.process,
      pid: 43,
      startToken: "Mon Aug 24 12:00:01 2026",
      processToken: otherToken(),
    },
  };
}

function runningStatus(evidence: ExactEvidence) {
  return {
    status: "running" as const,
    paths: dependencies({}).paths,
    health: { schemaVersion: "0.11.0" as const, ...evidence.health },
  };
}
