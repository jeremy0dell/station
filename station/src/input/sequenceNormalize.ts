import { kittySequenceToLegacy } from "../terminal/index.js";
import { stripTerminalReplies } from "../terminal/input/terminalReplies.js";
import { cursorKeyBytes } from "../terminal/protocol/cursorKeys.js";
import type { PtyRegistryView } from "../terminal/registry/ptyRegistry.js";
import type { PaneId } from "../state/types.js";
import type { ProviderId, StationSnapshot } from "@station/contracts";

export type NormalizedSequence = { consumed: true } | { consumed: false; legacy: string };

/**
 * Normalize bytes before routing so raw kitty sequences, empty keys, and
 * unconsumed terminal query replies never reach shell input.
 */
export function normalizeSequence(
  raw: string,
  options?: { preserveModifiedEnter?: boolean },
): NormalizedSequence {
  const stripped = stripTerminalReplies(raw);
  if (stripped === "" && raw !== "") {
    return { consumed: true };
  }
  const legacy = kittySequenceToLegacy(stripped, options);
  if (legacy === "") {
    // Key releases and untranslatable functional keys: consumed, not leaked.
    return { consumed: true };
  }
  return { consumed: false, legacy };
}

const CURSOR_KEY_BYTES = cursorKeyBytes();

/** Rewrite arrow-key bytes to the pane's application/normal cursor-key mode. */
export function paneInputBytes(
  bytes: string,
  registry: PtyRegistryView | undefined,
  paneId: PaneId,
): string {
  const cursor = CURSOR_KEY_BYTES.get(bytes);
  if (cursor === undefined) {
    return bytes;
  }
  return registry?.get(paneId)?.screen?.isApplicationCursorKeys() === true
    ? cursor.application
    : cursor.normal;
}

export function providerSupportsModifiedEnterSoftNewline(
  snapshot: StationSnapshot | undefined,
  providerId: ProviderId,
): boolean {
  return (
    snapshot?.sessions.some(
      (session) =>
        session.harness.provider === providerId &&
        session.harness.capabilities.supportsModifiedEnterSoftNewline,
    ) === true
  );
}
