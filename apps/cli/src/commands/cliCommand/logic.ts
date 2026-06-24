import type {
  CliCommandConfigErrorContext,
  CliCommandNode,
  CliCommandOption,
  CliCommandRoute,
  CliCommandRunContext,
  CliCommandTopic,
  CliHelpMode,
} from "./types.js";

export type CliCommandRegistryApi = {
  isTopLevelCliCommand: (value: string) => boolean;
  cliCommandRequiresConfig: (command: string, args: readonly string[]) => boolean;
  resolveCliCommandRoute: (command: string, args: readonly string[]) => CliCommandRoute | undefined;
  runCliCommandRoute: (
    route: CliCommandRoute,
    context: CliCommandRunContext,
  ) => Promise<Awaited<ReturnType<NonNullable<CliCommandNode["run"]>>>>;
  handleCliCommandConfigError: (
    route: CliCommandRoute,
    error: unknown,
    context: CliCommandConfigErrorContext,
  ) => Promise<Awaited<ReturnType<NonNullable<CliCommandNode["handleConfigError"]>>>>;
  resolveCliCommandTopic: (path: readonly string[]) => CliCommandTopic | undefined;
  renderCliCommandHelpTopic: (path: readonly string[], mode: CliHelpMode) => string;
};

export function createCliCommandRegistryApi(registry: CliCommandNode): CliCommandRegistryApi {
  function isTopLevelCliCommand(value: string): boolean {
    return findChild(registry, value) !== undefined;
  }

  function cliCommandRequiresConfig(command: string, args: readonly string[]): boolean {
    return resolveCliCommandRoute(command, args)?.requiresConfig === true;
  }

  function resolveCliCommandRoute(
    command: string,
    args: readonly string[],
  ): CliCommandRoute | undefined {
    const topLevel = findChild(registry, command);
    if (topLevel === undefined) {
      return undefined;
    }

    const path = [topLevel.name];
    let node = topLevel;
    let requiresConfig = topLevel.requiresConfig === true;
    let route =
      node.run === undefined
        ? undefined
        : {
            node,
            path: [...path],
            args: [...args],
            requiresConfig,
          };

    for (let index = 0; index < args.length; index += 1) {
      const segment = args[index];
      if (segment === undefined) {
        return route;
      }
      const child = findChild(node, segment);
      if (child === undefined) {
        return route;
      }
      node = child;
      path.push(child.name);
      requiresConfig = requiresConfig || child.requiresConfig === true;
      if (node.run !== undefined) {
        route = {
          node,
          path: [...path],
          args: args.slice(index + 1),
          requiresConfig,
        };
      }
    }

    return route;
  }

  async function runCliCommandRoute(
    route: CliCommandRoute,
    context: CliCommandRunContext,
  ): Promise<Awaited<ReturnType<NonNullable<CliCommandNode["run"]>>>> {
    if (route.node.run === undefined) {
      throw new Error(`Unknown command: ${route.path.join(" ")}`);
    }
    return route.node.run({ ...context, path: route.path, args: route.args });
  }

  async function handleCliCommandConfigError(
    route: CliCommandRoute,
    error: unknown,
    context: CliCommandConfigErrorContext,
  ): Promise<Awaited<ReturnType<NonNullable<CliCommandNode["handleConfigError"]>>>> {
    return route.node.handleConfigError?.(error, {
      ...context,
      path: route.path,
      args: route.args,
    });
  }

  function resolveCliCommandTopic(path: readonly string[]): CliCommandTopic | undefined {
    if (path.length === 0) {
      return { node: registry, path: [] };
    }

    let node = registry;
    const resolvedPath: string[] = [];
    for (let index = 0; index < path.length; index += 1) {
      const segment = path[index];
      if (segment === undefined) {
        return undefined;
      }

      const child = findChild(node, segment);
      if (child !== undefined) {
        node = child;
        resolvedPath.push(child.name);
        continue;
      }

      if (node.topicArguments?.includes(segment) === true && index === path.length - 1) {
        return { node, path: resolvedPath };
      }
      return undefined;
    }

    return { node, path: resolvedPath };
  }

  function renderCliCommandHelpTopic(path: readonly string[], mode: CliHelpMode): string {
    const topic = resolveCliCommandTopic(path);
    if (topic === undefined) {
      throw new Error(`Unknown help topic: ${commandLabel(path)}`);
    }
    return renderCliCommandTopic(topic.node, topic.path, mode);
  }

  return {
    isTopLevelCliCommand,
    cliCommandRequiresConfig,
    resolveCliCommandRoute,
    runCliCommandRoute,
    handleCliCommandConfigError,
    resolveCliCommandTopic,
    renderCliCommandHelpTopic,
  };
}

function renderCliCommandTopic(
  node: CliCommandNode,
  path: readonly string[],
  mode: CliHelpMode,
): string {
  const lines: string[] = [];
  addSection(lines, "Usage", node.usage ?? [commandLabel(path)]);
  addSection(lines, "Summary", [node.description]);
  addEntrySection(lines, "Commands", commandEntries(node.children));
  addEntrySection(lines, "Options", node.options);
  addSection(lines, "Examples", node.examples);

  if (mode === "man") {
    addSection(lines, "Behavior Notes", node.notes ?? genericNotes(path));
    addSection(lines, "Manual Verification", node.verification ?? genericVerification(path));
  }

  return `${lines.join("\n")}\n`;
}

function commandEntries(children: readonly CliCommandNode[] | undefined): CliCommandOption[] {
  if (children === undefined) {
    return [];
  }
  return children.map((child) => ({
    name: child.displayName ?? child.name,
    description: child.description,
  }));
}

function addSection(lines: string[], heading: string, values: readonly string[] | undefined): void {
  if (values === undefined || values.length === 0) {
    return;
  }
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(`${heading}:`);
  for (const value of values) {
    lines.push(`  ${value}`);
  }
}

function addEntrySection(
  lines: string[],
  heading: string,
  entries: readonly CliCommandOption[] | undefined,
): void {
  if (entries === undefined || entries.length === 0) {
    return;
  }
  const width = Math.max(...entries.map((entry) => entry.name.length));
  addSection(
    lines,
    heading,
    entries.map((entry) => `${entry.name.padEnd(width)}  ${entry.description}`),
  );
}

function genericNotes(path: readonly string[]): string[] {
  return [
    `${commandLabel(path)} help and manual output is read-only.`,
    "The help path is resolved before config loading and before observer startup.",
  ];
}

function genericVerification(path: readonly string[]): string[] {
  const suffix = path.length === 0 ? "" : ` ${path.join(" ")}`;
  return [`pnpm stn${suffix} --help`, `pnpm stn${suffix} --man`];
}

function findChild(parent: CliCommandNode, name: string): CliCommandNode | undefined {
  return parent.children?.find((child) => child.name === name);
}

function commandLabel(path: readonly string[]): string {
  return path.length === 0 ? "stn" : `stn ${path.join(" ")}`;
}
