import {
  TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
  TuiRendererControlRequestSchema,
  TuiRendererControlResponseSchema,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const frame = {
  protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
  requestId: "request-1",
};

describe("TUI renderer control schemas", () => {
  it("parses the supported requests", () => {
    expect(
      TuiRendererControlRequestSchema.parse({
        ...frame,
        type: "dismiss",
      }),
    ).toEqual({ ...frame, type: "dismiss" });
    expect(
      TuiRendererControlRequestSchema.parse({
        ...frame,
        type: "resolve-focus-target",
      }),
    ).toEqual({ ...frame, type: "resolve-focus-target" });
    expect(
      TuiRendererControlRequestSchema.parse({
        ...frame,
        type: "dismiss-focus-target",
        focusRequestId: "focus-request-1",
      }),
    ).toEqual({ ...frame, type: "dismiss-focus-target", focusRequestId: "focus-request-1" });
  });

  it("parses dismissed, focus-target, and error responses", () => {
    expect(
      TuiRendererControlResponseSchema.parse({
        ...frame,
        type: "dismissed",
      }),
    ).toEqual({ ...frame, type: "dismissed" });
    expect(
      TuiRendererControlResponseSchema.parse({
        ...frame,
        type: "focus-target",
        origin: { provider: "tmux", clientId: "client-2" },
      }),
    ).toEqual({
      ...frame,
      type: "focus-target",
      origin: { provider: "tmux", clientId: "client-2" },
    });
    expect(
      TuiRendererControlResponseSchema.parse({
        ...frame,
        type: "error",
        error: {
          tag: "TuiRendererControlError",
          code: "TUI_RENDERER_CONTROL_FAILED",
          message: "The popup control request failed.",
        },
      }),
    ).toMatchObject({ ...frame, type: "error" });
  });

  it.each([
    { ...frame, type: "dismiss", command: "tmux kill-pane" },
    { ...frame, type: "dismiss", clientId: "client-2" },
    { ...frame, type: "resolve-focus-target", argv: ["-t", "client-2"] },
    { ...frame, type: "resolve-focus-target", payload: { clientId: "client-2" } },
    {
      ...frame,
      type: "dismiss-focus-target",
      focusRequestId: "focus-request-1",
      claim: "v1.open.secret",
    },
    { ...frame, type: "run-command" },
  ])("rejects unsupported or authority-bearing request %#", (request) => {
    expect(TuiRendererControlRequestSchema.safeParse(request).success).toBe(false);
  });

  it.each([
    { type: "dismiss", requestId: "request-1" },
    { ...frame, protocolVersion: 2, type: "dismiss" },
    { ...frame, requestId: "", type: "dismiss" },
    { ...frame, requestId: "x".repeat(129), type: "dismiss" },
  ])("rejects malformed request framing %#", (request) => {
    expect(TuiRendererControlRequestSchema.safeParse(request).success).toBe(false);
  });

  it.each([
    { ...frame, type: "dismissed", clientId: "client-2" },
    { ...frame, type: "focus-target" },
    {
      ...frame,
      type: "focus-target",
      origin: { provider: "tmux", clientId: "client-2", command: "display-message" },
    },
    {
      ...frame,
      type: "focus-target",
      origin: { provider: "tmux", clientId: "client-2" },
      claim: "provider-private-claim",
    },
    { ...frame, type: "ok" },
    {
      ...frame,
      type: "error",
      error: {
        tag: "TuiRendererControlError",
        code: "TUI_RENDERER_CONTROL_FAILED",
        message: "Failure.\n    at secret (/tmp/control.ts:1:1)",
      },
    },
  ])("rejects malformed or unsupported response %#", (response) => {
    expect(TuiRendererControlResponseSchema.safeParse(response).success).toBe(false);
  });
});
