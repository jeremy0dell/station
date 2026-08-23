import type {
  CurrentSessionContext,
  TerminalCallerContextRequest,
  TerminalPlacementPort,
} from "@station/contracts";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ObserverCore } from "../reconcile/core.js";

/**
 * USE CASE
 *
 * Resolves one caller's terminal claim into an adapter-validated authority and
 * correlates its exact public target with the canonical session snapshot. Raw
 * claims and provider proof stay inside the terminal adapter; ambiguous,
 * absent, stale, or mismatched claims fail closed.
 */
export async function resolveCurrentSessionContext(input: {
  providers: ProviderRegistry;
  core: ObserverCore;
  caller: TerminalCallerContextRequest;
}): Promise<CurrentSessionContext> {
  const claims: Array<{
    placement: TerminalPlacementPort;
    source: CurrentSessionContext["source"];
  }> = [];
  for (const placement of input.providers.terminalPlacements.values()) {
    const source = await placement.resolveCurrentPlacement?.(input.caller);
    if (source === undefined) continue;
    if (source.provider !== placement.id) {
      throw {
        tag: "TerminalProviderError",
        code: "TERMINAL_CALLER_CONTEXT_REJECTED",
        message: "A terminal placement adapter returned a source for another provider.",
        provider: placement.id,
      };
    }
    claims.push({ placement, source });
  }
  if (claims.length !== 1) {
    throw {
      tag: "CommandValidationError",
      code:
        claims.length === 0
          ? "TERMINAL_CALLER_CONTEXT_MISSING"
          : "TERMINAL_CALLER_CONTEXT_AMBIGUOUS",
      message:
        claims.length === 0
          ? "STATION could not verify a terminal context for this process."
          : "STATION found more than one terminal context claim for this process.",
      hint: "Run this command from one live supported terminal context and retry.",
    };
  }

  const claim = claims[0];
  if (claim === undefined) {
    throw new Error("Current terminal context selection lost its unique result.");
  }
  const terminal = input.providers.terminals.get(claim.placement.id);
  if (terminal === undefined) {
    throw new Error(`Placement terminal is not registered: ${claim.placement.id}`);
  }
  const target = (await terminal.listTargets()).find(
    (candidate) =>
      candidate.provider === claim.source.provider && candidate.id === claim.source.targetId,
  );
  const session =
    target?.sessionId === undefined
      ? undefined
      : input.core.getSnapshot().sessions.find((candidate) => candidate.id === target.sessionId);
  const result: CurrentSessionContext = {
    source: claim.source,
    presentation: "presented",
  };
  if (session !== undefined) {
    const group = input.core
      .getSnapshot()
      .sessionGroups.find(
        (candidate) =>
          candidate.projectId === session.projectId && candidate.sessionIds.includes(session.id),
      );
    result.session = {
      id: session.id,
      projectId: session.projectId,
      worktreeId: session.worktreeId,
    };
    if (group !== undefined) {
      result.session.group = { id: group.id, name: group.name };
    }
  }
  return result;
}
