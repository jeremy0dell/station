import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { executionError } from "./state.js";

const execute = promisify(execFile);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execute(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args],
    {
      cwd,
      timeout: 30_000,
      maxBuffer: MAX_TRANSFER_BYTES,
      env: {
        PATH: process.env.PATH,
        HOME: tmpdir(),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
    },
  );
  return result.stdout.trim();
}

/** Exports exactly the committed tree without history, local configuration, or working files. */
export async function sourceArchive(
  path: string,
): Promise<{ baseCommit: string; baseTree: string; archive: Uint8Array }> {
  const baseCommit = sha.parse(await git(path, ["rev-parse", "HEAD"]));
  const baseTree = sha.parse(await git(path, ["rev-parse", `${baseCommit}^{tree}`]));
  const entries = await git(path, ["ls-tree", "-r", baseCommit]);
  if (entries.split("\n").some((entry) => entry.startsWith("160000 "))) {
    throw executionError(
      "EXECUTION_SUBMODULE_UNSUPPORTED",
      "Cloud source cannot contain Git submodules; materialize them in the selected repository first.",
    );
  }
  const temporary = await mkdtemp(join(tmpdir(), "station-cloud-source-"));
  try {
    await git(temporary, ["init", "--bare", "."]);
    const objects = await git(path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]);
    z.string()
      .regex(/^[^\r\n]+$/)
      .parse(objects);
    await writeFile(join(temporary, "objects/info/alternates"), `${objects}\n`);
    // Repository export attributes must not omit files or substitute committed bytes.
    await writeFile(join(temporary, "info/attributes"), "** -export-ignore -export-subst\n");
    const output = join(temporary, "source.tar");
    await git(temporary, ["archive", "--format=tar", `--output=${output}`, baseCommit]);
    if ((await stat(output)).size > MAX_TRANSFER_BYTES)
      throw executionError("EXECUTION_SOURCE_TOO_LARGE", "Committed cloud source exceeds 64 MiB.");
    return { baseCommit, baseTree, archive: await readFile(output) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
