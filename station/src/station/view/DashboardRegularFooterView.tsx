import type { DashboardFooterRegularModel } from "@station/dashboard-core/selectors";
import { truncateCells } from "@station/dashboard-core/selectors";
import { toOpenTuiColor, useStationTheme } from "../../theme/index.js";

export function DashboardRegularFooterView({
  model,
  columns,
}: {
  model: DashboardFooterRegularModel;
  columns: number;
}) {
  const theme = useStationTheme();
  return <text fg={toOpenTuiColor(theme.text.primary)}>{truncateCells(model.text, columns)}</text>;
}
