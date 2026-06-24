import {
  expectedHookCommands,
  expectedIngressHookScript,
  type IngressHookScriptOptions,
} from "@station/harness-shared";
import { CURSOR_HOOK_EVENT_NAMES, type CursorHookEventName } from "./hookConstants.js";

export type CursorHookScriptOptions = IngressHookScriptOptions & {
  hookScriptPath: string;
};

export function expectedCursorHookCommands(input: {
  hookScriptPath: string;
}): Record<CursorHookEventName, string> {
  return expectedHookCommands(CURSOR_HOOK_EVENT_NAMES, input.hookScriptPath);
}

export function expectedCursorHookScript(input: CursorHookScriptOptions): string {
  return expectedIngressHookScript({ ...input, provider: "cursor" });
}
