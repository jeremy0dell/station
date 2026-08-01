import { createLinePromptSetupPresenter } from "./presenters/linePrompt.js";
import { createTextSetupPresenter, type TextSetupPresenter } from "./presenters/text.js";
import type { SetupRenderOptions } from "./theme.js";
import type { SetupCommandDeps, SetupPromptAdapter } from "./types.js";

export { parseMultiSelectAnswer } from "./presenters/linePrompt.js";

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

export function setupPresenter(deps: SetupCommandDeps): TextSetupPresenter {
  return createTextSetupPresenter({
    ...renderOptions(deps),
    write: deps.writeStdout ?? defaultWriteStdout,
  });
}

export function defaultPrompt(): SetupPromptAdapter {
  return createLinePromptSetupPresenter();
}
