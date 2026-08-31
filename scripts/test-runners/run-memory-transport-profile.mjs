#!/usr/bin/env node
import { execFile } from "node:child_process";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const DEFAULT_COUNTS = [1_000, 4_000, 16_000, 64_000, 256_000];
const DEFAULT_PAYLOAD_BYTES = 4_096;
const DEFAULT_COOLDOWN_MS = 30_000;
const SAMPLE_INTERVAL_MS = 5_000;
const MAX_TARGET_FOOTPRINT_BYTES = 8 * 1024 * 1024 * 1024;

export function robustRetentionSlope(samples) {
  const slopes = [];
  for (let left = 0; left < samples.length; left += 1) {
    for (let right = left + 1; right < samples.length; right += 1) {
      const operations = samples[right].operations - samples[left].operations;
      if (operations > 0) {
        slopes.push(
          (samples[right].physicalFootprintBytes - samples[left].physicalFootprintBytes) /
            operations,
        );
      }
    }
  }
  if (slopes.length === 0) return 0;
  slopes.sort((left, right) => left - right);
  const middle = Math.floor(slopes.length / 2);
  return slopes.length % 2 === 0 ? (slopes[middle - 1] + slopes[middle]) / 2 : slopes[middle];
}

export function classifyTransportRetention(control, stalled) {
  const controlSlope = robustRetentionSlope(control);
  const stalledSlope = robustRetentionSlope(stalled);
  const finalGapBytes =
    (stalled.at(-1)?.physicalFootprintBytes ?? 0) - (control.at(-1)?.physicalFootprintBytes ?? 0);
  return {
    controlSlopeBytesPerFrame: controlSlope,
    stalledSlopeBytesPerFrame: stalledSlope,
    finalGapBytes,
    implicated: stalledSlope > Math.max(controlSlope * 3, 64) && finalGapBytes >= 128 * 1024 * 1024,
  };
}

export function transportStayedBounded(controls, stalled, repeats) {
  return (
    controls.length === repeats &&
    stalled.length === repeats &&
    controls.every(
      (cell) =>
        cell.status === "complete" &&
        cell.transportDiagnostics?.inboundQueueDepth === 0 &&
        cell.transportDiagnostics.inboundQueueBytes === 0 &&
        cell.transportDiagnostics.outboundBackpressureCount === 0 &&
        cell.transportDiagnostics.overflowCount === 0 &&
        cell.transportDiagnostics.closeCount === 1,
    ) &&
    stalled.every(
      (cell) =>
        cell.status === "overflow-closed" &&
        cell.transportDiagnostics?.overflowCount === 1 &&
        cell.transportDiagnostics.closeCount === 1 &&
        cell.transportDiagnostics.inboundQueueDepth === 0 &&
        cell.transportDiagnostics.inboundQueueBytes === 0 &&
        cell.transportDiagnostics.outboundBackpressureCount === 0 &&
        cell.transportDiagnostics.inboundHighWaterDepth <= cell.transportLimits?.maxQueuedFrames &&
        cell.transportDiagnostics.inboundHighWaterBytes <= cell.transportLimits?.maxQueuedBytes,
    )
  );
}

export async function checkPrerequisites(options) {
  const missing = [];
  if (process.platform !== "darwin") missing.push("macOS");
  const bun = options.bun;
  if (bun === undefined || !isAbsolute(bun)) missing.push("absolute Bun 1.4.0 path");
  let bunVersion;
  if (missing.length === 0) {
    try {
      await access(bun);
      bunVersion = (await execFileAsync(bun, ["--version"], { cwd: repoRoot })).stdout.trim();
      if (bunVersion !== "1.4.0") missing.push(`Bun 1.4.0 (found ${bunVersion})`);
    } catch {
      missing.push("executable Bun 1.4.0");
    }
  }
  for (const tool of [
    "/usr/bin/footprint",
    "/usr/bin/vmmap",
    "/usr/bin/heap",
    "/usr/bin/sample",
    "/usr/sbin/sysctl",
  ]) {
    try {
      await access(tool);
    } catch {
      missing.push(tool);
    }
  }
  const clean =
    (
      await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: repoRoot,
      })
    ).stdout === "";
  if (!clean) missing.push("clean source checkout");
  try {
    await access(join(repoRoot, "packages", "protocol", "dist", "index.js"));
  } catch {
    missing.push("built @station/protocol dist");
  }
  const pressureLevel = await readPressureLevel();
  if (pressureLevel !== 1) missing.push(`normal memory pressure (found ${pressureLevel})`);
  return {
    clean,
    bun: bun === undefined ? undefined : { executable: bun, version: bunVersion },
    pressureLevel,
    missing,
    ready: missing.length === 0,
  };
}

export async function runMatrix(options) {
  if (!isAbsolute(options.output)) throw new Error("Transport profile output must be absolute.");
  const check = await checkPrerequisites(options);
  if (!check.ready)
    throw new Error(`Transport profile preflight failed: ${check.missing.join(", ")}`);
  await mkdir(options.output, { recursive: true, mode: 0o700 });
  const revision = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })
  ).stdout.trim();
  const manifest = {
    schemaVersion: 1,
    revision,
    bun: check.bun,
    counts: options.counts,
    payloadBytes: options.payloadBytes,
    cooldownMs: options.cooldownMs,
    repeats: options.repeats,
    cells: [],
  };
  await writeJson(join(options.output, "manifest.json"), manifest);
  const cells = [];
  for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
    for (const mode of ["drain", "stalled"]) {
      const cell = await runCell({ ...options, mode, repeat });
      cells.push(cell);
      manifest.cells.push({ mode, repeat, output: cell.output, status: cell.status });
      await writeJson(join(options.output, "manifest.json"), manifest);
    }
  }
  const controls = cells.filter((cell) => cell.mode === "drain" && cell.status === "complete");
  const stalled = cells.filter(
    (cell) =>
      cell.mode === "stalled" && (cell.status === "complete" || cell.status === "overflow-closed"),
  );
  const comparisons = [];
  for (let index = 0; index < Math.min(controls.length, stalled.length); index += 1) {
    comparisons.push(classifyTransportRetention(controls[index].samples, stalled[index].samples));
  }
  const result = {
    schemaVersion: 1,
    revision,
    cells,
    comparisons,
    implicated:
      comparisons.length === options.repeats && comparisons.every((item) => item.implicated),
    bounded: transportStayedBounded(controls, stalled, options.repeats),
  };
  await writeJson(join(options.output, "result.json"), result);
  process.stdout.write(
    `${JSON.stringify({ output: options.output, implicated: result.implicated, bounded: result.bounded, comparisons })}\n`,
  );
  return result;
}

async function runCell(options) {
  const label = `${options.repeat}-${options.mode}`;
  const output = join(options.output, label);
  const socketPath = join(output, "transport.sock");
  const peerSamplesPath = join(output, "peer-memory.jsonl");
  const processSamplesPath = join(output, "process-memory.jsonl");
  await mkdir(output, { recursive: true, mode: 0o700 });
  await unlink(socketPath).catch(() => undefined);

  let peer;
  let socket;
  let status = "complete";
  let stopReason;
  let sent = 0;
  const samples = [];
  const server = createServer((accepted) => {
    socket = accepted;
    socket.setNoDelay(true);
  });
  server.listen(socketPath);
  await once(server, "listening");

  try {
    peer = Bun.spawn(
      [
        options.bun,
        scriptPath,
        "--peer",
        "--socket",
        socketPath,
        "--samples",
        peerSamplesPath,
        "--mode",
        options.mode,
      ],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    await waitForPeerReady(peer);
    await waitFor(() => socket !== undefined, 5_000, "transport peer connection");
    const payload = "x".repeat(Math.max(1, options.payloadBytes - 80));
    for (const count of options.counts) {
      const outcome = await sendUntil(
        socket,
        sent,
        count,
        payload,
        peer.pid,
        options.stepTimeoutMs,
      );
      sent = outcome.sent;
      if (outcome.reason !== undefined) {
        status = outcome.reason === "peer-closed" ? "overflow-closed" : outcome.reason;
        stopReason = outcome.reason;
      }
      await delay(options.cooldownMs);
      const sample = await collectProcessSample(peer.pid, sent);
      samples.push(sample);
      appendJsonLine(processSamplesPath, sample);
      const safety = await safetyReason(sample);
      if (safety !== undefined) {
        status = "safety-stop";
        stopReason = safety;
      }
      if (status !== "complete") break;
    }
    await captureFinalEvidence(peer.pid, output, label);
  } finally {
    socket?.destroy();
    await new Promise((resolve) => server.close(resolve));
    if (peer !== undefined) await terminateOwnedPeer(peer);
    await unlink(socketPath).catch(() => undefined);
  }

  const peerSamples = await readJsonLines(peerSamplesPath);
  const finalPeerSample = peerSamples.findLast(
    (sample) => sample.transportDiagnostics !== undefined,
  );
  const transportDiagnostics = finalPeerSample?.transportDiagnostics;
  const transportLimits = finalPeerSample?.transportLimits;

  const cell = {
    schemaVersion: 1,
    mode: options.mode,
    repeat: options.repeat,
    status,
    ...(stopReason === undefined ? {} : { stopReason }),
    sentFrames: sent,
    samples,
    slopeBytesPerFrame: robustRetentionSlope(samples),
    ...(transportLimits === undefined ? {} : { transportLimits }),
    ...(transportDiagnostics === undefined ? {} : { transportDiagnostics }),
    output,
  };
  await writeJson(join(output, "cell-result.json"), cell);
  return cell;
}

async function runPeer(options) {
  const { connectUnixSocket, NDJSON_TRANSPORT_LIMITS } = await import(
    "../../packages/protocol/dist/index.js"
  );
  const connection = await connectUnixSocket(options.socket, {
    transportLimits: NDJSON_TRANSPORT_LIMITS,
  });
  const startedAt = performance.now();
  let sequence = 0;
  let disposed = false;
  let consumed = 0;
  const jsc = await import("bun:jsc").catch(() => undefined);
  const sample = (phase) => {
    if (disposed) return;
    appendJsonLine(options.samples, {
      schemaVersion: 1,
      event: "sample",
      sequence: sequence++,
      phase,
      at: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - startedAt),
      pid: process.pid,
      consumed,
      memory: process.memoryUsage(),
      transportLimits: NDJSON_TRANSPORT_LIMITS,
      transportDiagnostics: connection.diagnostics(),
      ...(jsc === undefined ? {} : { jsc: jsc.heapStats() }),
    });
  };
  const interval = setInterval(() => sample("interval"), SAMPLE_INTERVAL_MS);
  const consume =
    options.mode === "drain"
      ? (async () => {
          for await (const _message of connection.messages()) consumed += 1;
        })()
      : undefined;
  const finish = async () => {
    if (disposed) return;
    clearInterval(interval);
    sample("final");
    disposed = true;
    connection.close();
    await consume?.catch(() => undefined);
  };
  process.once("SIGTERM", () => void finish().then(() => process.exit(0)));
  process.once("SIGINT", () => void finish().then(() => process.exit(0)));
  sample("initial");
  process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`);
  await connection.closed;
  sample("connection-closed");
  await new Promise(() => undefined);
}

async function sendUntil(socket, start, target, payload, pid, timeoutMs) {
  let sent = start;
  const deadline = Date.now() + timeoutMs;
  while (sent < target) {
    if (socket.destroyed) return { sent, reason: "peer-closed" };
    const frame = `${JSON.stringify({ sequence: sent, payload })}\n`;
    if (!socket.write(frame)) {
      const outcome = await waitForSocketDrain(socket, Math.max(1, deadline - Date.now()));
      if (outcome === "closed") return { sent, reason: "peer-closed" };
      if (outcome === "timeout") return { sent, reason: "backpressured" };
    }
    sent += 1;
    if (sent % 1_024 === 0) {
      const sample = await collectProcessSample(pid, sent, false);
      const reason = await safetyReason(sample);
      if (reason !== undefined) return { sent, reason };
      if (Date.now() >= deadline) return { sent, reason: "backpressured" };
    }
  }
  return { sent };
}

function waitForSocketDrain(socket, timeoutMs) {
  return new Promise((resolve) => {
    const finish = (outcome) => {
      clearTimeout(timer);
      socket.off("drain", onDrain);
      socket.off("close", onClose);
      socket.off("error", onClose);
      resolve(outcome);
    };
    const onDrain = () => finish("drain");
    const onClose = () => finish("closed");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    socket.once("drain", onDrain);
    socket.once("close", onClose);
    socket.once("error", onClose);
  });
}

async function collectProcessSample(pid, operations, includeFootprint = true) {
  const rssResult = await runTool("/bin/ps", ["-o", "rss=", "-p", String(pid)], 5_000);
  const rssKb = rssResult.ok ? Number.parseInt(rssResult.stdout.trim(), 10) : undefined;
  const sample = {
    schemaVersion: 1,
    event: "process-sample",
    at: new Date().toISOString(),
    pid,
    operations,
    ...(Number.isFinite(rssKb) ? { rssBytes: rssKb * 1024 } : {}),
  };
  if (includeFootprint) {
    const result = await runTool(
      "/usr/bin/footprint",
      ["--pid", String(pid), "--format", "bytes", "--noCategories"],
      15_000,
    );
    if (result.ok) {
      const current = parseBytes(result.stdout, /phys_footprint:\s*([\d,]+)\s*B/u);
      const peak = parseBytes(result.stdout, /phys_footprint_peak:\s*([\d,]+)\s*B/u);
      if (current !== undefined) sample.physicalFootprintBytes = current;
      if (peak !== undefined) sample.physicalFootprintPeakBytes = peak;
    } else {
      sample.footprintError = result.message;
    }
  }
  return sample;
}

async function safetyReason(sample) {
  if ((sample.physicalFootprintBytes ?? sample.rssBytes ?? 0) >= MAX_TARGET_FOOTPRINT_BYTES) {
    return "target-footprint-limit";
  }
  const pressure = await readPressureLevel();
  return pressure >= 4 ? "critical-memory-pressure" : undefined;
}

async function readPressureLevel() {
  const result = await runTool(
    "/usr/sbin/sysctl",
    ["-n", "kern.memorystatus_vm_pressure_level"],
    5_000,
  );
  return result.ok ? Number.parseInt(result.stdout.trim(), 10) : Number.NaN;
}

async function captureFinalEvidence(pid, output, label) {
  for (const tool of [
    {
      name: "footprint",
      command: "/usr/bin/footprint",
      args: ["--pid", String(pid), "--format", "bytes", "--wide", "--swapped", "--wired"],
    },
    { name: "vmmap-summary", command: "/usr/bin/vmmap", args: ["-summary", String(pid)] },
    { name: "heap", command: "/usr/bin/heap", args: [String(pid)] },
    { name: "sample", command: "/usr/bin/sample", args: [String(pid), "1", "1"] },
  ]) {
    const result = await runTool(tool.command, tool.args, 20_000);
    await writeFile(
      join(output, `${label}-${tool.name}.txt`),
      result.ok ? result.stdout : `${result.message}\n${result.stderr ?? ""}`,
      { mode: 0o600 },
    );
  }
}

async function waitForPeerReady(peer) {
  const reader = peer.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await readWithTimeout(reader, Math.max(1, deadline - Date.now()));
    if (result === undefined) break;
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      reader.releaseLock();
      if (message.ready === true) return;
      break;
    }
  }
  const stderr = await new Response(peer.stderr).text().catch(() => "");
  throw new Error(`Transport peer did not become ready. ${stderr}`.trim());
}

async function terminateOwnedPeer(peer) {
  if (peer.exitCode !== null) return;
  peer.kill("SIGTERM");
  const exited = await settlesWithin(peer.exited, 3_000);
  if (!exited) {
    peer.kill("SIGKILL");
    await peer.exited;
  }
}

function readWithTimeout(reader, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function settlesWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function runTool(command, args, timeout) {
  try {
    const result = await execFileAsync(command, args, { timeout, maxBuffer: 16 * 1024 * 1024 });
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

function parseArgs(argv) {
  const options = {
    counts: DEFAULT_COUNTS,
    payloadBytes: DEFAULT_PAYLOAD_BYTES,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    repeats: 2,
    stepTimeoutMs: 120_000,
  };
  let action;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") action = "check";
    else if (arg === "--matrix") action = "matrix";
    else if (arg === "--peer") action = "peer";
    else if (arg === "--bun-1-4-0") options.bun = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--counts") options.counts = argv[++index].split(",").map(Number);
    else if (arg === "--payload-bytes") options.payloadBytes = Number(argv[++index]);
    else if (arg === "--cooldown-ms") options.cooldownMs = Number(argv[++index]);
    else if (arg === "--repeats") options.repeats = Number(argv[++index]);
    else if (arg === "--step-timeout-ms") options.stepTimeoutMs = Number(argv[++index]);
    else if (arg === "--socket") options.socket = argv[++index];
    else if (arg === "--samples") options.samples = argv[++index];
    else if (arg === "--mode") options.mode = argv[++index];
    else throw new Error(`Unsupported transport profile argument: ${arg}`);
  }
  if (action === undefined) throw new Error("Expected --check, --matrix, or --peer.");
  if (
    !options.counts.every(
      (value, index, values) => Number.isSafeInteger(value) && value > (values[index - 1] ?? 0),
    )
  )
    throw new Error("Frame counts must be increasing positive safe integers.");
  for (const [name, value] of [
    ["payload bytes", options.payloadBytes],
    ["cooldown", options.cooldownMs],
    ["repeats", options.repeats],
    ["step timeout", options.stepTimeoutMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive safe integer.`);
  }
  if (action === "peer" && options.mode !== "drain" && options.mode !== "stalled")
    throw new Error("Peer mode must be drain or stalled.");
  return { action, options };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function readJsonLines(path) {
  const contents = await readFile(path, "utf8").catch(() => "");
  return contents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function appendJsonLine(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await delay(10);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.main) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.action === "check") {
      process.stdout.write(
        `${JSON.stringify(await checkPrerequisites(parsed.options), null, 2)}\n`,
      );
    } else if (parsed.action === "matrix") {
      await runMatrix(parsed.options);
    } else {
      await runPeer(parsed.options);
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
