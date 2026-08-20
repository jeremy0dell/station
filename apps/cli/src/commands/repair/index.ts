import type { StationConfig } from "@station/config";
import type { CliRunResult } from "../../cliTypes.js";
import { parseRepairArgs } from "./args.js";
import {
  captureRepairInventory,
  type RepairCommandDeps,
  type RepairInventoryOptions,
} from "./inventory.js";
import { repairInventoryText, repairPreviewText } from "./presentation.js";
import { planRecoveryRepair } from "./recoveryPlan.js";
import { planRuntimeRepair } from "./runtimePlan.js";

export type RepairCommandOptions = {
  config: StationConfig;
  configPath?: string;
  timeoutMs?: number;
};

export type { RepairCommandDeps } from "./inventory.js";

export async function runRepairCommand(
  args: readonly string[],
  options: RepairCommandOptions,
  deps: RepairCommandDeps = {},
): Promise<CliRunResult> {
  const parsed = parseRepairArgs(args);
  const inventoryOptions: RepairInventoryOptions = {
    config: options.config,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
  const inventory = await captureRepairInventory(inventoryOptions, deps);
  if (parsed.action === "inventory") {
    return {
      code: inventory.completeness === "complete" ? 0 : 1,
      output: parsed.json ? inventory : repairInventoryText(inventory),
      outputFormat: parsed.json ? "json" : "text",
    };
  }
  const report =
    parsed.action === "runtime"
      ? planRuntimeRepair(inventory, parsed.request)
      : planRecoveryRepair(inventory, parsed.request);
  return {
    code: report.status === "planned" ? 0 : 1,
    output: parsed.json ? report : repairPreviewText(report),
    outputFormat: parsed.json ? "json" : "text",
  };
}
