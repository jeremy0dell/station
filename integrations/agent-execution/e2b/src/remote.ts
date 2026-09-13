import { z } from "zod";
import { shellQuote } from "./source.js";
import type { ExecutionRecord } from "./state.js";

export const ROOT = "/home/user/.station-execution";
export const CONFIG = `${ROOT}/config.toml`;
export const REMOTE_ENV = {
  PATH: `${ROOT}/bin:/usr/local/bin:/usr/bin:/bin`,
  LANG: "C.UTF-8",
  STATION_CONFIG_PATH: CONFIG,
};
export const RuntimeSessionSchema = z
  .object({
    sessionId: z.string().min(1),
    path: z.string().startsWith(`${ROOT}/worktrees/`),
    harness: z.object({ provider: z.string() }).passthrough(),
  })
  .passthrough();

// These public release artifacts are pinned independently of the local executable architecture.
export const installRuntime = `set -eu
mkdir -p '${ROOT}/bin' '${ROOT}/source' '${ROOT}/worktrees'
if ! command -v tmux >/dev/null || ! command -v lsof >/dev/null; then sudo apt-get update -qq && sudo apt-get install -y -qq tmux lsof; fi
if ! test -x '${ROOT}/bin/stn'; then
  curl --fail --silent --show-error --location 'https://github.com/jeremy0dell/station/releases/download/v0.0.0-pre-alpha.14.8/stn-v0.0.0-pre-alpha.14.8-linux-x64.tar.gz' -o '${ROOT}/stn.tar.gz'
  echo '3f7dd96b3d6885bf433a79df25b729f87c00bf23d96e1029a76d9924af726888  ${ROOT}/stn.tar.gz' | sha256sum -c -
  tar -xzf '${ROOT}/stn.tar.gz' -C '${ROOT}/bin'
  curl --fail --silent --show-error --location 'https://github.com/max-sixty/worktrunk/releases/download/v0.64.0/worktrunk-x86_64-unknown-linux-musl.tar.xz' -o '${ROOT}/wt.tar.xz'
  echo 'f5dda9b8139289eeb159e710e08ccf58495d385016fd94a0b4fe3212e13936af  ${ROOT}/wt.tar.xz' | sha256sum -c -
  tar -xJf '${ROOT}/wt.tar.xz' -C '${ROOT}/bin' --strip-components=1
fi
command -v git
'${ROOT}/bin/stn' --version
'${ROOT}/bin/wt' --version
tmux -S '${ROOT}/tmux.sock' new-session -d -s station-cloud -n control
`;

export type RemoteHarnessSettings = {
  profile?: string | undefined;
  permissionMode?: "standard" | "yolo" | "auto" | undefined;
  approvalPolicy?: string | undefined;
  sandboxMode?: string | undefined;
};

export function runtimeConfig(harness: string, settings: RemoteHarnessSettings = {}): string {
  const fields = {
    profile: settings.profile,
    permission_mode: settings.permissionMode,
    approval_policy: settings.approvalPolicy,
    sandbox_mode: settings.sandboxMode,
  };
  const configured = Object.entries(fields)
    .flatMap(([key, value]) => (value === undefined ? [] : [`${key} = ${JSON.stringify(value)}`]))
    .join("\n");
  return `schema_version = 1
[observer]
state_dir = "${ROOT}/state"
socket_path = "${ROOT}/observer.sock"
[defaults]
worktree_provider = "worktrunk"
terminal = "tmux"
harness = ${JSON.stringify(harness)}
layout = "agent-only"
[worktree.worktrunk]
managed_root = "${ROOT}/worktrees"
use_lifecycle_hooks = false
hook_mode = "disabled"
[terminal.tmux]
workbench_socket_path = "${ROOT}/tmux.sock"
workbench_session = "station-cloud"
[harness.${harness}]
command = ${JSON.stringify(harness)}
enabled = true
install_hooks = true
${configured}
[repository.github]
enabled = false
[[projects]]
id = "cloud"
label = "Cloud"
root = "${ROOT}/source"
`;
}

export function materializeSource(record: ExecutionRecord): string {
  return `set -eu
test ! -e '${ROOT}/source/.git'
tar -xf '${ROOT}/source.tar' -C '${ROOT}/source' --no-same-owner
cd '${ROOT}/source'
git init -q -b main
git -c core.hooksPath=/dev/null add -f -A
test "$(git write-tree)" = ${shellQuote(record.baseTree)}
git -c core.hooksPath=/dev/null -c user.name=Station -c user.email=station@localhost commit -q -m 'Cloud source'
`;
}

export function collectScript(record: ExecutionRecord, nonce: string): string {
  if (record.remotePath === undefined) throw new Error("Remote worktree is unavailable.");
  return `set -eu
cd ${shellQuote(record.remotePath)}
export GIT_INDEX_FILE='${ROOT}/index-${nonce}'
trap 'rm -f "$GIT_INDEX_FILE"' EXIT
git read-tree HEAD
git -c core.hooksPath=/dev/null add -A
tree=$(git write-tree)
git -c core.hooksPath=/dev/null diff --binary --full-index --no-ext-diff --no-textconv ${shellQuote(record.baseTree)} "$tree" > '${ROOT}/result-${nonce}.patch'
wc -c < '${ROOT}/result-${nonce}.patch'
printf '%s\\n' "$tree"
sha256sum '${ROOT}/result-${nonce}.patch'
`;
}
