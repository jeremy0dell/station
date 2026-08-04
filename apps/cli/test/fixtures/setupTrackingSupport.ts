import type {
  SetupCommandDeps,
  SetupPromptAdapter,
  SetupPromptAnswer,
  SetupPromptChoice,
} from "../../src/commands/setup/types.js";

type SetupReadFile = (path: string) => Promise<string>;

export type GuidedPromptFixture = {
  readonly confirm: (message: string) => Promise<boolean>;
  readonly selectMany: (request: {
    readonly message: string;
    readonly choices: readonly SetupPromptChoice[];
  }) => Promise<readonly string[]>;
  readonly selectOne?: (request: {
    readonly message: string;
    readonly choices: readonly SetupPromptChoice[];
  }) => Promise<string>;
};

export function configBackedHarnessHooksProbe(
  readFile: SetupReadFile,
): NonNullable<SetupCommandDeps["probeHarnessHooksStatus"]> {
  return async (...probeArguments) => {
    const [harnessId, configPath] = probeArguments;
    if (harnessId === "pi") return undefined;
    let source = "";
    try {
      source = await readFile(configPath);
    } catch {
      source = "";
    }
    const block = setupHarnessBlock({ source, harnessId });
    const requested = /(?:^|\n)install_hooks\s*=\s*true(?:\n|$)/.test(block);
    return {
      provider: harnessId,
      requested,
      installed: requested,
      missing: requested ? [] : ["tracking artifact"],
      message: requested ? "Tracking artifacts are installed." : "Tracking is disabled.",
    };
  };
}

export const successfulProviderTrackingPort: NonNullable<
  SetupCommandDeps["providerTrackingPort"]
> = async (operation) => ({
  status: "completed",
  operationId: operation.id,
  commit: {
    kind: "provider-tracking",
    provider: operation.kind === "prepare-worktrunk-tracking" ? "worktrunk" : operation.harnessId,
    changed: true,
  },
});

type GuidedPromptAdapterFixture = {
  readonly prompt: GuidedPromptFixture;
  readonly report?: (message: string) => void;
};

export function toSetupPromptAdapter(input: GuidedPromptAdapterFixture): SetupPromptAdapter {
  return createSetupPromptAdapter({ ...input, acceptRequiredTracking: false });
}

export function withRequiredTrackingConsent(input: GuidedPromptAdapterFixture): SetupPromptAdapter {
  return createSetupPromptAdapter({ ...input, acceptRequiredTracking: true });
}

function createSetupPromptAdapter(
  input: GuidedPromptAdapterFixture & {
    readonly acceptRequiredTracking: boolean;
  },
): SetupPromptAdapter {
  const answered = <T>(value: T): SetupPromptAnswer<T> => ({ kind: "answered", value });
  const report = input.report ?? (() => undefined);
  return {
    isInteractiveTerminal: () => true,
    intro: report,
    outro: report,
    cancel: report,
    async confirm(request) {
      const value =
        input.acceptRequiredTracking && request.message.includes("Station requires tracking")
          ? true
          : await input.prompt.confirm(request.message);
      return answered(value);
    },
    async selectOne(request) {
      const selected =
        input.prompt.selectOne === undefined
          ? (request.initialValue ?? request.choices[0]?.value ?? "")
          : await input.prompt.selectOne({
              message: request.message,
              choices: request.choices,
            });
      return answered(selected);
    },
    async selectMany(request) {
      return answered(
        await input.prompt.selectMany({
          message: request.message,
          choices: request.choices,
        }),
      );
    },
    note: (...noteArguments) => {
      if (noteArguments[1] !== undefined) report(noteArguments[1]);
      report(noteArguments[0]);
    },
    logStep: report,
    logSuccess: report,
    logWarn: report,
    logError: report,
    logInfo: report,
  };
}

function setupHarnessBlock(input: { readonly source: string; readonly harnessId: string }): string {
  const marker = `[harness.${input.harnessId}]`;
  const start = input.source.indexOf(marker);
  if (start < 0) return "";
  const contentStart = start + marker.length;
  const end = input.source.indexOf("\n[", contentStart);
  return input.source.slice(contentStart, end < 0 ? input.source.length : end);
}
