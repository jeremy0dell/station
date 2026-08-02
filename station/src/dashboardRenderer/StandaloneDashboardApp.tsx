import { embeddedStationTheme, StationThemeProvider } from "../theme/index.js";
import { FullscreenDashboard, type FullscreenDashboardProps } from "./FullscreenDashboard.js";

/** Production composition root for the standalone and popup dashboard renderer. */
export function StandaloneDashboardApp(props: FullscreenDashboardProps) {
  return (
    <StationThemeProvider theme={embeddedStationTheme}>
      <FullscreenDashboard {...props} />
    </StationThemeProvider>
  );
}
