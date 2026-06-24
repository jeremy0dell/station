import { expectedIngressHookScript, type IngressHookScriptOptions } from "@station/harness-shared";

export type ClaudeHookScriptOptions = IngressHookScriptOptions & {
  hookScriptPath: string;
};

export function expectedClaudeHookScript(input: ClaudeHookScriptOptions): string {
  return expectedIngressHookScript({ ...input, provider: "claude", swallowErrors: true });
}
