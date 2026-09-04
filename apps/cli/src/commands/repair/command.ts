import type { RepairInventoryReport, RepairPreview } from "@station/contracts";
import type { CliRunResult } from "../../cliTypes.js";
import type { RepairExecutionDeps } from "../../repair/execution.js";
import { executeRepair } from "../../repair/execution.js";
import { parseRepairRequest } from "./args.js";
import { repairApplyResult, repairInventoryResult, repairPreviewResult } from "./report.js";

export async function runRepairCommand(
  args: readonly string[],
  deps: RepairExecutionDeps,
): Promise<CliRunResult> {
  const request = parseRepairRequest(args);
  if (request.kind === "inventory") {
    const report: RepairInventoryReport = {
      schemaVersion: 1,
      kind: "inventory",
      inventory: await deps.inspectInventory(),
    };
    return repairInventoryResult(report, request.output);
  }
  if (request.mode === "preview") {
    const inventory = await deps.inspectInventory();
    const report: RepairPreview = {
      schemaVersion: 1,
      kind: "preview",
      inventory,
      plan: deps.derivePlan(inventory, request.selector),
    };
    return repairPreviewResult(report, request.output);
  }
  if (request.expectedPlanDigest === undefined) throw new Error("Expected repair plan is missing.");
  return repairApplyResult(
    await executeRepair(request.selector, request.expectedPlanDigest, deps),
    request.output,
  );
}
