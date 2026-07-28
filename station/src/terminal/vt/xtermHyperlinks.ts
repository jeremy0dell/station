import type { IBufferCell, Terminal } from "@xterm/headless";

type XtermCellInternals = IBufferCell & {
  hasExtendedAttrs?: () => number;
  extended?: { urlId?: number };
};

type XtermTerminalInternals = Terminal & {
  _core?: {
    _oscLinkService?: {
      getLinkData?(linkId: number): { uri?: string } | undefined;
    };
  };
};

/**
 * Resolves an OSC 8 URI through @xterm/headless 6.0.0's private cell and link-service shape.
 * BufferLine.loadCell leaves a reused cell's `extended` object untouched for ordinary cells, so
 * `hasExtendedAttrs()` must gate `extended.urlId`; any missing or changed private shape fails closed.
 */
export function resolveXtermCellHyperlink(
  terminal: Terminal,
  cell: IBufferCell,
): string | undefined {
  try {
    const cellInternals = cell as XtermCellInternals;
    if (!cellInternals.hasExtendedAttrs?.()) {
      return undefined;
    }
    const linkId = cellInternals.extended?.urlId;
    if (linkId === undefined || !Number.isInteger(linkId) || linkId <= 0) {
      return undefined;
    }
    const linkData = (terminal as XtermTerminalInternals)._core?._oscLinkService?.getLinkData?.(
      linkId,
    );
    return typeof linkData?.uri === "string" && linkData.uri.length > 0
      ? linkData.uri
      : undefined;
  } catch {
    return undefined;
  }
}
