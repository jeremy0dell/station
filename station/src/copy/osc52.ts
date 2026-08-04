import { OscCommand } from "../terminal/protocol/osc.js";
import { VtPrefix, VtTerminator } from "../terminal/protocol/syntax.js";

/**
 * OSC 52 clipboard write for the outer terminal. Emitting this to the host
 * (not the PTY) lets a yank reach the system clipboard even over SSH, on
 * terminals that honor OSC 52 writes.
 */
export function buildOsc52Sequence(text: string): string {
  const base64 = Buffer.from(text, "utf8").toString("base64");
  return `${VtPrefix.Osc}${OscCommand.Clipboard};c;${base64}${VtTerminator.Bell}`;
}
