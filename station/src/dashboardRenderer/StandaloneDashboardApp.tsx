import {
  DashboardSurfaceProvider,
  TERMINAL_DEFAULT_SURFACES,
} from "../station/view/dashboardSurfaceContext.js";
import {
  FullscreenDashboard,
  type FullscreenDashboardProps,
} from "./FullscreenDashboard.js";

/** Production composition root for the standalone and popup dashboard renderer. */
export function StandaloneDashboardApp(props: FullscreenDashboardProps) {
  return (
    <DashboardSurfaceProvider value={TERMINAL_DEFAULT_SURFACES}>
      <FullscreenDashboard {...props} />
    </DashboardSurfaceProvider>
  );
}
