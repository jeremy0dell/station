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
const runnerScript = fileURLToPath(
  new URL("../../../scripts/test-runners/run-setup-guided-e2e.mjs", import.meta.url),
);

describeReal("real setup guided E2E process ownership", () => {
  it.each([
    ["term", 143, "SIGTERM"],
    ["hup", 129, "SIGHUP"],
  ])("reaps the exact supervised group after %s", async (scenario, exitCode, signal) => {
    const result = await runScenario(scenario);
    expect(result).toMatchObject({ exitCode, groupGone: true, records: 0 });
    expect(result.roles.every((role) => role === "setup-guided-e2e")).toBe(true);
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

  it("reaps the group when the inner vitest runner is killed", async () => {
    const result = await runScenario("inner-kill");
    expect(result).toMatchObject({ exitCode: 137, groupGone: true, records: 0 });
    expect(result.events).toEqual(
      expect.arrayContaining(["runtime.shutdown.requested", "runtime.cleanup.completed"]),
    );
  });

  it("revalidates before escalating a TERM-resistant supervised group", async () => {
    const result = await runScenario("escalate");
    expect(result).toMatchObject({ exitCode: 143, groupGone: true, records: 0 });
    expect(result.events).toContain("runtime.cleanup.escalated");
    expect(result.signals).toContain("SIGKILL");
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
  records: number;
  events: string[];
  roles: string[];
  signals: string[];
};

async function runScenario(scenario: string): Promise<ScenarioResult> {
  const root = await mkdtemp(join(tmpdir(), "station-setup-guided-owner-e2e-"));
  const harnessPath = join(root, "harness.py");
  const stubPath = join(root, "stub-vitest.mjs");
  await writeFile(harnessPath, PYTHON_HARNESS, { mode: 0o700 });
  await writeFile(stubPath, STUB_VITEST, { mode: 0o700 });
  try {
    const { stdout } = await execFileAsync("python3", [harnessPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        STATION_SETUP_GUIDED_E2E_CHECKOUT: repoRoot,
        STATION_SETUP_GUIDED_E2E_RUNNER: runnerScript,
        STATION_SETUP_GUIDED_E2E_STUB: stubPath,
        STATION_SETUP_GUIDED_E2E_ROOT: root,
        STATION_SETUP_GUIDED_E2E_SCENARIO: scenario,
      },
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
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

const STUB_VITEST = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const mode = process.env.STATION_SETUP_GUIDED_E2E_MODE ?? "normal";
if (mode === "normal") process.exit(0);
if (mode === "ignore-term") {
  process.on("SIGTERM", () => {});
  process.on("SIGHUP", () => {});
}
const readyFile = process.env.STATION_SETUP_GUIDED_E2E_READY;
if (readyFile) writeFileSync(readyFile, String(process.pid));
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

root = os.environ["STATION_SETUP_GUIDED_E2E_ROOT"]
scenario = os.environ["STATION_SETUP_GUIDED_E2E_SCENARIO"]
checkout = os.environ["STATION_SETUP_GUIDED_E2E_CHECKOUT"]
runner = os.environ["STATION_SETUP_GUIDED_E2E_RUNNER"]
stub = os.environ["STATION_SETUP_GUIDED_E2E_STUB"]
state_dir = os.path.join(root, "state")
os.makedirs(state_dir, 0o700)
config_path = os.path.join(root, "config.toml")
with open(config_path, "w", encoding="utf-8") as file:
    file.write(
        "schema_version = 1\\n"
        "projects = []\\n"
        "\\n"
        "[observer]\\n"
        'state_dir = "' + state_dir + '"\\n'
        "\\n"
        "[defaults]\\n"
        'worktree_provider = "worktrunk"\\n'
        'terminal = "tmux"\\n'
        'harness = "codex"\\n'
        'layout = "agent-shell"\\n'
    )
tracked_groups = set()
processes = []
masters = []
survivor = None

def wait_until(predicate, timeout=12.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise RuntimeError("timed out waiting for setup guided lifecycle state")

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

def stub_pid(group):
    members = group_members(group)
    for pid in members:
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as file:
                command = file.read().replace(b"\\0", b" ").decode("utf-8", "replace")
        except OSError:
            command = subprocess.run(
                ["ps", "-p", str(pid), "-o", "command="],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
        if stub in command:
            return pid
    raise RuntimeError("stub vitest process was not found in the supervised group")

def child_session():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)

start_counter = 0

def start_owner(mode, wait_for_running=True):
    global start_counter
    start_counter += 1
    ready_file = os.path.join(root, "ready-" + str(start_counter))
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({
        "STATION_CONFIG_PATH": config_path,
        "STATION_SETUP_E2E_VITEST_BIN": stub,
        "STATION_SETUP_GUIDED_E2E_MODE": mode,
        "STATION_SETUP_GUIDED_E2E_READY": ready_file,
        "STATION_OBSERVER_SOCKET_PATH": os.path.join(root, "run", "observer.sock"),
        "STATION_HOST_SOCKET_PATH": os.path.join(root, "run", "station-host.sock"),
        "STATION_LAYOUT_PATH": os.path.join(root, "state", "layout.json"),
        "TERM": "xterm-256color",
    })
    process = subprocess.Popen(
        ["node", runner],
        cwd=checkout,
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
    if mode != "normal":
        wait_until(lambda: os.path.exists(ready_file))
    return process, master, group

def await_exit(process, timeout=15.0):
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
    if scenario in ("term", "hup", "escalate", "inner-kill"):
        mode = "normal"
        if scenario in ("term", "hup"):
            mode = "long"
        if scenario == "escalate":
            mode = "ignore-term"
        if scenario == "inner-kill":
            mode = "long"
        owner, master, group = start_owner(mode)
        if scenario == "hup":
            close_master(master)
        elif scenario == "inner-kill":
            os.kill(stub_pid(group), signal.SIGKILL)
        else:
            os.kill(owner.pid, signal.SIGTERM)
        code = await_exit(owner, 20.0)
        wait_until(lambda: not group_members(group), 5.0)
        result = {
            "exitCode": code,
            "groupGone": not group_members(group),
            "records": len(record_paths()),
        }
    elif scenario == "rescue":
        survivor = subprocess.Popen(
            ["node", "-e", "setInterval(() => {}, 1000)"],
            cwd=checkout,
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
        rescue_code = await_exit(rescue, 20.0)
        wait_until(lambda: not group_members(old_group), 5.0)
        result = {
            "killedOwnerExitCode": killed_code,
            "rescueExitCode": rescue_code,
            "oldGroupGone": not group_members(old_group),
            "survivorPreserved": survivor.poll() is None,
            "records": len(record_paths()),
        }
    else:
        raise RuntimeError("unknown setup guided lifecycle scenario")

    events = event_records()
    result["events"] = [record.get("message") for record in events]
    result["roles"] = [
        record.get("attributes", {}).get("role")
        for record in events
        if record.get("attributes", {}).get("role") is not None
    ]
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
