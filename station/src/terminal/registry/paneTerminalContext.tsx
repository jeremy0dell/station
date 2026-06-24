import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { PaneId } from "../../state/types.js";
import type { StationTerminalSize } from "../types.js";
import type { StationVtScreen } from "../vt/screen.js";
import type { PtyRegistryView } from "./ptyRegistry.js";

const PaneRegistryContext = createContext<PtyRegistryView | null>(null);

export function PaneRegistryProvider({
  registry,
  children,
}: {
  registry: PtyRegistryView;
  children: ReactNode;
}) {
  return <PaneRegistryContext.Provider value={registry}>{children}</PaneRegistryContext.Provider>;
}

/** The pane view surface for non-hook consumers (e.g. PaneGrid's mouse-forward write). */
export function usePaneRegistry(): PtyRegistryView {
  const registry = useContext(PaneRegistryContext);
  if (registry === null) {
    throw new Error("usePaneRegistry must be used inside a PaneRegistryProvider");
  }
  return registry;
}

export type PaneTerminal = {
  screen: StationVtScreen | null;
  status: string;
  oscTitle: string | undefined;
  cwd: string | undefined;
  reportSize(size: StationTerminalSize): void;
};

/**
 * Bind one pane id to its live view. The scalars refresh on the registry's
 * structural notify (spawn/exit/dispose/title); screen *content* flows through
 * the renderable's own subscription, not these.
 */
export function usePaneTerminal(paneId: PaneId): PaneTerminal {
  const registry = usePaneRegistry();
  // One getter backs both the getSnapshot and the unused getServerSnapshot slot.
  const getScreen = () => registry.get(paneId)?.screen ?? null;
  const getStatus = () => registry.get(paneId)?.status ?? "starting shell";
  const getOscTitle = () => registry.get(paneId)?.screen?.getTitle();
  const getCwd = () => registry.get(paneId)?.cwd;
  const screen = useSyncExternalStore(registry.subscribe, getScreen, getScreen);
  const status = useSyncExternalStore(registry.subscribe, getStatus, getStatus);
  const oscTitle = useSyncExternalStore(registry.subscribe, getOscTitle, getOscTitle);
  const cwd = useSyncExternalStore(registry.subscribe, getCwd, getCwd);
  return {
    screen,
    status,
    oscTitle,
    cwd,
    reportSize: (size) => registry.resize(paneId, size),
  };
}
