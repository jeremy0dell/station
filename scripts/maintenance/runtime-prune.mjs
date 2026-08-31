#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  applyVerifiedDisposableRuntimePrune,
  DisposableRuntimeIdSchema,
  inspectDisposableRuntimeOwners,
  RuntimeOwnerError,
} from "../runtime-owner.mjs";
import { inspectRegisteredRuntimeHosts, resolveRuntimeStateDir } from "./runtime-inventory.mjs";

const schemaVersion = 1;
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const ErrorCodeSchema = z.object({ code: z.string() }).loose();
const RuntimeProjectionSchema = z
  .object({
    runtimeId: DisposableRuntimeIdSchema,
    role: z.enum(["native-hmr", "setup-guided-e2e", "binary-smoke", "memory-profile"]),
    runtimeKey: DigestSchema,
    checkoutKey: DigestSchema,
    ownerState: z.string().min(1),
    processGroupState: z.string().min(1),
    memberCount: z.number().int().nonnegative(),
    socketRoots: z.object({ count: z.number().int().nonnegative(), key: DigestSchema }).strict(),
    persistenceRoots: z
      .object({ count: z.number().int().nonnegative(), key: DigestSchema })
      .strict(),
    cleanupRoots: z.object({ count: z.number().int().nonnegative(), key: DigestSchema }).strict(),
  })
  .strict();
const PlanBaseSchema = z
  .object({
    schemaVersion: z.literal(schemaVersion),
    mode: z.literal("plan"),
    stateDirKey: DigestSchema,
    runtimeId: DisposableRuntimeIdSchema,
  })
  .strict();
const EligiblePlanSchema = PlanBaseSchema.extend({
  eligible: z.literal(true),
  runtime: RuntimeProjectionSchema,
  action: z.enum(["terminate-and-retire", "retire-record"]),
  safety: z
    .object({
      registeredHostCount: z.number().int().nonnegative(),
      livePtyCount: z.number().int().nonnegative(),
      protectedProcessCount: z.number().int().nonnegative(),
      protectedProcessesKey: DigestSchema,
    })
    .strict(),
  planDigest: DigestSchema,
  applyWith: z.string().min(1),
}).strict();
const RefusedPlanSchema = PlanBaseSchema.extend({
  eligible: z.literal(false),
  refusalCodes: z.array(z.string().min(1)).min(1),
}).strict();
export const RuntimePrunePlanSchema = z.discriminatedUnion("eligible", [
  EligiblePlanSchema,
  RefusedPlanSchema,
]);

if (isMain()) {
  try {
    const options = parseRuntimePruneArgs(process.argv.slice(2));
    if (options.command === "help") {
      printRuntimePruneHelp();
    } else if (options.command === "plan") {
      const plan = await buildRuntimePrunePlan(options);
      process.stdout.write(
        options.json ? `${JSON.stringify(plan)}\n` : formatRuntimePrunePlan(plan),
      );
      if (!plan.eligible) process.exitCode = 1;
    } else {
      const result = await applyRuntimePrune(options);
      process.stdout.write(
        options.json ? `${JSON.stringify(result)}\n` : formatRuntimePruneResult(result),
      );
      process.exitCode = result.exitCode;
    }
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : "Runtime prune failed."}\n`);
    process.exitCode = cause instanceof RuntimeOwnerError ? (cause.exitCode ?? 1) : 1;
  }
}

export function parseRuntimePruneArgs(args) {
  const input = args.filter((arg) => arg !== "--");
  if (input.includes("--help") || input.includes("-h")) return { command: "help", json: false };
  let runtimeId;
  let stateDir;
  let expectPlan;
  let yes = false;
  let json = false;
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    switch (arg) {
      case "--runtime":
        if (runtimeId !== undefined) throw new Error("--runtime may be supplied only once.");
        runtimeId = requiredOption(input, ++index, arg);
        break;
      case "--state-dir": {
        const value = requiredOption(input, ++index, arg);
        if (!isAbsolute(value)) throw new Error("--state-dir requires an absolute path.");
        stateDir = resolve(value);
        break;
      }
      case "--expect-plan":
        expectPlan = requiredOption(input, ++index, arg);
        break;
      case "--yes":
        yes = true;
        break;
      case "--json":
        json = true;
        break;
      default:
        throw new Error(`Unknown runtime prune option: ${arg}`);
    }
  }
  const parsedRuntimeId = DisposableRuntimeIdSchema.safeParse(runtimeId);
  if (!parsedRuntimeId.success) throw new Error("--runtime requires one run_<uuid> identifier.");
  if (yes !== (expectPlan !== undefined)) {
    throw new Error("--yes and --expect-plan <sha256> must be supplied together.");
  }
  if (expectPlan !== undefined && !DigestSchema.safeParse(expectPlan).success) {
    throw new Error("--expect-plan must be a SHA-256 digest.");
  }
  return {
    command: yes ? "apply" : "plan",
    runtimeId: parsedRuntimeId.data,
    json,
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(expectPlan === undefined ? {} : { expectPlan }),
  };
}

/** Build a stable, redacted prune authorization without writing runtime state. */
export async function buildRuntimePrunePlan(options) {
  return (await inspectRuntimePrunePlan(options)).plan;
}

/** Apply only the current plan digest, with fresh safety evidence before each destructive stage. */
export async function applyRuntimePrune(options) {
  const stateDir = options.stateDir ?? (await resolveRuntimeStateDir());
  const expectedPlan = options.expectPlan;
  if (!DigestSchema.safeParse(expectedPlan).success) {
    throw new RuntimeOwnerError(
      "RUNTIME_PRUNE_CONFIRMATION_REQUIRED",
      "Apply requires --yes and the digest from a fresh eligible plan.",
    );
  }
  const inspected = await inspectRuntimePrunePlan({ stateDir, runtimeId: options.runtimeId });
  if (!inspected.plan.eligible) {
    throw new RuntimeOwnerError(
      "RUNTIME_PRUNE_NOT_ELIGIBLE",
      `Runtime prune refused: ${inspected.plan.refusalCodes.join(", ")}.`,
    );
  }
  if (inspected.plan.planDigest !== expectedPlan) {
    throw new RuntimeOwnerError(
      "RUNTIME_PRUNE_PLAN_CHANGED",
      "The current runtime evidence does not match --expect-plan; generate a fresh plan.",
    );
  }

  return applyVerifiedDisposableRuntimePrune(
    {
      stateDir,
      runtimeId: options.runtimeId,
      planDigest: expectedPlan,
      record: inspected.record,
    },
    async ({ stage, record, processGroup }) => {
      if (stage === "before-mutation") {
        const refreshed = await inspectRuntimePrunePlan({ stateDir, runtimeId: options.runtimeId });
        if (!refreshed.plan.eligible || refreshed.plan.planDigest !== expectedPlan) {
          throw new RuntimeOwnerError(
            "RUNTIME_PRUNE_PLAN_CHANGED",
            "Runtime evidence changed after confirmation; no signal was authorized.",
          );
        }
        return;
      }
      const safety = await inspectRuntimePruneSafety(stateDir, record, processGroup);
      if (safety.refusalCodes.length > 0 || safety.safetyKey !== inspected.safetyKey) {
        throw new RuntimeOwnerError(
          "RUNTIME_PRUNE_SAFETY_CHANGED",
          "Protected runtime, root, or checkout evidence changed during cleanup.",
        );
      }
    },
  );
}

async function inspectRuntimePrunePlan(options) {
  const stateDir = options.stateDir ?? (await resolveRuntimeStateDir());
  const base = {
    schemaVersion,
    mode: "plan",
    stateDirKey: digest(stateDir),
    runtimeId: options.runtimeId,
  };
  const owners = await inspectDisposableRuntimeOwners(stateDir);
  if (owners.state !== "available") {
    return refusedInspection(base, [owners.refusalCode ?? "RUNTIME_PRUNE_OWNER_DIRECTORY_MISSING"]);
  }
  const matches = owners.records.filter(
    (entry) => (entry.record?.runtimeId ?? entry.runtimeId) === options.runtimeId,
  );
  if (matches.length !== 1) {
    return refusedInspection(base, [
      matches.length === 0 ? "RUNTIME_PRUNE_RUNTIME_NOT_FOUND" : "RUNTIME_PRUNE_RUNTIME_AMBIGUOUS",
    ]);
  }
  const entry = matches[0];
  if (entry.record === undefined) {
    return refusedInspection(base, [entry.refusalCode ?? "RUNTIME_PRUNE_RECORD_REFUSED"]);
  }

  const processGroup = entry.processGroup;
  const safety = await inspectRuntimePruneSafety(stateDir, entry.record, processGroup, owners);
  const refusalCodes = [...safety.refusalCodes];
  if (entry.ownerIdentity === "exact") refusalCodes.push("RUNTIME_PRUNE_OWNER_ACTIVE");
  else if (entry.ownerIdentity !== "absent") refusalCodes.push("RUNTIME_PRUNE_OWNER_AMBIGUOUS");
  if (!["exact", "absent", "unstarted"].includes(processGroup.kind)) {
    refusalCodes.push(processGroup.code ?? "RUNTIME_PRUNE_GROUP_AMBIGUOUS");
  }
  const uniqueRefusals = sortedUnique(refusalCodes);
  if (uniqueRefusals.length > 0) return refusedInspection(base, uniqueRefusals);

  const action = processGroup.kind === "exact" ? "terminate-and-retire" : "retire-record";
  const authorization = {
    schemaVersion,
    stateDir,
    action,
    record: entry.record,
    ownerIdentity: entry.ownerIdentity,
    processGroup,
    checkout: safety.checkout,
    cleanupRoots: safety.cleanupRoots,
    hosts: safety.hostEvidence,
  };
  const planDigest = digest(authorization);
  const plan = RuntimePrunePlanSchema.parse({
    ...base,
    eligible: true,
    runtime: {
      runtimeId: entry.record.runtimeId,
      role: entry.record.role,
      runtimeKey: entry.record.runtimeKey,
      checkoutKey: entry.record.checkout.key,
      ownerState: entry.ownerIdentity,
      processGroupState: processGroup.kind,
      memberCount: processGroup.members?.length ?? 0,
      socketRoots: projectRoots(entry.record.socketRoots),
      persistenceRoots: projectRoots(entry.record.persistenceRoots),
      cleanupRoots: projectRoots((entry.record.cleanupRoots ?? []).map((root) => root.path)),
    },
    action,
    safety: {
      registeredHostCount: safety.hostEvidence.hosts.filter((host) => host.state === "available")
        .length,
      livePtyCount: safety.livePtyCount,
      protectedProcessCount: safety.protectedProcesses.length,
      protectedProcessesKey: digest(safety.protectedProcesses),
    },
    planDigest,
    applyWith: `--yes --expect-plan ${planDigest}`,
  });
  return { plan, record: entry.record, safetyKey: safety.safetyKey };
}

async function inspectRuntimePruneSafety(stateDir, record, processGroup, knownOwners) {
  const owners = knownOwners ?? (await inspectDisposableRuntimeOwners(stateDir));
  const refusalCodes = [];
  if (owners.state !== "available" || owners.records.some((entry) => entry.record === undefined)) {
    refusalCodes.push(owners.refusalCode ?? "RUNTIME_PRUNE_OWNER_EVIDENCE_REFUSED");
  }
  const validRecords = owners.records.filter((entry) => entry.record !== undefined);
  const current = validRecords.find((entry) => entry.record.runtimeId === record.runtimeId);
  if (
    current === undefined ||
    current.record.owner.processToken !== record.owner.processToken ||
    current.record.runtimeKey !== record.runtimeKey
  ) {
    refusalCodes.push("RUNTIME_PRUNE_RECORD_REPLACED");
  }

  const checkout = await inspectCheckout(record);
  if (checkout.state !== "exact") refusalCodes.push(checkout.refusalCode);
  const cleanup = await inspectCleanupRoots(record, processGroup.kind);
  refusalCodes.push(...cleanup.refusalCodes);
  const hostEvidence = await inspectRegisteredRuntimeHosts(validRecords);
  if (hostEvidence.state === "refused") {
    refusalCodes.push(hostEvidence.refusalCode ?? "RUNTIME_PRUNE_HOST_EVIDENCE_REFUSED");
  }
  const protection = classifyRuntimePruneProtection({
    record,
    groupMembers: processGroup.members ?? [],
    cleanupRoots: cleanup.roots,
    hostEvidence,
  });
  refusalCodes.push(...protection.refusalCodes);
  return {
    refusalCodes: sortedUnique(refusalCodes),
    checkout,
    cleanupRoots: cleanup.roots,
    hostEvidence,
    protectedProcesses: protection.protectedProcesses,
    livePtyCount: protection.livePtyCount,
    safetyKey: digest({
      checkout,
      cleanupRoots: cleanup.roots,
      protectedProcesses: protection.protectedProcesses,
      protectedSockets: protection.protectedSockets,
    }),
  };
}

/** Classify Host and PTY identities relative to the exact disposable process group. */
export function classifyRuntimePruneProtection({
  record,
  groupMembers,
  cleanupRoots,
  hostEvidence,
}) {
  const group = new Set(groupMembers);
  const protectedProcesses = [];
  const protectedSockets = [];
  const refusalCodes = [];
  let livePtyCount = 0;
  for (const host of hostEvidence.hosts) {
    if (host.state === "refused") {
      refusalCodes.push(host.refusalCode ?? "RUNTIME_PRUNE_HOST_EVIDENCE_REFUSED");
      continue;
    }
    if (host.state !== "available") continue;
    const insideCleanupRoot = cleanupRoots.some(
      (root) => root.state === "exact" && pathContains(root.path, host.socketPath),
    );
    const processes = [
      { kind: "host", ...host.holder },
      ...host.livePtys.map((identity) => ({ kind: "pty", ...identity })),
    ];
    livePtyCount += host.livePtys.length;
    for (const identity of processes) {
      if (group.has(identity.pid)) {
        if (record.role !== "binary-smoke" || !insideCleanupRoot) {
          refusalCodes.push("RUNTIME_PRUNE_PERSISTENT_RUNTIME_OVERLAP");
        }
        continue;
      }
      protectedProcesses.push(identity);
      if (insideCleanupRoot) refusalCodes.push("RUNTIME_PRUNE_CLEANUP_ROOT_IN_USE");
    }
    if (processes.some((identity) => !group.has(identity.pid))) {
      protectedSockets.push({
        socketPath: host.socketPath,
        socketIdentity: host.socketIdentity,
      });
    }
  }
  return {
    protectedProcesses: protectedProcesses.sort((left, right) => left.pid - right.pid),
    protectedSockets: protectedSockets.sort((left, right) =>
      left.socketPath.localeCompare(right.socketPath),
    ),
    refusalCodes: sortedUnique(refusalCodes),
    livePtyCount,
  };
}

async function inspectCheckout(record) {
  try {
    const metadata = await lstat(record.checkout.root);
    const canonical = await realpath(record.checkout.root);
    const identity = await stat(canonical);
    const exact =
      metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      canonical === record.checkout.root &&
      String(identity.dev) === record.checkout.device &&
      String(identity.ino) === record.checkout.inode;
    return exact
      ? { state: "exact", device: String(identity.dev), inode: String(identity.ino) }
      : { state: "changed", refusalCode: "RUNTIME_PRUNE_CHECKOUT_CHANGED" };
  } catch {
    return { state: "unavailable", refusalCode: "RUNTIME_PRUNE_CHECKOUT_UNAVAILABLE" };
  }
}

async function inspectCleanupRoots(record, processGroupState) {
  const roots = [];
  const refusalCodes = [];
  const temporaryRoot = await realpath(tmpdir());
  for (const expected of record.cleanupRoots ?? []) {
    if (
      record.role !== "binary-smoke" ||
      !pathContains(temporaryRoot, expected.path) ||
      expected.path === temporaryRoot ||
      pathContains(expected.path, record.checkout.root) ||
      pathContains(expected.path, record.recordRoot)
    ) {
      refusalCodes.push("RUNTIME_PRUNE_CLEANUP_ROOT_REFUSED");
      continue;
    }
    try {
      const metadata = await lstat(expected.path);
      const canonical = await realpath(expected.path);
      const identity = await stat(canonical);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        canonical !== expected.path ||
        String(identity.dev) !== expected.device ||
        String(identity.ino) !== expected.inode
      ) {
        refusalCodes.push("RUNTIME_PRUNE_CLEANUP_ROOT_CHANGED");
      } else {
        roots.push({
          state: "exact",
          path: canonical,
          device: String(identity.dev),
          inode: String(identity.ino),
        });
      }
    } catch (cause) {
      const parsed = ErrorCodeSchema.safeParse(cause);
      if (
        parsed.success &&
        parsed.data.code === "ENOENT" &&
        record.state.reason === "operator-prune" &&
        ["absent", "unstarted"].includes(processGroupState)
      ) {
        roots.push({ state: "absent", path: expected.path });
      } else {
        refusalCodes.push("RUNTIME_PRUNE_CLEANUP_ROOT_UNAVAILABLE");
      }
    }
  }
  return { roots, refusalCodes };
}

function refusedInspection(base, refusalCodes) {
  return {
    plan: RuntimePrunePlanSchema.parse({
      ...base,
      eligible: false,
      refusalCodes: sortedUnique(refusalCodes),
    }),
  };
}

function projectRoots(paths) {
  return { count: paths.length, key: digest([...paths].sort()) };
}

function pathContains(root, candidate) {
  const value = relative(root, candidate);
  return value.length === 0 || (!value.startsWith("..") && !isAbsolute(value));
}

function sortedUnique(values) {
  return [...new Set(values.filter((value) => value !== undefined))].sort();
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function requiredOption(args, index, option) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

export function formatRuntimePrunePlan(plan) {
  const lines = ["Station runtime prune plan (read-only)", `runtime: ${plan.runtimeId}`];
  if (!plan.eligible) {
    lines.push(`eligible: no (${plan.refusalCodes.join(", ")})`);
    return `${lines.join("\n")}\n`;
  }
  lines.push(`eligible: yes`, `action: ${plan.action}`);
  lines.push(
    `protected: ${plan.safety.protectedProcessCount} processes; ${plan.safety.livePtyCount} live PTYs`,
  );
  lines.push(`plan digest: ${plan.planDigest}`);
  lines.push(`apply: rerun with ${plan.applyWith}`);
  return `${lines.join("\n")}\n`;
}

export function formatRuntimePruneResult(result) {
  return `Pruned ${result.runtimeId}: ${result.action} (${result.planDigest})\n`;
}

function printRuntimePruneHelp() {
  process.stdout.write(`Usage: bun run station:runtime-prune -- --runtime <run_uuid> [--state-dir /absolute/path] [--json]
       bun run station:runtime-prune -- --runtime <run_uuid> [--state-dir /absolute/path] --yes --expect-plan <sha256> [--json]

Plans one registered disposable runtime without mutation. Apply requires the exact
digest from a fresh eligible plan and revalidates ownership before every action.\n`);
}

function isMain() {
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}
