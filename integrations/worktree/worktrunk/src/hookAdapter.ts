import type { ProviderHookAdapter } from "@station/contracts";
import { normalizeWorktrunkLifecycleEvent } from "./hooks.js";

export const worktrunkHookAdapter: ProviderHookAdapter = {
  provider: "worktrunk",
  kind: "worktree",
  normalizeEventName: normalizeWorktrunkLifecycleEvent,
};
