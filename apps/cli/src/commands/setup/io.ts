import { createInterface } from "node:readline/promises";
import type { SetupRenderOptions } from "./theme.js";
import type { SetupCommandDeps, SetupPromptAdapter } from "./types.js";

export async function write(deps: SetupCommandDeps, chunk: string): Promise<void> {
  const writer = deps.writeStdout ?? defaultWriteStdout;
  await writer(chunk);
}

export function defaultWriteStdout(chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(chunk, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function renderOptions(deps: SetupCommandDeps): SetupRenderOptions {
  if (deps.writeStdout !== undefined) return { color: false };
  const env = deps.env ?? process.env;
  if (env.NO_COLOR !== undefined || env.TERM === "dumb") return { color: false };
  return { color: process.stdout.isTTY === true };
}

export function defaultPrompt(): SetupPromptAdapter {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return {
    async confirm(message) {
      const answer = await readline.question(`${message} [y/N] `);
      return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
    },
    async select(message, choices) {
      const labels = choices.map((choice, index) => `${index + 1}. ${choice.label}`).join("\n");
      const answer = await readline.question(`${message}\n${labels}\n> `);
      const index = Number(answer.trim()) - 1;
      return choices[index]?.value ?? choices[0]?.value ?? "";
    },
    close() {
      readline.close();
    },
  };
}
