import {
  expectedHookCommands,
  expectedIngressHookScript,
  type IngressHookScriptOptions,
} from "@station/harness-shared";
import { CODEX_HOOK_EVENT_NAMES, type CodexHookEventName } from "./hookConstants.js";

export type CodexHookScriptOptions = IngressHookScriptOptions & {
  hookScriptPath: string;
};

export function expectedCodexHookCommands(input: {
  hookScriptPath: string;
}): Record<CodexHookEventName, string> {
  return expectedHookCommands(CODEX_HOOK_EVENT_NAMES, input.hookScriptPath);
}

export function expectedCodexHookScript(input: CodexHookScriptOptions): string {
  return expectedIngressHookScript({ ...input, provider: "codex" });
}
