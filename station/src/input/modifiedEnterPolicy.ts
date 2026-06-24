import { selectPaneRecord } from "../state/selectors.js";
import type { AgentIdentity, StationState } from "../state/types.js";
import type { PtyRegistryView } from "../terminal/registry/ptyRegistry.js";
import type { ProviderId } from "@station/contracts";

export type ModifiedEnterSupport = (providerId: ProviderId) => boolean;

/**
 * Preserving modified Enter is normally negotiated by the child app. Host-backed
 * panes can be warm-attached after that negotiation already happened, so the
 * Station-owned pane identity and provider capability are the compatibility fallback.
 */
export function focusedPaneAcceptsModifiedEnter(
  state: StationState,
  registry: PtyRegistryView | undefined,
  supportsModifiedEnter: ModifiedEnterSupport = () => false,
): boolean {
  const focus = state.input.focus;
  if (focus.kind !== "pane") {
    return false;
  }
  if (registry?.get(focus.paneId)?.screen?.isKittyKeyboardEnabled() === true) {
    return true;
  }
  const pane = selectPaneRecord(state, focus.paneId);
  return pane?.role === "primary-agent" && agentSupportsModifiedEnter(pane.agentIdentity, supportsModifiedEnter);
}

function agentSupportsModifiedEnter(
  identity: AgentIdentity | undefined,
  supportsModifiedEnter: ModifiedEnterSupport,
): boolean {
  const provider = identity?.harnessProvider;
  return provider !== undefined && supportsModifiedEnter(provider);
}
