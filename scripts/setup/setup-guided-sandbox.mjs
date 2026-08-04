#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = join(repoRoot, "apps", "cli", "dist", "main.js");
const sandboxPrefix = "stn-setup-sandbox-";
const profiles = new Set(["first-run", "multi", "missing-tools", "everything-missing"]);

const options = parseOptions(process.argv.slice(2));
if (options.help) {
  printHelp();
} else {
  await main(options);
}

async function main(options) {
  if (!options.prepareOnly && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("The guided setup sandbox requires terminal stdin and stdout.");
  }
  if (!options.skipBuild) buildCheckout();

  const sandbox = await createSandbox(options.profile);
  const retained = options.keep || options.prepareOnly;
  printSandboxSummary(sandbox, options.profile, retained);

  if (options.prepareOnly) return;

  let exitCode = 1;
  try {
    exitCode = await runInteractive(sandbox.runPath);
  } finally {
    if (retained) {
      process.stdout.write(`\nSandbox retained: ${sandbox.root}\n`);
    } else {
      await removeSandbox(sandbox.root);
      process.stdout.write("\nSandbox removed.\n");
    }
  }
  process.exitCode = exitCode;
}

function parseOptions(arguments_) {
  let profile = "first-run";
  let help = false;
  let keep = false;
  let prepareOnly = false;
  let skipBuild = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    switch (argument) {
      case "--":
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      case "--keep":
        keep = true;
        break;
      case "--prepare-only":
        prepareOnly = true;
        break;
      case "--skip-build":
        skipBuild = true;
        break;
      case "--profile": {
        const candidate = arguments_[index + 1];
        if (candidate === undefined || !profiles.has(candidate)) {
          throw new Error(`--profile must be one of: ${[...profiles].join(", ")}`);
        }
        profile = candidate;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown setup sandbox option: ${argument}`);
    }
  }

  return { help, keep, prepareOnly, profile, skipBuild };
}

function printHelp() {
  process.stdout.write(`Usage: pnpm setup:guided:sandbox -- [options]

Run the real guided setup UI inside a disposable, manually interactive environment.

Options:
  --profile <name>  first-run (default), multi, missing-tools, or everything-missing
  --keep            retain the sandbox, shims, logs, and rerunnable launcher
  --prepare-only    prepare and retain the sandbox without launching setup
  --skip-build      use the current build instead of running pnpm build first
  -h, --help        show this help

Profiles:
  first-run          required tools available; no agent CLI installed
  multi              required tools plus Codex and OpenCode available
  missing-tools      required tools absent; Codex and OpenCode available
  everything-missing required tools and agent CLIs absent
`);
}

function buildCheckout() {
  const result = spawnSync("pnpm", ["build"], { cwd: repoRoot, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm build exited ${String(result.status)}`);
}

async function createSandbox(profile) {
  const root = await mkdtemp(join(tmpdir(), sandboxPrefix));
  await chmod(root, 0o700);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const runtime = join(root, "runtime");
  const state = join(root, "state");
  const temp = join(root, "tmp");
  const logPath = join(root, "external-commands.log");
  const helperPath = join(bin, ".sandbox-command");
  const configPath = join(home, ".config", "station", "config.toml");
  const runPath = join(root, "run-setup");

  await Promise.all(
    [
      home,
      bin,
      repo,
      runtime,
      state,
      temp,
      join(home, ".cache"),
      join(home, ".config"),
      join(home, ".local", "bin"),
      join(home, ".local", "share"),
      join(home, ".codex"),
      join(home, ".claude"),
      join(home, ".cursor"),
      join(home, ".opencode"),
    ].map((path) => mkdir(path, { recursive: true })),
  );
  await writeFile(join(home, ".zshrc"), "# setup sandbox zshrc\n", "utf8");
  await writeFile(logPath, "", "utf8");

  const gitPath = commandPath("git");
  initializeRepository(repo, home, gitPath);
  await writeSandboxCommand(helperPath, logPath);
  await writeGitShim(bin, gitPath, logPath);
  await writeBrewShim(bin, helperPath, logPath);
  await writeCurlShim(bin, logPath);
  await writeNpmShim(bin, helperPath, logPath);
  await writePnpmShim(bin, logPath);
  await writeXcodeSelectShim(bin, logPath);
  await writeFailureShim(bin, "gh", logPath);

  if (profile === "first-run" || profile === "multi") {
    await installCommands(bin, helperPath, ["wt", "tmux", "hunk", "bun"]);
  }
  if (profile === "multi" || profile === "missing-tools") {
    await installCommands(bin, helperPath, ["codex", "opencode"]);
  }

  await writeRunScript({
    bin,
    cliPath,
    configPath,
    helperPath,
    home,
    logPath,
    repo,
    root,
    runPath,
    runtime,
    state,
    temp,
  });

  return { bin, configPath, home, logPath, root, runPath };
}

function commandPath(command) {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  const path = result.stdout.trim();
  if (result.status !== 0 || !path.startsWith("/")) {
    throw new Error(`Required sandbox host command is unavailable: ${command}`);
  }
  return path;
}

function initializeRepository(repo, home, gitPath) {
  const env = {
    HOME: home,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  runChecked(gitPath, ["init", "-q", "-b", "main", repo], { env });
  spawnSync("/bin/sh", ["-c", 'printf "# Setup sandbox\\n" > README.md'], {
    cwd: repo,
    env,
  });
  runChecked(gitPath, ["add", "README.md"], { cwd: repo, env });
  runChecked(
    gitPath,
    [
      "-c",
      "user.name=Station Setup Sandbox",
      "-c",
      "user.email=setup-sandbox@example.invalid",
      "commit",
      "-q",
      "-m",
      "Initialize setup sandbox",
    ],
    { cwd: repo, env },
  );
}

function runChecked(command, arguments_, options) {
  const result = spawnSync(command, arguments_, { ...options, stdio: "pipe" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} exited ${String(result.status)}`);
  }
}

async function writeSandboxCommand(path, logPath) {
  await writeExecutable(
    path,
    `${logInvocation(logPath)}
name="\${0##*/}"
case "$name" in
  wt)
    if [ "\${1:-}" = "--version" ]; then echo "worktrunk 1.2.3"; exit 0; fi
    if [ "\${1:-} \${2:-} \${3:-} \${4:-}" = "-y config shell install" ]; then
      shell_name="\${5:-\${6:-}}"
      case "$shell_name" in zsh) rc="$HOME/.zshrc" ;; bash) rc="$HOME/.bashrc" ;; *) exit 2 ;; esac
      if printf '%s\\n' "$@" | grep -F -- "--dry-run" >/dev/null 2>&1; then
        grep -F "# station setup sandbox worktrunk" "$rc" >/dev/null 2>&1 || echo "shell integration update pending"
        exit 0
      fi
      test -f "$rc" || { echo "No shell config file found" >&2; exit 1; }
      grep -F "# station setup sandbox worktrunk" "$rc" >/dev/null 2>&1 || printf '\\n# station setup sandbox worktrunk\\n' >> "$rc"
      echo "sandbox shell integration installed"
      exit 0
    fi
    exit 0
    ;;
  tmux)
    if [ "\${1:-}" = "-V" ]; then echo "tmux 3.5a"; fi
    exit 0
    ;;
  codex) [ "\${1:-}" = "--version" ] && echo "codex 0.1.0"; exit 0 ;;
  claude) [ "\${1:-}" = "--version" ] && echo "claude 1.0.0"; exit 0 ;;
  agent) [ "\${1:-}" = "--version" ] && echo "cursor-agent 1.0.0"; exit 0 ;;
  opencode) [ "\${1:-}" = "--version" ] && echo "opencode 1.0.0"; exit 0 ;;
  pi) [ "\${1:-}" = "--version" ] && echo "pi 0.80.10"; exit 0 ;;
  bun) [ "\${1:-}" = "--version" ] && echo "1.3.14"; exit 0 ;;
  hunk) [ "\${1:-}" = "--version" ] && echo "hunk 0.17.7"; exit 0 ;;
  stn|stn-ingress|stn-tmux-popup) exit 0 ;;
  *) echo "unsupported sandbox command: $name" >&2; exit 2 ;;
esac
`,
  );
}

async function writeGitShim(bin, gitPath, logPath) {
  await writeExecutable(
    join(bin, "git"),
    `${logInvocation(logPath)}
exec ${shellQuote(gitPath)} "$@"
`,
  );
}

async function writeBrewShim(bin, helperPath, logPath) {
  await writeExecutable(
    join(bin, "brew"),
    `${logInvocation(logPath)}
if [ "\${1:-}" = "--version" ]; then echo "Homebrew 4.0.0"; exit 0; fi
if [ "\${1:-}" != "install" ]; then exit 2; fi
case " $* " in
  *homebrew/cask/codex*) command_name=codex ;;
  *homebrew/cask/claude-code*) command_name=claude ;;
  *homebrew/core/opencode*) command_name=opencode ;;
  *homebrew/core/pi-coding-agent*) command_name=pi ;;
  *worktrunk*) command_name=wt ;;
  *hunk*) command_name=hunk ;;
  *tmux*) command_name=tmux ;;
  *bun*) command_name=bun ;;
  *) echo "unsupported sandbox brew package: $*" >&2; exit 2 ;;
esac
ln -sf ${shellQuote(helperPath)} "$STATION_SETUP_SANDBOX_BIN/$command_name"
echo "sandbox brew installed $command_name"
`,
  );
}

async function writeCurlShim(bin, logPath) {
  await writeExecutable(
    join(bin, "curl"),
    `${logInvocation(logPath)}
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
test -n "$output"
case "$url" in
  *cursor.com*) target="$STATION_CURSOR_AGENT_BIN" ;;
  *chatgpt.com*) target="$STATION_CODEX_BIN" ;;
  *opencode.ai*) target="$HOME/.opencode/bin/opencode" ;;
  *) echo "sandbox blocked unexpected download: $url" >&2; exit 2 ;;
esac
cat > "$output" <<INSTALL
#!/bin/sh
set -eu
mkdir -p "$(dirname "$target")"
ln -sf "$STATION_SETUP_SANDBOX_HELPER" "$target"
echo "sandbox installer created $target"
INSTALL
chmod 700 "$output"
`,
  );
}

async function writeNpmShim(bin, helperPath, logPath) {
  await writeExecutable(
    join(bin, "npm"),
    `${logInvocation(logPath)}
case " $* " in
  *@anthropic-ai/claude-code*) target="$STATION_CLAUDE_BIN" ;;
  *@earendil-works/pi-coding-agent*) target="$STATION_PI_BIN" ;;
  *) echo "sandbox blocked unexpected npm command: $*" >&2; exit 2 ;;
esac
mkdir -p "$(dirname "$target")"
ln -sf ${shellQuote(helperPath)} "$target"
echo "sandbox npm installed \${target##*/}"
`,
  );
}

async function writePnpmShim(bin, logPath) {
  await writeExecutable(
    join(bin, "pnpm"),
    `${logInvocation(logPath)}
case " $* " in
  *station:link*)
    ln -sf ${shellQuote(join(repoRoot, "bin", "stn"))} "$STATION_SETUP_SANDBOX_BIN/stn"
    ln -sf ${shellQuote(join(repoRoot, "bin", "stn-ingress"))} "$STATION_SETUP_SANDBOX_BIN/stn-ingress"
    ln -sf ${shellQuote(join(repoRoot, "integrations", "terminal", "tmux", "bin", "stn-popup"))} "$STATION_SETUP_SANDBOX_BIN/stn-tmux-popup"
    echo "sandbox launchers linked"
    ;;
  *) echo "sandbox blocked unexpected pnpm command: $*" >&2; exit 2 ;;
esac
`,
  );
}

async function writeXcodeSelectShim(bin, logPath) {
  await writeExecutable(
    join(bin, "xcode-select"),
    `${logInvocation(logPath)}
case "\${1:-}" in
  -p|--print-path) echo "/sandbox/CommandLineTools" ;;
  --install) echo "sandbox Command Line Tools install requested" ;;
  *) exit 2 ;;
esac
`,
  );
}

async function writeFailureShim(bin, name, logPath) {
  await writeExecutable(
    join(bin, name),
    `${logInvocation(logPath)}
echo "sandbox blocked $0 $*" >&2
exit 2
`,
  );
}

async function installCommands(bin, helperPath, names) {
  await Promise.all(names.map((name) => symlink(helperPath, join(bin, name))));
}

async function writeRunScript(paths) {
  const environment = {
    HOME: paths.home,
    PATH: `${paths.bin}:${join(paths.home, ".local", "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: paths.temp,
    XDG_CACHE_HOME: join(paths.home, ".cache"),
    XDG_CONFIG_HOME: join(paths.home, ".config"),
    XDG_DATA_HOME: join(paths.home, ".local", "share"),
    XDG_RUNTIME_DIR: paths.runtime,
    XDG_STATE_HOME: paths.state,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    SHELL: "/bin/zsh",
    TERM: process.env.TERM ?? "xterm-256color",
    COLORTERM: process.env.COLORTERM ?? "truecolor",
    STATION_CONFIG_PATH: paths.configPath,
    STATION_OBSERVER_SOCKET_PATH: join(paths.runtime, "station", "observer.sock"),
    STATION_WORKTRUNK_BIN: join(paths.bin, "wt"),
    STATION_TMUX_BIN: join(paths.bin, "tmux"),
    STATION_CODEX_BIN: join(paths.bin, "codex"),
    STATION_CLAUDE_BIN: join(paths.bin, "claude"),
    STATION_CURSOR_AGENT_BIN: join(paths.bin, "agent"),
    STATION_OPENCODE_BIN: join(paths.bin, "opencode"),
    STATION_PI_BIN: join(paths.bin, "pi"),
    CODEX_HOME: join(paths.home, ".codex"),
    CLAUDE_CONFIG_DIR: join(paths.home, ".claude"),
    STATION_CURSOR_HOME: join(paths.home, ".cursor"),
    STATION_CURSOR_HOOKS_PATH: join(paths.home, ".cursor", "hooks.json"),
    OPENCODE_CONFIG_DIR: join(paths.home, ".opencode"),
    STATION_SETUP_SANDBOX_ROOT: paths.root,
    STATION_SETUP_SANDBOX_BIN: paths.bin,
    STATION_SETUP_SANDBOX_HELPER: paths.helperPath,
    STATION_SETUP_SANDBOX_LOG: paths.logPath,
  };
  const assignments = Object.entries(environment)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" \\\n  ");
  await writeExecutable(
    paths.runPath,
    `cleanup() {
  env -i \\
  ${assignments} \\
  ${shellQuote(process.execPath)} ${shellQuote(paths.cliPath)} --config ${shellQuote(paths.configPath)} observer stop --timeout-ms 3000 >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP TERM
cd ${shellQuote(paths.repo)}
env -i \\
  ${assignments} \\
  ${shellQuote(process.execPath)} ${shellQuote(paths.cliPath)} --config ${shellQuote(paths.configPath)} setup
`,
  );
}

function logInvocation(logPath) {
  return `invocation="$0"
for argument in "$@"; do invocation="$invocation <$argument>"; done
printf '%s\\n' "$invocation" >> ${shellQuote(logPath)}`;
}

async function writeExecutable(path, body) {
  await writeFile(path, `#!/bin/sh\nset -eu\n${body}`, { encoding: "utf8", mode: 0o700 });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function runInteractive(runPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(runPath, [], { stdio: "inherit" });
    const forwardedSignals = ["SIGHUP", "SIGINT", "SIGTERM"];
    const handlers = new Map(
      forwardedSignals.map((signal) => [
        signal,
        () => {
          // Keep the sandbox owner alive long enough to stop its Observer and remove disposable state.
          child.kill(signal);
        },
      ]),
    );
    for (const [signal, handler] of handlers) process.on(signal, handler);

    child.once("error", reject);
    child.once("close", (code, signal) => {
      for (const [handledSignal, handler] of handlers) process.off(handledSignal, handler);
      if (signal !== null) {
        resolve(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function printSandboxSummary(sandbox, profile, retained) {
  process.stdout.write(`
Guided setup sandbox
  profile: ${profile}
  root:    ${sandbox.root}
  home:    ${sandbox.home}
  config:  ${sandbox.configPath}
  shims:   ${sandbox.bin}
  log:     ${sandbox.logPath}
  rerun:   ${sandbox.runPath}

All mutable setup paths and installer commands are redirected into this sandbox.
Resize the terminal, cancel at any prompt, or edit a shim from another terminal.
${retained ? "The sandbox will be retained." : "The sandbox will be removed after setup exits."}

`);
}

async function removeSandbox(root) {
  const expectedParent = tmpdir();
  if (dirname(root) !== expectedParent || !root.split("/").at(-1)?.startsWith(sandboxPrefix)) {
    throw new Error(`Refusing to remove unexpected setup sandbox path: ${root}`);
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
