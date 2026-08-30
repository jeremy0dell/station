import { TextAttributes } from "@opentui/core";
import { cellWidth, clipCells } from "@station/dashboard-core/text";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import {
  toOpenTuiColor,
  useStationTheme,
  type StationColor,
} from "../../../theme/index.js";
import { semanticItemRenderableId } from "../layout/scroll/scrollViewport.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "../stationMouseContext.js";
import { fit, SheetText, spaces } from "./sheetText.js";

export function SheetChoiceLine({
  choiceKey,
  label,
  detail,
  color,
  width,
  current = false,
  selected = false,
  note,
  itemId,
}: {
  choiceKey: string | undefined;
  label: string;
  detail: string;
  color?: StationColor | undefined;
  width: number;
  /** Marks the row as the currently-selected option (e.g. a project's default). */
  current?: boolean;
  /** Marks the row under the keyboard cursor; painted like hover so ↑↓ and mouse agree. */
  selected?: boolean;
  /** Right-aligned dim status (e.g. "updating…") shown in the row's free space. */
  note?: string | undefined;
  /** Semantic identity shared by focus-follow and pointer activation. */
  itemId: string;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const focused = hover || selected;
  // Cursor and canonical selection stay independent without changing row width.
  const cursor = selected ? "▸" : " ";
  const marker = current ? "✓" : " ";
  const keyPrefix = choiceKey === undefined ? "  " : `${choiceKey} `;
  const content = detail.length === 0 ? label : `${label} ${detail}`;
  const contentWidth = Math.max(0, width - 2 - cellWidth(keyPrefix));
  const noteText = note ?? "";
  const noteWidth = Math.min(cellWidth(noteText), Math.max(0, contentWidth - 2));
  const visibleNote = clipCells(noteText, noteWidth);
  const visibleContent = clipCells(
    content,
    Math.max(0, contentWidth - (noteWidth > 0 ? noteWidth + 1 : 0)),
  );
  const gap = spaces(
    Math.max(0, contentWidth - cellWidth(visibleContent) - cellWidth(visibleNote)),
  );
  return (
    <SheetText
      id={semanticItemRenderableId(itemId)}
      fg={toOpenTuiColor(focused ? theme.status.success : theme.text.primary)}
      {...(focused ? { bg: toOpenTuiColor(theme.interaction.hover) } : {})}
      {...stationMouseProps(dispatch, { kind: "sheetListItem", itemId })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      width={width}
      wrapMode="none"
    >
      {cursor}
      <span {...(current ? { fg: toOpenTuiColor(theme.action.primary) } : {})}>{marker}</span>
      {keyPrefix}
      <span {...(color === undefined ? {} : { fg: toOpenTuiColor(color) })}>{visibleContent}</span>
      {gap}
      <span attributes={TextAttributes.DIM}>{visibleNote}</span>
    </SheetText>
  );
}

/** Index-selected picker line (the add-project flow's cursor-driven lists). */
export function SheetPickerLine({
  width,
  selected,
  label,
  detail,
  mouseTarget,
  itemId,
}: {
  width: number;
  selected: boolean;
  label: string;
  detail: string;
  /** When set, clicking the row moves the flow cursor to it. */
  mouseTarget?: StationMouseTarget;
  /** Semantic identity used by the sheet viewport for focus-follow. */
  itemId?: string;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const prefix = selected ? " > " : "   ";
  const detailText = detail.length === 0 ? "" : ` ${detail}`;
  const maxDetailWidth = Math.max(0, width - cellWidth(prefix) - 10);
  const visibleDetail = fit(detailText, Math.min(cellWidth(detailText), maxDetailWidth));
  const labelWidth = Math.max(1, width - cellWidth(prefix) - cellWidth(visibleDetail));
  const color = toOpenTuiColor(selected || hover ? theme.action.primary : theme.text.primary);
  return (
    <SheetText
      {...(itemId === undefined ? {} : { id: semanticItemRenderableId(itemId) })}
      fg={toOpenTuiColor(theme.text.primary)}
      {...(mouseTarget === undefined
        ? {}
        : {
            ...stationMouseProps(dispatch, mouseTarget),
            onMouseOver: () => setHover(true),
            onMouseOut: () => setHover(false),
          })}
    >
      <span fg={color}>{prefix}</span>
      <span fg={color}>{fit(label, labelWidth)}</span>
      {cellWidth(visibleDetail) > 0 ? (
        <span attributes={TextAttributes.DIM}>{visibleDetail}</span>
      ) : null}
    </SheetText>
  );
}
