import { setHarnessInstallHooksInToml } from "../harnesses/installHooks.js";
import { loadConfigFromToml } from "../load/index.js";
import { quoteTomlString } from "../tomlEdit.js";

type SetupConfigHarnessId = "claude" | "codex" | "cursor" | "opencode" | "pi";

export type SetupConfigDesiredState = {
  readonly defaultHarness: SetupConfigHarnessId;
  readonly harnesses: readonly {
    readonly id: SetupConfigHarnessId;
    readonly command: string;
    readonly installHooks: boolean;
  }[];
  readonly worktrunkCommand: string;
  readonly tmuxCommand?: string;
  readonly installWorktrunkHooks: boolean;
};

export type SetupConfigMutationInput = {
  readonly configPath: string;
  readonly homeDir: string;
  readonly current:
    | { readonly state: "missing" }
    | { readonly state: "valid"; readonly source: string };
  readonly desired: SetupConfigDesiredState;
};

export type SetupConfigMutationPlan =
  | { readonly operation: "none"; readonly reason: string }
  | {
      readonly operation: "blocked";
      readonly path: string;
      readonly reason: string;
    }
  | {
      readonly operation: "create";
      readonly path: string;
      readonly content: string;
    }
  | {
      readonly operation: "update";
      readonly path: string;
      readonly before: string;
      readonly content: string;
    };

export async function planSetupConfigMutation(
  input: SetupConfigMutationInput,
): Promise<SetupConfigMutationPlan> {
  if (input.current.state === "missing") {
    const content = renderSetupConfig(input.desired);
    await validateCandidate(content, input);
    return { operation: "create", path: input.configPath, content };
  }

  const loaded = await loadConfigFromToml(input.current.source, {
    configPath: input.configPath,
    homeDir: input.homeDir,
  });
  const coreProblem = existingConfigUpdateCoreProblem(loaded.config.defaults);
  if (coreProblem !== undefined) {
    return { operation: "blocked", path: input.configPath, reason: coreProblem };
  }

  let content = input.current.source;
  for (const harness of input.desired.harnesses) {
    const configured = loaded.config.harness?.[harness.id];
    if (configured !== undefined && harness.installHooks && configured.installHooks !== true) {
      content = await setHarnessInstallHooksInToml(content, {
        harness: harness.id,
        installHooks: true,
        configPath: input.configPath,
        homeDir: input.homeDir,
      });
    }
  }

  const missingHarnesses = input.desired.harnesses.filter(
    (harness) => loaded.config.harness?.[harness.id] === undefined,
  );
  const appendedText = renderHarnessAppendText(
    missingHarnesses,
    preferredNewline(input.current.source),
  );
  if (appendedText.length > 0) {
    content = `${content}${content.endsWith("\n") ? "" : preferredNewline(content)}${appendedText}`;
  }
  if (content === input.current.source) {
    return {
      operation: "none",
      reason:
        input.desired.harnesses.length === 1
          ? "Config already includes the selected harness and core defaults."
          : "Config already includes the selected harnesses and core defaults.",
    };
  }

  await validateCandidate(content, input);
  return {
    operation: "update",
    path: input.configPath,
    before: input.current.source,
    content,
  };
}

export function renderSetupConfig(desired: SetupConfigDesiredState): string {
  const defaultHarness = desired.harnesses.find((harness) => harness.id === desired.defaultHarness);
  if (defaultHarness === undefined) {
    throw new Error("New setup config requires its default harness in the selected harnesses.");
  }
  return [
    "schema_version = 1",
    "projects = []",
    "",
    "[observer]",
    'state_dir = "~/.local/state/station"',
    "",
    "[defaults]",
    'worktree_provider = "worktrunk"',
    'terminal = "tmux"',
    `harness = ${quoteTomlString(defaultHarness.id)}`,
    'layout = "agent-shell"',
    "",
    "[worktree.worktrunk]",
    `command = ${quoteTomlString(desired.worktrunkCommand)}`,
    'managed_root = "~/.worktrees"',
    "include_main = false",
    "include_external = false",
    `use_lifecycle_hooks = ${desired.installWorktrunkHooks ? "true" : "false"}`,
    `hook_mode = ${quoteTomlString(desired.installWorktrunkHooks ? "required-for-mvp" : "disabled")}`,
    "",
    "[terminal.tmux]",
    ...(desired.tmuxCommand === undefined
      ? []
      : [`command = ${quoteTomlString(desired.tmuxCommand)}`]),
    'session_prefix = "station"',
    'topology = "workbench"',
    'workbench_session = "station"',
    'window_naming = "project-branch"',
    "primary_agent_pane = true",
    "",
    ...desired.harnesses.flatMap((harness) => [...renderHarnessBlock(harness).split("\n"), ""]),
  ].join("\n");
}

function renderHarnessAppendText(
  harnesses: SetupConfigDesiredState["harnesses"],
  newline: "\n" | "\r\n",
): string {
  if (harnesses.length === 0) return "";
  const blocks = harnesses.map((harness) => renderHarnessBlock(harness).replaceAll("\n", newline));
  return `${newline}${blocks.join(`${newline}${newline}`)}${newline}`;
}

function renderHarnessBlock(harness: SetupConfigDesiredState["harnesses"][number]): string {
  return [
    `[harness.${harness.id}]`,
    "enabled = true",
    `command = ${quoteTomlString(harness.command)}`,
    ...(harness.installHooks ? ["install_hooks = true"] : []),
  ].join("\n");
}

function existingConfigUpdateCoreProblem(defaults: {
  worktreeProvider: string;
  terminal: string;
  harness: string;
}): string | undefined {
  if (defaults.worktreeProvider !== "worktrunk") {
    return `Config defaults use worktree provider ${defaults.worktreeProvider}; setup will not rewrite existing defaults.`;
  }
  if (defaults.terminal !== "tmux") {
    return `Config defaults use terminal ${defaults.terminal}; setup will not rewrite existing defaults.`;
  }
  if (!supportedSetupHarnessIds.has(defaults.harness)) {
    return `Config defaults use unsupported harness ${defaults.harness}; setup will not rewrite existing defaults.`;
  }
  return undefined;
}

const supportedSetupHarnessIds: ReadonlySet<string> = new Set<SetupConfigHarnessId>([
  "claude",
  "codex",
  "cursor",
  "opencode",
  "pi",
]);

async function validateCandidate(
  content: string,
  input: Pick<SetupConfigMutationInput, "configPath" | "homeDir">,
): Promise<void> {
  await loadConfigFromToml(content, {
    configPath: input.configPath,
    homeDir: input.homeDir,
  });
}

function preferredNewline(source: string): "\n" | "\r\n" {
  return source.includes("\r\n") ? "\r\n" : "\n";
}
