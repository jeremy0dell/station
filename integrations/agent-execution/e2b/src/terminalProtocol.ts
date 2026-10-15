import {
  HostAttachAckSchema,
  HostFrameSchema,
  HostPtyIdentitySchema,
  HostPtyRefSchema,
} from "@station/host";
import { z } from "zod";

export const MAX_PENDING_BYTES = 1024 * 1024;
export const INPUT_WINDOW_BYTES = 64 * 1024;
export const INPUT_FRAME_BYTES = 32 * 1024;
export const TerminalIdentitySchema = HostPtyIdentitySchema.extend(HostPtyRefSchema.shape).strict();
export const SessionIdSchema = z.string().regex(/^ses_[a-zA-Z0-9_-]+$/);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const size = { cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) };
export const TerminalOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("input"),
      seq: sequence,
      data: z
        .string()
        .min(1)
        .refine((data) => Buffer.byteLength(data) <= INPUT_FRAME_BYTES),
    })
    .strict(),
  z.object({ type: z.literal("resize"), seq: sequence, ...size }).strict(),
]);
export type TerminalOperation = z.infer<typeof TerminalOperationSchema>;
export const TerminalClientFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("attach"),
      version: z.literal(1),
      ticket: z.uuid(),
      execution: SessionIdSchema,
      identity: TerminalIdentitySchema,
    })
    .strict(),
  ...TerminalOperationSchema.options,
]);
export const TerminalServerFrameSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("attached"), version: z.literal(1), ack: HostAttachAckSchema })
    .strict(),
  z.object({ type: z.literal("frame"), frame: HostFrameSchema }).strict(),
  // Cumulative acknowledgements mean remote Host accepted every operation through seq.
  z.object({ type: z.literal("accepted"), seq: sequence, bytes: sequence }).strict(),
  z
    .object({
      type: z.literal("failure"),
      code: z.enum(["unavailable", "revoked", "overflow", "invalid"]),
      message: z.string().max(300),
    })
    .strict(),
]);
export type TerminalServerFrame = z.infer<typeof TerminalServerFrameSchema>;
export const TerminalGrantSchema = z
  .object({
    version: z.literal(1),
    address: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "wss:" && !url.username && !url.password && !url.search && !url.hash;
    }),
    trafficToken: z.string().min(1).max(4096),
    ticket: z.uuid(),
    execution: SessionIdSchema,
    identity: TerminalIdentitySchema,
    deadline: z.iso.datetime(),
  })
  .strict();
export type TerminalGrant = z.infer<typeof TerminalGrantSchema>;
export const GatewayConfigSchema = z
  .object({
    version: z.literal(1),
    execution: SessionIdSchema,
    identity: TerminalIdentitySchema,
    hostSocket: z.string().min(1),
    controlSocket: z.string().min(1),
    port: z.number().int().min(1024).max(65535),
  })
  .strict();
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export const GatewayRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("grant"),
      execution: SessionIdSchema,
      identity: TerminalIdentitySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("revoke"),
      execution: SessionIdSchema,
      identity: TerminalIdentitySchema,
    })
    .strict(),
]);
export type GatewayRequest = z.infer<typeof GatewayRequestSchema>;
export const GatewayResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ticket"), ticket: z.uuid(), deadline: z.iso.datetime() }).strict(),
  z.object({ type: z.literal("revoked") }).strict(),
  z.object({ type: z.literal("error") }).strict(),
]);
export type GatewayResponse = z.infer<typeof GatewayResponseSchema>;
export const BrokerRequestSchema = z
  .object({ version: z.literal(1), sessionId: SessionIdSchema })
  .strict();
export const BrokerResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("grant"), grant: TerminalGrantSchema }).strict(),
  z.object({ type: z.literal("legacy") }).strict(),
  z.object({ type: z.literal("revoked") }).strict(),
  z.object({ type: z.literal("unavailable") }).strict(),
]);
export const GatewayStartConfigSchema = GatewayConfigSchema.omit({ identity: true })
  .extend({ remoteSessionId: SessionIdSchema })
  .strict();
export const RuntimeArtifactSchema = z
  .object({
    buildIdentity: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    version: z.string().min(1),
    sourceCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
  })
  .strict();
export type RuntimeArtifact = z.infer<typeof RuntimeArtifactSchema>;
export const GatewayReadySchema = z
  .object({
    config: GatewayConfigSchema,
    runtime: z
      .object({ version: z.string(), buildIdentity: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict(),
  })
  .strict();
