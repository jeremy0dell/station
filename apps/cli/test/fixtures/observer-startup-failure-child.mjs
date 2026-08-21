import { runCliObserverProcess } from "../../dist/observerMain.js";

const failure = (() => {
  switch (process.argv[2]) {
    case "error":
      return new Error(
        "ordinary failure with API_TOKEN=super-secret-value\n    at /private/ordinary-frame.ts",
      );
    case "typed":
      return Object.assign(new Error("typed failure"), {
        tag: "ObserverProcessEvidenceError",
        code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
        message: "Typed failure with API_TOKEN=super-secret-value",
        hint: "Inspect the exact process evidence.",
      });
    case "plain-object":
      return {
        message: "plain-object failure with API_TOKEN=super-secret-value",
        stack: "plain-object failure\n    at /private/plain-object-frame.ts",
      };
    case "unknown":
      return "unknown failure with API_TOKEN=super-secret-value\n    at /private/unknown-frame.ts";
    default:
      throw new Error(`Unknown startup failure fixture: ${String(process.argv[2])}`);
  }
})();

process.exitCode = await runCliObserverProcess(async () => {
  throw failure;
});
