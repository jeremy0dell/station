import type { CliRunResult } from "../../src/cliTypes.js";
import type { CommandDispatchReceiptResult } from "../../src/commands/command.js";

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

const acceptedReceiptResult: CommandDispatchReceiptResult = {
  status: "accepted",
  receipt: {
    commandId: "cmd_type",
    accepted: true,
    status: "accepted",
  },
};

// @ts-expect-error dispatch status and receipt acceptance are one discriminated fact.
const mismatchedReceiptResult: CommandDispatchReceiptResult = {
  status: "rejected",
  receipt: acceptedReceiptResult.receipt,
};

void correlatedResult;
void absentCorrelation;
void explicitUndefinedCorrelation;
void explicitUndefinedTrace;
void acceptedReceiptResult;
void mismatchedReceiptResult;
