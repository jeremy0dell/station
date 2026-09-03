# Configuration

Station uses one global TOML file, `~/.config/station/config.toml`, plus an
optional project-local override at `.station/config.toml`. This page is the
field-by-field reference for both files and for user-set environment variables.

The annotated [`examples/config.toml`](../examples/config.toml) is the
copy-paste starting point. [`examples/project-local-config.toml`](../examples/project-local-config.toml)
shows the local file.

## At a glance

| File | Path (default) | What it controls | Read by | Relocate with |
| --- | --- | --- | --- | --- |
| **Runtime config** | `~/.config/station/config.toml` | Projects, defaults, the Observer, providers, hooks, retention, feature flags, and TUI/workspace behavior | Observer, `stn`, and the TUI renderers | `STATION_CONFIG_PATH` or `stn --config <path>` |
| **Project-local config** | `<project.root>/.station/config.toml` | Opt-in per-project harness/layout defaults, additive commands, and display overrides | Config loader | `[projects.local_config]` |

The state directory is adjacent runtime state, not configuration. It contains
the database, logs, diagnostics, hook spool, and runtime paths. Do not edit it
by hand; see [Debugging](debugging.md) and [Diagnostics](diagnostics.md).

## Runtime config (`config.toml`)

The runtime file is parsed as TOML and validated against a strict schema.
`schema_version = 1`, `[defaults]`, and `projects = []` are
required. Unknown top-level or core-section keys fail the load with
`CONFIG_VALIDATION_FAILED`. `[harness.<id>]` accepts arbitrary
provider IDs. `[workspace]` and `[tui]` are best-effort: invalid
values fall back to defaults and produce a diagnostic instead of taking down the
Observer.

### `[observer]` — daemon tuning (optional)

| Key | Type | Notes |
| --- | --- | --- |
| `auto_start` | bool | Auto-start the Observer daemon. |
| `auto_start_from_hooks` | bool | Auto-start when a provider hook fires. |
| `idle_shutdown_minutes` | int > 0 | Shut down after N idle minutes. |
| `reconcile_interval_ms` | int > 0 | Reconcile-loop interval. |
| `socket_path` | string | Observer IPC socket; `~` expands at load time. |
| `state_dir` | string | State, log, and database root; defaults to `~/.local/state/station`. |

### `[defaults]` — global defaults (required)

A project that omits a value inherits the global value.

| Key | Type | Notes |
| --- | --- | --- |
| `worktree_provider` | string | Required non-empty provider ID; common value: `worktrunk`. |
| `terminal` | string | Required non-empty terminal provider ID; common value: `tmux`. |
| `harness` | string | Required non-empty harness provider ID; common value: `codex`. |
| `layout` | string | Required non-empty layout ID. |
| `default_branch` | string (optional) | Protected default branch used by destructive worktree operations. |
| `harness_permission_mode` | `standard or yolo` (optional) | `auto` is valid only under `[harness.claude]`. |

Provider IDs are not cross-checked during config validation. Unknown IDs remain
unavailable at runtime. Meaningful IDs include `worktrunk` and
`noop-worktree`, `tmux` and `noop-terminal`, and
the harness IDs documented in the harness guides.

### `[worktree.worktrunk]` — Worktrunk provider (optional)

| Key | Type | Notes |
| --- | --- | --- |
| `command` | string | Worktrunk executable; overrides `STATION_WORKTRUNK_BIN`, default `wt`. |
| `config_path` | string | Worktrunk config path; `~` expands at load time. |
| `managed_root` | string | Authoritative root for Station-created worktrees; `~` expands at load time. |
| `base` (optional) | string | Default base branch for listings and new worktrees. |
| `include_main` | bool | Include the main worktree in listings by default. |
| `include_external` | bool | Include external worktrees in listings by default. |
| `use_lifecycle_hooks` | bool | `false` uses Worktrunk `--no-hooks`, `true` uses `--yes`, and unset uses Worktrunk defaults. |
| `hook_mode` | `required-for-mvp` or `disabled` | Worktrunk lifecycle-hook expectation. |
| `breadcrumb_location` | `external`, `worktree`, `provider-native`, or `disabled` | Default recovery-breadcrumb location. |

Changing `managed_root` affects future creates only. Existing linked worktrees
remain at their registered paths; do not move or delete one that still owns a
session.

### `[terminal.tmux]` — tmux provider (optional)

Dashboard and CLI session creation use explicit placement requests. See
[TUI development](tui.md) for the placement and renderer contract.

| Key | Type | Notes |
| --- | --- | --- |
| `command` | string | tmux executable; overrides `STATION_TMUX_BIN`, default `tmux`. |
| `session_prefix` | string | Prefix for managed tmux sessions. |
| `topology` | `workbench` | Single-value topology. |
| `workbench_session` | string | Managed tmux workbench session. |
| `workbench_socket_path` | string | Optional fixed tmux socket; `~` and relative paths resolve from the global config directory. |
| `window_naming` | `project-branch` | Single-value window-naming policy. |
| `primary_agent_pane` | bool | Whether the primary agent gets a dedicated pane. |
| `popup_width` / `popup_height` / `popup_position` | string | Popup geometry, such as `50%` or `C`. |
| `popup_status_bar` | bool | Show the persistent popup's nested status bar; default `false`. |
| `popup_scope` | `server` or `client` | Share one popup per tmux server (`server`, default) or create one per client (`client`). |

Popup geometry and status-bar settings are captured by the generated popup
binding; rerun `stn setup` after changing them. Close existing popups
before changing `popup_scope`.

### `[harness.<id>]` — agent harness (optional)

Multiple harness tables may be configured. `[defaults].harness` is the
default; other configured harnesses remain available for explicit selection.

| Key | Type | Notes |
| --- | --- | --- |
| `enabled` | bool | Enable this harness. |
| `command` | string | Harness executable; overrides its `STATION_*_BIN` fallback. |
| `profile` | string | Provider profile passed to the harness. |
| `permission_mode` | `standard` or `yolo` | `auto` is accepted only for Claude. |
| `sandbox_mode` | string | Provider-specific sandbox mode. |
| `approval_policy` | string | Provider-specific approval policy. |
| `install_hooks` | bool | Require Station-owned tracking artifacts for this harness. |
| `resume` | bool | Resume provider sessions when supported. |

Setup requires the effective default harness and any harness explicitly selected
in the current guided run to be runnable. For Claude, Codex, Cursor, and
OpenCode, required tracking artifacts must be prepared when `install_hooks`
is true. Preparation does not prove provider delivery, trust, or authentication;
see [Diagnostics](diagnostics.md) and [Harness authoring](harness-authoring.md).

Harness command fallbacks:

| Harness | Env var | Default command |
| --- | --- | --- |
| Claude Code | `STATION_CLAUDE_BIN` | `claude` |
| Codex | `STATION_CODEX_BIN` | `codex` |
| Cursor Agent | `STATION_CURSOR_AGENT_BIN` | `agent` |
| OpenCode | `STATION_OPENCODE_BIN` | `opencode` |
| Pi | `STATION_PI_BIN` | `pi` |

### `[[hooks.event]]` — Observer event hooks (optional, repeatable)

An Observer event hook runs a command when a `StationEvent` matches. This is
distinct from provider delivery hooks; see [Harness ingress](harness-ingress.md).

| Key | Type | Notes |
| --- | --- | --- |
| `id` | string | Required hook identifier. |
| `events` | string[] (≥1) | Required event types to match. |
| `command` | string | Required command, such as `stn`. |
| `args` | string[] | Command arguments. |
| `timeout_ms` | int > 0 | Hook timeout. |
| `filter` | table | Optional `agent_state`, `harness`, `change_source`, or `harness_event_type` narrowing. |

`events` accepts these current `StationEvent` types:

```text
observer.started
observer.reconciled
project.updated
worktree.added
worktree.updated
worktree.removed
worktree.agentStateChanged
session.created
session.updated
session.removed
sessionGroup.updated
sessionGroup.removed
command.accepted
command.started
command.succeeded
command.failed
provider.healthChanged
providerHook.ingested
harness.eventReported
providerHook.spoolDrained
```

| Filter | Type | Meaning |
| --- | --- | --- |
| `agent_state` | `none`, `starting`, `idle`, `working`, `needs_attention`, `stuck`, `exited`, or `unknown` | Observed agent state on `worktree.agentStateChanged`. |
| `harness` | string | Harness provider ID. |
| `change_source` | `harness_event_report` or `reconcile` | Source of an agent-state change. |
| `harness_event_type` | string | Native harness event type, when present. |

### `[[projects]]` — managed projects (required array)
The array may be empty. Project IDs, aliases, and Worktrunk managed roots must
be unique, and each `root` must exist when the config loads.

| Key | Type | Notes |
| --- | --- | --- |
| `id` | string | Required and unique; `stn project add` derives it from the root basename when omitted. |
| `label` | string | Required display label. |
| `root` | string | Required existing directory; `~` and relative paths resolve from the config directory. |
| `aliases` | string[] | Alternate names, unique across projects. |
| `repo` | string | Optional repository metadata, such as `github.com/org/web`. |
| `default_branch` | string | Inherits `[defaults].default_branch`. |
| `env` | table<string,string> | Project launch environment; not overridable locally. |
| `defaults.harness` / `defaults.terminal` / `defaults.layout` | string | Per-project values override the matching global defaults; `terminal` is not locally overridable. |
| `commands.<label>` | string | Named project command; labels are preserved as authored. |
| `display.group` / `display.sort_order` | string / int | Static project grouping and optional display order. |
| `worktrunk.enabled` | bool | Defaults to `true`. |
| `worktrunk.base` | string | Overrides the global Worktrunk base. |
| `worktrunk.managed_root` | string | Relative paths resolve from `project.root`; omitted global roots get a unique project child. |
| `worktrunk.include_main` / `worktrunk.include_external` | bool | Override the matching global listing policy. |
| `setup.copy_from_project_root` | string[] | Required regular files copied to the same relative paths in each new worktree before launch. |
| `recovery_breadcrumbs.location` | enum | Overrides the global breadcrumb location. |
| `recovery_breadcrumbs.path` | string | Optional breadcrumb path. |
| `local_config.enabled` | bool | Required in the table; only `true` reads the local file. |
| `local_config.path` | string | `~/` expands from `$HOME`; other paths resolve from `project.root`. |

`[projects.display].group` is a static project label. Dynamic Session Groups
are Observer-owned state and are changed by recorded operations, not by either
config file.

A checkout-style project root with local `core.bare=true` is rejected by
`stn project add`; Station does not rewrite that Git setting. Use the
project doctor and [Diagnostics](diagnostics.md) for repair guidance.

Project setup can copy local files that Git does not place in a new worktree:

```toml
[projects.setup]
copy_from_project_root = [".env.local", "config/private.json"]
```

Each entry uses forward-slash relative syntax. Absolute paths, dot path
components, backslashes, duplicate entries, directories, and symbolic links
are rejected. The source must resolve inside `project.root` and exist as a
regular file before Worktrunk creates the worktree. Station copies the files in
the configured order after fork seeding and before agent launch. Missing parent
directories are created inside the worktree. An existing regular destination
is preserved; any other destination type fails setup. A copy failure removes
the exact newly created worktree. A failed removal reports the worktree identity
and requires inspection before retrying.

### `[workspace]` — native Station UI behavior (optional, best-effort)

Only the native Station TUI reads this section. Invalid values fall back to
defaults and produce a diagnostic.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `scroll_on_output` | `freeze`, `shift`, or `follow` | `freeze` | Behavior while scrolled up; all modes track live output at the bottom. |
| `scrollback_lines` | int 0-10000 | `10000` | Normal-buffer history per native pane; changes apply to new screens. |
| `overlay_width_percent` | int 10-100 | `60` | Native overlay width, clamped to available space. |
| `overlay_height_percent` | int 10-100 | `60` | Native overlay height, clamped to available space. |
| `welcome_on_boot` | bool | `true` | Show the welcome screen over the restored layout on cold boot. |
| `automations` | `Automation[]` | built-in `see-diff` | Omit to keep the built-in automation; use `[]` to disable it. |

An `Automation` is `{ id, label, enabled?, steps[] }`. Each step is
`{ command, split?, anchor?, run?, focus? }`; automations are authored as
`[[workspace.automations]]` tables:

```toml
[[workspace.automations]]
id = "triage"
label = "Triage"

  [[workspace.automations.steps]]
  command = "git status"
```

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `command` | string | required | Command to write or execute in the new pane. |
| `split` | `right` or `below` | `right` | Split direction. |
| `anchor` | `origin` or `previous` | `previous` | Pane used as the split anchor. |
| `run` | `execute` or `write` | `execute` | Execute the command or only type it. |
| `focus` | bool | `false` | Focus the new pane. |
| `id` / `label` | string | required | Unique menu key and display label. |
| `enabled` | bool | `true` | Hide the automation when `false`. |
| `steps` | `AutomationStep[]` | required | One or more steps. |

### `[tui]` — shared dashboard behavior and widgets (optional, best-effort)

`[tui]` applies to the native overlay and standalone/fullscreen/tmux
dashboards. `[workspace]` is native-only.

`[tui.session_create]` controls the renderer after dashboard-driven New Session,
Quick Session, or Quick Group creation. Both global values default to `true`;
terminal-specific values inherit omitted global values:

```toml
[tui.session_create]
focus_created_session = true
dismiss_dashboard = true

[tui.session_create.terminals.tmux]
dismiss_dashboard = false
```

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `focus_created_session` | bool | `true` | Focus the exact canonical session created by the operation. |
| `dismiss_dashboard` | bool | `true` | Dismiss after focus succeeds when focus is enabled. |

Terminal keys are provider IDs such as `tmux` and `native`. The policy
resolves when a renderer starts; an open renderer does not live-reload it. An
invalid `[tui]` policy falls back to section defaults and records a warning.

`[tui].widgets` is an ordered array for the shared title strip. Each widget
accepts optional `enabled` (default `true`):

- `time`: optional `time_format` (`12h` or `24h`);
- `weather`: required `city`, with optional `label`, `temperature_unit` (`fahrenheit` or `celsius`), and positive `refresh_interval_minutes`;
- `fleet`: live-agent count from the Observer snapshot;
- `prs`: open-PR count from the snapshot;
- `tz`: one or two `{ label, time_zone }` IANA zones plus optional `time_format`;
- `moon`: current moon phase.

`[tui.island]` controls the floating Station island:

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `rest_counts` | bool | `false` | Show active working/ready counts in the collapsed island. |
| `project_rollup` | bool | `false` | Show each project's worst agent status on hover. |

The needs-you `!N` lane remains visible regardless of these settings.

### `[repository.github]` — repository metadata provider (optional)

Enabled by default when omitted.

| Key | Type | Notes |
| --- | --- | --- |
| `enabled` | bool | `false` disables GitHub metadata. |
| `command` | string | GitHub CLI; overrides `STATION_GH_BIN`, default `gh`. |
| `timeout_ms` | int > 0 | Provider command timeout; default 3000 ms. |

### `[observability.retention]` — local evidence caps (optional)

| Key | Type | Notes |
| --- | --- | --- |
| `max_days` | int > 0 | Default retained-file age cap. |
| `max_total_mb` | int > 0 | Total local-state size cap. |
| `max_file_mb` | int > 0 | Per-file size cap. |
| `max_files_per_component` | int > 0 | Per-component log count cap. |
| `[observability.retention.components]` | `observer_max_mb`, `cli_max_mb`, `tui_max_mb`, `hook_runner_max_mb`, `provider_max_mb` | int > 0 | Per-component log caps. |
| `[observability.retention.sqlite]` | `events_max_days`, `commands_max_days`, `errors_max_days`, `provider_observations_max_days` | int > 0 | SQLite age/reporting thresholds. |
| `[observability.retention.debug_bundles]` | `max_bundles`, `max_days` | int > 0 | Bundle count and age caps. |
| `[observability.retention.hook_spool]` | `delivered_delete_immediately` | bool | Delete successfully delivered spool records immediately. |
| `[observability.retention.hook_spool]` | `failed_max_days`, `failed_max_items` | int > 0 | Failed spool age and item caps. |

See [Diagnostics](diagnostics.md) for which limits are enforced versus reported.

### `[feature_flags]` — behavior gates (optional)

Strict boolean record; unknown flag names are rejected.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `session_resume_agent` | bool | `false` | Enable resuming provider-native agent sessions. |
| `station_persistent_agents` | bool | `false` | Keep Station Host agents alive across UI close and reattach. |

## Project-local config (`.station/config.toml`)

This hand-authored file is read only when enabled by the matching
`[projects.local_config]` entry. It has its own required
`schema_version = 1`.

```toml
[projects.local_config]
enabled = true
path = ".station/config.toml"
```

`enabled` is the only gate. An absent or false value ignores the file. `~/`
paths expand against `$HOME`; all other paths, including absolute-looking
ones, resolve against `project.root`.

Only these overrides are accepted:

| Section | Allowed | Type | Merge rule |
| --- | --- | --- | --- |
| root | `schema_version` | exactly `1` | Required. |
| `[defaults]` | `harness`, `layout` | string | Local value wins; `terminal` cannot be overridden. |
| `[commands]` | any command labels | table<string,string> | Additive only; collisions keep the global value and emit `CONFIG_LOCAL_COMMAND_OVERRIDE`. |
| `[display]` | `group`, `sort_order` | string / int | Shallow merge; local values win. |

`env` and `setup` cannot be set locally. A missing, unreadable, invalid, or schema-invalid
enabled file leaves the global project block in effect and records a diagnostic;
the core runtime config remains a hard-failure boundary.

## Locations and environment variables

### Runtime paths

| Variable | Selects or relocates | Notes |
| --- | --- | --- |
| `STATION_CONFIG_PATH` | Global config file | Equivalent to `stn --config <path>`. |
| `XDG_RUNTIME_DIR` | Observer and Station Host sockets | Sockets use `$XDG_RUNTIME_DIR/station/`; state files stay under `state_dir`. |
| `STATION_OBSERVER_SOCKET_PATH` | TUI/harness Observer connection | Connection-side override. |
| `STATION_HOST_SOCKET_PATH` | Native Station Host socket | TUI-side override for Host reattachment/listing. |
| `STATION_LAYOUT_PATH` | Native layout snapshot | Overrides the layout path. |
| `XDG_STATE_HOME` | Native layout default | Used when `STATION_LAYOUT_PATH` is absent. |
| `HOME` | `~` expansion | Anchors default config, state, socket, and provider-home paths. |

### Provider executables

These are used when the corresponding config `command` field is absent:

| Variable | Provider | Default |
| --- | --- | --- |
| `STATION_WORKTRUNK_BIN` | Worktrunk | `wt` |
| `STATION_TMUX_BIN` | tmux | `tmux` |
| `STATION_GH_BIN` | GitHub provider | `gh` |
| `STATION_CLAUDE_BIN` | Claude Code | `claude` |
| `STATION_CODEX_BIN` | Codex | `codex` |
| `STATION_CURSOR_AGENT_BIN` | Cursor Agent | `agent` |
| `STATION_OPENCODE_BIN` | OpenCode | `opencode` |
| `STATION_PI_BIN` | Pi | `pi` |

### Provider homes

| Variable | Used by |
| --- | --- |
| `CODEX_HOME` | Codex hooks and launched agents. |
| `CLAUDE_CONFIG_DIR` | Claude hooks and launched agents. |
| `STATION_CURSOR_HOME` | Cursor hooks and launched agents. |
| `STATION_CURSOR_HOOKS_PATH` | Cursor hook setup. |
| `OPENCODE_CONFIG_DIR` | OpenCode plugin and launched agents. |

### Development selectors

These are opt-in development/runtime selectors, not generated launch context:

| Variable | Meaning |
| --- | --- |
| `STATION_SOURCE` | Native TUI source: `observer` (default) or `mock`. |
| `STATION_SCENARIO` | Mock fixture name; default `baseline`. |
| `STATION_PTY_IMPL` | PTY implementation: source `bridge`, compiled `bun`, or explicit degraded `bun-nocctty`; no silent fallback. |
| `STATION_NODE` | Node executable for the source PTY bridge; default `node`. |
| `STATION_PTY_ORPHAN_TTL_MS` | Positive lifetime of an unadopted parked Host bridge; default 24 hours. |
| `STATION_BUN` | Bun executable for source/development Host launches; default `bun`. |
| `STATION_HOST_ENTRY` | Non-standard source Host entry; usually unset. |
| `STATION_HOST_HANDOFF` | Exact `1` opts into exact Host build convergence; other values keep compatibility behavior. |
| `STATION_CLI_TRACE` | Exact `1` enables best-effort per-process CLI trace records. |
| `STATION_DASHBOARD_COMMAND` | Development override for the command-capable dashboard renderer. |
| `STATION_TUI_COMMAND` / `STATION_TUI_SESSION_NAME` | Development popup routing overrides. |
| `STATION_SHELL_AUTOCLOSE` | Native overlay auto-close for a `+sh` shell; `1`/`true` or `0`/`false`. |
| `STATION_PROFILE` | Native development render profiling; `1`/`true` or `0`/`false`. |

The PTY helper, compiled asset extraction, child environment, generated launch
context, and `STATION_INGRESS_BIN` are runtime behavior rather than
hand-authored configuration. See [TUI development](tui.md),
[Single-binary Station](single-binary.md), [Harness ingress](harness-ingress.md),
and [System dependencies](system-dependencies.md).

Default state paths follow `[observer].state_dir`:

- `observer.sqlite`, `logs/`, `diagnostics/`, and `spool/hooks/` remain there;
- Observer and Host sockets use its `run/` directory unless `XDG_RUNTIME_DIR` relocates them; and
- the claim and pidfile follow the resolved Observer socket.

See [Observer singleton lifecycle](observer-singleton.md) for ownership and
permissions. `STATION_STATE_DIR` and other generated launch/hook variables
are internal context, not user-facing relocation settings.

## Gotchas / FAQ

**Which file does X go in?**

| I want to… | File | Section |
| --- | --- | --- |
| Add or remove a project | `config.toml` | `[[projects]]` or `stn project add/remove` |
| Change default harness/terminal/layout | `config.toml` | `[defaults]` |
| Set a project harness or layout | Local config or `config.toml` | `[defaults]` / `[projects.defaults]` |
| Add project commands | `config.toml` or local config | `[projects.commands]` / `[commands]` |
| Copy required local files into new worktrees | `config.toml` | `[projects.setup]` |
| Tune the Observer | `config.toml` | `[observer]` |
| React to Observer events | `config.toml` | `[[hooks.event]]` |
| Change native scroll, welcome, or automations | `config.toml` | `[workspace]` |
| Configure dashboard focus/dismissal or widgets | `config.toml` | `[tui]` |
| Set evidence caps | `config.toml` | `[observability.retention]` |
| Toggle a behavior gate | `config.toml` | `[feature_flags]` |

**Why did my whole config fail over one typo?** Core config is strict. The
`[tui]` and `[workspace]` sections degrade to defaults with a
diagnostic, and arbitrary `[harness.<id>]` tables are accepted.

**Why did my project-local command not override the global command?** Local
`[commands]` is additive-only; a collision keeps the global value and
records `CONFIG_LOCAL_COMMAND_OVERRIDE`.

**Why did my project-local file not take effect?** Confirm
`[projects.local_config].enabled = true`. A broken enabled file falls back
to the global project block and reports a diagnostic.

**Are `~` paths expanded?** Yes for the config path, project roots and local
paths, Observer socket/state paths, and Worktrunk config/managed-root paths.
Other provider-specific path-like values remain authored unless their provider
defines expansion.
