import type { StationConfig } from "@station/config";
import { type StationEvent, StationEventSchema, StationSnapshotSchema } from "@station/contracts";
import { createObserverClient, type ObserverApi } from "@station/protocol";
import { Effect, runRuntimeBoundaryWithTimeout } from "@station/runtime";
import {
  type ObserverProcessDeps,
  type ObserverStatus,
  observerStatusErrorMessage,
  startObserver,
} from "../../observerProcess.js";
import { resolveObserverPaths } from "../../paths.js";
import { parseObserveArgs } from "./args.js";
import { observeEventMatches, observeProtocolFilter } from "./filters.js";
import {
  formatEventLines,
  formatJsonEnvelope,
  formatSnapshotLines,
  type ObserveEnvelope,
} from "./formatters.js";
import {
  applyEventBeforeFormatting,
  applyEventToSnapshotContext,
  createObserveSnapshotContext,
  loadSnapshotContext,
} from "./snapshotContext.js";

export type ObserveCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  timeoutMs?: number;
};

export type ObserveCommandDeps = {
  observer?: ObserverProcessDeps;
  writeStdout?: (chunk: string) => void | Promise<void>;
  now?: () => Date;
  terminalSize?: () => ObserveTerminalSize;
  isTty?: boolean;
  signal?: AbortSignal;
};

export type ObserveCommandResult = {
  code: number;
};

type ObserveTerminalSize = {
  columns: number;
  rows: number;
};

type ControlledNext =
  | {
      kind: "next";
      result: IteratorResult<StationEvent>;
    }
  | {
      kind: "timeout";
    }
  | {
      kind: "aborted";
    }
  | {
      kind: "error";
      error: unknown;
    };

type ObserveStreamResult =
  | {
      kind: "completed";
    }
  | {
      kind: "brokenPipe";
    }
  | {
      kind: "aborted";
    };

export async function runObserveCommand(
  args: string[],
  options: ObserveCommandOptions = {},
  deps: ObserveCommandDeps = {},
): Promise<ObserveCommandResult> {
  const parsed = parseObserveArgs(args);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const paths = resolveObserverPaths(options.config);
  const observerDeps = deps.observer ?? {};
  const observerOptions: Parameters<typeof startObserver>[0] = { paths, timeoutMs };
  if (options.config !== undefined) {
    observerOptions.config = options.config;
  }
  if (options.configPath !== undefined) {
    observerOptions.configPath = options.configPath;
  }
  const status = await startObserver(observerOptions, observerDeps);
  assertRunning(status);

  const client =
    observerDeps.clientFactory?.(paths.socketPath) ??
    createObserverClient({ socketPath: paths.socketPath, timeoutMs });
  const context = createObserveSnapshotContext();
  const writer = deps.writeStdout ?? defaultWriteStdout;
  if (parsed.pane) {
    validatePaneOutputTarget(deps);
  }
  const pane = parsed.pane
    ? createObservePaneRenderer({
        writer,
        now: () => nowIso(deps),
        terminalSize: deps.terminalSize ?? defaultTerminalSize,
      })
    : undefined;
  const outputWriter = pane?.write ?? writer;
  const signalHandle = observeAbortSignal(deps.signal);
  let paneStarted = false;
  let seq = 0;

  try {
    if (pane !== undefined) {
      const started = await pane.start();
      if (!started) {
        return { code: 0 };
      }
      paneStarted = true;
    }

    if (parsed.includeSnapshot || parsed.pane) {
      const snapshot = await loadInitialSnapshot(client, timeoutMs);
      loadSnapshotContext(context, snapshot);
      seq += 1;
      const receivedAt = nowIso(deps);
      const envelope: ObserveEnvelope = {
        kind: "snapshot",
        seq,
        receivedAt,
        snapshot,
      };
      const wrote = await writeObserveChunk(
        outputWriter,
        parsed.json
          ? formatJsonEnvelope(envelope)
          : `${formatSnapshotLines(snapshot, context, receivedAt).join("\n")}\n`,
      );
      if (!wrote) {
        return { code: 0 };
      }
    }

    if (parsed.limit === 0) {
      return { code: 0 };
    }

    const streamInput: ObserveStreamInput = {
      client,
      context,
      json: parsed.json,
      matches: (event) => observeEventMatches(parsed, event),
      nextSeq: () => {
        seq += 1;
        return seq;
      },
      now: () => nowIso(deps),
      signal: signalHandle.signal,
      writer: outputWriter,
    };
    if (parsed.durationMs !== undefined) {
      streamInput.durationMs = parsed.durationMs;
    }
    if (parsed.limit !== undefined) {
      streamInput.limit = parsed.limit;
    }
    const filter = observeProtocolFilter(parsed);
    if (filter !== undefined) {
      streamInput.filter = filter;
    }

    const streamResult = await Effect.runPromise(observeStreamEffect(streamInput));
    if (streamResult.kind === "aborted") {
      return { code: 130 };
    }
    if (streamResult.kind === "brokenPipe") {
      return { code: 0 };
    }
  } finally {
    if (paneStarted && pane !== undefined) {
      await pane.stop();
    }
    signalHandle.dispose();
  }

  return { code: 0 };
}

type ObservePaneRenderer = {
  start: () => Promise<boolean>;
  write: (chunk: string) => Promise<void>;
  stop: () => Promise<void>;
};

function createObservePaneRenderer(input: {
  writer: (chunk: string) => void | Promise<void>;
  now: () => string;
  terminalSize: () => ObserveTerminalSize;
}): ObservePaneRenderer {
  const feedLines: string[] = [];
  let snapshotSummary: string | undefined;

  return {
    start: async () => writeObserveChunk(input.writer, "\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J"),
    write: async (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length === 0) {
          continue;
        }
        if (line.includes("  snapshot   ")) {
          snapshotSummary = line;
          continue;
        }
        if (line.includes("  orphan!    ")) {
          continue;
        }
        feedLines.push(line);
      }
      if (feedLines.length > 1000) {
        feedLines.splice(0, feedLines.length - 1000);
      }
      await input.writer(
        renderObservePane(input.terminalSize(), input.now(), feedLines, snapshotSummary),
      );
    },
    stop: async () => {
      try {
        await input.writer("\x1b[?25h\x1b[?1049l");
      } catch (error) {
        if (!isBrokenPipeError(error)) {
          throw error;
        }
      }
    },
  };
}

function renderObservePane(
  size: ObserveTerminalSize,
  now: string,
  feedLines: readonly string[],
  snapshotSummary: string | undefined,
): string {
  const rows = Number.isSafeInteger(size.rows) && size.rows > 0 ? size.rows : 24;
  const columns = Number.isSafeInteger(size.columns) && size.columns > 0 ? size.columns : 100;
  const bodyRows = Math.max(1, rows - 3);
  const visibleLines = feedLines.slice(-bodyRows);
  const header = truncatePaneLine(
    `stn observe  live  updated:${paneClockTime(now)}  lines:${feedLines.length}`,
    columns,
  );
  const summary = truncatePaneLine(snapshotSummary ?? "snapshot pending", columns);
  const separator = "-".repeat(Math.max(1, Math.min(columns, 100)));
  const body = visibleLines.map((line) => truncatePaneLine(line, columns));
  while (body.length < bodyRows) {
    body.push("");
  }
  return `\x1b[H\x1b[2J${[header, summary, separator, ...body].join("\n")}`;
}

function truncatePaneLine(line: string, columns: number): string {
  return line.length <= columns ? line : line.slice(0, Math.max(0, columns));
}

function paneClockTime(timestamp: string): string {
  const direct = /T(\d\d:\d\d:\d\d)/.exec(timestamp);
  if (direct !== null) {
    return direct[1] ?? timestamp;
  }
  const date = new Date(timestamp);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(11, 19);
  }
  return timestamp;
}

function defaultTerminalSize(): ObserveTerminalSize {
  return {
    columns: process.stdout.columns ?? 100,
    rows: process.stdout.rows ?? 24,
  };
}

function validatePaneOutputTarget(deps: ObserveCommandDeps): void {
  if (deps.isTty === false) {
    throw new Error(
      "--pane requires a TTY. Use observe without --pane or use --json for pipelines.",
    );
  }
  if (deps.writeStdout === undefined && deps.isTty !== true && process.stdout.isTTY !== true) {
    throw new Error(
      "--pane requires a TTY. Use observe without --pane or use --json for pipelines.",
    );
  }
}

type ObserveStreamInput = {
  client: ObserverApi;
  context: ReturnType<typeof createObserveSnapshotContext>;
  durationMs?: number;
  filter?: Parameters<ObserverApi["subscribe"]>[0];
  json: boolean;
  limit?: number;
  matches: (event: StationEvent) => boolean;
  nextSeq: () => number;
  now: () => string;
  signal: AbortSignal;
  writer: (chunk: string) => void | Promise<void>;
};

function observeStreamEffect(
  input: ObserveStreamInput,
): Effect.Effect<ObserveStreamResult, unknown> {
  const iterator = input.client.subscribe(input.filter)[Symbol.asyncIterator]();
  const startedAtMs = Date.now();

  return streamLoopEffect({
    ...input,
    emittedEvents: 0,
    iterator,
    startedAtMs,
  }).pipe(
    Effect.ensuring(
      Effect.tryPromise({
        try: () => iterator.return?.().then(() => undefined) ?? Promise.resolve(undefined),
        catch: (error) => error,
      }).pipe(Effect.catchAll(() => Effect.succeed(undefined))),
    ),
  );
}

function streamLoopEffect(input: {
  context: ReturnType<typeof createObserveSnapshotContext>;
  durationMs?: number;
  emittedEvents: number;
  iterator: AsyncIterator<StationEvent>;
  json: boolean;
  limit?: number;
  matches: (event: StationEvent) => boolean;
  nextSeq: () => number;
  now: () => string;
  signal: AbortSignal;
  startedAtMs: number;
  writer: (chunk: string) => void | Promise<void>;
}): Effect.Effect<ObserveStreamResult, unknown> {
  return Effect.gen(function* () {
    if (input.limit !== undefined && input.emittedEvents >= input.limit) {
      return { kind: "completed" as const };
    }

    const remainingMs =
      input.durationMs === undefined
        ? undefined
        : input.durationMs - (Date.now() - input.startedAtMs);
    if (remainingMs !== undefined && remainingMs <= 0) {
      return { kind: "completed" as const };
    }

    const next = yield* nextWithControlsEffect(input.iterator, remainingMs, input.signal);
    if (next.kind === "timeout") {
      return { kind: "completed" as const };
    }
    if (next.kind === "aborted") {
      return { kind: "aborted" as const };
    }
    if (next.kind === "error") {
      return yield* Effect.fail(next.error);
    }
    if (next.result.done) {
      return { kind: "completed" as const };
    }

    const event = StationEventSchema.parse(next.result.value);
    if (!input.matches(event)) {
      return yield* streamLoopEffect(input);
    }

    if (applyEventBeforeFormatting(event)) {
      applyEventToSnapshotContext(input.context, event);
    }
    const seq = input.nextSeq();
    const receivedAt = input.now();
    const envelope: ObserveEnvelope = {
      kind: "event",
      seq,
      receivedAt,
      event,
    };
    const chunk = input.json
      ? formatJsonEnvelope(envelope)
      : `${formatEventLines(event, input.context, receivedAt).join("\n")}\n`;
    if (!applyEventBeforeFormatting(event)) {
      applyEventToSnapshotContext(input.context, event);
    }

    const writeResult = yield* writeObserveChunkEffect(input.writer, chunk);
    if (writeResult.kind === "brokenPipe") {
      return writeResult;
    }
    return yield* streamLoopEffect({
      ...input,
      emittedEvents: input.emittedEvents + 1,
    });
  });
}

async function loadInitialSnapshot(client: ObserverApi, timeoutMs: number) {
  const result = await runRuntimeBoundaryWithTimeout(
    {
      operation: "cli.observe.snapshot",
      timeoutMs,
      error: {
        tag: "ObserveCommandError",
        code: "OBSERVE_SNAPSHOT_FAILED",
        message: "Observe command could not load the initial observer snapshot.",
      },
      timeoutError: {
        tag: "TimeoutError",
        code: "OBSERVE_SNAPSHOT_TIMEOUT",
        message: "Observe command could not load the initial observer snapshot.",
      },
    },
    async () => StationSnapshotSchema.parse(await client.getSnapshot()),
  );
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function nextWithControlsEffect(
  iterator: AsyncIterator<StationEvent>,
  remainingMs: number | undefined,
  signal: AbortSignal,
): Effect.Effect<ControlledNext, never> {
  if (signal.aborted) {
    return Effect.succeed({ kind: "aborted" });
  }

  const next = Effect.tryPromise({
    try: () => iterator.next(),
    catch: (error) => error,
  }).pipe(
    Effect.match({
      onFailure: (error): ControlledNext => ({ kind: "error", error }),
      onSuccess: (result): ControlledNext => ({ kind: "next", result }),
    }),
  );

  if (remainingMs !== undefined) {
    return Effect.raceFirst(
      Effect.raceFirst(next, abortSignalEffect(signal)),
      Effect.as(Effect.sleep(`${remainingMs} millis`), { kind: "timeout" as const }),
    );
  }

  return Effect.raceFirst(next, abortSignalEffect(signal));
}

function abortSignalEffect(signal: AbortSignal): Effect.Effect<ControlledNext, never> {
  return Effect.async<ControlledNext>((resume) => {
    if (signal.aborted) {
      resume(Effect.succeed({ kind: "aborted" }));
      return Effect.void;
    }
    const abort = () => resume(Effect.succeed({ kind: "aborted" }));
    signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });
}

function observeAbortSignal(signal: AbortSignal | undefined): {
  signal: AbortSignal;
  dispose: () => void;
} {
  if (signal !== undefined) {
    return { signal, dispose: () => undefined };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  return {
    signal: controller.signal,
    dispose: () => process.off("SIGINT", abort),
  };
}

async function writeObserveChunk(
  writer: (chunk: string) => void | Promise<void>,
  chunk: string,
): Promise<boolean> {
  try {
    await writer(chunk);
    return true;
  } catch (error) {
    if (isBrokenPipeError(error)) {
      return false;
    }
    throw error;
  }
}

function writeObserveChunkEffect(
  writer: (chunk: string) => void | Promise<void>,
  chunk: string,
): Effect.Effect<ObserveStreamResult, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await writer(chunk);
      return { kind: "completed" as const };
    },
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      isBrokenPipeError(error)
        ? Effect.succeed({ kind: "brokenPipe" as const })
        : Effect.fail(error),
    ),
  );
}

async function defaultWriteStdout(chunk: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(chunk, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function nowIso(deps: ObserveCommandDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPIPE"
  );
}

function assertRunning(
  status: ObserverStatus,
): asserts status is Extract<ObserverStatus, { status: "running" }> {
  if (status.status !== "running") {
    throw new Error(observerStatusErrorMessage(status));
  }
}
