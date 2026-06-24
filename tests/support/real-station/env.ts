import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RealE2eRequirements = {
  worktrunk?: boolean;
  tmux?: boolean;
  claude?: boolean;
  codex?: boolean;
  pi?: boolean;
  opencode?: boolean;
};

export type RealE2eEnvironment = {
  repoRoot: string;
  stationBin: string;
  stationIngressBin: string;
  worktrunkBin?: string;
  tmuxBin?: string;
  claudeBin?: string;
  codexBin?: string;
  piBin?: string;
  opencodeBin?: string;
};

export function realE2eEnabled(): boolean {
  return process.env.STATION_REAL_E2E === "1";
}

export async function requireRealE2eEnvironment(
  requirements: RealE2eRequirements = {},
): Promise<RealE2eEnvironment> {
  if (!realE2eEnabled()) {
    throw new Error("Set STATION_REAL_E2E=1 to run real E2E tests.");
  }

  const repoRoot = process.cwd();
  const stationBin = join(repoRoot, "bin", "stn");
  const stationIngressBin = join(repoRoot, "bin", "stn-ingress");
  await access(stationBin);
  await access(stationIngressBin);

  const env: RealE2eEnvironment = {
    repoRoot,
    stationBin,
    stationIngressBin,
  };

  if (requirements.worktrunk === true) {
    if (process.env.STATION_REAL_WORKTRUNK !== "1") {
      throw new Error("Set STATION_REAL_WORKTRUNK=1 to run real Worktrunk E2E tests.");
    }
    const worktrunkBin = process.env.STATION_WORKTRUNK_BIN ?? "wt";
    await execFileAsync(worktrunkBin, ["--version"], { timeout: 15_000 });
    env.worktrunkBin = worktrunkBin;
  }

  if (requirements.tmux === true) {
    const tmuxBin = process.env.STATION_TMUX_BIN ?? "tmux";
    await execFileAsync(tmuxBin, ["-V"], { timeout: 10_000 });
    env.tmuxBin = tmuxBin;
  }

  if (requirements.claude === true) {
    if (process.env.STATION_REAL_CLAUDE !== "1") {
      throw new Error("Set STATION_REAL_CLAUDE=1 to run real Claude E2E tests.");
    }
    const claudeBin = process.env.STATION_CLAUDE_BIN ?? "claude";
    await execFileAsync(claudeBin, ["--version"], { timeout: 20_000 });
    env.claudeBin = claudeBin;
  }

  if (requirements.codex === true) {
    if (process.env.STATION_REAL_CODEX !== "1") {
      throw new Error("Set STATION_REAL_CODEX=1 to run real Codex E2E tests.");
    }
    const codexBin = process.env.STATION_CODEX_BIN ?? "codex";
    await execFileAsync(codexBin, ["login", "status"], { timeout: 20_000 });
    env.codexBin = codexBin;
  }

  if (requirements.pi === true) {
    if (process.env.STATION_REAL_PI !== "1") {
      throw new Error("Set STATION_REAL_PI=1 to run real Pi E2E tests.");
    }
    const piBin = process.env.STATION_PI_BIN ?? "pi";
    await execFileAsync(piBin, ["--version"], { timeout: 20_000 });
    env.piBin = piBin;
  }

  if (requirements.opencode === true) {
    if (process.env.STATION_REAL_OPENCODE !== "1") {
      throw new Error("Set STATION_REAL_OPENCODE=1 to run real OpenCode E2E tests.");
    }
    const opencodeBin = process.env.STATION_OPENCODE_BIN ?? "opencode";
    await execFileAsync(opencodeBin, ["--version"], { timeout: 20_000 });
    env.opencodeBin = opencodeBin;
  }

  return env;
}

export function requireToolPath(
  env: RealE2eEnvironment,
  tool: "worktrunk" | "tmux" | "claude" | "codex" | "pi" | "opencode",
): string {
  if (tool === "worktrunk" && env.worktrunkBin !== undefined) return env.worktrunkBin;
  if (tool === "tmux" && env.tmuxBin !== undefined) return env.tmuxBin;
  if (tool === "claude" && env.claudeBin !== undefined) return env.claudeBin;
  if (tool === "codex" && env.codexBin !== undefined) return env.codexBin;
  if (tool === "pi" && env.piBin !== undefined) return env.piBin;
  if (tool === "opencode" && env.opencodeBin !== undefined) return env.opencodeBin;
  throw new Error(`Real E2E environment is missing ${tool}.`);
}
