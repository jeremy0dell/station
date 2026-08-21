import { readFile } from "node:fs/promises";
import {
  ProtocolEventEnvelopeSchema,
  ProtocolRequestSchema,
  ProtocolResponseSchema,
  ProtocolResultSchemas,
  protocolSuccessResponse,
} from "@station/protocol";
import { describe, expect, it } from "vitest";

const fixtureUrl = new URL("../fixtures/protocol-messages.json", import.meta.url);

async function fixtures(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

describe("protocol message envelopes", () => {
  it("parses request, response, error, and event envelopes", async () => {
    const messages = await fixtures();

    expect(ProtocolRequestSchema.safeParse(messages.request).success).toBe(true);
    expect(ProtocolResponseSchema.safeParse(messages.successResponse).success).toBe(true);
    expect(ProtocolResponseSchema.safeParse(messages.errorResponse).success).toBe(true);
    expect(ProtocolEventEnvelopeSchema.safeParse(messages.eventEnvelope).success).toBe(true);
    expect(ProtocolRequestSchema.safeParse(messages.doctorRequest).success).toBe(true);
    expect(ProtocolRequestSchema.safeParse(messages.diagnosticsRequest).success).toBe(true);
    expect(ProtocolRequestSchema.safeParse(messages.recoveryInventoryRequest).success).toBe(true);
    const recoveryInventoryResponse = ProtocolResponseSchema.parse(
      messages.recoveryInventoryResponse,
    );
    expect("result" in recoveryInventoryResponse).toBe(true);
    if (!("result" in recoveryInventoryResponse)) {
      throw new Error("Expected recovery inventory success fixture.");
    }
    expect(
      ProtocolResultSchemas["session.recoveryInventory"].safeParse(recoveryInventoryResponse.result)
        .success,
    ).toBe(true);
  });

  it("rejects unknown protocol methods", () => {
    expect(
      ProtocolRequestSchema.safeParse({
        schemaVersion: "0.12.0",
        jsonrpc: "2.0",
        id: "req_bad",
        method: "provider.rawCall",
      }).success,
    ).toBe(false);
  });

  it("refuses provider-native recovery data before protocol serialization", () => {
    expect(() =>
      protocolSuccessResponse("req_leaked_recovery", "session.recoveryInventory", {
        schemaVersion: 1,
        sessions: [],
        recoveryHandles: [
          {
            id: "handle-leaked",
            provider: "codex",
            projectId: "web",
            worktreeId: "worktree-leaked",
            targetKind: "native-session",
            target: { kind: "native-session", id: "native-secret" },
            observedAt: "2026-05-20T12:00:00.000Z",
            lastSeenAt: "2026-05-20T12:00:00.000Z",
          },
        ],
      }),
    ).toThrow();
  });
});
