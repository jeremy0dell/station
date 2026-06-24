import { z } from "zod";
import { nonEmptyStringSchema } from "./shared.js";

export const FeatureFlagOwnerSchema = z.enum(["observer", "cli", "tui", "provider"]);
export const FeatureFlagExposureSchema = z.enum(["client", "server"]);
export const FeatureFlagLifecycleSchema = z.enum(["temporary", "permanent", "deprecated"]);
export const FeatureFlagSurfaceSchema = z.enum([
  "config",
  "observer",
  "protocol",
  "tui",
  "cli",
  "provider",
  "diagnostics",
]);

export type FeatureFlagOwner = z.infer<typeof FeatureFlagOwnerSchema>;
export type FeatureFlagExposure = z.infer<typeof FeatureFlagExposureSchema>;
export type FeatureFlagLifecycle = z.infer<typeof FeatureFlagLifecycleSchema>;
export type FeatureFlagSurface = z.infer<typeof FeatureFlagSurfaceSchema>;

export const FeatureFlagDefinitionSchema = z
  .object({
    defaultValue: z.boolean(),
    exposure: FeatureFlagExposureSchema,
    owner: FeatureFlagOwnerSchema,
    surfaces: z.array(FeatureFlagSurfaceSchema).nonempty(),
    lifecycle: FeatureFlagLifecycleSchema,
    summary: nonEmptyStringSchema,
  })
  .strict();

export type FeatureFlagDefinition = z.infer<typeof FeatureFlagDefinitionSchema>;
export type FeatureFlagDefinitionInput = {
  defaultValue: boolean;
  exposure: FeatureFlagExposure;
  owner: FeatureFlagOwner;
  surfaces: ReadonlyArray<FeatureFlagSurface>;
  lifecycle: FeatureFlagLifecycle;
  summary: string;
};
export type FeatureFlagDefinitionsMap = Readonly<Record<string, FeatureFlagDefinitionInput>>;

export const FeatureFlagDefinitions = {
  sessionResumeAgent: {
    defaultValue: false,
    exposure: "client",
    owner: "observer",
    surfaces: ["config", "observer", "protocol", "tui", "provider"],
    lifecycle: "temporary",
    summary: "Enable resuming lost provider-native agent sessions.",
  },
  stationPersistentAgents: {
    defaultValue: false,
    // Server-exposed: the observer/provider gate spawning in the host and
    // populating the launch result's reattachHandle. The Station UI keys off
    // that handle's presence, so it needs no client-side flag value.
    exposure: "server",
    owner: "observer",
    surfaces: ["config", "observer", "protocol", "provider"],
    lifecycle: "temporary",
    summary: "Host Station agents in a standalone daemon so they survive UI close and reattach.",
  },
} as const satisfies FeatureFlagDefinitionsMap;

export type FeatureFlagKey = keyof typeof FeatureFlagDefinitions & string;
export type ClientFeatureFlagKey = ClientFeatureFlagKeyForDefinitions<
  typeof FeatureFlagDefinitions
>;
export type ServerFeatureFlagKey = ServerFeatureFlagKeyForDefinitions<
  typeof FeatureFlagDefinitions
>;

export type FeatureFlagKeyForDefinitions<Definitions extends FeatureFlagDefinitionsMap> =
  keyof Definitions & string;

export type ClientFeatureFlagKeyForDefinitions<Definitions extends FeatureFlagDefinitionsMap> = {
  [Key in FeatureFlagKeyForDefinitions<Definitions>]: Definitions[Key]["exposure"] extends "client"
    ? Key
    : never;
}[FeatureFlagKeyForDefinitions<Definitions>];

export type ServerFeatureFlagKeyForDefinitions<Definitions extends FeatureFlagDefinitionsMap> = {
  [Key in FeatureFlagKeyForDefinitions<Definitions>]: Definitions[Key]["exposure"] extends "server"
    ? Key
    : never;
}[FeatureFlagKeyForDefinitions<Definitions>];

export type FeatureFlagConfigForDefinitions<Definitions extends FeatureFlagDefinitionsMap> =
  Partial<Record<FeatureFlagKeyForDefinitions<Definitions>, boolean>>;

export type FeatureFlagValuesForDefinitions<Definitions extends FeatureFlagDefinitionsMap> = Record<
  FeatureFlagKeyForDefinitions<Definitions>,
  boolean
>;

export type ClientFeatureFlagValuesForDefinitions<Definitions extends FeatureFlagDefinitionsMap> =
  Record<ClientFeatureFlagKeyForDefinitions<Definitions>, boolean>;

export type FeatureFlagConfig = FeatureFlagConfigForDefinitions<typeof FeatureFlagDefinitions>;

export type EvaluatedFeatureFlagsForDefinitions<Definitions extends FeatureFlagDefinitionsMap> = {
  revision: string;
  flags: FeatureFlagValuesForDefinitions<Definitions>;
};

export type ClientFeatureFlagsForDefinitions<Definitions extends FeatureFlagDefinitionsMap> = {
  revision: string;
  flags: ClientFeatureFlagValuesForDefinitions<Definitions>;
};

export type EvaluatedFeatureFlags = EvaluatedFeatureFlagsForDefinitions<
  typeof FeatureFlagDefinitions
>;
export type ClientFeatureFlags = ClientFeatureFlagsForDefinitions<typeof FeatureFlagDefinitions>;

export const FEATURE_FLAG_KEYS = featureFlagKeys(FeatureFlagDefinitions) as FeatureFlagKey[];
export const CLIENT_FEATURE_FLAG_KEYS = clientFeatureFlagKeys(
  FeatureFlagDefinitions,
) as ClientFeatureFlagKey[];
export const SERVER_FEATURE_FLAG_KEYS = serverFeatureFlagKeys(
  FeatureFlagDefinitions,
) as ServerFeatureFlagKey[];

export const FeatureFlagConfigSchema = createFeatureFlagConfigSchema(
  FeatureFlagDefinitions,
) as z.ZodType<FeatureFlagConfig>;

export const EvaluatedFeatureFlagsSchema = createEvaluatedFeatureFlagsSchema(
  FeatureFlagDefinitions,
) as z.ZodType<EvaluatedFeatureFlags>;

export const ClientFeatureFlagsSchema = createClientFeatureFlagsSchema(
  FeatureFlagDefinitions,
) as z.ZodType<ClientFeatureFlags>;

export function createFeatureFlagConfigSchema(
  definitions: FeatureFlagDefinitionsMap,
): z.ZodType<Record<string, boolean>> {
  return flagRecordSchema(definitions, "feature flag");
}

export function createEvaluatedFeatureFlagsSchema(
  definitions: FeatureFlagDefinitionsMap,
): z.ZodType<{ revision: string; flags: Record<string, boolean> }> {
  return z
    .object({
      revision: nonEmptyStringSchema,
      flags: flagRecordSchema(definitions, "evaluated feature flag", { requireAll: true }),
    })
    .strict();
}

export function createClientFeatureFlagsSchema(
  definitions: FeatureFlagDefinitionsMap,
): z.ZodType<{ revision: string; flags: Record<string, boolean> }> {
  const clientDefinitions = clientFeatureFlagDefinitions(definitions);
  return z
    .object({
      revision: nonEmptyStringSchema,
      flags: flagRecordSchema(clientDefinitions, "client feature flag", { requireAll: true }),
    })
    .strict();
}

export function featureFlagKeys<Definitions extends FeatureFlagDefinitionsMap>(
  definitions: Definitions,
): Array<FeatureFlagKeyForDefinitions<Definitions>> {
  return Object.keys(definitions).sort() as Array<FeatureFlagKeyForDefinitions<Definitions>>;
}

export function clientFeatureFlagKeys<Definitions extends FeatureFlagDefinitionsMap>(
  definitions: Definitions,
): Array<ClientFeatureFlagKeyForDefinitions<Definitions>> {
  return featureFlagKeys(definitions).filter(
    (key): key is ClientFeatureFlagKeyForDefinitions<Definitions> =>
      definitions[key]?.exposure === "client",
  );
}

export function serverFeatureFlagKeys<Definitions extends FeatureFlagDefinitionsMap>(
  definitions: Definitions,
): Array<ServerFeatureFlagKeyForDefinitions<Definitions>> {
  return featureFlagKeys(definitions).filter(
    (key): key is ServerFeatureFlagKeyForDefinitions<Definitions> =>
      definitions[key]?.exposure === "server",
  );
}

export function isClientFeatureFlagKey(key: FeatureFlagKey): key is ClientFeatureFlagKey {
  return (FeatureFlagDefinitions as FeatureFlagDefinitionsMap)[key]?.exposure === "client";
}

export function defaultFeatureFlagValue(key: FeatureFlagKey): boolean {
  return (FeatureFlagDefinitions as FeatureFlagDefinitionsMap)[key]?.defaultValue ?? false;
}

export function defaultClientFeatureFlagValue(key: ClientFeatureFlagKey): boolean {
  return defaultFeatureFlagValue(key);
}

function clientFeatureFlagDefinitions(
  definitions: FeatureFlagDefinitionsMap,
): FeatureFlagDefinitionsMap {
  return Object.fromEntries(
    Object.entries(definitions).filter(([, definition]) => definition.exposure === "client"),
  );
}

function flagRecordSchema(
  definitions: FeatureFlagDefinitionsMap,
  label: string,
  options: { requireAll?: boolean } = {},
): z.ZodType<Record<string, boolean>> {
  const allowedKeys = new Set(Object.keys(definitions));
  return z.record(nonEmptyStringSchema, z.boolean()).superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `Unknown ${label} "${key}".`,
        });
      }
    }
    if (options.requireAll === true) {
      for (const key of allowedKeys) {
        if (!(key in value)) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: `Missing ${label} "${key}".`,
          });
        }
      }
    }
  });
}
