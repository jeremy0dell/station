import type { NotifyCommandDeps } from "./commands/notify.js";
import type { ObserveCommandDeps } from "./commands/observe/index.js";
import type { PopupCommandDeps } from "./commands/popup.js";
import type { SetupCommandDeps } from "./commands/setup/index.js";
import type { TuiCommandDeps } from "./commands/tui.js";
import type { CliEnv } from "./env.js";
import type { ObserverProcessDeps } from "./observerProcess.js";

export type CliRunResult = {
  code: number;
  output?: unknown;
  outputFormat?: "json" | "text";
};

export type CliRunOptions = {
  stdin?: string;
  env?: CliEnv;
  observerDeps?: ObserverProcessDeps;
  popupDeps?: PopupCommandDeps;
  tuiDeps?: TuiCommandDeps;
  notifyDeps?: NotifyCommandDeps;
  observeDeps?: ObserveCommandDeps;
  setupDeps?: SetupCommandDeps;
};
