import type { RuntimeSafeError } from "@station/runtime";

/**
 * POLICY
 *
 * Protects command-capable Station UI launch from delegating to a different-build
 * Observer before renderer, reconcile, popup, or Host-producing effects.
 */
export function requireMatchingStationUiObserverBuild(
  clientBuildVersion: string,
  observerBuildVersion: string,
): void {
  if (clientBuildVersion === observerBuildVersion) {
    return;
  }

  throw {
    tag: "TuiCommandError",
    code: "TUI_OBSERVER_BUILD_MISMATCH",
    message: `Station UI caller selector "${clientBuildVersion}" does not match accepted Observer selector "${observerBuildVersion}"; launch was refused before Station Host-producing work could mix builds.`,
    hint: `Use the matching Observer build "${observerBuildVersion}" to account for live terminals. When hosted work is empty, stop the incumbent Observer and retry, or use isolated Observer state.`,
  } satisfies RuntimeSafeError;
}
