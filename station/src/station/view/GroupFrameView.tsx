import { TextAttributes } from "@opentui/core";
import { truncateCells } from "@station/dashboard-core/selectors";
import {
  toOpenTuiColor,
  useStationTheme,
  type StationTheme,
} from "../../theme/index.js";

export type GroupFrameFocus = {
  focusedHeader: boolean;
  containsFocusedRow: boolean;
};

export function GroupFrameText({ text, focus }: { text: string; focus: GroupFrameFocus }) {
  const theme = useStationTheme();
  const presentation = groupFramePresentation(theme, focus);
  return (
    <text flexShrink={0} fg={presentation.fg} attributes={presentation.attributes}>
      {text}
    </text>
  );
}

export function GroupFrameRailView({
  text,
  focusedHeader,
  containsFocusedRow,
}: {
  text: string;
  focusedHeader: boolean;
  containsFocusedRow: boolean;
}) {
  return <GroupFrameText text={text} focus={{ focusedHeader, containsFocusedRow }} />;
}

export function GroupFrameBottomView({
  columns,
  focusedHeader,
  containsFocusedRow,
}: {
  columns: number;
  focusedHeader: boolean;
  containsFocusedRow: boolean;
}) {
  const width = Math.max(1, Math.floor(columns));
  const line = width < 2 ? truncateCells("╰", width) : `╰${"─".repeat(width - 2)}╯`;
  return <GroupFrameText text={line} focus={{ focusedHeader, containsFocusedRow }} />;
}

function groupFramePresentation(theme: StationTheme, focus: GroupFrameFocus) {
  if (focus.focusedHeader) {
    return {
      fg: toOpenTuiColor(theme.status.working),
      attributes: TextAttributes.NONE,
    };
  }
  if (focus.containsFocusedRow) {
    return {
      fg: toOpenTuiColor(theme.status.working),
      attributes: TextAttributes.DIM,
    };
  }
  return {
    fg: toOpenTuiColor(theme.interaction.hairline),
    attributes: TextAttributes.NONE,
  };
}
