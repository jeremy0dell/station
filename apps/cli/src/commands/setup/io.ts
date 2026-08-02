import { promisify } from "node:util";
import { createTextSetupPresenter, type TextSetupPresenter } from "./presenters/text.js";
import type { SetupRenderOptions } from "./presenters/theme.js";
import type { SetupCommandDeps } from "./types.js";

export async function write(deps: SetupCommandDeps, content: string): Promise<void> {
  const writer = deps.writeStdout ?? defaultWriteStdout;
  await writer(content);
}

const defaultWriteStdout = promisify(process.stdout.write.bind(process.stdout)) as (
  output: string,
) => Promise<void>;

export function renderOptions(deps: SetupCommandDeps): SetupRenderOptions {
  if (deps.writeStdout !== undefined) return { color: false, hyperlinks: false };
  const env = deps.env ?? process.env;
  const interactive = process.stdout.isTTY === true && env.TERM !== "dumb";
  return {
    color: interactive && env.NO_COLOR === undefined,
    hyperlinks: interactive,
  };
}

export function setupPresenter(deps: SetupCommandDeps): TextSetupPresenter {
  return createTextSetupPresenter({
    ...renderOptions(deps),
    write: deps.writeStdout ?? defaultWriteStdout,
  });
}
