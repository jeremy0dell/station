import { parseArgs } from "node:util";
import { CollectSessionCommandSchema } from "@station/contracts";
import { z } from "zod";
import { escapeTerminalBytes } from "../../terminalOutput.js";
import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode } from "../cliCommand/types.js";
import { executeTypedObserverCommand } from "../command.js";
import { findSessionSummary } from "../session/summary.js";
import { loadObserverSnapshot } from "../snapshot.js";

export const collectSessionCliCommand: CliCommandNode = {
  name: "collect",
  description: "Download cloud changes into a separate local result directory.",
  usage: ["stn session collect <sessionId> [--json] [--timeout-ms <ms>]"],
  options: [
    { name: "--json", description: "Print the command outcome and refreshed session." },
    {
      name: "--timeout-ms <ms>",
      description: "Bound the wait for collection; defaults to 120000.",
    },
  ],
  async run(context) {
    const parsed = parseArgs({
      args: context.args,
      allowPositionals: true,
      strict: true,
      options: { json: { type: "boolean" }, "timeout-ms": { type: "string" } },
    });
    const [sessionId] = z.tuple([z.string().min(1)]).parse(parsed.positionals);
    const timeoutMs = z.coerce
      .number()
      .int()
      .min(1)
      .max(600_000)
      .parse(parsed.values["timeout-ms"] ?? 120_000);
    const command = CollectSessionCommandSchema.parse({
      type: "session.collect",
      payload: { sessionId },
    });
    const options = { ...loadedCommandOptions(context), timeoutMs, waitForCompletion: true };
    const outcome = await executeTypedObserverCommand(
      command,
      options,
      context.options.observerDeps,
    );
    if (outcome.status !== "succeeded") return { code: 1, output: outcome, outputFormat: "json" };
    const snapshot = await loadObserverSnapshot(options, context.options.observerDeps);
    const session = findSessionSummary(snapshot, sessionId);
    return parsed.values.json === true
      ? { code: 0, output: { outcome, session }, outputFormat: "json" }
      : {
          code: 0,
          output: `Cloud changes: ${escapeTerminalBytes(session.execution?.resultDirectory ?? "Refresh the session to see the result directory.")}`,
          outputFormat: "text",
        };
  },
};
