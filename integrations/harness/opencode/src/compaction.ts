import {
  OpenCodeCompactEventSchema,
  type OpenCodeNativeEvent,
  OpenCodeNativeEventSchema,
} from "./eventSchemas.js";

export type OpenCodePayloadCompactionOptions = {
  cwd?: string;
  pid?: number;
};

export type OpenCodePayloadCompactionResult = {
  payload: unknown;
  compacted: boolean;
  originalByteCount: number | null;
  compactedByteCount: number | null;
  omittedFieldNames: string[];
};

const nativeTopLevelFields = new Set(["id", "type", "properties", "cwd", "directory", "pid"]);

export function compactOpenCodeHookPayload(
  payload: unknown,
  options: OpenCodePayloadCompactionOptions = {},
): OpenCodePayloadCompactionResult {
  const originalByteCount = jsonByteCount(payload);
  const compactResult = OpenCodeCompactEventSchema.safeParse(payload);
  if (compactResult.success) {
    return {
      payload: compactResult.data,
      compacted: false,
      originalByteCount,
      compactedByteCount: jsonByteCount(compactResult.data),
      omittedFieldNames: [],
    };
  }

  const nativeResult = OpenCodeNativeEventSchema.safeParse(payload);
  if (!nativeResult.success) {
    return {
      payload,
      compacted: false,
      originalByteCount,
      compactedByteCount: originalByteCount,
      omittedFieldNames: [],
    };
  }

  const compacted = compactNativeOpenCodeEvent(nativeResult.data, options);
  return {
    payload: compacted.payload,
    compacted: true,
    originalByteCount,
    compactedByteCount: jsonByteCount(compacted.payload),
    omittedFieldNames: compacted.omittedFieldNames,
  };
}

function compactNativeOpenCodeEvent(
  event: OpenCodeNativeEvent,
  options: OpenCodePayloadCompactionOptions,
): { payload: unknown; omittedFieldNames: string[] } {
  const properties = event.properties;
  const promotedProperties = new Set<string>();
  const payload: Record<string, unknown> = {
    event_type: event.type,
    cwd:
      event.cwd ??
      properties?.cwd ??
      event.directory ??
      properties?.directory ??
      options.cwd ??
      process.cwd(),
  };

  if (event.id !== undefined) {
    payload.event_id = event.id;
  }
  if (event.pid !== undefined) {
    payload.pid = event.pid;
  } else if (options.pid !== undefined) {
    payload.pid = options.pid;
  }
  if (properties?.sessionID !== undefined) {
    payload.opencode_session_id = properties.sessionID;
    promotedProperties.add("sessionID");
  } else if (properties?.sessionId !== undefined) {
    payload.opencode_session_id = properties.sessionId;
    promotedProperties.add("sessionId");
  } else if (properties?.info?.id !== undefined) {
    payload.opencode_session_id = properties.info.id;
    promotedProperties.add("info");
  }
  if (properties?.status !== undefined) {
    payload.status_type =
      typeof properties.status === "string" ? properties.status : properties.status.type;
    promotedProperties.add("status");
  }
  if (properties?.reply !== undefined) {
    if (event.type === "permission.replied") {
      payload.permission_reply = properties.reply;
    } else if (event.type === "question.replied") {
      payload.question_reply = properties.reply;
    }
    promotedProperties.add("reply");
  }
  if (event.type === "question.replied" && properties?.answers !== undefined) {
    payload.question_reply = "answered";
    promotedProperties.add("answers");
  }
  if (properties?.requestID !== undefined) {
    payload.request_id = properties.requestID;
    promotedProperties.add("requestID");
  } else if (properties?.id !== undefined) {
    payload.request_id = properties.id;
    promotedProperties.add("id");
  }
  if (properties?.messageID !== undefined) {
    payload.message_id = properties.messageID;
    promotedProperties.add("messageID");
  }
  if (properties?.partID !== undefined) {
    payload.part_id = properties.partID;
    promotedProperties.add("partID");
  }
  if (properties?.callID !== undefined) {
    payload.tool_call_id = properties.callID;
    promotedProperties.add("callID");
  }
  if (typeof properties?.tool === "string") {
    payload.tool_name = properties.tool;
    promotedProperties.add("tool");
  } else if (properties?.tool !== undefined) {
    promotedProperties.add("tool");
    if (properties.tool.messageID !== undefined && payload.message_id === undefined) {
      payload.message_id = properties.tool.messageID;
    }
    if (properties.tool.callID !== undefined && payload.tool_call_id === undefined) {
      payload.tool_call_id = properties.tool.callID;
    }
  }
  if (payload.tool_name === undefined && properties?.name !== undefined) {
    payload.tool_name = properties.name;
    promotedProperties.add("name");
  }
  if (payload.tool_name === undefined && properties?.permission !== undefined) {
    payload.tool_name = properties.permission;
    promotedProperties.add("permission");
  }
  if (properties?.command !== undefined) {
    payload.command_name = properties.command;
    promotedProperties.add("command");
  } else if (event.type === "command.executed" && properties?.name !== undefined) {
    payload.command_name = properties.name;
    promotedProperties.add("name");
  }
  if (properties?.file !== undefined) {
    payload.file_path = properties.file;
    promotedProperties.add("file");
  } else if (properties?.path !== undefined) {
    payload.file_path = properties.path;
    promotedProperties.add("path");
  }
  if (properties?.error?.name !== undefined) {
    payload.error_name = properties.error.name;
    promotedProperties.add("error");
  }
  if (properties !== undefined) {
    payload.property_keys = Object.keys(properties).sort().slice(0, 128);
  }

  const parsed = OpenCodeCompactEventSchema.parse(payload);
  return {
    payload: parsed,
    omittedFieldNames: omittedNativeFieldNames(event, promotedProperties),
  };
}

function omittedNativeFieldNames(
  event: OpenCodeNativeEvent,
  promotedProperties: ReadonlySet<string>,
): string[] {
  const omitted = new Set<string>();
  for (const key of Object.keys(event)) {
    if (!nativeTopLevelFields.has(key)) {
      omitted.add(key);
    }
  }
  if (event.properties !== undefined) {
    for (const key of Object.keys(event.properties)) {
      if (!promotedProperties.has(key)) {
        omitted.add(`properties.${key}`);
      }
    }
  }
  return [...omitted].sort();
}

function jsonByteCount(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return null;
    }
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    return null;
  }
}
