// OpenTUI port of apps/tui's EditableTextInput + TuiCursor: value split at
// the cursor with a blinking "|" cell between (style-only blink; layout
// stays stable because the cursor cell is always one column wide).
import { useEffect, useState } from "react";
import {
  clampEditableTextCursor,
  type EditableTextInputState,
} from "@station/dashboard-core";
import { STATION_COLORS } from "./theme.js";

export type EditableTextInputViewProps = EditableTextInputState & {
  placeholder?: string;
  placeholderColor?: string;
};

export function EditableTextInputView({
  value,
  cursor,
  placeholder,
  placeholderColor = STATION_COLORS.gray,
}: EditableTextInputViewProps) {
  if (value.length === 0 && placeholder !== undefined) {
    return (
      <span>
        <BlinkingCursor />
        <span fg={placeholderColor}>{placeholder}</span>
      </span>
    );
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
