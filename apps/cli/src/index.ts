export type { CliRunOptions, CliRunResult } from "./main.js";
export { runCli } from "./main.js";
export type {
  ObserverProcessOptions,
  ObserverStatus,
  SpawnObserverInput,
} from "./observerProcess.js";
export {
  getObserverStatus,
  restartObserver,
  startObserver,
  stopObserver,
  waitForObserverHealth,
} from "./observerProcess.js";
