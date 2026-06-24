import {
  type CommandId,
  CommandIdSchema,
  type StationEvent,
  StationEventTypeSchema,
} from "@station/contracts";

export type StationEventType = StationEvent["type"];

export type ParsedObserveArgs = {
  json: boolean;
  pane: boolean;
  includeSnapshot: boolean;
  agent: boolean;
  failed: boolean;
  types: readonly StationEventType[];
  traceId?: string;
  commandId?: CommandId;
  limit?: number;
  durationMs?: number;
};

export function parseObserveArgs(args: readonly string[]): ParsedObserveArgs {
  const parsed: {
    json: boolean;
    pane: boolean;
    includeSnapshot: boolean;
    agent: boolean;
    failed: boolean;
    types: StationEventType[];
    traceId?: string;
    commandId?: CommandId;
    limit?: number;
    durationMs?: number;
  } = {
    json: false,
    pane: false,
    includeSnapshot: false,
    agent: false,
    failed: false,
    types: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--json":
        parsed.json = true;
        break;
      case "--pane":
        parsed.pane = true;
        break;
      case "--include-snapshot":
        parsed.includeSnapshot = true;
        break;
      case "--agent":
        parsed.agent = true;
        break;
      case "--failed":
        parsed.failed = true;
        break;
      case "--type": {
        const value = optionValue(args[index + 1], "--type");
        parsed.types.push(...parseEventTypes(value));
        index += 1;
        break;
      }
      case "--trace": {
        parsed.traceId = optionValue(args[index + 1], "--trace");
        index += 1;
        break;
      }
      case "--command": {
        const value = optionValue(args[index + 1], "--command");
        parsed.commandId = parseObserveCommandId(value);
        index += 1;
        break;
      }
      case "--limit": {
        parsed.limit = parseLimit(optionValue(args[index + 1], "--limit"));
        index += 1;
        break;
      }
      case "--duration": {
        parsed.durationMs = parseDurationMs(optionValue(args[index + 1], "--duration"));
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown observe option: ${arg ?? ""}`);
    }
  }

  if (parsed.json && parsed.pane) {
    throw new Error("--pane cannot be combined with --json.");
  }

  return parsed;
}

function optionValue(value: string | undefined, option: string): string {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parseEventTypes(value: string): StationEventType[] {
  const eventTypes = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (eventTypes.length === 0) {
    throw new Error("--type requires at least one event type.");
  }

  return eventTypes.map((eventType) => {
    const parsed = StationEventTypeSchema.safeParse(eventType);
    if (!parsed.success) {
      throw new Error(`Invalid observe event type: ${eventType}.`);
    }
    return parsed.data;
  });
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || value.trim() !== String(parsed)) {
    throw new Error("--limit must be a non-negative integer.");
  }
  return parsed;
}

function parseDurationMs(value: string): number {
  const match = /^(\d+)(ms|s|m)$/.exec(value);
  if (match === null) {
    throw new Error("--duration must be a positive duration like 500ms, 30s, or 5m.");
  }

  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("--duration must be a positive duration like 500ms, 30s, or 5m.");
  }

  const unit = match[2];
  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60_000;
    default:
      throw new Error("--duration must be a positive duration like 500ms, 30s, or 5m.");
  }
}

function parseObserveCommandId(value: string): CommandId {
  const parsed = CommandIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid observe command id: ${value}.`);
  }
  return parsed.data;
}
