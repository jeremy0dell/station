import { readFile } from "node:fs/promises";
import {
  ProtocolEventEnvelopeSchema,
  ProtocolParamSchemas,
  ProtocolRequestSchema,
  ProtocolResponseSchema,
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
    expect(ProtocolRequestSchema.safeParse(messages.readinessRequest).success).toBe(true);
  });

  it("strictly validates harness readiness query params", () => {
    expect(
      ProtocolParamSchemas["harness.readiness.get"].safeParse({
        provider: "codex",
        refresh: true,
      }).success,
    ).toBe(true);
    expect(
      ProtocolParamSchemas["harness.readiness.get"].safeParse({
        provider: "codex",
        providerData: { raw: true },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown protocol methods", () => {
    expect(
      ProtocolRequestSchema.safeParse({
        schemaVersion: "0.8.0",
        jsonrpc: "2.0",
        id: "req_bad",
        method: "provider.rawCall",
      }).success,
    ).toBe(false);
  });
});
