import type { IBufferCell } from "@xterm/headless";
import { ControlByte } from "../terminal/protocol/controlBytes.js";

type XtermStyleAttributes = Pick<
  IBufferCell,
  | "getBgColor"
  | "getFgColor"
  | "isBgPalette"
  | "isBgRGB"
  | "isAttributeDefault"
  | "isBlink"
  | "isBold"
  | "isDim"
  | "isFgPalette"
  | "isFgRGB"
  | "isInvisible"
  | "isInverse"
  | "isItalic"
  | "isOverline"
  | "isStrikethrough"
  | "isUnderline"
>;

export type PinnedXtermAttributes = XtermStyleAttributes & {
  extended: { underlineColor: number; urlId: number };
  getUnderlineStyle(): number;
  getUnderlineVariantOffset(): number;
  isProtected(): number;
};

export type PinnedXtermCellAttributes = PinnedXtermAttributes &
  Pick<IBufferCell, "getChars" | "getWidth">;

export function isUnsupportedXtermAttribute(attributes: PinnedXtermAttributes): boolean {
  return (
    Boolean(attributes.isProtected()) ||
    attributes.getUnderlineStyle() > 1 ||
    attributes.extended.underlineColor !== 0 ||
    attributes.getUnderlineVariantOffset() !== 0 ||
    attributes.extended.urlId !== 0
  );
}

export function isUnsupportedBlankXtermAttribute(
  attributes: PinnedXtermCellAttributes,
): boolean {
  return Boolean(
    attributes.getWidth() === 1 &&
    attributes.getChars() === "" &&
    (attributes.isFgPalette() ||
      attributes.isFgRGB() ||
      attributes.isInverse() ||
      attributes.isBold() ||
      attributes.isUnderline() ||
      attributes.isOverline() ||
      attributes.isBlink() ||
      attributes.isInvisible() ||
      attributes.isItalic() ||
      attributes.isDim() ||
      attributes.isStrikethrough()),
  );
}

export function xtermBackgroundKey(attributes: IBufferCell): string {
  if (attributes.isBgRGB()) {
    return `rgb:${attributes.getBgColor()}`;
  }
  if (attributes.isBgPalette()) {
    return `palette:${attributes.getBgColor()}`;
  }
  return "default";
}

export function xtermBackgroundSgr(attributes: IBufferCell): string {
  const background = attributes.getBgColor();
  if (attributes.isBgRGB()) {
    const red = (background >>> 16) & 0xff;
    const green = (background >>> 8) & 0xff;
    const blue = background & 0xff;
    return `${ControlByte.Csi}48;2;${red};${green};${blue}m`;
  }
  if (background >= 16) {
    return `${ControlByte.Csi}48;5;${background}m`;
  }
  if (!attributes.isBgPalette()) {
    return `${ControlByte.Csi}49m`;
  }
  return `${ControlByte.Csi}${background & 8 ? 100 + (background & 7) : 40 + (background & 7)}m`;
}

/** Emits only the basic SGR subset accepted by the snapshot preflight above. */
export function xtermAttributeSgr(attributes: XtermStyleAttributes): string {
  const params: number[] = [];
  const foreground = attributes.getFgColor();
  if (attributes.isFgRGB()) {
    params.push(38, 2, (foreground >>> 16) & 0xff, (foreground >>> 8) & 0xff, foreground & 0xff);
  } else if (attributes.isFgPalette()) {
    params.push(
      ...(foreground >= 16
        ? [38, 5, foreground]
        : [foreground & 8 ? 90 + (foreground & 7) : 30 + (foreground & 7)]),
    );
  }
  const background = attributes.getBgColor();
  if (attributes.isBgRGB()) {
    params.push(48, 2, (background >>> 16) & 0xff, (background >>> 8) & 0xff, background & 0xff);
  } else if (attributes.isBgPalette()) {
    params.push(
      ...(background >= 16
        ? [48, 5, background]
        : [background & 8 ? 100 + (background & 7) : 40 + (background & 7)]),
    );
  }
  if (attributes.isInverse()) params.push(7);
  if (attributes.isBold()) params.push(1);
  if (attributes.isUnderline()) params.push(4);
  if (attributes.isOverline()) params.push(53);
  if (attributes.isBlink()) params.push(5);
  if (attributes.isInvisible()) params.push(8);
  if (attributes.isItalic()) params.push(3);
  if (attributes.isDim()) params.push(2);
  if (attributes.isStrikethrough()) params.push(9);
  return params.length === 0 ? "" : `${ControlByte.Csi}${params.join(";")}m`;
}
