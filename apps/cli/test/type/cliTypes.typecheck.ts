import type { CliRunResult } from "../../src/cliTypes.js";

const correlatedResult: CliRunResult = {
  code: 0,
  output: { status: "succeeded" },
  audit: {
    commandStatus: "succeeded",
    command: { commandId: "cmd_type", traceId: "trc_type" },
    resources: { projectId: "web" },
  },
};

const absentAudit: CliRunResult = { code: 0 };

// @ts-expect-error exactOptionalPropertyTypes keeps absent audit metadata distinct from undefined.
const explicitUndefinedAudit: CliRunResult = {
  code: 0,
  audit: undefined,
};

void correlatedResult;
void absentAudit;
void explicitUndefinedAudit;
