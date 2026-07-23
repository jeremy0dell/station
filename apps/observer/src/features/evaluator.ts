import { createHash } from "node:crypto";
import {
  type ClientFeatureFlagsForDefinitions,
  clientFeatureFlagKeys,
  createClientFeatureFlagsSchema,
  createEvaluatedFeatureFlagsSchema,
  type EvaluatedFeatureFlagsForDefinitions,
  type FeatureFlagConfig,
  type FeatureFlagConfigForDefinitions,
  FeatureFlagDefinitions,
  type FeatureFlagDefinitionsMap,
  type FeatureFlagKeyForDefinitions,
  featureFlagKeys,
} from "@station/contracts";

export type FeatureFlagEvaluator = FeatureFlagEvaluatorForDefinitions<
  typeof FeatureFlagDefinitions
>;

export type FeatureFlagEvaluatorForDefinitions<Definitions extends FeatureFlagDefinitionsMap> = {
  enabled(key: FeatureFlagKeyForDefinitions<Definitions>): boolean;
  clientSnapshot(): ClientFeatureFlagsForDefinitions<Definitions>;
  all(): EvaluatedFeatureFlagsForDefinitions<Definitions>;
};

export function createFeatureFlagEvaluator(
  input: { overrides?: FeatureFlagConfig; revisionSeed?: string } = {},
): FeatureFlagEvaluator {
  return createFeatureFlagEvaluatorForDefinitions({
    definitions: FeatureFlagDefinitions,
    ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
    ...(input.revisionSeed === undefined ? {} : { revisionSeed: input.revisionSeed }),
  });
}

export function createFeatureFlagEvaluatorForDefinitions<
  Definitions extends FeatureFlagDefinitionsMap,
>(input: {
  definitions: Definitions;
  overrides?: FeatureFlagConfigForDefinitions<Definitions>;
  revisionSeed?: string;
}): FeatureFlagEvaluatorForDefinitions<Definitions> {
  const evaluated = evaluateFeatureFlagsForDefinitions(input);
  const clientFlags = clientFeatureFlagsForDefinitions(input.definitions, evaluated);

  return {
    enabled: (key) => evaluated.flags[key],
    clientSnapshot: () => clientFlags,
    all: () => evaluated,
  };
}

export function evaluateFeatureFlagsForDefinitions<
  Definitions extends FeatureFlagDefinitionsMap,
>(input: {
  definitions: Definitions;
  overrides?: FeatureFlagConfigForDefinitions<Definitions>;
  revisionSeed?: string;
}): EvaluatedFeatureFlagsForDefinitions<Definitions> {
  const flags: Record<string, boolean> = {};
  for (const key of featureFlagKeys(input.definitions)) {
    const definition = input.definitions[key];
    if (definition === undefined) {
      continue;
    }
    flags[key] = input.overrides?.[key] ?? definition.defaultValue;
  }

  const evaluated = {
    revision: featureFlagRevision({
      seed: input.revisionSeed ?? "",
      flags,
    }),
    flags,
  };
  return createEvaluatedFeatureFlagsSchema(input.definitions).parse(
    evaluated,
  ) as EvaluatedFeatureFlagsForDefinitions<Definitions>;
}

export function clientFeatureFlagsForDefinitions<Definitions extends FeatureFlagDefinitionsMap>(
  definitions: Definitions,
  evaluated: EvaluatedFeatureFlagsForDefinitions<Definitions>,
): ClientFeatureFlagsForDefinitions<Definitions> {
  const flags: Record<string, boolean> = {};
  for (const key of clientFeatureFlagKeys(definitions)) {
    flags[key] = evaluated.flags[key];
  }

  return createClientFeatureFlagsSchema(definitions).parse({
    revision: evaluated.revision,
    flags,
  }) as ClientFeatureFlagsForDefinitions<Definitions>;
}

function featureFlagRevision(input: { seed: string; flags: Record<string, boolean> }): string {
  const pairs = Object.entries(input.flags).sort(([left], [right]) => left.localeCompare(right));
  const encoded = JSON.stringify({
    seed: input.seed,
    flags: pairs,
  });
  return `config:${createHash("sha256").update(encoded).digest("hex").slice(0, 12)}`;
}
