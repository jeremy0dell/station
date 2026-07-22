import { createInterface } from "node:readline/promises";
import type { SetupRenderOptions } from "./theme.js";
import type { SetupCommandDeps, SetupPromptAdapter, SetupPromptChoice } from "./types.js";

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
    async selectMany(message, choices) {
      const labels = choices.map((choice, index) => `${index + 1}. ${choice.label}`).join("\n");
      const answer = await readline.question(`${message}\n${labels}\n> `);
      return parseMultiSelectAnswer(answer, choices);
    },
    close() {
      readline.close();
    },
  };
}

export function parseMultiSelectAnswer(
  answer: string,
  choices: readonly SetupPromptChoice[],
): string[] {
  const selected: string[] = [];
  for (const token of answer.split(",")) {
    const trimmed = token.trim();
    const index = /^\d+$/.test(trimmed) ? Number(trimmed) - 1 : -1;
    const value = Number.isInteger(index) ? choices[index]?.value : undefined;
    if (value !== undefined && !selected.includes(value)) selected.push(value);
  }
  if (selected.length > 0) return selected;
  const fallback = choices[0]?.value;
  return fallback === undefined ? [] : [fallback];
}
