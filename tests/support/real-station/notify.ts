import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type RealNotifyHookCapture = {
  command: string;
  args: string[];
  logPath: string;
};

export async function createRealNotifyHookCapture(root: string): Promise<RealNotifyHookCapture> {
  const scriptPath = join(root, "capture-event-hook.mjs");
  const logPath = join(root, "notify-events.jsonl");
  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(
    scriptPath,
    [
      "#!/usr/bin/env node",
      'import { appendFile } from "node:fs/promises";',
      "const logPath = process.argv[2];",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "for await (const chunk of process.stdin) input += chunk;",
      "await appendFile(logPath, input.trimEnd() + '\\n', 'utf8');",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(scriptPath, 0o700);
  return { command: process.execPath, args: [scriptPath, logPath], logPath };
}

export async function waitForNotifyEvent(
  logPath: string,
  predicate: (event: unknown) => boolean,
  timeoutMs = 60_000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const source = await readFile(logPath, "utf8").catch(() => "");
    for (const line of source.split("\n")) {
      if (line.trim().length === 0) continue;
      const event = JSON.parse(line) as unknown;
      if (predicate(event)) {
        return event;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for notify event in ${logPath}.`);
}
