/**
 * OSC 52 clipboard write for the outer terminal. Emitting this to the host
 * (not the PTY) lets a yank reach the system clipboard even over SSH, on
 * terminals that honor OSC 52 writes.
 */
export function buildOsc52Sequence(text: string): string {
  const base64 = Buffer.from(text, "utf8").toString("base64");
  return `\x1b]52;c;${base64}\x07`;
}
