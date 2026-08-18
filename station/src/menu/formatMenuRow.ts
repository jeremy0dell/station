export function formatMenuRow(
  label: string,
  shortcut: string | undefined,
  availableCells: number,
): string {
  const width = Math.max(0, availableCells);
  const visibleShortcut = shortcut !== undefined && width > shortcut.length ? shortcut : "";
  const suffix = visibleShortcut === "" ? "" : ` ${visibleShortcut}`;
  const visibleLabel = label.slice(0, Math.max(0, width - suffix.length));
  return `${visibleLabel}${" ".repeat(Math.max(0, width - visibleLabel.length - suffix.length))}${suffix}`;
}
