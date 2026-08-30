import { isCompiledBinary } from "@station/runtime";
import type { SetupToolInstallOperation } from "@station/setup-core";
import { setupMessageRef } from "@station/setup-messages";
import type { CliEnv } from "../../env.js";
import { createSetupOperationAdapter } from "./adapters/operations.js";
import { checkBrewDependency } from "./checks/brew.js";
import { checkSetupBun } from "./checks/bun.js";
import { checkSetupDiffViewer } from "./checks/diffViewer.js";
import type { SetupDependencyCheckOptions } from "./checks/system.js";
import { checkSetupTmux } from "./checks/tmux.js";
import { checkSetupToolchain, type ToolchainFact } from "./checks/toolchain.js";
import { checkSetupWorktrunk } from "./checks/worktrunk.js";
import { setupPresenter } from "./io.js";
import type {
  TextSetupSystemHint,
  TextSetupSystemRow,
  TextSetupSystemView,
} from "./presenters/text.js";
import { SETUP_TOOL_DEFINITIONS, setupToolDefinitions } from "./toolDefinitions.js";
import type { SetupCommandDeps, SetupCommandOptions, SetupCommandResult } from "./types.js";

export async function runSetupSystemCommand(
  args: { check: boolean; yes: boolean; noBrew: boolean },
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
): Promise<SetupCommandResult> {
  const initial = await collectSystemFacts(args, options, deps);
  const presenter = setupPresenter(deps);
  await presenter.write(
    presenter.renderSystemStatus(projectSystemView(setupMessageRef("system.title"), initial)),
  );

  let operationFailed = false;
  if (args.yes && initial.brew.status === "ok") {
    const operations = applicableSystemTools(initial).flatMap(({ id, factKey }) =>
      initial[factKey].status === "missing" ? [systemInstallOperation(id)] : [],
    );
    const executeOperation = createSetupOperationAdapter({ deps });
    // System prerequisites are ordered and fail-fast, so later installs never run after a required package failure.
    for (const operation of operations) {
      const progress = {
        label: systemToolInstallLabel({ operation, text: presenter.text }),
      };
      await presenter.write(`${presenter.renderProgressStart(progress)}\n`);
      const outcome = await executeOperation(operation);
      if (outcome.status === "failed") {
        operationFailed = true;
        await presenter.write(`${presenter.renderProgressFailure(progress, outcome.error)}\n`);
        await presenter.writeMessage(setupMessageRef("system.install-failed"));
        break;
      }
      await presenter.write(`${presenter.renderProgressComplete(progress)}\n`);
    }
  }

  if (!args.yes) {
    return { code: systemReady(initial) ? 0 : 1 };
  }

  const refreshed = await collectSystemFacts(args, options, deps);
  await presenter.write(
    presenter.renderSystemStatus(
      projectSystemView(setupMessageRef("system.final-title"), refreshed),
    ),
  );
  return { code: !operationFailed && systemReady(refreshed) ? 0 : 1 };
}

type SystemFacts = {
  compiled: boolean;
  worktrunk: Awaited<ReturnType<typeof checkSetupWorktrunk>>;
  tmux: Awaited<ReturnType<typeof checkSetupTmux>>;
  bun: Awaited<ReturnType<typeof checkSetupBun>>;
  diffViewer: Awaited<ReturnType<typeof checkSetupDiffViewer>>;
  brew: Awaited<ReturnType<typeof checkBrewDependency>>;
  toolchain: Awaited<ReturnType<typeof checkSetupToolchain>> | undefined;
};

async function collectSystemFacts(
  args: { noBrew: boolean },
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
): Promise<SystemFacts> {
  const env = deps.env ?? options.env;
  const compiled = deps.compiled ?? isCompiledBinary();
  const dependencyOptions = dependencyOptionsForCommand(deps, env);
  const [worktrunk, tmux, bun, diffViewer, brew, toolchain] = await Promise.all([
    checkSetupWorktrunk(dependencyOptions),
    checkSetupTmux(dependencyOptions),
    compiled
      ? Promise.resolve({ status: "ok" as const, command: SETUP_TOOL_DEFINITIONS.bun.command })
      : checkSetupBun(dependencyOptions),
    checkSetupDiffViewer(dependencyOptions),
    checkBrewDependency({
      ...(deps.runner === undefined ? {} : { runner: deps.runner }),
      ...(env === undefined ? {} : { env }),
      ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
      noBrew: args.noBrew,
    }),
    compiled
      ? Promise.resolve(undefined)
      : checkSetupToolchain({
          ...(deps.runner === undefined ? {} : { runner: deps.runner }),
          ...(env === undefined ? {} : { env }),
          ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
          ...(deps.nodeVersion === undefined ? {} : { nodeVersion: deps.nodeVersion }),
        }),
  ]);
  return { compiled, worktrunk, tmux, bun, diffViewer, brew, toolchain };
}

function projectSystemView(
  title: TextSetupSystemView["title"],
  facts: SystemFacts,
): TextSetupSystemView {
  const rows: TextSetupSystemRow[] = [
    ...applicableSystemTools(facts)
      .filter(({ id }) => id !== "bun")
      .map(({ factKey, label }) => dependencySystemRow(facts[factKey].status, label)),
    {
      status: facts.brew.status === "ok" ? "ok" : facts.brew.status,
      label: setupMessageRef("label.homebrew"),
    },
    ...(facts.toolchain === undefined
      ? []
      : [
          toolchainSystemRow(facts.toolchain.node, setupMessageRef("label.node")),
          toolchainSystemRow(facts.toolchain.bun, setupMessageRef("label.bun")),
        ]),
  ];
  return {
    title,
    rows,
    hints: facts.toolchain === undefined ? [] : runtimeToolchainHints(facts.toolchain),
  };
}

function dependencySystemRow(
  status: "ok" | "missing",
  label: TextSetupSystemRow["label"],
): TextSetupSystemRow {
  return { status, label };
}

function toolchainSystemRow(
  fact: ToolchainFact,
  label: TextSetupSystemRow["label"],
): TextSetupSystemRow {
  return {
    status: fact.status === "ok" ? "ok" : "warn",
    label,
    detail: `${toolchainStatusLabel(fact)} ${toolchainVersionLabel(fact)}`,
  };
}

function systemReady(facts: SystemFacts): boolean {
  return (
    applicableSystemTools(facts).every(({ factKey }) => facts[factKey].status === "ok") &&
    (facts.toolchain === undefined ||
      (facts.toolchain.node.status === "ok" && facts.toolchain.bun.status === "ok"))
  );
}

function applicableSystemTools(facts: SystemFacts) {
  return setupToolDefinitions.filter(({ id }) => id !== "bun" || !facts.compiled);
}

function systemInstallOperation(
  tool: SetupToolInstallOperation["tool"],
): SetupToolInstallOperation {
  return {
    id: `install:${tool}`,
    kind: "install-tool",
    tier: "required",
    selected: true,
    tool,
  };
}

function systemToolInstallLabel(input: {
  readonly operation: SetupToolInstallOperation;
  readonly text: (reference: ReturnType<typeof setupMessageRef>) => string;
}): string {
  const { operation, text } = input;
  const definition = SETUP_TOOL_DEFINITIONS[operation.tool];
  return text(
    setupMessageRef("action.install-label", {
      label: text(definition.label),
    }),
  );
}

function dependencyOptionsForCommand(
  deps: SetupCommandDeps,
  env: CliEnv | undefined,
): SetupDependencyCheckOptions {
  const dependencyOptions: SetupDependencyCheckOptions = {};
  if (env !== undefined) dependencyOptions.env = env;
  if (deps.runner !== undefined) dependencyOptions.runner = deps.runner;
  if (deps.access !== undefined) dependencyOptions.access = deps.access;
  return dependencyOptions;
}

function toolchainStatusLabel(fact: ToolchainFact): string {
  return fact.status === "ok" ? "ok" : fact.status;
}

function toolchainVersionLabel(fact: ToolchainFact): string {
  const actual = fact.actual ?? "not found";
  return `${actual} (expected ${fact.expected})`;
}

function runtimeToolchainHints(toolchain: {
  node: ToolchainFact;
  bun: ToolchainFact;
}): TextSetupSystemHint[] {
  const hints: TextSetupSystemHint[] = [];
  if (toolchain.node.status !== "ok") {
    hints.push({
      message: setupMessageRef("system.node-hint"),
      commandSequences: [
        [
          ["fnm", "install", "24"],
          ["fnm", "use", "24"],
        ],
        [
          ["nvm", "install", "24"],
          ["nvm", "use", "24"],
        ],
      ],
    });
  }
  if (toolchain.bun.status !== "ok") {
    hints.push({
      message: setupMessageRef("system.bun-hint", { version: toolchain.bun.expected }),
    });
  }
  if (hints.length > 0) {
    hints.push({ message: setupMessageRef("system.unchanged-hint") });
  }
  return hints;
}
