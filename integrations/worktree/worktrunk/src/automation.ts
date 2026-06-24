import { type ExternalCommandRunner, runExternalCommand } from "@station/runtime";

export type WorktrunkAutomationFlag = "--no-hooks" | "--yes";
export type WorktrunkAutomationModeName = "skip-hooks" | "preapprove-hooks" | "worktrunk-default";

export type WorktrunkAutomationMode = {
  automationMode: WorktrunkAutomationModeName;
  message: string;
  flag?: WorktrunkAutomationFlag;
};

export function worktrunkAutomationMode(
  useLifecycleHooks: boolean | undefined,
): WorktrunkAutomationMode {
  if (useLifecycleHooks === false) {
    return {
      automationMode: "skip-hooks",
      flag: "--no-hooks",
      message: "Worktrunk automation skips lifecycle hooks for STATION mutations.",
    };
  }
  if (useLifecycleHooks === true) {
    return {
      automationMode: "preapprove-hooks",
      flag: "--yes",
      message: "Worktrunk automation pre-approves lifecycle hook prompts for STATION mutations.",
    };
  }
  return {
    automationMode: "worktrunk-default",
    message: "Worktrunk automation uses default hook prompt behavior for STATION mutations.",
  };
}

export async function missingWorktrunkAutomationFlagSupport(input: {
  command: string;
  flag: WorktrunkAutomationFlag;
  timeoutMs: number;
  runner?: ExternalCommandRunner | undefined;
}): Promise<string[]> {
  const subcommands = ["switch", "remove"] as const;
  const missing: string[] = [];
  for (const subcommand of subcommands) {
    const output = await runExternalCommand(
      {
        command: input.command,
        args: [subcommand, "--help"],
        timeoutMs: input.timeoutMs,
        maxOutputChars: 64 * 1024,
      },
      input.runner,
    );
    const help = `${output.stdout}\n${output.stderr}`;
    if (!help.includes(input.flag)) {
      missing.push(subcommand);
    }
  }
  return missing;
}
