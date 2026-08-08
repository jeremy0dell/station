import { TextAttributes } from "@opentui/core";
import type { RowSegment } from "@station/dashboard-core/selectors";
import stringWidth from "string-width";
import { rowColor, toOpenTuiColor, useStationTheme } from "../../theme/index.js";
import { useHoverPointer } from "../../useHoverPointer.js";
import type { StationMouseTarget } from "../input/stationMouse.js";
import { Throbber } from "./Throbber.js";
import {
  stationMouseProps,
  useStationHoverEnabled,
  useStationMouse,
} from "./stationMouseContext.js";

type TextRowSegment = Extract<RowSegment, { kind: "text" }>;
type SegmentLink = {
  left: number;
  segment: TextRowSegment;
  url: string;
  width: number;
};

export function Segments({ segments }: { segments: readonly RowSegment[] }) {
  return (
    <>
      {segments.map((segment, index) => (
        <Segment key={segmentKey(segment, index)} segment={segment} />
      ))}
    </>
  );
}

function segmentKey(segment: RowSegment, index: number): string {
  if (segment.kind === "throbber") {
    return `throbber:${segment.variant}:${index}`;
  }
  return `text:${segment.text}:${segment.url ?? ""}:${index}`;
}

export function SegmentLinkTargets({ segments }: { segments: readonly RowSegment[] }) {
  return (
    <>
      {segmentLinks(segments).map((link, index) => (
        <SegmentLinkTarget key={`link:${link.url}:${link.left}:${index}`} link={link} />
      ))}
    </>
  );
}

function SegmentLinkTarget({ link }: { link: SegmentLink }) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const pointerProps = useHoverPointer({ enabled: useStationHoverEnabled() });
  const { left, segment, url, width } = link;
  const attributes = textSegmentAttributes(segment);
  const color = rowColor(theme, segment.color);
  const fg = segment.highlighted === true
    ? toOpenTuiColor(theme.filter.matchForeground)
    : color === undefined
      ? undefined
      : toOpenTuiColor(color);
  const bg =
    segment.highlighted === true ? toOpenTuiColor(theme.filter.matchBackground) : undefined;
  const target: StationMouseTarget = { kind: "link", url };
  return (
    <text
      position="absolute"
      top={0}
      left={left}
      width={width}
      height={1}
      {...(fg === undefined ? {} : { fg })}
      {...(bg === undefined ? {} : { bg })}
      attributes={attributes}
      {...pointerProps}
      {...stationMouseProps(dispatch, target)}
    >
      {segment.text}
    </text>
  );
}

function Segment({ segment }: { segment: RowSegment }) {
  const theme = useStationTheme();
  if (segment.kind === "throbber") {
    const color = rowColor(theme, segment.color);
    const fg = color === undefined ? undefined : toOpenTuiColor(color);
    const throbber = <Throbber variant={segment.variant} {...(fg === undefined ? {} : { fg })} />;
    return segment.dimmed === true ? (
      <span attributes={TextAttributes.DIM}>{throbber}</span>
    ) : (
      throbber
    );
  }
  const attributes = textSegmentAttributes(segment);
  const color = rowColor(theme, segment.color);
  const fg = segment.highlighted === true
    ? toOpenTuiColor(theme.filter.matchForeground)
    : color === undefined
      ? undefined
      : toOpenTuiColor(color);
  const bg =
    segment.highlighted === true ? toOpenTuiColor(theme.filter.matchBackground) : undefined;
  return (
    <span
      {...(fg === undefined ? {} : { fg })}
      {...(bg === undefined ? {} : { bg })}
      attributes={attributes}
    >
      {segment.text}
    </span>
  );
}

function textSegmentAttributes(segment: TextRowSegment): number {
  let attributes = TextAttributes.NONE;
  if (segment.dimColor === true || segment.dimmed === true) {
    attributes |= TextAttributes.DIM;
  }
  if (segment.underline === true) {
    attributes |= TextAttributes.UNDERLINE;
  }
  return attributes;
}

function segmentCellWidth(segment: RowSegment): number {
  if (segment.kind === "throbber") {
    return 1;
  }
  return stringWidth(segment.text);
}

function segmentLinks(segments: readonly RowSegment[]): SegmentLink[] {
  const links: SegmentLink[] = [];
  let left = 0;
  for (const segment of segments) {
    const segmentLeft = left;
    const width = segmentCellWidth(segment);
    left += width;
    if (segment.kind === "text" && segment.url !== undefined && width > 0) {
      links.push({ left: segmentLeft, segment, url: segment.url, width });
    }
  }
  return links;
}
