import { claudeHookAdapter } from "@station/claude";
import { codexHookAdapter } from "@station/codex";
import type { ProviderHookAdapter } from "@station/contracts";
import { cursorHookAdapter } from "@station/cursor";
import { piHookAdapter } from "@station/pi";
import { worktrunkHookAdapter } from "@station/worktrunk";

export * from "./command.js";
export * from "./deliveryPolicy.js";
export * from "./observerStartup.js";
export * from "./sender.js";
export * from "./spool.js";
export * from "./stdin.js";

export const defaultProviderHookAdapters: readonly ProviderHookAdapter[] = [
  claudeHookAdapter,
  codexHookAdapter,
  cursorHookAdapter,
  piHookAdapter,
  worktrunkHookAdapter,
];
