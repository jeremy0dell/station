import type { StationCommand, TerminalFocusOrigin } from "@station/contracts";

export type CommandRuntimeOptions = {
  clientLabel: string;
  persistentPopup: boolean;
  focusOrigin?: TerminalFocusOrigin;
  resolveFocusOrigin?: () => Promise<TerminalFocusOrigin | undefined>;
};

type CreateSessionCommand = Extract<StationCommand, { type: "session.create" }>;
type StartAgentCommand = Extract<StationCommand, { type: "session.startAgent" }>;
type ResumeAgentCommand = Extract<StationCommand, { type: "session.resumeAgent" }>;
type RuntimeTerminalOptions = NonNullable<StartAgentCommand["payload"]["terminal"]>;

async function prepareCreateSessionCommandForRuntime(
  command: CreateSessionCommand,
  runtime: CommandRuntimeOptions,
): Promise<CreateSessionCommand> {
  if (!shouldFocusSessionCommand(runtime)) {
    return command;
  }

  const origin = await resolveFocusOrigin(runtime);
  return {
    ...command,
    payload: {
      ...command.payload,
      terminal: terminalWithRuntimeFocus(command.payload.terminal, origin),
    },
  };
}

async function prepareStartAgentCommandForRuntime(
  command: StartAgentCommand | ResumeAgentCommand,
  runtime: CommandRuntimeOptions,
): Promise<StartAgentCommand | ResumeAgentCommand> {
  if (!shouldFocusSessionCommand(runtime)) {
    return command;
  }

  const origin = await resolveFocusOrigin(runtime);
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
    runtime.resolveFocusOrigin !== undefined
  );
}

async function resolveFocusOrigin(
  runtime: Pick<CommandRuntimeOptions, "focusOrigin" | "resolveFocusOrigin">,
): Promise<TerminalFocusOrigin | undefined> {
  if (runtime.resolveFocusOrigin === undefined) {
    return runtime.focusOrigin;
  }
  return (await runtime.resolveFocusOrigin()) ?? runtime.focusOrigin;
}

export async function prepareCommandForRuntime(
  command: StationCommand,
  runtime: CommandRuntimeOptions,
): Promise<StationCommand> {
  if (command.type === "session.create") {
    return prepareCreateSessionCommandForRuntime(command, runtime);
  }
  if (command.type === "session.startAgent") {
    return prepareStartAgentCommandForRuntime(command, runtime);
  }
  if (command.type === "session.resumeAgent") {
    return prepareStartAgentCommandForRuntime(command, runtime);
  }
  return command;
}

export async function withResolvedFocusOrigin(
  command: Extract<StationCommand, { type: "terminal.focus" }>,
  runtime: Pick<CommandRuntimeOptions, "focusOrigin" | "resolveFocusOrigin">,
): Promise<Extract<StationCommand, { type: "terminal.focus" }>> {
  const origin = await resolveFocusOrigin(runtime);
  if (origin === undefined) {
    return command;
  }
  return {
    type: "terminal.focus",
    payload: {
      ...command.payload,
      origin,
    },
  };
}
