import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTerminalBroker, requestTerminalGrant } from "../../src/terminalBroker.js";

it("keeps live broker ownership exclusive and supports disposal/restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "e2b-broker-"));
  const broker = await createTerminalBroker(directory, async () => undefined);
  try {
    await expect(createTerminalBroker(directory, async () => undefined)).rejects.toThrow(/live/);
    const connection = await requestTerminalGrant(broker.path, "ses_test", () => {});
    expect(connection.response.type).toBe("legacy");
    connection.close();
    await broker.dispose();
    const replacement = await createTerminalBroker(directory, async () => undefined);
    await broker.dispose();
    const next = await requestTerminalGrant(replacement.path, "ses_test", () => {});
    next.close();
    await replacement.dispose();
  } finally {
    await broker.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
