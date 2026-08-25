import { toOpenTuiColor, useStationTheme } from "../../theme/index.js";

/** Structural hairline between dashboard-owned regions. */
export function DashboardDividerView() {
  const theme = useStationTheme();
  return (
    <box
      width="100%"
      height={1}
      flexShrink={0}
      border={["top"]}
      borderColor={toOpenTuiColor(theme.text.muted)}
    />
  );
}
