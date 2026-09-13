import { runExecutionBridge } from "@station/e2b";
import { z } from "zod";
import type { CliCommandNode } from "../cliCommand/types.js";

export const executionCliCommand: CliCommandNode = {
  name: "execution",
  description: "Connect a Station-managed cloud terminal.",
  requiresConfig: false,
  usage: ["stn execution attach <socket> <sessionId>"],
  notes: [
    "Station invokes this command for the primary cloud agent pane. Use session create, collect, and close to manage cloud work.",
  ],
  async run(context) {
    const [action, path, sessionId] = z
      .tuple([z.literal("attach"), z.string().min(1), z.string().regex(/^ses_[a-zA-Z0-9_-]+$/)])
      .parse(context.args);
    void action;
    await runExecutionBridge(path, sessionId);
    return { code: 0 };
  },
};
