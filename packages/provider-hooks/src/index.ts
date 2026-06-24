import { codexHookAdapter } from "@station/codex";
import type { ProviderHookAdapter } from "@station/contracts";
import { piHookAdapter } from "@station/pi";
import { worktrunkHookAdapter } from "@station/worktrunk";

export * from "./command.js";
export * from "./deliveryPolicy.js";
export * from "./observerStartup.js";
export * from "./sender.js";
export * from "./spool.js";
export * from "./stdin.js";

export const defaultProviderHookAdapters: readonly ProviderHookAdapter[] = [
  codexHookAdapter,
  piHookAdapter,
  worktrunkHookAdapter,
];
