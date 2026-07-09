declare const STATION_BUILD_VERSION: string;
declare const STATION_BUILD_COMPILED: boolean;

export type StationBuildInfo = {
  version: string;
  compiled: boolean;
};

export function stationBuildInfo(): StationBuildInfo {
  return {
    version: typeof STATION_BUILD_VERSION === "undefined" ? "0.0.0-dev" : STATION_BUILD_VERSION,
    compiled: typeof STATION_BUILD_COMPILED === "undefined" ? false : STATION_BUILD_COMPILED,
  };
}

export function isCompiledBinary(): boolean {
  return stationBuildInfo().compiled;
}
