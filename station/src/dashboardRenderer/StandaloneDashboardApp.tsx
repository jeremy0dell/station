import {
  StationThemeProvider,
  useStationThemeSource,
  type StationThemeSource,
} from "../theme/index.js";
import { FullscreenDashboard, type FullscreenDashboardProps } from "./FullscreenDashboard.js";

export type StandaloneDashboardAppProps = FullscreenDashboardProps &
  Readonly<{ themeSource: StationThemeSource }>;

/** Production composition root for the standalone and popup dashboard renderer. */
export function StandaloneDashboardApp({
  themeSource,
  ...props
}: StandaloneDashboardAppProps) {
  const theme = useStationThemeSource(themeSource);
  return (
    <StationThemeProvider theme={theme}>
      <FullscreenDashboard {...props} />
    </StationThemeProvider>
  );
}
