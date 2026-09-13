import { GatewayStartConfigSchema } from "@station/e2b";
import { expect, it } from "vitest";

it("rejects gateway configuration that adds remote command authority", () => {
  const config = {
    version: 1,
    execution: "ses_local",
    remoteSessionId: "ses_remote",
    hostSocket: "/private/host.sock",
    controlSocket: "/private/control.sock",
    port: 8080,
  };
  expect(GatewayStartConfigSchema.safeParse(config).success).toBe(true);
  expect(GatewayStartConfigSchema.safeParse({ ...config, command: "sh" }).success).toBe(false);
});
