import type { StationConfig } from "@station/config";
import type { CliRunOptions, CliRunResult } from "../../cliTypes.js";

export type CliCommandOption = {
  name: string;
  description: string;
};

export type CliHelpMode = "help" | "man";

export type CliCommandRunContext = {
  path: readonly string[];
  args: string[];
  allArgs: string[];
  cliEntryPath: string;
  renderHelpTopic: (path: readonly string[], mode: CliHelpMode) => string;
  configPath?: string;
  config?: StationConfig;
  resolvedConfigPath?: string;
  options: CliRunOptions;
};

export type CliCommandConfigErrorContext = Omit<
  CliCommandRunContext,
  "config" | "resolvedConfigPath"
>;

export type CliCommandNode = {
  name: string;
  description: string;
  displayName?: string;
  usage?: readonly string[];
  options?: readonly CliCommandOption[];
  examples?: readonly string[];
  notes?: readonly string[];
  verification?: readonly string[];
  requiresConfig?: boolean;
  topicArguments?: readonly string[];
  children?: readonly CliCommandNode[];
  run?: (context: CliCommandRunContext) => Promise<CliRunResult>;
  handleConfigError?: (
    error: unknown,
    context: CliCommandConfigErrorContext,
  ) => Promise<CliRunResult | undefined>;
};

export type CliCommandTopic = {
  node: CliCommandNode;
  path: readonly string[];
};

export type CliCommandRoute = CliCommandTopic & {
  args: string[];
  requiresConfig: boolean;
};
