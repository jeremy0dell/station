/** Returns the generated hook script path when it is the command's first shell token. */
export function generatedHookScriptPath(command: string, scriptName: string): string | undefined {
  const executable = firstShellToken(command);
  return executable === scriptName || executable.endsWith(`/${scriptName}`)
    ? executable
    : undefined;
}

function firstShellToken(command: string): string {
  if (!command.startsWith("'")) {
    const separator = command.indexOf(" ");
    return command.slice(0, separator < 0 ? undefined : separator);
  }

  const closingQuote = /'(?: |$)/u.exec(command);
  if (closingQuote?.index === undefined) return "";
  return command.slice(1, closingQuote.index).replaceAll("'\\''", "'");
}
