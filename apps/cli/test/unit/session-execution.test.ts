import { expect, it } from "vitest";
import { parseSessionArgs } from "../../src/commands/session/args.js";

it("parses cloud execution only for new sessions and requires explicit result abandonment", () => {
  expect(
    parseSessionArgs([
      "create",
      "project",
      "--branch",
      "cloud-task",
      "--terminal",
      "tmux",
      "--execution",
      "e2b",
    ]),
  ).toMatchObject({ action: "create", execution: "e2b" });
  expect(() =>
    parseSessionArgs([
      "fork",
      "ses_test",
      "--branch",
      "task",
      "--terminal",
      "tmux",
      "--execution",
      "e2b",
    ]),
  ).toThrow();
  expect(parseSessionArgs(["close", "ses_test", "--mode", "all", "--force"])).not.toHaveProperty(
    "command.payload.discardResults",
  );
  expect(
    parseSessionArgs(["close", "ses_test", "--mode", "all", "--force", "--discard-results"]),
  ).toHaveProperty("command.payload.discardResults", true);
  expect(() =>
    parseSessionArgs(["close", "ses_test", "--mode", "terminal", "--discard-results"]),
  ).toThrow();
});
