import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const describeReal = environmentValue("STATION_REAL_E2E") === "1" ? describe : describe.skip;
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const ownerModule = fileURLToPath(new URL("../../../scripts/runtime-owner.mjs", import.meta.url));
const ttyClaimModule = fileURLToPath(
  new URL("../../../station/src/singleInstance.ts", import.meta.url),
);

describeReal("real native HMR process ownership", () => {
  it.each([
    ["term", 143, "SIGTERM"],
    ["hup", 129, "SIGHUP"],
  ])("reaps the exact Bun group after %s", async (scenario, exitCode, signal) => {
    const result = await runScenario(scenario);
    expect(result).toMatchObject({ exitCode, groupGone: true, records: 0 });
    expect(result.events).toEqual(
      expect.arrayContaining([
        "runtime.owner.registered",
        "runtime.process.started",
        "runtime.shutdown.requested",
        "runtime.cleanup.completed",
        "runtime.owner.retired",
      ]),
    );
    expect(result.signals).toContain(signal);
  });

  it("revalidates before escalating a TERM-resistant Bun group", async () => {
    const result = await runScenario("escalate");
    expect(result).toMatchObject({ exitCode: 143, groupGone: true, records: 0 });
    expect(result.events).toContain("runtime.cleanup.escalated");
    expect(result.signals).toContain("SIGKILL");
  });

  it("claims the real input TTY from inside the detached supervised renderer tree", async () => {
    const result = await runScenario("tty-claim");
    expect(result).toMatchObject({ exitCode: 0, ttyClaimKind: "owned", records: 0 });
  });

  it("recovers a killed launcher's group and preserves an unrelated persistent group", async () => {
    const result = await runScenario("rescue");
    expect(result).toMatchObject({
      killedOwnerExitCode: -9,
      rescueExitCode: 0,
      oldGroupGone: true,
      survivorPreserved: true,
      records: 0,
    });
    expect(result.events).toEqual(
      expect.arrayContaining(["runtime.orphan.detected", "runtime.orphan.recovered"]),
    );
  });
});

function environmentValue(name: string): string | undefined {
  return process.env[name];
}

type ScenarioResult = {
  exitCode?: number;
  killedOwnerExitCode?: number;
  rescueExitCode?: number;
  groupGone?: boolean;
  oldGroupGone?: boolean;
  survivorPreserved?: boolean;
  ttyClaimKind?: string;
  ttyClaimCode?: string;
  records: number;
  events: string[];
  signals: string[];
};

async function runScenario(scenario: string): Promise<ScenarioResult> {
  const root = await mkdtemp(join(tmpdir(), "station-native-hmr-owner-e2e-"));
  const harnessPath = join(root, "harness.py");
  const driverPath = join(root, "driver.mjs");
  const fixturePath = join(root, "fixture.mjs");
  await writeFile(harnessPath, PYTHON_HARNESS, { mode: 0o700 });
  await writeFile(driverPath, NODE_DRIVER, { mode: 0o700 });
  await writeFile(fixturePath, BUN_FIXTURE, { mode: 0o700 });
  try {
    const { stdout } = await execFileAsync("python3", [harnessPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        STATION_HMR_E2E_BUN: environmentValue("STATION_BUN") ?? "bun",
        STATION_HMR_E2E_CHECKOUT: repoRoot,
        STATION_HMR_E2E_DRIVER: driverPath,
        STATION_HMR_E2E_FIXTURE: fixturePath,
        STATION_HMR_E2E_OWNER_MODULE: ownerModule,
        STATION_HMR_E2E_ROOT: root,
        STATION_HMR_E2E_TTY_CLAIM_MODULE: ttyClaimModule,
        STATION_HMR_E2E_TTY_CLAIM_RESULT: join(root, "tty-claim-result.json"),
        STATION_HMR_E2E_SCENARIO: scenario,
      },
      maxBuffer: 1024 * 1024,
      timeout: 40_000,
    });
    return JSON.parse(stdout.trim()) as ScenarioResult;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `${failure.message}\nstdout:\n${failure.stdout ?? ""}\nstderr:\n${failure.stderr ?? ""}`,
      { cause: error },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const NODE_DRIVER = `
const { runOwnedDisposableRuntime } = await import(process.env.STATION_HMR_E2E_OWNER_MODULE);
const stateDir = process.env.STATION_HMR_E2E_STATE;
const mode = process.env.STATION_HMR_E2E_MODE;
const result = await runOwnedDisposableRuntime({
  role: "native-hmr",
  checkoutRoot: process.env.STATION_HMR_E2E_CHECKOUT,
  stateDir,
  socketRoots: [stateDir + "/run"],
  persistenceRoots: [stateDir],
  survivorPolicy: "preserve-persistent-station-runtime",
  terminalKey: "real-native-hmr-test-terminal",
  correlation: {
    traceId: "trc_real_hmr_" + mode + "_" + process.pid,
    spanId: "spn_real_hmr_" + process.pid,
  },
  launch: {
    cwd: process.env.STATION_HMR_E2E_CHECKOUT,
    steps: [{
      command: process.env.STATION_HMR_E2E_BUN,
      args: [process.env.STATION_HMR_E2E_FIXTURE, mode],
    }],
  },
});
process.exitCode = result.exitCode;
`;

const BUN_FIXTURE = `
import { writeFileSync } from "node:fs";

const mode = process.argv[2];
if (mode === "tty-claim") {
  const { acquireStationTtyOwnership } = await import(
    process.env.STATION_HMR_E2E_TTY_CLAIM_MODULE
  );
  const result = await acquireStationTtyOwnership();
  const payload = {
    kind: result.kind,
    ...(result.kind === "refused" ? { code: result.error.code } : {}),
  };
  if (result.kind === "owned") result.ownership.release();
  writeFileSync(process.env.STATION_HMR_E2E_TTY_CLAIM_RESULT, JSON.stringify(payload));
  process.exit(result.kind === "owned" ? 0 : 1);
}
if (mode === "normal") process.exit(0);
if (mode === "ignore-term") {
  process.on("SIGTERM", () => {});
  process.on("SIGHUP", () => {});
}
setInterval(() => {}, 1000);
`;

const PYTHON_HARNESS = `
import fcntl
import glob
import json
import os
import pty
import signal
import subprocess
import termios
import time

root = os.environ["STATION_HMR_E2E_ROOT"]
scenario = os.environ["STATION_HMR_E2E_SCENARIO"]
state_dir = os.path.join(root, "state")
os.mkdir(state_dir, 0o700)
tracked_groups = set()
processes = []
masters = []
survivor = None

def wait_until(predicate, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise RuntimeError("timed out waiting for native HMR lifecycle state")

def record_paths():
    return glob.glob(os.path.join(state_dir, "run", "runtime-owners", "v1", "run_*.json"))

def current_record_for_owner(owner_pid):
    for path in record_paths():
        with open(path, encoding="utf-8") as file:
            record = json.load(file)
        if record["owner"]["pid"] == owner_pid and record["state"]["phase"] == "running":
            return record
    return None

def event_records():
    path = os.path.join(state_dir, "logs", "cli.jsonl")
    if not os.path.exists(path):
        return []
    records = []
    with open(path, encoding="utf-8") as file:
        for line in file:
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return records

def group_members(pgid):
    result = subprocess.run(
        ["ps", "-ax", "-o", "pid=,pgid="],
        text=True,
        capture_output=True,
        check=True,
    )
    members = []
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) == 2 and int(fields[1]) == pgid:
            members.append(int(fields[0]))
    return members

def child_session():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)

def start_owner(mode, wait_for_running=True):
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({
        "STATION_HMR_E2E_STATE": state_dir,
        "STATION_HMR_E2E_MODE": mode,
        "TERM": "xterm-256color",
    })
    process = subprocess.Popen(
        ["node", os.environ["STATION_HMR_E2E_DRIVER"]],
        cwd=os.environ["STATION_HMR_E2E_CHECKOUT"],
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        preexec_fn=child_session,
    )
    os.close(slave)
    processes.append(process)
    masters.append(master)
    if not wait_for_running:
        return process, master, None
    record = wait_until(lambda: current_record_for_owner(process.pid))
    group = record["processGroup"]["pgid"]
    tracked_groups.add(group)
    return process, master, group

def await_exit(process, timeout=10.0):
    return process.wait(timeout=timeout)

def close_master(master):
    if master in masters:
        masters.remove(master)
    try:
        os.close(master)
    except OSError:
        pass

def reap_group(pgid):
    if not group_members(pgid):
        return
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.time() + 1.0
    while time.time() < deadline and group_members(pgid):
        time.sleep(0.05)
    if group_members(pgid):
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass

try:
    if scenario in ("term", "hup", "escalate"):
        mode = "ignore-term" if scenario == "escalate" else "long"
        owner, master, group = start_owner(mode)
        if scenario == "hup":
            close_master(master)
        else:
            os.kill(owner.pid, signal.SIGTERM)
        code = await_exit(owner, 12.0)
        wait_until(lambda: not group_members(group), 5.0)
        result = {
            "exitCode": code,
            "groupGone": not group_members(group),
            "records": len(record_paths()),
        }
    elif scenario == "tty-claim":
        owner, master, _ = start_owner("tty-claim", wait_for_running=False)
        code = await_exit(owner, 12.0)
        with open(os.environ["STATION_HMR_E2E_TTY_CLAIM_RESULT"], encoding="utf-8") as file:
            claim = json.load(file)
        result = {
            "exitCode": code,
            "ttyClaimKind": claim.get("kind"),
            "ttyClaimCode": claim.get("code"),
            "records": len(record_paths()),
        }
    elif scenario == "rescue":
        survivor = subprocess.Popen(
            [os.environ["STATION_HMR_E2E_BUN"], os.environ["STATION_HMR_E2E_FIXTURE"], "long"],
            cwd=os.environ["STATION_HMR_E2E_CHECKOUT"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        owner, master, old_group = start_owner("long")
        os.kill(owner.pid, signal.SIGKILL)
        killed_code = await_exit(owner)
        wait_until(lambda: group_members(old_group))
        rescue, rescue_master, _ = start_owner("normal", wait_for_running=False)
        rescue_code = await_exit(rescue, 12.0)
        wait_until(lambda: not group_members(old_group), 5.0)
        result = {
            "killedOwnerExitCode": killed_code,
            "rescueExitCode": rescue_code,
            "oldGroupGone": not group_members(old_group),
            "survivorPreserved": survivor.poll() is None,
            "records": len(record_paths()),
        }
    else:
        raise RuntimeError("unknown native HMR lifecycle scenario")

    events = event_records()
    result["events"] = [record.get("message") for record in events]
    result["signals"] = [
        record.get("attributes", {}).get("signal")
        for record in events
        if record.get("attributes", {}).get("signal") is not None
    ]
    print(json.dumps(result))
finally:
    if survivor is not None and survivor.poll() is None:
        try:
            os.killpg(survivor.pid, signal.SIGTERM)
            survivor.wait(timeout=2.0)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(survivor.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            survivor.wait(timeout=2.0)
    for pgid in tracked_groups:
        reap_group(pgid)
    for process in processes:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=2.0)
    for master in list(masters):
        close_master(master)
`;
