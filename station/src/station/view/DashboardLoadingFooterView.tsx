import type { DashboardFooterLoadingModel } from "@station/dashboard-core/selectors";
import { truncateCells } from "@station/dashboard-core/selectors";
import { toOpenTuiColor, useStationTheme } from "../../theme/index.js";

export function DashboardLoadingFooterView({
  model,
  columns,
}: {
  model: DashboardFooterLoadingModel;
  columns: number;
}) {
  const theme = useStationTheme();
  return <text fg={toOpenTuiColor(theme.text.muted)}>{truncateCells(model.text, columns)}</text>;
}
