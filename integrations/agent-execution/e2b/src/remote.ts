import { SafeErrorSchema } from "@station/contracts";
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

export const RemoteLaunchResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("succeeded"),
      command: z
        .object({
          status: z.literal("succeeded"),
          result: z.object({ sessionId: z.string().min(1) }).passthrough(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      status: z.literal("failed"),
      command: z.object({ status: z.literal("failed"), error: SafeErrorSchema }).passthrough(),
    })
    .passthrough(),
  z
    .object({
      status: z.literal("rejected"),
      receipt: z.object({ accepted: z.literal(false), error: SafeErrorSchema }).passthrough(),
    })
    .passthrough(),
]);

export function installRuntime(sha256: string): string {
  return `set -eu
mkdir -p '${ROOT}/bin' '${ROOT}/source' '${ROOT}/worktrees'
echo '${sha256}  ${ROOT}/stn.tar.gz' | sha256sum -c -
tar -xzf '${ROOT}/stn.tar.gz' -C '${ROOT}/bin'
if ! command -v lsof >/dev/null; then sudo apt-get update -qq && sudo apt-get install -y -qq lsof; fi
curl --fail --silent --show-error --location 'https://github.com/max-sixty/worktrunk/releases/download/v0.64.0/worktrunk-x86_64-unknown-linux-musl.tar.xz' -o '${ROOT}/wt.tar.xz'
echo 'f5dda9b8139289eeb159e710e08ccf58495d385016fd94a0b4fe3212e13936af  ${ROOT}/wt.tar.xz' | sha256sum -c -
tar -xJf '${ROOT}/wt.tar.xz' -C '${ROOT}/bin' --strip-components=1
command -v git
'${ROOT}/bin/stn' --version
'${ROOT}/bin/wt' --version
`;
}

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
terminal = "native"
harness = ${JSON.stringify(harness)}
layout = "agent-only"
[worktree.worktrunk]
managed_root = "${ROOT}/worktrees"
use_lifecycle_hooks = false
hook_mode = "disabled"
[feature_flags]
station_persistent_agents = true
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
