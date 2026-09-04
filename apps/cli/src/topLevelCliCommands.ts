const topLevelCliCommandNames = [
  "command",
  "debug",
  "doctor",
  "event-hooks",
  "group",
  "hooks",
  "host",
  "notify",
  "observe",
  "observer",
  "popup",
  "project",
  "repair",
  "reconcile",
  "session",
  "setup",
  "snapshot",
  "tui",
  "update",
  "worktrunk",
] as const;

const topLevelCliCommands = new Set<string>(topLevelCliCommandNames);

export function isTopLevelCliCommand(value: string): boolean {
  return topLevelCliCommands.has(value);
}

export function allTopLevelCliCommandNames(): readonly string[] {
  return topLevelCliCommandNames;
}
