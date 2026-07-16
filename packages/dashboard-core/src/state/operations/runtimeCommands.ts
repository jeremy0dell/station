import type { StationCommand, TerminalFocusOrigin } from "@station/contracts";

export type CommandRuntimeOptions = {
  clientLabel: string;
  persistentPopup: boolean;
  focusOrigin?: TerminalFocusOrigin;
  resolveFocusTarget?: () => Promise<TuiFocusTarget | undefined>;
};

export type TuiFocusTarget = {
  origin: TerminalFocusOrigin;
  onFocusSuccess?: () => Promise<void>;
};

type CreateSessionCommand = Extract<StationCommand, { type: "session.create" }>;
type StartAgentCommand = Extract<StationCommand, { type: "session.startAgent" }>;
type ResumeAgentCommand = Extract<StationCommand, { type: "session.resumeAgent" }>;
type RuntimeTerminalOptions = NonNullable<StartAgentCommand["payload"]["terminal"]>;

export async function prepareCreateSessionCommandForRuntime(
  command: CreateSessionCommand,
  runtime: CommandRuntimeOptions,
): Promise<{ command: CreateSessionCommand; target?: TuiFocusTarget }> {
  if (!shouldFocusSessionCommand(runtime)) {
    return { command };
  }

  const target = await resolveFocusTarget(runtime);
  const prepared = {
    ...command,
    payload: {
      ...command.payload,
      terminal: terminalWithRuntimeFocus(command.payload.terminal, target?.origin),
    },
  };
  return target === undefined ? { command: prepared } : { command: prepared, target };
}

async function prepareStartAgentCommandForRuntime(
  command: StartAgentCommand | ResumeAgentCommand,
  runtime: CommandRuntimeOptions,
): Promise<StartAgentCommand | ResumeAgentCommand> {
  if (!shouldFocusSessionCommand(runtime)) {
    return command;
  }

  const origin = (await resolveFocusTarget(runtime))?.origin;
  return {
    ...command,
    payload: {
      ...command.payload,
      terminal: terminalWithRuntimeFocus(command.payload.terminal ?? {}, origin),
    },
  };
}

function terminalWithRuntimeFocus<TerminalOptions extends RuntimeTerminalOptions>(
  terminal: TerminalOptions,
  origin: TerminalFocusOrigin | undefined,
): TerminalOptions & { focus: true } {
  if (origin === undefined) {
    return {
      ...terminal,
      focus: true,
    };
  }
  return {
    ...terminal,
    focus: true,
    origin,
  };
}

function shouldFocusSessionCommand(runtime: CommandRuntimeOptions): boolean {
  return (
    runtime.persistentPopup ||
    runtime.focusOrigin !== undefined ||
    runtime.resolveFocusTarget !== undefined
  );
}

async function resolveFocusTarget(
  runtime: Pick<CommandRuntimeOptions, "focusOrigin" | "resolveFocusTarget">,
): Promise<TuiFocusTarget | undefined> {
  if (runtime.resolveFocusTarget === undefined) {
    return runtime.focusOrigin === undefined ? undefined : { origin: runtime.focusOrigin };
  }
  return (
    (await runtime.resolveFocusTarget()) ??
    (runtime.focusOrigin === undefined ? undefined : { origin: runtime.focusOrigin })
  );
}

export async function prepareCommandForRuntime(
  command: StationCommand,
  runtime: CommandRuntimeOptions,
): Promise<StationCommand> {
  if (command.type === "session.create") {
    return (await prepareCreateSessionCommandForRuntime(command, runtime)).command;
  }
  if (command.type === "session.startAgent") {
    return prepareStartAgentCommandForRuntime(command, runtime);
  }
  if (command.type === "session.resumeAgent") {
    return prepareStartAgentCommandForRuntime(command, runtime);
  }
  return command;
}

export async function prepareFocusCommandForRuntime(
  command: Extract<StationCommand, { type: "terminal.focus" }>,
  runtime: Pick<CommandRuntimeOptions, "focusOrigin" | "resolveFocusTarget">,
): Promise<{
  command: Extract<StationCommand, { type: "terminal.focus" }>;
  target?: TuiFocusTarget;
}> {
  const target = await resolveFocusTarget(runtime);
  if (target === undefined) {
    return { command };
  }
  return {
    command: {
      type: "terminal.focus",
      payload: {
        ...command.payload,
        origin: target.origin,
      },
    },
    target,
  };
}
