import { spawn } from "node:child_process";
import type { HarnessLaunchPlan } from "@station/contracts";

export async function runScriptedAgentLaunchPlan(plan: HarnessLaunchPlan): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      stdio: "ignore",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`Scripted agent exited with code ${code ?? "null"} signal ${signal ?? "null"}.`),
      );
    });
  });
}
