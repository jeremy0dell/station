/**
 * POLICY
 *
 * Encodes untrusted update text so one value cannot emit controls or create another terminal line.
 */
export function encodeUpdateTerminalText(value: string): string {
  let encoded = "";
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    const unsafe =
      point <= 0x1f ||
      (point >= 0x7f && point <= 0x9f) ||
      point === 0x061c ||
      point === 0x200e ||
      point === 0x200f ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069) ||
      point === 0x2028 ||
      point === 0x2029;
    encoded += unsafe ? `\\u${point.toString(16).padStart(4, "0")}` : character;
  }
  return encoded;
}
