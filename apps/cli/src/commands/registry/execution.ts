import { readFile, writeFile } from "node:fs/promises";
import {
  createTerminalGateway,
  GatewayStartConfigSchema,
  readGatewayConfig,
  requestGateway,
  runExecutionBridge,
  runTerminalRelay,
  TerminalIdentitySchema,
} from "@station/e2b";
import { createStationHostClient } from "@station/host";
import { stationBuildInfo } from "@station/runtime";
import { z } from "zod";
import type { CliCommandNode } from "../cliCommand/types.js";

export const executionCliCommand: CliCommandNode = {
  name: "execution",
  description: "Connect a Station-managed cloud terminal.",
  requiresConfig: false,
  usage: ["stn execution attach <socket> <sessionId>"],
  notes: [
    "Station invokes the private attachment and gateway commands. Use session create, collect, and close to manage cloud work.",
  ],
  async run(context) {
    const [action, path, sessionId] = z
      .union([
        z.tuple([z.literal("attach"), z.string().min(1), z.string().regex(/^ses_[a-zA-Z0-9_-]+$/)]),
        z.tuple([z.enum(["serve", "grant", "revoke"]), z.string().min(1)]),
      ])
      .parse(context.args);
    if (action === "attach") {
      if (sessionId === undefined) throw new Error("Session identity required.");
      await (path.endsWith("terminal.sock")
        ? runTerminalRelay(path, sessionId)
        : runExecutionBridge(path, sessionId));
    } else if (action === "serve") {
      const start = GatewayStartConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
      const host = createStationHostClient({ socketPath: start.hostSocket });
      try {
        const matches = (await host.list()).filter(
          (entry) => entry.kind === "agent" && entry.sessionId === start.remoteSessionId,
        );
        if (matches.length !== 1) throw new Error("The original remote terminal is unavailable.");
        const identity = TerminalIdentitySchema.strip().parse(matches[0]);
        const { remoteSessionId: _, ...fields } = start;
        const config = { ...fields, identity };
        const gateway = await createTerminalGateway(config);
        const runtime = stationBuildInfo();
        try {
          await writeFile(
            `${path}.ready`,
            JSON.stringify({
              config,
              runtime: { version: runtime.version, buildIdentity: runtime.buildIdentity },
            }),
            { mode: 0o600 },
          );
          await new Promise<void>((resolve) => {
            const stop = () => {
              process.off("SIGTERM", stop);
              process.off("SIGINT", stop);
              resolve();
            };
            process.on("SIGTERM", stop);
            process.on("SIGINT", stop);
          });
        } finally {
          await gateway.dispose();
        }
      } finally {
        host.dispose();
      }
    } else {
      const ready = await readGatewayConfig(path);
      const response = await requestGateway(ready.controlSocket, {
        type: action,
        execution: ready.execution,
        identity: ready.identity,
      });
      return {
        code: response.type === "error" ? 1 : 0,
        output: `${JSON.stringify(response)}\n`,
        outputFormat: "text" as const,
      };
    }
    return { code: 0 };
  },
};
