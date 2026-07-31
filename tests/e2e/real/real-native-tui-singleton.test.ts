import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const describeReal = process.env.STATION_REAL_E2E === "1" ? describe : describe.skip;
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const stationRoot = resolve(repoRoot, "station");
const sourceCommand = [process.env.STATION_BUN ?? "bun", "--hot", "src/main.tsx"];

describeReal("real native Station per-TTY ownership", () => {
  it("cooperatively replaces a source renderer before routing one complete CSI-u key", async () => {
    const result = await runScenario("takeover", sourceCommand);
    expect(result).toMatchObject({
      incumbentExitCode: 0,
      successorAliveAfterTakeover: true,
      inputOwner: "successor",
      inputEvents: 1,
    });
  }, 30_000);

  it("refuses legacy-looking and non-releasing owners without killing them", async () => {
    const legacy = await runScenario("legacy", sourceCommand);
    expect(legacy).toMatchObject({
      refusalCode: "TUI_TTY_LEGACY_OWNER_POSSIBLE",
      fixturePreserved: true,
    });

    const ignored = await runScenario("timeout", sourceCommand);
    expect(ignored).toMatchObject({
      refusalCode: "TUI_TTY_TAKEOVER_TIMEOUT",
      fixturePreserved: true,
      takeoverRequests: 1,
    });
  }, 30_000);

  it("allows at most one of two simultaneous source contenders to reach raw mode", async () => {
    const result = await runScenario("concurrent", sourceCommand);
    expect(result.rawModeOwners).toBeLessThanOrEqual(1);
  }, 30_000);

  const compiledBin = process.env.STATION_COMPILED_BIN;
  const compiledCommand = [resolve(compiledBin ?? ""), "__tui"];
  (compiledBin === undefined ? it.skip : it)(
    "repeats cooperative takeover through the exact compiled __tui entrypoint",
    async () => {
      const result = await runScenario("takeover", compiledCommand);
      expect(result).toMatchObject({
        incumbentExitCode: 0,
        successorAliveAfterTakeover: true,
        inputOwner: "successor",
        inputEvents: 1,
      });
    },
    30_000,
  );
});

type ScenarioResult = Record<string, unknown>;

async function runScenario(scenario: string, command: readonly string[]): Promise<ScenarioResult> {
  const directory = await mkdtemp(join(tmpdir(), "station-native-singleton-e2e-"));
  const harnessPath = join(directory, "harness.py");
  await writeFile(harnessPath, PYTHON_HARNESS, { mode: 0o700 });
  try {
    try {
      const { stdout } = await execFileAsync("python3", [harnessPath], {
        cwd: stationRoot,
        env: {
          ...process.env,
          STATION_SINGLETON_E2E_COMMAND: JSON.stringify(command),
          STATION_SINGLETON_E2E_SCENARIO: scenario,
          STATION_SINGLETON_E2E_TEMP: directory,
          STATION_SINGLETON_E2E_STATION_ROOT: stationRoot,
        },
        maxBuffer: 1024 * 1024,
        timeout: 25_000,
      });
      return JSON.parse(stdout.trim()) as ScenarioResult;
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      throw new Error(
        `${failure.message}\nstdout:\n${failure.stdout ?? ""}\nstderr:\n${failure.stderr ?? ""}`,
        { cause: error },
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const PYTHON_HARNESS = String.raw`
import fcntl
import hashlib
import json
import os
import pty
import re
import select
import signal
import stat
import struct
import subprocess
import sys
import termios
import time
import tty

scenario = os.environ["STATION_SINGLETON_E2E_SCENARIO"]
station_command = json.loads(os.environ["STATION_SINGLETON_E2E_COMMAND"])
temp_root = os.environ["STATION_SINGLETON_E2E_TEMP"]
station_root = os.environ["STATION_SINGLETON_E2E_STATION_ROOT"]
records = []
all_output = bytearray()
query_transcript = bytearray()
query_counts = {}
answered_modes = set()

os.setsid()
signal.signal(signal.SIGHUP, signal.SIG_IGN)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
tty.setraw(slave)
fcntl.fcntl(master, fcntl.F_SETFL, os.O_NONBLOCK)

tty_metadata = os.fstat(slave)
tty_identity = {
    "platform": "darwin" if sys.platform == "darwin" else "linux",
    "dev": str(tty_metadata.st_dev),
    "rdev": str(tty_metadata.st_rdev),
    "ino": str(tty_metadata.st_ino),
}
tty_hash = hashlib.sha256(json.dumps(tty_identity, separators=(",", ":")).encode()).hexdigest()[:32]
rendezvous_stem = "/tmp/station-tui-" + str(os.geteuid()) + "/" + tty_hash
rendezvous_artifacts = [
    rendezvous_stem + ".sqlite",
    rendezvous_stem + ".sqlite-journal",
    rendezvous_stem + ".sqlite-shm",
    rendezvous_stem + ".sqlite-wal",
    rendezvous_stem + ".sock",
]
preexisting_artifacts = {path for path in rendezvous_artifacts if os.path.lexists(path)}

shell_log = os.path.join(temp_root, "shell-input.jsonl")
shell_path = os.path.join(temp_root, "recording-shell.py")
with open(shell_path, "w", encoding="utf-8") as file:
    file.write("""#!/usr/bin/env python3
import json, os, tty
log = """ + repr(shell_log) + """
with open(log, "a", encoding="utf-8") as out:
    out.write(json.dumps({"type":"start","pid":os.getpid()}) + "\\n")
    out.flush()
tty.setraw(0)
while True:
    data = os.read(0, 4096)
    if not data:
        break
    with open(log, "a", encoding="utf-8") as out:
        out.write(json.dumps({"type":"input","pid":os.getpid(),"hex":data.hex()}) + "\\n")
        out.flush()
""")
os.chmod(shell_path, 0o700)

base_env = os.environ.copy()
config_path = os.path.join(temp_root, "config.toml")
with open(config_path, "w", encoding="utf-8") as file:
    file.write("""schema_version = 1
projects = []

[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = "codex"
layout = "agent-build-shell"

[workspace]
welcome_on_boot = false
""")
layout_path = os.path.join(temp_root, "layout.json")
with open(layout_path, "w", encoding="utf-8") as file:
    json.dump({
        "schemaVersion": 1,
        "panes": [{"id": "pane-main", "split": None, "role": "shell"}],
        "activePaneId": "pane-main",
        "cwdByPane": {"pane-main": station_root},
    }, file)
base_env.update({
    "HOME": temp_root,
    "XDG_CONFIG_HOME": os.path.join(temp_root, "config"),
    "XDG_STATE_HOME": os.path.join(temp_root, "state"),
    "STATION_CONFIG_PATH": config_path,
    "STATION_HOST_SOCKET_PATH": os.path.join(temp_root, "missing-host.sock"),
    "STATION_LAYOUT_PATH": layout_path,
    "STATION_SOURCE": "mock",
    "STATION_PTY_IMPL": "bun-nocctty",
    "STATION_SINGLETON_E2E_SHELL_LOG": shell_log,
    "SHELL": shell_path,
    "TERM": "xterm-256color",
})

def process_identity(pid):
    result = subprocess.run(
        ["ps", "-ww", "-p", str(pid), "-o", "lstart=,command="],
        text=True,
        capture_output=True,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else None

def spawn_owned(command, extra_env=None):
    env = base_env.copy()
    if extra_env:
        env.update(extra_env)
    process = subprocess.Popen(
        command,
        cwd=station_root,
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        preexec_fn=lambda: signal.signal(signal.SIGHUP, signal.SIG_DFL),
    )
    time.sleep(0.03)
    records.append((process, process_identity(process.pid)))
    return process

def read_output(duration=0.1):
    deadline = time.monotonic() + duration
    output = bytearray()
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], min(0.05, deadline - time.monotonic()))
        if not readable:
            continue
        try:
            chunk = os.read(master, 65536)
            output.extend(chunk)
            all_output.extend(chunk)
            if len(all_output) > 8192:
                del all_output[:-8192]
            answer_terminal_queries(chunk)
        except BlockingIOError:
            pass
        except OSError:
            break
    return bytes(output)

def answer_terminal_queries(chunk):
    query_transcript.extend(chunk)
    replies = {
        b"\x1b]10;?\x07": b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
        b"\x1b]11;?\x07": b"\x1b]11;rgb:0000/0000/0000\x1b\\",
        b"\x1b[6n": b"\x1b[1;1R",
        b"\x1b[?u": b"\x1b[?0u",
        b"\x1b[14t": b"\x1b[4;800;1120t",
        b"\x1b[16t": b"\x1b[6;20;10t",
        b"\x1b[c": b"\x1b[?1;2c",
        b"\x1b]1337;Capabilities\x1b\\": b"\x1b]1337;Capabilities=\x07",
        b"i=31337,s=1,v=1,a=q": b"\x1b_Gi=31337;OK\x1b\\",
    }
    for query, reply in replies.items():
        count = query_transcript.count(query)
        previous = query_counts.get(query, 0)
        for _ in range(count - previous):
            os.write(master, reply)
        query_counts[query] = count
    for match in re.finditer(br"\x1b\[\?(\d+)\$p", query_transcript):
        mode = match.group(1)
        if mode in answered_modes:
            continue
        answered_modes.add(mode)
        os.write(master, b"\x1b[?" + mode + b";0$y")

def wait_for_output(process, minimum=100, timeout=6):
    deadline = time.monotonic() + timeout
    output = bytearray()
    while len(output) < minimum and time.monotonic() < deadline:
        output.extend(read_output(0.1))
        if process.poll() is not None:
            raise AssertionError("renderer exited before raw-mode output: " + output.decode("utf-8", "replace"))
    if len(output) < minimum:
        raise AssertionError("renderer produced no raw-mode output")
    return bytes(output)

def wait_for_exit(process, timeout=6):
    deadline = time.monotonic() + timeout
    while process.poll() is None and time.monotonic() < deadline:
        read_output(0.05)
    if process.poll() is None:
        raise AssertionError("process did not exit within takeover budget: " + repr(all_output[-4000:]))
    return process.returncode

def wait_for_file(path, timeout=5):
    deadline = time.monotonic() + timeout
    while not os.path.exists(path) and time.monotonic() < deadline:
        read_output(0.05)
    if not os.path.exists(path):
        raise AssertionError("timed out waiting for " + path)

def shell_events():
    if not os.path.exists(shell_log):
        return []
    with open(shell_log, encoding="utf-8") as file:
        return [json.loads(line) for line in file if line.strip()]

def wait_for_shell_starts(count, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        starts = [event for event in shell_events() if event["type"] == "start"]
        if len(starts) >= count:
            return starts
        read_output(0.05)
    raise AssertionError("shell fixture did not start")

def wait_for_input(timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        inputs = [event for event in shell_events() if event["type"] == "input"]
        if inputs:
            return inputs
        read_output(0.05)
    raise AssertionError("successor did not route the CSI-u key")

def output_until_refusal(process, timeout=5):
    output = bytearray()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        output.extend(read_output(0.1))
        decoded = output.decode("utf-8", "replace")
        if refusal_code(decoded) is not None:
            return decoded
        if process.poll() is not None:
            break
    raise AssertionError("renderer did not report an ownership refusal: " + repr(output[-2000:]))

def process_exists(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False

def terminate_recorded(process, recorded):
    if process.poll() is not None:
        return
    current = process_identity(process.pid)
    if recorded is None or current != recorded:
        raise AssertionError("fixture identity changed before cleanup")
    process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        current = process_identity(process.pid)
        if current != recorded:
            raise AssertionError("fixture identity changed before forced cleanup")
        process.kill()
        process.wait(timeout=2)

def refusal_code(output):
    for code in [
        "TUI_TTY_LEGACY_OWNER_POSSIBLE",
        "TUI_TTY_TAKEOVER_TIMEOUT",
        "TUI_TTY_TAKEOVER_REFUSED",
        "TUI_TTY_OWNERSHIP_UNAVAILABLE",
    ]:
        if code in output:
            return code
    return None

result = None
try:
    if scenario == "takeover":
        incumbent = spawn_owned(station_command)
        wait_for_output(incumbent)
        try:
            wait_for_shell_starts(1)
        except AssertionError as error:
            raise AssertionError(str(error) + ": replies=" + repr(query_counts) + " output=" + repr(all_output[-4000:]))
        read_output(0.2)
        successor = spawn_owned(station_command)
        incumbent_exit = wait_for_exit(incumbent)
        wait_for_output(successor)
        starts = wait_for_shell_starts(2)
        os.write(master, b"\x1b[13;2u")
        inputs = wait_for_input()
        first_pid = starts[0]["pid"]
        successor_pid = starts[-1]["pid"]
        result = {
            "incumbentExitCode": incumbent_exit,
            "successorAliveAfterTakeover": successor.poll() is None,
            "inputOwner": "successor" if all(event["pid"] == successor_pid for event in inputs) and successor_pid != first_pid else "ambiguous",
            "inputEvents": len(inputs),
        }
    elif scenario == "legacy":
        unrelated_dir = os.path.join(temp_root, "unrelated", "src")
        os.makedirs(unrelated_dir, exist_ok=True)
        unrelated_path = os.path.join(unrelated_dir, "main.tsx")
        with open(unrelated_path, "w", encoding="utf-8") as file:
            file.write("setInterval(() => {}, 1000);\n")
        unrelated = spawn_owned([station_command[0], unrelated_path])
        station = spawn_owned(station_command)
        output = output_until_refusal(station)
        result = {
            "refusalCode": refusal_code(output),
            "fixturePreserved": unrelated.poll() is None,
        }
    elif scenario == "timeout":
        handled_path = os.path.join(temp_root, "handled")
        ready_path = os.path.join(temp_root, "ready")
        owner_path = os.path.join(temp_root, "ignoring-owner.ts")
        single_instance = os.path.join(station_root, "src", "singleInstance.ts")
        with open(owner_path, "w", encoding="utf-8") as file:
            file.write(f'''import {{ acquireStationTtyOwnership }} from {json.dumps(single_instance)};
import {{ appendFileSync, writeFileSync }} from "node:fs";
const result = await acquireStationTtyOwnership();
if (result.kind !== "owned") throw new Error(JSON.stringify(result));
result.ownership.setTakeoverHandler(() => appendFileSync({json.dumps(handled_path)}, "1"));
writeFileSync({json.dumps(ready_path)}, "1");
setInterval(() => {{}}, 1000);
''')
        owner = spawn_owned([station_command[0], owner_path])
        wait_for_file(ready_path)
        station = spawn_owned(station_command)
        output = output_until_refusal(station, 6)
        result = {
            "refusalCode": refusal_code(output),
            "fixturePreserved": owner.poll() is None,
            "takeoverRequests": len(open(handled_path).read()) if os.path.exists(handled_path) else 0,
        }
    elif scenario == "concurrent":
        first = spawn_owned(station_command)
        second = spawn_owned(station_command)
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline and first.poll() is None and second.poll() is None:
            read_output(0.1)
        read_output(0.3)
        shell_pids = {event["pid"] for event in shell_events() if event["type"] == "start"}
        result = {"rawModeOwners": sum(process_exists(pid) for pid in shell_pids)}
    else:
        raise AssertionError("unknown scenario: " + scenario)
finally:
    try:
        os.write(master, b"\x11")
    except OSError:
        pass
    time.sleep(0.3)
    for process, identity in reversed(records):
        terminate_recorded(process, identity)
    os.close(master)
    os.close(slave)
    for path in rendezvous_artifacts:
        if path in preexisting_artifacts or not os.path.lexists(path):
            continue
        metadata = os.lstat(path)
        if metadata.st_uid != os.geteuid() or not (stat.S_ISREG(metadata.st_mode) or stat.S_ISSOCK(metadata.st_mode)):
            raise AssertionError("refusing unsafe rendezvous cleanup: " + path)
        os.unlink(path)

print(json.dumps(result))
`;
