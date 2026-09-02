export function captureNativeCallerClaims(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return environment.STATION_PANE === undefined ? {} : { STATION_PANE: environment.STATION_PANE };
}
