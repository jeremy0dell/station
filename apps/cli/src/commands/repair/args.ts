import {
  type RecoveryRepairDryRunRequest,
  RecoveryRepairDryRunRequestSchema,
  type RuntimeRepairDryRunRequest,
  RuntimeRepairDryRunRequestSchema,
} from "@station/contracts";

export type RepairArgs =
  | { action: "inventory"; json: boolean }
  | { action: "runtime"; json: boolean; request: RuntimeRepairDryRunRequest }
  | { action: "recovery"; json: boolean; request: RecoveryRepairDryRunRequest };

export function parseRepairArgs(args: readonly string[]): RepairArgs {
  const action = args[0];
  if (action === undefined) throw new Error("repair requires inventory, runtime, or recovery.");
  if (action === "inventory") return parseInventoryArgs(args.slice(1));
  if (action === "runtime") return parseRuntimeArgs(args.slice(1));
  if (action === "recovery") return parseRecoveryArgs(args.slice(1));
  throw new Error(`Unknown repair action: ${action}`);
}

function parseInventoryArgs(args: readonly string[]): RepairArgs {
  const unknown = args.find((arg) => arg !== "--json");
  if (unknown !== undefined) throw new Error(`Unknown repair inventory option: ${unknown}`);
  return { action: "inventory", json: args.includes("--json") };
}

function parseRuntimeArgs(args: readonly string[]): RepairArgs {
  rejectMutationFlags(args);
  const values = parseValues(args, new Set(["--expect-inventory", "--target"]));
  requireDryRun(values.flags);
  const expectInventory = oneValue(values.options, "--expect-inventory");
  const targetKeys = repeatedValues(values.options, "--target");
  return {
    action: "runtime",
    json: values.flags.has("--json"),
    request: RuntimeRepairDryRunRequestSchema.parse({
      schemaVersion: 1,
      dryRun: true,
      expectInventory,
      targetKeys: sortedUnique(targetKeys, "--target"),
    }),
  };
}

function parseRecoveryArgs(args: readonly string[]): RepairArgs {
  rejectMutationFlags(args);
  const values = parseValues(
    args,
    new Set(["--expect-inventory", "--session", "--keep-handle", "--prune-handle"]),
  );
  requireDryRun(values.flags);
  const keepValues = repeatedValues(values.options, "--keep-handle");
  if (keepValues.length > 1) throw new Error("--keep-handle may be specified only once.");
  const request = {
    schemaVersion: 1 as const,
    dryRun: true as const,
    expectInventory: oneValue(values.options, "--expect-inventory"),
    sessionId: oneValue(values.options, "--session"),
    pruneHandleIds: sortedUnique(
      repeatedValues(values.options, "--prune-handle"),
      "--prune-handle",
    ),
    ...(keepValues[0] === undefined ? {} : { keepHandleId: keepValues[0] }),
  };
  return {
    action: "recovery",
    json: values.flags.has("--json"),
    request: RecoveryRepairDryRunRequestSchema.parse(request),
  };
}

function parseValues(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
): { flags: Set<string>; options: Map<string, string[]> } {
  const flags = new Set<string>();
  const options = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--json" || arg === "--dry-run") {
      if (flags.has(arg)) throw new Error(`${arg} may be specified only once.`);
      flags.add(arg);
      continue;
    }
    if (!valueFlags.has(arg)) throw new Error(`Unknown repair option: ${arg}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    const current = options.get(arg) ?? [];
    current.push(value);
    options.set(arg, current);
    index += 1;
  }
  return { flags, options };
}

function rejectMutationFlags(args: readonly string[]): void {
  const rejected = args.find(
    (arg) => arg === "--yes" || arg === "--force" || arg === "--expect-plan",
  );
  if (rejected !== undefined) {
    throw new Error(`${rejected} is not supported; repair runtime and recovery are preview-only.`);
  }
}

function requireDryRun(flags: ReadonlySet<string>): void {
  if (!flags.has("--dry-run")) {
    throw new Error("repair runtime and recovery require --dry-run; mutation is not supported.");
  }
}

function oneValue(options: ReadonlyMap<string, string[]>, flag: string): string {
  const values = options.get(flag) ?? [];
  if (values.length === 0) throw new Error(`${flag} is required.`);
  if (values.length > 1) throw new Error(`${flag} may be specified only once.`);
  return values[0] as string;
}

function repeatedValues(options: ReadonlyMap<string, string[]>, flag: string): string[] {
  return options.get(flag) ?? [];
}

function sortedUnique(values: readonly string[], flag: string): string[] {
  const sorted = [...new Set(values)].sort((left, right) => left.localeCompare(right));
  if (sorted.length !== values.length) throw new Error(`${flag} values must be unique.`);
  return sorted;
}
