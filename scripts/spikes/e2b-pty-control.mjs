import { createHash } from "node:crypto";
import { addAbortListener } from "node:events";
import { types } from "node:util";
import { z } from "zod";

const e2bAllTraffic = "0.0.0.0/0";

const e2bPtyShell = "/bin/bash";

const e2bPtyShellArgs = Object.freeze(["-i", "-l"]);

const ptyMarkerEnvironmentKeys = Object.freeze({
  executionId: "STATION_E2B_EXECUTION_ID",
  generation: "STATION_E2B_GENERATION",
  launchNonce: "STATION_E2B_LAUNCH_NONCE",
  source: "STATION_E2B_SOURCE",
});

const ptyMarkerEnvironmentNames = Object.freeze(Object.values(ptyMarkerEnvironmentKeys));

const ptyMaximumChunkBytes = 1_048_576;

const ptyMaximumPendingOutputBytes = 1_048_576;

const sandboxStateSchema = z.enum(["running", "paused"]);

const sandboxIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9-]+$/);

const ptyPidSchema = z.number().int().positive().max(2_147_483_647);

const generationSchema = z.number().int().positive().safe();

const ptyGenerationMarkerSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(generationSchema);

const scopeIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_.-]+$/);

const remoteWorkspaceRoot = "/workspace/station-481";

const remoteWorkspacePathSchema = z
  .string()
  .max(128)
  .regex(/^\/workspace\/station-481\/[a-fA-F0-9-]{36}$/);

const ptyAdapterConfigSchema = z
  .object({
    scopeId: scopeIdSchema,
    sandboxTimeoutMs: z.number().int().min(30_000).max(1_200_000),
    requestTimeoutMs: z.number().int().min(1_000).max(60_000),
  })
  .strict();

const PtyCandidateSchema = z
  .object({
    sandboxId: sandboxIdSchema,
    pid: ptyPidSchema,
    executionId: z.string().uuid(),
    generation: generationSchema,
    launchNonce: z.string().uuid(),
  })
  .strict();

const adapterOperationOptionsSchema = z.object({ signal: z.instanceof(AbortSignal) }).strict();

const lifecycleFunctionSchema = z.custom((input) => typeof input === "function");

const ptyTerminalSizeSchema = z
  .object({
    cols: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
  })
  .strict();

const ptyAttachmentOptionsSchema = z
  .object({
    signal: z.instanceof(AbortSignal),
    onData: lifecycleFunctionSchema,
  })
  .strict();

const ptyCreateOptionsSchema = ptyAttachmentOptionsSchema
  .extend({ size: ptyTerminalSizeSchema })
  .strict();

const abortSignalPrototype = AbortSignal.prototype;

const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

const objectGetPrototypeOf = Object.getPrototypeOf;

const objectPrototype = Object.prototype;

const reflectOwnKeys = Reflect.ownKeys;

const abortSignalAbortedDescriptor = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
  abortSignalPrototype,
  "aborted",
]);

const abortSignalAbortedGetter = abortSignalAbortedDescriptor?.get;

const eventTargetPrototype = EventTarget.prototype;

const eventTargetAddEventListener = EventTarget.prototype.addEventListener;

const eventTargetRemoveEventListener = EventTarget.prototype.removeEventListener;

const NativeAbortController = AbortController;

const abortControllerAbort = AbortController.prototype.abort;

const abortControllerSignalGetter = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
  AbortController.prototype,
  "signal",
])?.get;

const arrayIsArray = Array.isArray;

const arrayPush = Array.prototype.push;

const dateGetTime = Date.prototype.getTime;

const dateNow = Date.now;

const uint8ArrayPrototype = Uint8Array.prototype;

const uint8ArraySlice = Uint8Array.prototype.slice;

const typedArrayPrototype = Reflect.apply(objectGetPrototypeOf, Object, [uint8ArrayPrototype]);

const typedArrayByteLengthGetter = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
  typedArrayPrototype,
  "byteLength",
])?.get;

const isProxy = types.isProxy;

const stationSandboxMetadataSchema = z
  .object({
    station_owner: z.literal("station_e2b_spike"),
    station_issue: z.literal("481"),
    station_run_id: z.string().uuid(),
    station_execution_id: z.string().uuid(),
    station_generation: z.string().regex(/^[1-9][0-9]*$/),
    station_scope_id: scopeIdSchema,
    station_config_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

const ptyAuthorityIdentityShape = {
  sandboxId: sandboxIdSchema,
  expectedMetadata: stationSandboxMetadataSchema,
  workspacePath: remoteWorkspacePathSchema,
  executionId: z.string().uuid(),
  generation: generationSchema,
  launchNonce: z.string().uuid(),
  sourceFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
};

const ptyAuthoritySchema = z
  .discriminatedUnion("mode", [
    z.object({ ...ptyAuthorityIdentityShape, mode: z.literal("preflight") }).strict(),
    z.object({ ...ptyAuthorityIdentityShape, mode: z.literal("launch") }).strict(),
    z.object({ ...ptyAuthorityIdentityShape, mode: z.literal("cleanup_discovery") }).strict(),
    z
      .object({ ...ptyAuthorityIdentityShape, mode: z.literal("control"), pid: ptyPidSchema })
      .strict(),
    z
      .object({ ...ptyAuthorityIdentityShape, mode: z.literal("cleanup"), pid: ptyPidSchema })
      .strict(),
  ])
  .superRefine((authority, context) => {
    if (authority.workspacePath !== `${remoteWorkspaceRoot}/${authority.executionId}`) {
      context.addIssue({
        code: "custom",
        path: ["workspacePath"],
        message: "PTY authority workspace mismatch.",
      });
    }
    if (
      authority.expectedMetadata.station_execution_id !== authority.executionId ||
      authority.expectedMetadata.station_generation !== String(authority.generation)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expectedMetadata"],
        message: "PTY authority metadata mismatch.",
      });
    }
  });

const sdkSandboxMetadataSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .refine((value) => Buffer.byteLength(value) <= 128),
    z
      .string()
      .max(1_024)
      .refine((value) => Buffer.byteLength(value) <= 1_024),
  )
  .superRefine((metadata, context) => {
    const entries = Object.entries(metadata);
    if (entries.length > 32) {
      context.addIssue({ code: "custom", message: "Too many SDK metadata entries." });
    }
    const byteCount = entries.reduce(
      (total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(value),
      0,
    );
    if (byteCount > 8_192) {
      context.addIssue({ code: "custom", message: "SDK metadata is too large." });
    }
  });

const sdkSandboxListItemSchema = z
  .object({
    sandboxId: sandboxIdSchema,
    templateId: z.string().min(1).max(512),
    name: z.string().min(1).max(512).optional(),
    metadata: sdkSandboxMetadataSchema,
    startedAt: z.date(),
    endAt: z.date(),
    state: sandboxStateSchema,
    cpuCount: z.number().int().positive().max(1_024),
    memoryMB: z.number().int().positive().max(16_777_216),
    envdVersion: z.string().min(1).max(128),
    volumeMounts: z
      .array(
        z
          .object({
            name: z.string().min(1).max(512),
            path: z.string().min(1).max(4_096),
          })
          .strict(),
      )
      .max(128),
  })
  .strict();

const sourceNetworkTransformSchema = z
  .object({
    headers: z
      .record(z.string().min(1).max(256), z.string().max(8_192))
      .superRefine((headers, context) => {
        if (Object.keys(headers).length > 128) {
          context.addIssue({ code: "custom", message: "Too many network transform headers." });
        }
      })
      .optional(),
  })
  .strict();

const sourceNetworkRuleInfoSchema = z
  .object({ transform: sourceNetworkTransformSchema.optional() })
  .strict();

const sourceNetworkRulesInfoSchema = z
  .record(z.string().min(1).max(512), z.array(sourceNetworkRuleInfoSchema).max(32))
  .superRefine((rules, context) => {
    if (Object.keys(rules).length > 128) {
      context.addIssue({ code: "custom", message: "Too many network rule hosts." });
    }
  });

const sourceNetworkInfoSchema = z
  .object({
    allowOut: z.array(z.string().min(1).max(512)).max(128).optional(),
    denyOut: z.array(z.string().min(1).max(512)).max(128).optional(),
    rules: sourceNetworkRulesInfoSchema.optional(),
    egressProxy: z
      .object({
        address: z.string().min(1).max(512),
        username: z
          .string()
          .max(255)
          .refine((value) => Buffer.byteLength(value) <= 255)
          .optional(),
      })
      .strict()
      .optional(),
    allowPublicTraffic: z.boolean().optional(),
    maskRequestHost: z.string().min(1).max(512).optional(),
  })
  .strict();

const sourceSandboxInfoSchema = sdkSandboxListItemSchema
  .extend({
    allowInternetAccess: z.boolean().optional(),
    network: sourceNetworkInfoSchema.optional(),
    lifecycle: z
      .object({
        onTimeout: z.enum(["pause", "kill"]),
        autoResume: z.boolean(),
      })
      .strict()
      .optional(),
    sandboxDomain: z.string().min(1).max(512).optional(),
  })
  .strict();

const ptyProcessEnvironmentSchema = z
  .record(z.string().min(1).max(256), z.string().max(32_768))
  .superRefine((environment, context) => {
    const entries = Object.entries(environment);
    if (entries.length > 256) {
      context.addIssue({ code: "custom", message: "Too many PTY environment entries." });
      return;
    }
    const byteCount = entries.reduce(
      (total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(value),
      0,
    );
    if (byteCount > 65_536) {
      context.addIssue({ code: "custom", message: "PTY environment is too large." });
    }
  });

const ptySdkProcessInfoSchema = z
  .object({
    pid: ptyPidSchema,
    tag: z.string().min(1).max(256).optional(),
    cmd: z.string().min(1).max(4_096),
    args: z.array(z.string().max(4_096)).max(128),
    envs: ptyProcessEnvironmentSchema,
    cwd: z.string().min(1).max(4_096).optional(),
  })
  .strict();

const ptySdkScanResultSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("observed"), candidates: z.array(PtyCandidateSchema).max(10_000) })
    .strict(),
  z.object({ kind: z.literal("conflict") }).strict(),
  z.object({ kind: z.literal("unproven") }).strict(),
]);

const ptyProviderMutationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request_succeeded") }).strict(),
  z.object({ kind: z.literal("request_uncertain") }).strict(),
  z.object({ kind: z.literal("control_revoked") }).strict(),
]);

const ptyExitObservationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("exited"),
      exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647),
    })
    .strict(),
  z.object({ kind: z.literal("transport_unproven") }).strict(),
]);

const stationMetadataKeys = Object.freeze([
  "station_owner",
  "station_issue",
  "station_run_id",
  "station_execution_id",
  "station_generation",
  "station_scope_id",
  "station_config_fingerprint",
]);

const refusalCodeSchema = z.enum(["PTY_ADAPTER_INCOMPATIBLE", "SDK_INCOMPATIBLE"]);

class SpikeRefusal extends Error {
  constructor(code) {
    const parsed = refusalCodeSchema.safeParse(code);
    const safeCode = parsed.success ? parsed.data : "INTERNAL_REFUSAL";
    super(safeCode);
    this.name = "SpikeRefusal";
    this.code = safeCode;
  }
}

function refuse(code) {
  throw new SpikeRefusal(code);
}

export function fingerprintPtyConfig(input) {
  const config = ptyAdapterConfigSchema.parse(input);
  return `sha256:${createHash("sha256").update(JSON.stringify(config)).digest("hex")}`;
}

function readAbortSignalState(signal, failureCode) {
  let aborted;
  try {
    if (typeof abortSignalAbortedGetter !== "function") refuse(failureCode);
    aborted = Reflect.apply(abortSignalAbortedGetter, signal, []);
  } catch {
    refuse(failureCode);
  }
  if (typeof aborted !== "boolean") refuse(failureCode);
  return aborted;
}

function assertCanonicalAbortSignal(signal, failureCode) {
  let ownAbortedDescriptor;
  let ownAddDescriptor;
  let ownRemoveDescriptor;
  let currentAbortedDescriptor;
  let abortPrototypeAddDescriptor;
  let abortPrototypeRemoveDescriptor;
  let currentAddDescriptor;
  let currentRemoveDescriptor;
  let prototype;
  let prototypeParent;
  try {
    if (isProxy(signal)) refuse(failureCode);
    prototype = Reflect.apply(objectGetPrototypeOf, Object, [signal]);
    prototypeParent = Reflect.apply(objectGetPrototypeOf, Object, [abortSignalPrototype]);
    ownAbortedDescriptor = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
      signal,
      "aborted",
    ]);
    ownAddDescriptor = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
      signal,
      "addEventListener",
    ]);
    ownRemoveDescriptor = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
      signal,
      "removeEventListener",
    ]);
    currentAbortedDescriptor = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
      abortSignalPrototype,
      "aborted",
    ]);
    abortPrototypeAddDescriptor = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
      abortSignalPrototype,
      "addEventListener",
    ]);
    abortPrototypeRemoveDescriptor = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
      abortSignalPrototype,
      "removeEventListener",
    ]);
    currentAddDescriptor = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
      eventTargetPrototype,
      "addEventListener",
    ]);
    currentRemoveDescriptor = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
      eventTargetPrototype,
      "removeEventListener",
    ]);
  } catch {
    refuse(failureCode);
  }
  if (
    prototype !== abortSignalPrototype ||
    prototypeParent !== eventTargetPrototype ||
    ownAbortedDescriptor !== undefined ||
    ownAddDescriptor !== undefined ||
    ownRemoveDescriptor !== undefined ||
    abortPrototypeAddDescriptor !== undefined ||
    abortPrototypeRemoveDescriptor !== undefined ||
    currentAbortedDescriptor?.get !== abortSignalAbortedGetter ||
    currentAbortedDescriptor?.set !== abortSignalAbortedDescriptor?.set ||
    currentAddDescriptor?.value !== eventTargetAddEventListener ||
    currentRemoveDescriptor?.value !== eventTargetRemoveEventListener
  ) {
    refuse(failureCode);
  }
  readAbortSignalState(signal, failureCode);
  return signal;
}

function combineAbortSignals(signals, failureCode) {
  if (
    typeof abortControllerAbort !== "function" ||
    typeof abortControllerSignalGetter !== "function" ||
    typeof addAbortListener !== "function" ||
    typeof eventTargetRemoveEventListener !== "function"
  ) {
    refuse("SDK_INCOMPATIBLE");
  }
  const sources = [];
  for (let index = 0; index < signals.length; index += 1) {
    Reflect.apply(arrayPush, sources, [assertCanonicalAbortSignal(signals[index], failureCode)]);
  }
  const controller = new NativeAbortController();
  let signal;
  try {
    signal = Reflect.apply(abortControllerSignalGetter, controller, []);
  } catch {
    refuse("SDK_INCOMPATIBLE");
  }
  assertCanonicalAbortSignal(signal, "SDK_INCOMPATIBLE");
  const registrations = [];
  const dispose = () => {
    let valid = true;
    for (let index = 0; index < registrations.length; index += 1) {
      const registration = registrations[index];
      try {
        Reflect.apply(eventTargetRemoveEventListener, registration.source, [
          "abort",
          registration.listener,
        ]);
      } catch {
        valid = false;
      }
    }
    registrations.length = 0;
    if (!valid) refuse(failureCode);
  };
  const abort = () => {
    try {
      Reflect.apply(abortControllerAbort, controller, []);
    } catch {
      refuse(failureCode);
    }
  };
  const throwIfAborted = () => {
    if (readAbortSignalState(signal, failureCode)) refuse(failureCode);
    for (let index = 0; index < sources.length; index += 1) {
      if (readAbortSignalState(sources[index], failureCode)) refuse(failureCode);
    }
  };
  try {
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      if (readAbortSignalState(source, failureCode)) refuse(failureCode);
      Reflect.apply(arrayPush, registrations, [{ source, listener: abort }]);
      addAbortListener(source, abort);
      if (readAbortSignalState(source, failureCode)) abort();
    }
    throwIfAborted();
  } catch {
    try {
      dispose();
    } catch {
      // The fixed refusal below contains both registration and disposal failures.
    }
    refuse(failureCode);
  }
  return { signal, throwIfAborted, dispose };
}

function exactStringList(actual, expected) {
  return (
    actual !== undefined &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function hasDenyAllSourceNetwork(info) {
  if (info.allowInternetAccess !== false) return false;
  if (info.network === undefined) return true;
  const allowOut = info.network.allowOut;
  const denyOut = info.network.denyOut;
  return (
    (allowOut === undefined || allowOut.length === 0) &&
    (denyOut === undefined || exactStringList(denyOut, [e2bAllTraffic])) &&
    (info.network.rules === undefined || Object.keys(info.network.rules).length === 0) &&
    info.network.egressProxy === undefined
  );
}

function parseSourceSandboxInfo(input, authority) {
  let parsed;
  try {
    if (isProxy(input)) return { kind: "unproven" };
    parsed = sourceSandboxInfoSchema.safeParse(input);
  } catch {
    return { kind: "unproven" };
  }
  if (!parsed.success) return { kind: "unproven" };
  if (
    parsed.data.sandboxId !== authority.sandboxId ||
    !hasExactStationMetadata(parsed.data.metadata, authority.expectedMetadata)
  ) {
    return { kind: "conflict" };
  }
  if (
    parsed.data.state !== "running" ||
    parsed.data.lifecycle?.onTimeout !== "kill" ||
    parsed.data.lifecycle.autoResume !== false
  ) {
    return { kind: "unproven" };
  }
  return { kind: "exact", info: parsed.data };
}

function sourceSandboxConnectionPreservedAuthority(before, after) {
  let beforeStartedAtMs;
  let afterStartedAtMs;
  let beforeEndAtMs;
  let afterEndAtMs;
  try {
    beforeStartedAtMs = Reflect.apply(dateGetTime, before.startedAt, []);
    afterStartedAtMs = Reflect.apply(dateGetTime, after.startedAt, []);
    beforeEndAtMs = Reflect.apply(dateGetTime, before.endAt, []);
    afterEndAtMs = Reflect.apply(dateGetTime, after.endAt, []);
  } catch {
    return false;
  }
  return (
    after.sandboxId === before.sandboxId &&
    after.templateId === before.templateId &&
    afterStartedAtMs === beforeStartedAtMs &&
    afterEndAtMs <= beforeEndAtMs
  );
}

function captureE2bPtyApi(apiInput) {
  if (
    (typeof apiInput !== "object" && typeof apiInput !== "function") ||
    apiInput === null ||
    isProxy(apiInput)
  ) {
    refuse("PTY_ADAPTER_INCOMPATIBLE");
  }
  const methods = {};
  try {
    for (const name of ["connect", "getInfo"]) {
      const method = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [apiInput, name])?.value;
      if (typeof method !== "function" || isProxy(method)) {
        refuse("PTY_ADAPTER_INCOMPATIBLE");
      }
      methods[name] = method;
    }
  } catch (error) {
    if (error instanceof SpikeRefusal) throw error;
    refuse("PTY_ADAPTER_INCOMPATIBLE");
  }
  return { target: apiInput, ...methods };
}

function captureE2bPtyConnection(connectionInput, expectedSandboxId) {
  if (
    (typeof connectionInput !== "object" && typeof connectionInput !== "function") ||
    connectionInput === null ||
    isProxy(connectionInput)
  ) {
    refuse("PTY_ADAPTER_INCOMPATIBLE");
  }
  let sandboxId;
  const methods = {};
  try {
    sandboxId = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
      connectionInput,
      "sandboxId",
    ])?.value;
    for (const name of ["list", "create", "connectPty", "sendInput", "resize", "kill"]) {
      const method = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
        connectionInput,
        name,
      ])?.value;
      if (typeof method !== "function" || isProxy(method)) {
        refuse("PTY_ADAPTER_INCOMPATIBLE");
      }
      methods[name] = method;
    }
  } catch (error) {
    if (error instanceof SpikeRefusal) throw error;
    refuse("PTY_ADAPTER_INCOMPATIBLE");
  }
  if (sandboxId !== expectedSandboxId) refuse("PTY_ADAPTER_INCOMPATIBLE");
  return { target: connectionInput, sandboxId, ...methods };
}

function captureE2bPtyHandle(handleInput, expectedPid) {
  if (
    (typeof handleInput !== "object" && typeof handleInput !== "function") ||
    handleInput === null ||
    isProxy(handleInput)
  ) {
    refuse("PTY_ADAPTER_INCOMPATIBLE");
  }
  let pid;
  let observeExit;
  let disconnect;
  try {
    pid = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [handleInput, "pid"])?.value;
    observeExit = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
      handleInput,
      "observeExit",
    ])?.value;
    disconnect = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
      handleInput,
      "disconnect",
    ])?.value;
  } catch {
    refuse("PTY_ADAPTER_INCOMPATIBLE");
  }
  const parsedPid = ptyPidSchema.safeParse(pid);
  if (
    !parsedPid.success ||
    (expectedPid !== undefined && parsedPid.data !== expectedPid) ||
    typeof observeExit !== "function" ||
    typeof disconnect !== "function" ||
    isProxy(observeExit) ||
    isProxy(disconnect)
  ) {
    refuse("PTY_ADAPTER_INCOMPATIBLE");
  }
  return {
    target: handleInput,
    pid: parsedPid.data,
    observeExit,
    disconnect,
  };
}

function copyPtyBytes(input) {
  try {
    if (
      isProxy(input) ||
      Reflect.apply(objectGetPrototypeOf, Object, [input]) !== uint8ArrayPrototype ||
      typeof typedArrayByteLengthGetter !== "function"
    ) {
      return undefined;
    }
    const byteLength = Reflect.apply(typedArrayByteLengthGetter, input, []);
    if (!Number.isInteger(byteLength) || byteLength < 0 || byteLength > ptyMaximumChunkBytes) {
      return undefined;
    }
    return Reflect.apply(uint8ArraySlice, input, []);
  } catch {
    return undefined;
  }
}

function projectPtyStringArray(input) {
  try {
    if (
      isProxy(input) ||
      !Reflect.apply(arrayIsArray, Array, [input]) ||
      Reflect.apply(objectGetPrototypeOf, Object, [input]) !== Array.prototype
    ) {
      return undefined;
    }
    const lengthDescriptor = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
      input,
      "length",
    ]);
    const length = lengthDescriptor?.value;
    if (!Number.isInteger(length) || length < 0 || length > 128) return undefined;
    const keys = Reflect.apply(reflectOwnKeys, Reflect, [input]);
    if (keys.length !== length + 1 || !keys.includes("length")) return undefined;
    const projected = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
        input,
        String(index),
      ]);
      if (typeof descriptor?.value !== "string") return undefined;
      Reflect.apply(arrayPush, projected, [descriptor.value]);
    }
    return projected;
  } catch {
    return undefined;
  }
}

function projectPtyEnvironment(input) {
  try {
    if (
      (typeof input !== "object" && typeof input !== "function") ||
      input === null ||
      isProxy(input)
    ) {
      return undefined;
    }
    const prototype = Reflect.apply(objectGetPrototypeOf, Object, [input]);
    if (prototype !== objectPrototype && prototype !== null) return undefined;
    const keys = Reflect.apply(reflectOwnKeys, Reflect, [input]);
    if (keys.length > 256 || keys.some((key) => typeof key !== "string")) return undefined;
    const projected = Object.create(null);
    for (const key of keys) {
      const descriptor = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [input, key]);
      if (typeof descriptor?.value !== "string") return undefined;
      projected[key] = descriptor.value;
    }
    return projected;
  } catch {
    return undefined;
  }
}

function projectPtyProcessInfo(input) {
  try {
    if (
      (typeof input !== "object" && typeof input !== "function") ||
      input === null ||
      isProxy(input) ||
      Reflect.apply(objectGetPrototypeOf, Object, [input]) !== objectPrototype
    ) {
      return undefined;
    }
    const allowed = new Set(["pid", "tag", "cmd", "args", "envs", "cwd"]);
    const keys = Reflect.apply(reflectOwnKeys, Reflect, [input]);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
    const projected = {};
    for (const key of keys) {
      const descriptor = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [input, key]);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      projected[key] = descriptor.value;
    }
    projected.args = projectPtyStringArray(projected.args);
    projected.envs = projectPtyEnvironment(projected.envs);
    const parsed = ptySdkProcessInfoSchema.safeParse(projected);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function normalizePtyProcessList(input, authority) {
  try {
    if (
      isProxy(input) ||
      !Reflect.apply(arrayIsArray, Array, [input]) ||
      Reflect.apply(objectGetPrototypeOf, Object, [input]) !== Array.prototype
    ) {
      return { kind: "unproven" };
    }
    const lengthDescriptor = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
      input,
      "length",
    ]);
    const length = lengthDescriptor?.value;
    if (!Number.isInteger(length) || length < 0 || length > 10_000) {
      return { kind: "unproven" };
    }
    const candidates = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.apply(objectGetOwnPropertyDescriptor, Object, [
        input,
        String(index),
      ]);
      const process = projectPtyProcessInfo(descriptor?.value);
      if (process === undefined) return { kind: "unproven" };
      const stationMarkerNames = Object.keys(process.envs).filter((key) =>
        key.startsWith("STATION_E2B_"),
      );
      if (stationMarkerNames.some((key) => !ptyMarkerEnvironmentNames.includes(key))) {
        return { kind: "conflict" };
      }
      const markerValues = ptyMarkerEnvironmentNames.map((key) => process.envs[key]);
      const markerCount = markerValues.filter((value) => value !== undefined).length;
      if (markerCount === 0) continue;
      if (markerCount !== markerValues.length) return { kind: "conflict" };
      const executionId = z.string().uuid().safeParse(process.envs.STATION_E2B_EXECUTION_ID);
      const generation = ptyGenerationMarkerSchema.safeParse(process.envs.STATION_E2B_GENERATION);
      const launchNonce = z.string().uuid().safeParse(process.envs.STATION_E2B_LAUNCH_NONCE);
      if (
        !executionId.success ||
        !generation.success ||
        !launchNonce.success ||
        process.envs.STATION_E2B_GENERATION !== String(authority.generation) ||
        process.envs.STATION_E2B_SOURCE !== authority.sourceFingerprint ||
        process.tag !== undefined ||
        process.cmd !== e2bPtyShell ||
        !exactStringList(process.args, e2bPtyShellArgs) ||
        process.cwd !== authority.workspacePath
      ) {
        return { kind: "conflict" };
      }
      const candidate = PtyCandidateSchema.safeParse({
        sandboxId: authority.sandboxId,
        pid: process.pid,
        executionId: executionId.data,
        generation: generation.data,
        launchNonce: launchNonce.data,
      });
      if (!candidate.success || !ptyCandidateMatchesAuthority(candidate.data, authority)) {
        return { kind: "conflict" };
      }
      Reflect.apply(arrayPush, candidates, [candidate.data]);
    }
    return ptySdkScanResultSchema.parse({ kind: "observed", candidates });
  } catch {
    return { kind: "unproven" };
  }
}

function ptyCandidateMatchesAuthority(candidate, authority) {
  return (
    candidate.sandboxId === authority.sandboxId &&
    candidate.executionId === authority.executionId &&
    candidate.generation === authority.generation &&
    candidate.launchNonce === authority.launchNonce &&
    ((authority.mode !== "control" && authority.mode !== "cleanup") ||
      candidate.pid === authority.pid)
  );
}

export function createE2bPtyAdapter(ptyApiInput, providerConfigInput, dependencies = {}) {
  const parsedConfig = ptyAdapterConfigSchema.safeParse(providerConfigInput);
  if (!parsedConfig.success) refuse("PTY_ADAPTER_INCOMPATIBLE");
  const providerConfig = Object.freeze(parsedConfig.data);
  const providerConfigFingerprint = fingerprintPtyConfig(providerConfig);
  const ptyApi = captureE2bPtyApi(ptyApiInput);
  const nowEpochMs = dependencies.nowEpochMs ?? (() => Reflect.apply(dateNow, Date, []));
  if (typeof nowEpochMs !== "function" || isProxy(nowEpochMs)) {
    refuse("PTY_ADAPTER_INCOMPATIBLE");
  }

  const parseAuthority = (authorityInput, expectedMode) => {
    let parsed;
    try {
      parsed = ptyAuthoritySchema.safeParse(authorityInput);
    } catch {
      return undefined;
    }
    if (
      !parsed.success ||
      (expectedMode !== undefined && parsed.data.mode !== expectedMode) ||
      parsed.data.expectedMetadata.station_scope_id !== providerConfig.scopeId ||
      parsed.data.expectedMetadata.station_config_fingerprint !== providerConfigFingerprint
    ) {
      return undefined;
    }
    return parsed.data;
  };
  const readOperationSignal = (optionsInput) => {
    let parsed;
    try {
      parsed = adapterOperationOptionsSchema.safeParse(optionsInput);
    } catch {
      refuse("PTY_ADAPTER_INCOMPATIBLE");
    }
    if (!parsed.success) refuse("PTY_ADAPTER_INCOMPATIBLE");
    return assertCanonicalAbortSignal(parsed.data.signal, "PTY_ADAPTER_INCOMPATIBLE");
  };
  const readAttachmentOptions = (optionsInput, includeSize) => {
    let parsed;
    try {
      parsed = (includeSize ? ptyCreateOptionsSchema : ptyAttachmentOptionsSchema).safeParse(
        optionsInput,
      );
    } catch {
      refuse("PTY_ADAPTER_INCOMPATIBLE");
    }
    if (!parsed.success || isProxy(parsed.data.onData)) refuse("PTY_ADAPTER_INCOMPATIBLE");
    assertCanonicalAbortSignal(parsed.data.signal, "PTY_ADAPTER_INCOMPATIBLE");
    return parsed.data;
  };
  const readSandboxInfo = async (authority, signal) => {
    if (readAbortSignalState(signal, "PTY_ADAPTER_INCOMPATIBLE")) return { kind: "unproven" };
    let raw;
    try {
      raw = await Reflect.apply(ptyApi.getInfo, ptyApi.target, [
        authority.sandboxId,
        { requestTimeoutMs: providerConfig.requestTimeoutMs, signal },
      ]);
    } catch {
      return { kind: "unproven" };
    }
    if (readAbortSignalState(signal, "PTY_ADAPTER_INCOMPATIBLE")) return { kind: "unproven" };
    const parsed = parseSourceSandboxInfo(raw, authority);
    if (parsed.kind !== "exact" || !hasDenyAllSourceNetwork(parsed.info)) {
      return parsed.kind === "conflict" ? parsed : { kind: "unproven" };
    }
    return parsed;
  };

  let connectedSandboxId;
  let connectionPromise;
  const openConnection = async (authority, signal) => {
    const before = await readSandboxInfo(authority, signal);
    if (before.kind !== "exact") return before;
    if (connectedSandboxId !== undefined && connectedSandboxId !== authority.sandboxId) {
      return { kind: "conflict" };
    }
    if (connectionPromise === undefined) {
      let currentEpochMs;
      let endEpochMs;
      try {
        currentEpochMs = Reflect.apply(nowEpochMs, undefined, []);
        endEpochMs = Reflect.apply(dateGetTime, before.info.endAt, []);
      } catch {
        return { kind: "unproven" };
      }
      const remainingWholeSeconds = Math.floor((endEpochMs - currentEpochMs) / 1_000);
      if (remainingWholeSeconds < 1) return { kind: "unproven" };
      connectedSandboxId = authority.sandboxId;
      connectionPromise = Reflect.apply(ptyApi.connect, ptyApi.target, [
        authority.sandboxId,
        {
          timeoutMs: Math.min(remainingWholeSeconds * 1_000, providerConfig.sandboxTimeoutMs),
          requestTimeoutMs: providerConfig.requestTimeoutMs,
          signal,
        },
      ]).then((raw) => captureE2bPtyConnection(raw, authority.sandboxId));
    }
    let connection;
    try {
      connection = await connectionPromise;
    } catch {
      connectionPromise = undefined;
      connectedSandboxId = undefined;
      return { kind: "unproven" };
    }
    const after = await readSandboxInfo(authority, signal);
    if (
      after.kind !== "exact" ||
      !sourceSandboxConnectionPreservedAuthority(before.info, after.info)
    ) {
      return after.kind === "conflict" ? after : { kind: "unproven" };
    }
    return { kind: "exact", connection };
  };
  const scanConnection = async (connection, authority, signal) => {
    let raw;
    try {
      raw = await Reflect.apply(connection.list, connection.target, [
        { requestTimeoutMs: providerConfig.requestTimeoutMs, signal },
      ]);
    } catch {
      return { kind: "unproven" };
    }
    return normalizePtyProcessList(raw, authority);
  };
  const inspect = async (authority, signal) => {
    const opened = await openConnection(authority, signal);
    if (opened.kind !== "exact") return opened;
    const scan = await scanConnection(opened.connection, authority, signal);
    const after = await readSandboxInfo(authority, signal);
    return after.kind === "exact" ? scan : after;
  };
  const exactCandidate = (scan, authority) => {
    if (scan.kind !== "observed") return scan;
    if (scan.candidates.length === 0) return { kind: "absent" };
    if (
      scan.candidates.length !== 1 ||
      !ptyCandidateMatchesAuthority(scan.candidates[0], authority)
    ) {
      return { kind: "conflict" };
    }
    return { kind: "exact", candidate: scan.candidates[0] };
  };

  let nextControlEpoch = 0;
  let attachmentGeneration = 0;
  let stopRequested = false;
  let createAttempted = false;
  const attachments = new Set();
  let activeAttachment;
  let controlTail = Promise.resolve();
  let mutationTail = Promise.resolve();
  const serializeControl = (action) => {
    const result = controlTail.then(action, action);
    controlTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const serializeMutation = (action) => {
    const result = mutationTail.then(action, action);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const revokeRecord = (record) => {
    record.revoked = true;
    attachments.delete(record);
    if (activeAttachment === record) activeAttachment = undefined;
  };
  const revokeAttachments = async () => {
    // Revoke before awaiting detach, including handles that have not activated yet.
    attachmentGeneration += 1;
    const records = [...attachments];
    for (const record of records) revokeRecord(record);
    await Promise.allSettled(
      records.map((record) =>
        Promise.resolve().then(() =>
          Reflect.apply(record.handle.disconnect, record.handle.target, []),
        ),
      ),
    );
  };
  const validateAttachment = async (generation, action) => {
    try {
      const result = await action();
      if (
        result.kind !== "created" &&
        result.kind !== "connected" &&
        generation === attachmentGeneration
      )
        await revokeAttachments();
      return result;
    } catch (error) {
      if (generation === attachmentGeneration) await revokeAttachments();
      throw error;
    }
  };
  const supersede = async () => {
    const active = activeAttachment;
    if (active === undefined) return;
    revokeRecord(active);
    try {
      await Reflect.apply(active.handle.disconnect, active.handle.target, []);
    } catch {
      // Revocation is local authority; provider detach failure cannot restore it.
    }
  };
  const makeAttachment = (connection, handle, streamState, generation) => {
    const record = { pid: handle.pid, epoch: undefined, revoked: false, handle };
    attachments.add(record);
    streamState.record = record;
    const isRevoked = () => record.revoked || stopRequested || generation !== attachmentGeneration;
    const isActive = () =>
      !isRevoked() && record.epoch !== undefined && activeAttachment === record;
    const finiteOptions = (optionsInput) => ({
      requestTimeoutMs: providerConfig.requestTimeoutMs,
      signal: readOperationSignal(optionsInput),
    });
    return Object.freeze({
      activate() {
        return serializeControl(async () => {
          if (isRevoked()) return { kind: "control_revoked" };
          if (activeAttachment === record) return { kind: "active" };
          await supersede();
          if (isRevoked()) return { kind: "control_revoked" };
          while (streamState.pending.length > 0 && !streamState.outputGap && !isRevoked()) {
            const data = streamState.pending.shift();
            streamState.pendingBytes -= data.byteLength;
            try {
              await Reflect.apply(streamState.onData, undefined, [data]);
            } catch {
              streamState.outputGap = true;
            }
          }
          if (isRevoked()) return { kind: "control_revoked" };
          if (streamState.outputGap) {
            revokeRecord(record);
            try {
              await Reflect.apply(handle.disconnect, handle.target, []);
            } catch {
              // Output continuity remains unproven regardless of detach confirmation.
            }
            return { kind: "output_unproven" };
          }
          nextControlEpoch += 1;
          record.epoch = nextControlEpoch;
          activeAttachment = record;
          return { kind: "active" };
        });
      },
      async sendInput(input, optionsInput) {
        if (!isActive()) return { kind: "control_revoked" };
        const data = copyPtyBytes(input);
        if (data === undefined || data.byteLength === 0) {
          refuse("PTY_ADAPTER_INCOMPATIBLE");
        }
        if (!isActive()) return { kind: "control_revoked" };
        try {
          await Reflect.apply(connection.sendInput, connection.target, [
            record.pid,
            data,
            finiteOptions(optionsInput),
          ]);
          return { kind: "request_succeeded" };
        } catch {
          return { kind: "request_uncertain" };
        }
      },
      async resize(sizeInput, optionsInput) {
        if (!isActive()) return { kind: "control_revoked" };
        const size = ptyTerminalSizeSchema.safeParse(sizeInput);
        if (!size.success) refuse("PTY_ADAPTER_INCOMPATIBLE");
        if (!isActive()) return { kind: "control_revoked" };
        try {
          await Reflect.apply(connection.resize, connection.target, [
            record.pid,
            size.data,
            finiteOptions(optionsInput),
          ]);
          return { kind: "request_succeeded" };
        } catch {
          return { kind: "request_uncertain" };
        }
      },
      async observeExit() {
        let raw;
        try {
          raw = await Reflect.apply(handle.observeExit, handle.target, []);
        } catch {
          raw = { kind: "transport_unproven" };
        }
        await serializeControl(async () => revokeRecord(record));
        try {
          const parsed = ptyExitObservationSchema.safeParse(raw);
          return parsed.success ? parsed.data : { kind: "transport_unproven" };
        } catch {
          return { kind: "transport_unproven" };
        }
      },
      disconnect() {
        return serializeControl(async () => {
          revokeRecord(record);
          try {
            await Reflect.apply(handle.disconnect, handle.target, []);
            return { kind: "detached" };
          } catch {
            return { kind: "transport_unproven" };
          }
        });
      },
    });
  };
  const streamCallback = (streamState) => async (raw) => {
    const record = streamState.record;
    const data = copyPtyBytes(raw);
    if (data === undefined) {
      streamState.outputGap = true;
      streamState.pending.length = 0;
      streamState.pendingBytes = 0;
      if (record !== undefined) revokeRecord(record);
      refuse("PTY_ADAPTER_INCOMPATIBLE");
    }
    if (data.byteLength === 0) return;
    if (record === undefined || record.epoch === undefined || activeAttachment !== record) {
      if (record?.revoked || streamState.outputGap) return;
      if (streamState.pendingBytes + data.byteLength > ptyMaximumPendingOutputBytes) {
        streamState.outputGap = true;
        streamState.pending.length = 0;
        streamState.pendingBytes = 0;
        return;
      }
      Reflect.apply(arrayPush, streamState.pending, [data]);
      streamState.pendingBytes += data.byteLength;
      return;
    }
    try {
      await Reflect.apply(streamState.onData, undefined, [data]);
    } catch {
      revokeRecord(record);
      refuse("PTY_ADAPTER_INCOMPATIBLE");
    }
  };
  const newStreamState = (onData) => ({
    record: undefined,
    onData,
    pending: [],
    pendingBytes: 0,
    outputGap: false,
  });
  const runStreamHandshake = async (operationSignal, action) => {
    let guard;
    try {
      guard = combineAbortSignals([operationSignal], "PTY_ADAPTER_INCOMPATIBLE");
    } catch {
      return { kind: "request_uncertain" };
    }
    let raw;
    let succeeded = false;
    try {
      raw = await action(guard.signal);
      succeeded = true;
    } catch {
      // The remote stream may have started even when its response was lost.
    }
    let forwardingReleased = false;
    try {
      guard.dispose();
      forwardingReleased = true;
    } catch {
      // A retained caller-abort listener is not safe as a long-lived stream signal.
    }
    return succeeded
      ? { kind: "received", raw, forwardingReleased }
      : { kind: "request_uncertain" };
  };
  const ptyEnvironment = (authority) => ({
    [ptyMarkerEnvironmentKeys.executionId]: authority.executionId,
    [ptyMarkerEnvironmentKeys.generation]: String(authority.generation),
    [ptyMarkerEnvironmentKeys.launchNonce]: authority.launchNonce,
    [ptyMarkerEnvironmentKeys.source]: authority.sourceFingerprint,
  });

  return Object.freeze({
    async scan(authorityInput, optionsInput) {
      try {
        const authority = parseAuthority(authorityInput);
        const result =
          authority === undefined
            ? { kind: "unproven" }
            : await inspect(authority, readOperationSignal(optionsInput));
        if (result.kind !== "observed" || result.candidates.length !== 1) {
          await revokeAttachments();
        }
        return result;
      } catch (error) {
        await revokeAttachments();
        throw error;
      }
    },
    create(authorityInput, optionsInput) {
      const generation = attachmentGeneration;
      return serializeMutation(() =>
        validateAttachment(generation, async () => {
          if (stopRequested || generation !== attachmentGeneration)
            return { kind: "control_revoked" };
          if (createAttempted) return { kind: "request_uncertain" };
          const authority = parseAuthority(authorityInput, "launch");
          if (authority === undefined) return { kind: "conflict" };
          const options = readAttachmentOptions(optionsInput, true);
          if (readAbortSignalState(options.signal, "PTY_ADAPTER_INCOMPATIBLE"))
            return { kind: "request_uncertain" };
          const opened = await openConnection(authority, options.signal);
          if (opened.kind !== "exact") return opened;
          const before = exactCandidate(
            await scanConnection(opened.connection, authority, options.signal),
            authority,
          );
          if (before.kind !== "absent") {
            return before.kind === "unproven"
              ? { kind: "request_uncertain" }
              : { kind: "conflict" };
          }
          if ((await readSandboxInfo(authority, options.signal)).kind !== "exact") {
            return { kind: "request_uncertain" };
          }
          if (stopRequested || generation !== attachmentGeneration)
            return { kind: "control_revoked" };
          // A lost response can hide a remote PTY. An empty scan never rearms create.
          createAttempted = true;
          const streamState = newStreamState(options.onData);
          const handshake = await runStreamHandshake(options.signal, (streamSignal) =>
            Reflect.apply(opened.connection.create, opened.connection.target, [
              {
                cols: options.size.cols,
                rows: options.size.rows,
                cwd: authority.workspacePath,
                envs: ptyEnvironment(authority),
                onData: streamCallback(streamState),
                requestTimeoutMs: providerConfig.requestTimeoutMs,
                signal: streamSignal,
                timeoutMs: providerConfig.sandboxTimeoutMs,
              },
            ]),
          );
          if (handshake.kind !== "received") return handshake;
          let handle;
          try {
            handle = captureE2bPtyHandle(handshake.raw);
          } catch {
            return { kind: "request_uncertain" };
          }
          if (!handshake.forwardingReleased) {
            try {
              await Reflect.apply(handle.disconnect, handle.target, []);
            } catch {
              // The response remains uncertain, but caller cancellation is never retained as control.
            }
            return { kind: "request_uncertain" };
          }
          const after = exactCandidate(
            await scanConnection(opened.connection, authority, options.signal),
            authority,
          );
          const afterSandbox = await readSandboxInfo(authority, options.signal);
          if (
            afterSandbox.kind !== "exact" ||
            after.kind !== "exact" ||
            after.candidate.pid !== handle.pid
          ) {
            try {
              await Reflect.apply(handle.disconnect, handle.target, []);
            } catch {
              // The remote identity remains uncertain; never convert this into exit or retry authority.
            }
            return afterSandbox.kind === "conflict" || after.kind === "conflict"
              ? { kind: "conflict" }
              : { kind: "request_uncertain" };
          }
          if (stopRequested || generation !== attachmentGeneration) {
            try {
              await Reflect.apply(handle.disconnect, handle.target, []);
            } catch {
              // A late detach failure cannot restore an invalidated attachment attempt.
            }
            return { kind: "control_revoked" };
          }
          return {
            kind: "created",
            pid: handle.pid,
            attachment: makeAttachment(opened.connection, handle, streamState, generation),
          };
        }),
      );
    },
    connectExact(authorityInput, optionsInput) {
      const generation = attachmentGeneration;
      return serializeMutation(() =>
        validateAttachment(generation, async () => {
          if (stopRequested || generation !== attachmentGeneration)
            return { kind: "control_revoked" };
          const authority = parseAuthority(authorityInput, "control");
          if (authority === undefined) return { kind: "conflict" };
          const options = readAttachmentOptions(optionsInput, false);
          if (readAbortSignalState(options.signal, "PTY_ADAPTER_INCOMPATIBLE"))
            return { kind: "request_uncertain" };
          const opened = await openConnection(authority, options.signal);
          if (opened.kind !== "exact") return opened;
          const before = exactCandidate(
            await scanConnection(opened.connection, authority, options.signal),
            authority,
          );
          if (before.kind !== "exact") return before;
          if ((await readSandboxInfo(authority, options.signal)).kind !== "exact") {
            return { kind: "request_uncertain" };
          }
          if (stopRequested || generation !== attachmentGeneration)
            return { kind: "control_revoked" };
          const streamState = newStreamState(options.onData);
          let handle;
          try {
            const handshake = await runStreamHandshake(options.signal, (streamSignal) =>
              Reflect.apply(opened.connection.connectPty, opened.connection.target, [
                authority.pid,
                {
                  onData: streamCallback(streamState),
                  requestTimeoutMs: providerConfig.requestTimeoutMs,
                  signal: streamSignal,
                  timeoutMs: providerConfig.sandboxTimeoutMs,
                },
              ]),
            );
            if (handshake.kind !== "received") return handshake;
            handle = captureE2bPtyHandle(handshake.raw);
            if (handle.pid !== authority.pid) {
              try {
                await Reflect.apply(handle.disconnect, handle.target, []);
              } catch {
                // A mismatched handle is detached but never returned as control authority.
              }
              return { kind: "request_uncertain" };
            }
            if (!handshake.forwardingReleased) {
              try {
                await Reflect.apply(handle.disconnect, handle.target, []);
              } catch {
                // Caller cancellation is not retained as a stream-lifetime control.
              }
              return { kind: "request_uncertain" };
            }
          } catch {
            return { kind: "request_uncertain" };
          }
          const after = exactCandidate(
            await scanConnection(opened.connection, authority, options.signal),
            authority,
          );
          const afterSandbox = await readSandboxInfo(authority, options.signal);
          if (afterSandbox.kind !== "exact" || after.kind !== "exact") {
            try {
              await Reflect.apply(handle.disconnect, handle.target, []);
            } catch {
              // Local control remains revoked even when provider detach cannot be confirmed.
            }
            return afterSandbox.kind === "conflict" || after.kind === "conflict"
              ? { kind: "conflict" }
              : { kind: "request_uncertain" };
          }
          if (stopRequested || generation !== attachmentGeneration) {
            try {
              await Reflect.apply(handle.disconnect, handle.target, []);
            } catch {
              // A late detach failure cannot restore an invalidated attachment attempt.
            }
            return { kind: "control_revoked" };
          }
          return {
            kind: "connected",
            pid: handle.pid,
            attachment: makeAttachment(opened.connection, handle, streamState, generation),
          };
        }),
      );
    },
    stopExact(authorityInput, optionsInput) {
      stopRequested = true;
      const revocation = revokeAttachments();
      return serializeMutation(async () => {
        await revocation;
        const authority = parseAuthority(authorityInput, "cleanup");
        if (authority === undefined) return { kind: "request_uncertain" };
        const signal = readOperationSignal(optionsInput);
        const opened = await openConnection(authority, signal);
        if (opened.kind !== "exact") return { kind: "request_uncertain" };
        const before = exactCandidate(
          await scanConnection(opened.connection, authority, signal),
          authority,
        );
        if (before.kind !== "exact") return { kind: "request_uncertain" };
        if ((await readSandboxInfo(authority, signal)).kind !== "exact") {
          return { kind: "request_uncertain" };
        }
        let raw;
        try {
          raw = await Reflect.apply(opened.connection.kill, opened.connection.target, [
            authority.pid,
            { requestTimeoutMs: providerConfig.requestTimeoutMs, signal },
          ]);
        } catch {
          return { kind: "request_uncertain" };
        }
        return ptyProviderMutationResultSchema.parse({
          kind: raw === true ? "request_succeeded" : "request_uncertain",
        });
      });
    },
  });
}

function hasExactStationMetadata(metadata, expected) {
  const markedKeys = Object.keys(metadata).filter((key) => key.startsWith("station_"));
  return (
    markedKeys.length === stationMetadataKeys.length &&
    stationMetadataKeys.every((key) => metadata[key] === expected[key])
  );
}
