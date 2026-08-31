import { randomUUID } from "node:crypto";
import type { UiRunContext } from "@station/contracts";
import {
  HOST_PROTOCOL_VERSION,
  type HostClientIdentity,
  HostClientIdentitySchema,
} from "./protocol.js";

/**
 * ADAPTER
 *
 * Builds one immutable diagnostic identity for a physical Host client connection.
 */
export function createHostClientIdentity(
  buildVersion: string,
  options: { uiContext?: UiRunContext; connectionId?: string } = {},
): HostClientIdentity {
  const uiContext = options.uiContext ?? {
    uiRunId: `ui_${randomUUID()}`,
    rendererPid: process.pid,
    clientKind: "host_tool" as const,
  };
  return HostClientIdentitySchema.parse({
    protocolVersion: HOST_PROTOCOL_VERSION,
    buildVersion,
    ...uiContext,
    connectionId: options.connectionId ?? `conn_${randomUUID()}`,
  });
}
