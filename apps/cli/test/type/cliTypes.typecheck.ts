import type { CliRunResult } from "../../src/cliTypes.js";

const correlatedResult: CliRunResult = {
  code: 0,
  output: { status: "succeeded" },
  correlation: {
    status: "succeeded",
    commandId: "cmd_type",
    traceId: "trc_type",
  },
};

const absentCorrelation: CliRunResult = { code: 0 };

// @ts-expect-error exactOptionalPropertyTypes keeps absent correlation distinct from undefined.
const explicitUndefinedCorrelation: CliRunResult = {
  code: 0,
  correlation: undefined,
};

const explicitUndefinedTrace: CliRunResult = {
  code: 0,
  // @ts-expect-error exactOptionalPropertyTypes omits absent trace correlation instead of widening it.
  correlation: { status: "accepted", commandId: "cmd_type", traceId: undefined },
};

void correlatedResult;
void absentCorrelation;
void explicitUndefinedCorrelation;
void explicitUndefinedTrace;
