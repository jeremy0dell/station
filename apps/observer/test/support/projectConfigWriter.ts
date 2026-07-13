import type { ProjectConfigWriter } from "../../src/commands/projectConfigWriter.js";

export function createUnexpectedProjectConfigWriter(): ProjectConfigWriter {
  const unexpected = (): never => {
    throw new Error("Unexpected project configuration mutation in test.");
  };
  return {
    addProject: async () => unexpected(),
    removeProject: async () => unexpected(),
    setDefaultHarness: async () => unexpected(),
  };
}
