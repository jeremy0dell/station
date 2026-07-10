import { describe, expect, it } from "vitest";
import { checkSetupToolchain } from "../../src/commands/setup/checks/toolchain.js";

describe("setup toolchain", () => {
  it.each([
    "24.2.0",
    "v24.2.0",
    "24.2.1",
    "24.18.0",
  ])("accepts supported Node.js version %s", async (nodeVersion) => {
    const { node } = await checkSetupToolchain({ nodeVersion, runner: pnpm11Runner });

    expect(node).toMatchObject({
      status: "ok",
      actual: nodeVersion.startsWith("v") ? nodeVersion.slice(1) : nodeVersion,
      expected: ">=24.2 <25",
    });
  });

  it.each([
    "24.0.99",
    "24.1.99",
    "24.2",
    "24.2.x",
    "24.2.0.1",
    "25.0.0",
  ])("rejects unsupported or malformed Node.js version %s", async (nodeVersion) => {
    const { node } = await checkSetupToolchain({ nodeVersion, runner: pnpm11Runner });

    expect(node).toMatchObject({
      status: "incompatible",
      actual: nodeVersion,
      expected: ">=24.2 <25",
    });
  });
});

const pnpm11Runner = async () => ({
  command: "pnpm",
  args: ["--version"],
  stdout: "11.0.0\n",
  stderr: "",
  exitCode: 0,
});
