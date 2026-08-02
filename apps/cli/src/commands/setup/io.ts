import { promisify } from "node:util";
import { createTextSetupPresenter, type TextSetupPresenter } from "./presenters/text.js";
import type { SetupRenderOptions } from "./theme.js";
import type { SetupCommandDeps } from "./types.js";

export async function write(deps: SetupCommandDeps, content: string): Promise<void> {
  const writer = deps.writeStdout ?? defaultWriteStdout;
  await writer(content);
}

const defaultWriteStdout = promisify(process.stdout.write.bind(process.stdout)) as (
  output: string,
) => Promise<void>;

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
