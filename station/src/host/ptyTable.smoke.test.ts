import { describe, expect, it } from "bun:test";
import { createPtyTable } from "./ptyTable.js";

// Real node-pty spawn. Gated like the other PTY smokes so a plain `bun test`
// stays hermetic; run with STATION_PTY_SMOKE=1.
const SMOKE = process.env.STATION_PTY_SMOKE === "1";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
}

if (SMOKE) {
  describe("ptyTable real PTY smoke", () => {
    it("keeps a spawned PTY alive with no client attached and captures output", async () => {
      const table = createPtyTable();
      try {
        const { ptyId } = table.spawn({
          kind: "agent",
          terminalTargetId: "native:smoke",
          worktreeId: "smoke",
          projectId: "smoke",
          sessionId: "smoke",
          worktreePath: process.cwd(),
          harnessProvider: "scripted",
          command: "/bin/sh",
          args: ["-c", "printf READY; sleep 2"],
          cwd: process.cwd(),
          cols: 80,
          rows: 24,
        });

        await waitUntil(() => table.snapshot(ptyId).scrollback.join("").includes("READY"), 2000);
        expect(table.snapshot(ptyId).scrollback.join("")).toContain("READY");

        // The PTY is parented to the host, not a client: it survives with none attached.
        await delay(1100);
        expect(table.list()[0]).toMatchObject({ ptyId, alive: true });
      } finally {
        table.disposeAll();
      }
    });
  });
}
