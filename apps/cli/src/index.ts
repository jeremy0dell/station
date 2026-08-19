export { runCli } from "./main.js";
export type {
  ExactObserverActivationPhase,
  ExactObserverBuildStatus,
  ExactObserverIncumbentDisposition,
} from "./observerProcess.js";
export {
  ensureExactObserverBuild,
  getObserverStatus,
  restartObserver,
  startObserver,
  stopObserver,
} from "./observerProcess.js";
