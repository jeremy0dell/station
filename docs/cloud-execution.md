# Cloud agents from local Station

Station can run an agent in E2B while its dashboard, terminal, session identity,
and Git worktree remain on your Mac. Choose **Execution: e2b** in New Session,
or pass `--execution e2b` to `stn session create`.

## Setup

Add an execution provider to your global Station config. The Observer process
must inherit `E2B_API_KEY`; agent credentials use separate, explicit environment
references. Restart your development Observer after changing its environment.

```toml
[execution.e2b]
template = "base"
timeout_minutes = 60
max_sandboxes = 1
setup_command = "sudo npm install --global @anthropic-ai/claude-code"

[execution.e2b.harness_env.claude]
ANTHROPIC_API_KEY = "STATION_CLOUD_ANTHROPIC_API_KEY"
```

For Codex with an OpenAI API key, use this setup instead:

```toml
[execution.e2b]
template = "base"
timeout_minutes = 60
max_sandboxes = 1
setup_command = "sudo npm install --global @openai/codex && printenv OPENAI_API_KEY | codex login --with-api-key"

[execution.e2b.harness_env.codex]
OPENAI_API_KEY = "STATION_CLOUD_OPENAI_API_KEY"
```

Set `STATION_CLOUD_OPENAI_API_KEY` in the Observer environment. Station passes
only the selected integration's explicit credential references to the trusted
setup command and remote launch. The E2B key does not authenticate Codex.
Codex must pass `codex login status` before remote Station can launch it.
ChatGPT subscription authentication requires a separate login in the template;
Station does not copy the Mac's login cache. See
[Codex authentication](https://developers.openai.com/codex/auth).

Select a configured Station agent integration, such as `claude` or `codex`. The template or
`setup_command` must install its executable on `PATH`. `setup_command` is trusted
configuration and runs once before project source is uploaded. A custom E2B
Linux x64 template can preinstall dependencies to reduce startup time. Station
installs checksum-pinned Linux Station and Worktrunk releases plus tmux and lsof.

The compute key selects the E2B account; the key ID is not required. Agent login
homes and local project environment files are not copied. Station carries the selected agent's permission, approval, sandbox, and profile
settings into the cloud runtime. Named agent profiles must already exist inside
the template. Cloud startup has a ten-minute client
wait budget; the configured sandbox deadline still applies.

## Create and use a session

```sh
stn session create my-project --branch cloud-task --harness claude --terminal tmux --execution e2b
stn session list
stn session get <sessionId>
```

New Session uses the same execution selector in the native dashboard and tmux
popup. `E` cycles Local/e2b. Cloud dashboard titles have an `[e2b]` prefix.
Session details show execution state, expiry, and the most recent collected
result directory. A disconnected cloud session reports unknown agent status;
disconnection does not prove that the agent exited.
If remote Station rejects an unavailable agent, session details retain the
specific error code, such as `HARNESS_CODEX_UNAVAILABLE`, and setup instructions
across Observer restarts. Reopening the session reports that failure instead of
starting another agent.

The primary agent terminal connects to remote tmux. Input and resize reach the
existing remote agent. Closing the local terminal detaches it; the sandbox
continues running until stopped or expired. Reopen the session to reconnect.
If a disconnected bridge remains visible, close its local terminal first:

```sh
stn session close <sessionId> --mode terminal
```

Ordinary shell splits run in the Mac worktree. They do not show cloud edits.
Cloud sessions cannot switch execution provider, start a replacement agent, or
fork directly. Collect their changes before creating a new session.

## Retrieve and finish work

```sh
stn session collect <sessionId>
stn session close <sessionId> --mode all --force
```

Collection writes `changes.patch` and `manifest.json` into a private directory
under `<observer.state_dir>/execution-results/<sessionId>/`. It never applies
changes to the local worktree. The manifest records the source commit, source
and result Git trees, patch size, and SHA-256 checksum. Review the patch, then
use `git apply --check` and `git apply` in the intended local checkout.

Closing all resources stops the agent, retrieves and verifies a final patch,
and deletes the sandbox. Station confirms that both running and paused sandbox
inventories are empty for that execution before ending the local session.
The final result remains in the directory above after the session disappears.
`--mode harness` stops the agent and retains the sandbox for collection.

E2B kills the sandbox at its deadline. Collect before expiry; unsaved remote
changes can be lost. If collection fails, Station retains the session and
refuses destructive cleanup. To explicitly abandon results, including after an
expired sandbox, use:

```sh
stn session close <sessionId> --mode all --force --discard-results
```

`--force` alone does not discard cloud results. A lost sandbox-create response
retains the attempt until its exact identity is found or its deadline passes;
Station never silently creates a replacement. The configured capacity counts
these unresolved attempts. Restore missing provider configuration to clean up
its retained sessions.

## Source and terminal limits

Station uploads the committed Git tree of the new local worktree. It excludes
Git history, local Git configuration, and uncommitted, untracked, or ignored
working files. Commit needed files before creating the session. Tracked secrets
are source files and are uploaded. Submodules are rejected. Source archives and
result patches each have a 64 MiB limit.

Collection includes tracked changes and nonignored new files, including binary
files. It exports their final contents, not the agent's commit history. Remote
terminal continuity comes from the original tmux session and its bounded
scrollback. Pause/resume, remote shell splits, automatic patch application, and
coding-agent authentication setup are outside this execution provider.
