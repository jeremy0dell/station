import { type ExternalCommandRunner, runExternalCommand } from "@station/runtime";

type MacNotificationInput = {
  title: string;
  message: string;
  group: string;
  clickAction: string;
};

type MacNotificationSoundInput = {
  kind: "finished";
  commandRunner?: ExternalCommandRunner;
};

const finishedSoundPath = "/System/Library/Sounds/Glass.aiff";
const soundTimeoutMs = 5000;

export async function showMacNotification(
  input: MacNotificationInput,
  commandRunner?: ExternalCommandRunner,
): Promise<"terminal-notifier" | "osascript"> {
  try {
    await runExternalCommand(
      {
        command: "terminal-notifier",
        args: [
          "-title",
          input.title,
          "-message",
          input.message,
          "-group",
          input.group,
          "-execute",
          input.clickAction,
          "-ignoreDnD",
        ],
        timeoutMs: 3000,
      },
      commandRunner,
    );
    return "terminal-notifier";
  } catch {
    await showAppleScriptNotification(input, commandRunner);
    return "osascript";
  }
}

export async function playMacNotificationSound(
  input: MacNotificationSoundInput,
): Promise<"played" | "failed"> {
  try {
    await runExternalCommand(
      {
        command: "/usr/bin/afplay",
        args: [finishedSoundPath],
        timeoutMs: soundTimeoutMs,
      },
      input.commandRunner,
    );
    return "played";
  } catch {
    return "failed";
  }
}

async function showAppleScriptNotification(
  input: Pick<MacNotificationInput, "title" | "message">,
  commandRunner?: ExternalCommandRunner,
): Promise<void> {
  await runExternalCommand(
    {
      command: "/usr/bin/osascript",
      args: [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        input.title,
        input.message,
      ],
      timeoutMs: 3000,
    },
    commandRunner,
  );
}
