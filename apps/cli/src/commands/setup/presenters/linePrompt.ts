import { createInterface } from "node:readline/promises";
import { resolveSetupMessage, setupMessageRef } from "@station/setup-messages";
import type { SetupPromptAdapter, SetupPromptChoice } from "../types.js";

export type SetupLineReadline = {
  readonly question: (message: string) => Promise<string>;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly close: () => void;
};

export type CreateLinePromptSetupPresenterOptions = {
  readonly readline?: SetupLineReadline;
};

/**
 * ADAPTER
 *
 * Translates Enter-submitted line input into setup confirmations and validated multiple selections while coordinating terminal ownership.
 */
export function createLinePromptSetupPresenter(
  options: CreateLinePromptSetupPresenterOptions = {},
): SetupPromptAdapter {
  const readline =
    options.readline ?? createInterface({ input: process.stdin, output: process.stdout });
  return {
    async confirm(message) {
      const answer = await readline.question(`${message} [y/N] `);
      const normalized = answer.trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    },
    async selectMany(message, choices) {
      let prompt = message;
      while (true) {
        const labels = choices.map((choice, index) => `${index + 1}. ${choice.label}`).join("\n");
        const answer = await readline.question(`${prompt}\n${labels}\n> `);
        const selected = parseMultiSelectAnswer(answer, choices);
        if (selected.length > 0) return selected;
        prompt = `${resolveSetupMessage(setupMessageRef("guided.harness-select-required"))}\n${message}`;
      }
    },
    pause() {
      readline.pause();
    },
    resume() {
      readline.resume();
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
  return selected;
}
