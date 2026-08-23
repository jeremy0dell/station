// The semantic editor guarantees a grapheme-boundary cursor before this renderer
// splits the value around its stable, single-cell cursor glyph.
import type { ColorInput } from "@opentui/core";
import { useEffect, useState } from "react";
import { clampEditableTextCursor } from "@station/dashboard-core/selectors";
import type { EditableTextInputState } from "@station/dashboard-core/selectors";
import { toOpenTuiColor, useStationTheme } from "../../theme/index.js";

export type EditableTextInputViewProps = EditableTextInputState & {
  placeholder?: string;
  placeholderColor?: ColorInput;
  /** False keeps the value readable while another editor action owns focus. */
  active?: boolean;
};

export function EditableTextInputView({
  value,
  cursor,
  placeholder,
  placeholderColor,
  active = true,
}: EditableTextInputViewProps) {
  const theme = useStationTheme();
  const resolvedPlaceholderColor = placeholderColor ?? toOpenTuiColor(theme.text.muted);
  if (value.length === 0 && placeholder !== undefined) {
    if (!active) {
      return <span fg={resolvedPlaceholderColor}>{placeholder}</span>;
    }
    return (
      <span>
        <BlinkingCursor />
        <span fg={resolvedPlaceholderColor}>{placeholder}</span>
      </span>
    );
  }

  if (!active) {
    return <span>{value}</span>;
  }

  const clampedCursor = clampEditableTextCursor(cursor, value);
  return (
    <span>
      {value.slice(0, clampedCursor)}
      <BlinkingCursor />
      {value.slice(clampedCursor)}
    </span>
  );
}

function BlinkingCursor({ blinkIntervalMs = 500 }: { blinkIntervalMs?: number }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setInterval(() => {
      setVisible((current) => !current);
    }, blinkIntervalMs);
    return () => clearInterval(timer);
  }, [blinkIntervalMs]);

  return <span>{visible ? "|" : " "}</span>;
}
