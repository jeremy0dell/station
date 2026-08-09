import type { HostExitFrame, HostFrame, HostPtyIdentity } from "@station/host";
import type { PtyOutputCompatibility } from "../terminal/ptyOutputCompatibility.js";
import type {
  StationTerminalDisposable,
  StationTerminalProcess,
  StationTerminalSize,
} from "../terminal/types.js";
import type { ScrollbackRing } from "./scrollbackRing.js";
import type { SemanticTerminalModel } from "./semanticTerminalSnapshot.js";

const MIN_COLS = 2;
const MIN_ROWS = 1;

/** Geometry floor shared by spawn, resize, and adoption so ring, semantic model, and PTY never disagree. */
export function clampSize(cols: number, rows: number): StationTerminalSize {
  return { cols: Math.max(MIN_COLS, cols), rows: Math.max(MIN_ROWS, rows) };
}

export type PtyEntry = {
  ptyId: string;
  /** Opaque identity retained unchanged for this entry's complete PTY lifetime. */
  ptyInstanceId: string;
  identity: HostPtyIdentity;
  command: string;
  terminal: StationTerminalProcess;
  ring: ScrollbackRing;
  semantic: SemanticTerminalModel;
  outputCompatibility: PtyOutputCompatibility;
  compatibilityRewriteReported: boolean;
  cols: number;
  rows: number;
  exited: boolean;
  lastExit?: HostExitFrame;
  sinks: Set<(frame: HostFrame) => void>;
  subscriptions: StationTerminalDisposable[];
};

/** Everything activation needs beyond what spawn/adoption build per lane. */
export type PtyEntryInit = {
  ptyId: string;
  ptyInstanceId: string;
  identity: HostPtyIdentity;
  command: string;
  terminal: StationTerminalProcess;
  ring: ScrollbackRing;
  semantic: SemanticTerminalModel;
  outputCompatibility: PtyOutputCompatibility;
  cols: number;
  rows: number;
};
