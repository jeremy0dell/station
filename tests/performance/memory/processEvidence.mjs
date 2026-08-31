import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_INTERVAL_MS = 5_000;
const TOOL_TIMEOUT_MS = 15_000;

/** Samples OS-level memory identity without treating RSS as the macOS authority. */
export async function collectProcessSample(pid) {
  const sample = { at: new Date().toISOString(), pid };
  const ps = await runTool("ps", ["-o", "rss=", "-p", String(pid)], 5_000);
  if (ps.ok) {
    const rssKb = Number.parseInt(ps.stdout.trim(), 10);
    if (Number.isFinite(rssKb)) sample.rssBytes = rssKb * 1024;
  }
  if (process.platform === "darwin") {
    const footprint = await runTool(
      "/usr/bin/footprint",
      ["--pid", String(pid), "--format", "bytes", "--noCategories"],
      TOOL_TIMEOUT_MS,
    );
    if (footprint.ok) {
      const current = parseBytes(footprint.stdout, /phys_footprint:\s*([\d,]+)\s*B/u);
      const peak = parseBytes(footprint.stdout, /phys_footprint_peak:\s*([\d,]+)\s*B/u);
      if (current !== undefined) sample.physicalFootprintBytes = current;
      if (peak !== undefined) sample.physicalFootprintPeakBytes = peak;
    } else {
      sample.footprintError = footprint.message;
    }
  }
  return sample;
}

/** Starts bounded periodic process samples; the returned owner is disposable and signal-safe. */
export function startProcessMetricSampler(options) {
  const path = options?.path;
  const pid = options?.pid;
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("Process metric sampler requires an absolute output path.");
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Process metric sampler requires a positive process id.");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("Process metric sampler interval must be a positive safe integer.");
  }
  mkdirSync(dirname(path), { recursive: true });
  let disposed = false;
  let sequence = 0;
  let pending = Promise.resolve();
  const writeSample = () => {
    if (disposed) return;
    pending = pending
      .then(async () => {
        const sample = await collectProcessSample(pid);
        appendLine(path, {
          schemaVersion: 1,
          event: "process-sample",
          sequence: sequence++,
          ...sample,
        });
      })
      .catch((error) => {
        appendLine(path, {
          schemaVersion: 1,
          event: "process-sample-error",
          sequence: sequence++,
          at: new Date().toISOString(),
          pid,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  };
  writeSample();
  const interval = setInterval(writeSample, intervalMs);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(interval);
    },
    async flush() {
      await pending;
    },
  };
}

/** Captures final macOS footprint, VM-region, heap, and allocation evidence for one process. */
export async function captureProcessEvidence(options) {
  const pid = options?.pid;
  const outputDir = options?.outputDir;
  const label = options?.label;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Process evidence requires a positive process id.");
  }
  if (typeof outputDir !== "string" || !isAbsolute(outputDir)) {
    throw new Error("Process evidence requires an absolute output directory.");
  }
  if (typeof label !== "string" || label.length === 0) {
    throw new Error("Process evidence requires a non-empty label.");
  }
  mkdirSync(outputDir, { recursive: true });
  const commands = [
    {
      name: "footprint",
      command: "/usr/bin/footprint",
      args: ["--pid", String(pid), "--format", "bytes", "--wide", "--swapped", "--wired"],
    },
    { name: "vmmap-summary", command: "/usr/bin/vmmap", args: ["-summary", String(pid)] },
    { name: "heap", command: "/usr/bin/heap", args: [String(pid)] },
    { name: "sample", command: "/usr/bin/sample", args: [String(pid), "1", "1"] },
  ];
  const results = [];
  for (const tool of commands) {
    const result = await runTool(tool.command, tool.args, TOOL_TIMEOUT_MS);
    const outputPath = join(outputDir, `${safeLabel(label)}-${tool.name}.txt`);
    appendFileSync(
      outputPath,
      result.ok ? result.stdout : `${result.message}\n${result.stderr ?? ""}`,
    );
    results.push({
      tool: tool.name,
      output: outputPath,
      ok: result.ok,
      ...(result.ok ? {} : { message: result.message }),
    });
  }
  return { pid, label, results };
}

async function runTool(command, args, timeout) {
  try {
    const result = await execFileAsync(command, args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      stderr: typeof error?.stderr === "string" ? error.stderr : undefined,
    };
  }
}

function parseBytes(value, pattern) {
  const match = value.match(pattern);
  if (match === null) return undefined;
  const bytes = Number.parseInt(match[1].replaceAll(",", ""), 10);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

function safeLabel(value) {
  return value.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");
}

function appendLine(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}
