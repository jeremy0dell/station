import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  HarnessLaunchPlanSchema,
  SafeErrorSchema,
  TerminalOutputCompatibilitySchema,
  TerminalTargetIdSchema,
} from "@station/contracts";
import { HostPtyIdentitySchema, HostPtyRefSchema } from "@station/host";
import {
  connectUnixSocket,
  listenUnixSocket,
  NDJSON_TRANSPORT_LIMITS,
  type UnixSocketServer,
} from "@station/protocol";
import { runRuntimeBoundaryWithTimeout, safeErrorFromUnknown } from "@station/runtime";
import { z } from "zod";

const IdSchema = z.string().min(1);
const PositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const HostPtyAttachExpectationSchema = HostPtyIdentitySchema.merge(HostPtyRefSchema);

export const NativePlacementPaneProofSchema = z
  .object({
    paneId: IdSchema,
    entryGeneration: IdSchema,
    terminalPid: PositiveIntegerSchema,
    terminalTargetId: TerminalTargetIdSchema.optional(),
    hostPtyRef: HostPtyAttachExpectationSchema.optional(),
  })
  .strict();
export type NativePlacementPaneProof = z.infer<typeof NativePlacementPaneProofSchema>;

export const NativePlacementSnapshotSchema = z
  .object({
    uiRunId: IdSchema,
    handlerGeneration: IdSchema,
    rendererPid: PositiveIntegerSchema,
    panes: z.array(NativePlacementPaneProofSchema),
  })
  .strict();
export type NativePlacementSnapshot = z.infer<typeof NativePlacementSnapshotSchema>;

export const NativePlacementSourceProofSchema = NativePlacementPaneProofSchema.pick({
  paneId: true,
  entryGeneration: true,
  terminalPid: true,
})
  .extend({ handlerGeneration: IdSchema })
  .strict();
export type NativePlacementSourceProof = z.infer<typeof NativePlacementSourceProofSchema>;

export const NativePlacementLaunchSchema = HarnessLaunchPlanSchema.pick({
  provider: true,
  command: true,
  args: true,
  cwd: true,
  env: true,
})
  .extend({ outputCompatibility: TerminalOutputCompatibilitySchema.optional() })
  .strict();
export type NativePlacementLaunch = z.infer<typeof NativePlacementLaunchSchema>;

const SnapshotRequestSchema = z.object({ type: z.literal("snapshot") }).strict();
const ReserveRequestSchema = z
  .object({
    type: z.literal("reserve"),
    source: NativePlacementSourceProofSchema,
    bindingToken: IdSchema,
    target: z
      .object({
        terminalTargetId: TerminalTargetIdSchema,
        sessionId: IdSchema,
        worktreeId: IdSchema,
        harnessProvider: IdSchema,
      })
      .strict(),
  })
  .strict();
const CommitRequestSchema = z
  .object({
    type: z.literal("commit"),
    bindingToken: IdSchema,
    launch: NativePlacementLaunchSchema,
    host: z
      .object({ socketPath: IdSchema, ptyRef: HostPtyAttachExpectationSchema })
      .strict()
      .optional(),
  })
  .strict();
const ReleaseRequestSchema = z
  .object({ type: z.literal("release"), bindingToken: IdSchema })
  .strict();

export const NativePlacementRequestSchema = z.discriminatedUnion("type", [
  SnapshotRequestSchema,
  ReserveRequestSchema,
  CommitRequestSchema,
  ReleaseRequestSchema,
]);
export type NativePlacementRequest = z.infer<typeof NativePlacementRequestSchema>;

const NativePlacementValueSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("snapshot"),
      snapshot: NativePlacementSnapshotSchema,
    })
    .strict(),
  z.object({ type: z.literal("reserved"), paneId: IdSchema }).strict(),
  z
    .object({
      type: z.literal("committed"),
      paneId: IdSchema,
      entryGeneration: IdSchema,
      terminalPid: PositiveIntegerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("released"),
      status: z.enum(["released", "already-absent"]),
    })
    .strict(),
]);
export type NativePlacementValue = z.infer<typeof NativePlacementValueSchema>;

const NativePlacementResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: NativePlacementValueSchema }).strict(),
  z.object({ ok: z.literal(false), error: SafeErrorSchema }).strict(),
]);

export function nativePlacementSocketDirectory(stateDir: string): string {
  return join(stateDir, "run", "np");
}

export function nativePlacementSocketPath(stateDir: string, uiRunId: string): string {
  const rendererId = createHash("sha256").update(uiRunId).digest("hex").slice(0, 24);
  return join(nativePlacementSocketDirectory(stateDir), `${rendererId}.sock`);
}

export async function requestNativePlacement(
  socketPath: string,
  request: NativePlacementRequest,
  timeoutMs = 5_000,
): Promise<NativePlacementValue> {
  const result = await runRuntimeBoundaryWithTimeout(
    {
      operation: "native-placement-request",
      timeoutMs,
      error: {
        tag: "TerminalProviderError",
        code: "TERMINAL_PLACEMENT_REJECTED",
        message: "Native placement request failed.",
        provider: "native",
      },
      timeoutError: {
        tag: "TimeoutError",
        code: "TERMINAL_PLACEMENT_TIMEOUT",
        message: "Native placement request timed out.",
        provider: "native",
      },
    },
    async ({ signal }) => {
      const connection = await connectUnixSocket(socketPath, {
        timeoutMs,
        transportLimits: NDJSON_TRANSPORT_LIMITS,
      });
      const close = () => connection.close();
      signal.addEventListener("abort", close, { once: true });
      try {
        if (!connection.send(NativePlacementRequestSchema.parse(request))) {
          throw new Error("Native placement request could not be written.");
        }
        for await (const frame of connection.messages()) {
          const response = NativePlacementResponseSchema.parse(frame);
          if (!response.ok) throw response.error;
          return response.value;
        }
        throw new Error("Native placement endpoint closed without a response.");
      } finally {
        signal.removeEventListener("abort", close);
        connection.close();
      }
    },
  );
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * ADAPTER
 *
 * Serves strict one-shot native placement requests on one renderer-owned socket.
 */
export async function startNativePlacementProtocolServer(options: {
  socketPath: string;
  handle(request: NativePlacementRequest): Promise<NativePlacementValue>;
}): Promise<UnixSocketServer> {
  return listenUnixSocket({
    socketPath: options.socketPath,
    transportLimits: NDJSON_TRANSPORT_LIMITS,
    onConnection: async (connection) => {
      let responded = false;
      try {
        const next = await connection.messages()[Symbol.asyncIterator]().next();
        if (next.done) return;
        const request = NativePlacementRequestSchema.parse(next.value);
        const value = NativePlacementValueSchema.parse(await options.handle(request));
        responded = connection.send({ ok: true, value });
      } catch (cause) {
        responded = connection.send({
          ok: false,
          error: safeErrorFromUnknown(cause, {
            tag: "TerminalProviderError",
            code: "TERMINAL_PLACEMENT_REJECTED",
            message: "Native renderer placement request failed.",
            provider: "native",
          }),
        });
      } finally {
        // The requester closes after reading. Closing here can race the final
        // error frame on Unix sockets; only close when no response was queued.
        if (!responded) connection.close();
      }
    },
  });
}
