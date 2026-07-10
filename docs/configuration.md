# Configuration

STATION is configured by a single file: `~/.config/station/config.toml`. A project
may optionally carry a second, narrow file (`.station/config.toml`) for per-project
overrides. This page is the single reference for both: what each controls, who
reads it, where it lives, and how to relocate it.

If you only ever edit one thing, it is `~/.config/station/config.toml`.

If that default file does not exist yet, `stn` and its `tui`/`popup` launch
routes use in-memory first-run defaults, ensure the observer, and show the
existing empty-state UI. They do not create a config file; `stn setup` remains
the writer. After every successful guided or non-interactive setup config write,
setup starts or restarts the observer and waits for it to become healthy with
the updated configuration. If activation fails, setup retains the config, exits
nonzero, and points to `stn observer restart`. This exception applies only to the
implicit default path: a missing explicit `--config`, an unreadable file,
malformed TOML, or invalid config still stops launch with an error.

> The annotated `examples/config.toml` is the copy-paste starting point;
> `examples/project-local-config.toml` shows the project-local file. This page is
> the field-by-field reference.

## At a glance

| File | Path (default) | What it controls | Read by | Relocate with |
| --- | --- | --- | --- | --- |
| **Runtime config** | `~/.config/station/config.toml` | Everything: projects, defaults, the observer daemon, providers (worktree/terminal/harness), event hooks, retention, feature flags, the `[tui]` widgets, and the `[workspace]` native-UI behavior | observer, `stn` CLI, native TUI | `STATION_CONFIG_PATH` or `stn --config <path>` |
| **Project-local config** | `<project.root>/.station/config.toml` | Opt-in per-project overrides: harness/layout defaults, extra commands, display | config loader (merged into the project) | set its `path` in `[projects.local_config]` |

Not config, but adjacent:

| Directory | Path (default) | Holds | Relocate with |
| --- | --- | --- | --- |
| **State dir** | `~/.local/state/station/` | SQLite DB, logs, diagnostics, hook spool, sockets | `observer.state_dir` in config; sockets also follow `XDG_RUNTIME_DIR` |

The state dir is **not** a config file — never edit anything under
`~/.local/state/station` by hand. See [debugging.md](./debugging.md).

---

## Runtime config (`config.toml`)

The one file, owned by the `@station/config` package. It is parsed (TOML), keys are
normalized snake_case → camelCase, and validated against a **strict Zod schema**.
Every key below is shown in the TOML spelling.

- **Unknown/misspelled top-level or section keys fail the whole load** with
  `CONFIG_VALIDATION_FAILED` — a typo aborts startup. Exceptions: `[harness.*]`
  (accepts arbitrary harness ids) and the two TUI-only sections below.
- **`[tui]` and `[workspace]` are best-effort.** A bad value in either section does
  **not** abort the load (which would take down the observer over a cosmetic typo);
  the section degrades to defaults and records a warn-level diagnostic, visible via
  `stn doctor` and `stn setup check`.
- `schema_version` is **required** and must be exactly `1`.

`[defaults]` and `[[projects]]` are the only **required** sections (an empty
`projects = []` is valid but the key must be present). Everything else is optional.

### `[observer]` — daemon tuning (optional)

| Key | Type | Notes |
| --- | --- | --- |
| `auto_start` | bool | Auto-start the observer daemon. |
| `auto_start_from_hooks` | bool | Auto-start when a provider hook fires. |
| `idle_shutdown_minutes` | int > 0 | Shut down after N idle minutes. |
| `reconcile_interval_ms` | int > 0 | Reconcile loop interval. |
| `socket_path` | string | Observer IPC socket. `~` expands at load time. |
| `state_dir` | string | State/log/db root. Defaults to `~/.local/state/station`; `~` expands at load time. |

### `[defaults]` — global defaults (REQUIRED)

A project omitting a field inherits the global value.

| Key | Type | Notes |
| --- | --- | --- |
| `worktree_provider` | string | e.g. `"worktrunk"`. Free-form; **not** validated against known providers. |
| `terminal` | string | e.g. `"tmux"`. Free-form. |
| `harness` | string | e.g. `"codex"`. Free-form; **not** cross-checked against `[harness.*]`. |
| `layout` | string | e.g. `"agent-build-shell"`. Free-form. |
| `default_branch` | string (optional) | e.g. `"main"`. |
| `harness_permission_mode` | `standard` \| `yolo` (optional) | **`auto` is rejected here** — it is Claude-only (see `[harness.*]`). |

`worktree_provider`, `terminal`, `harness`, and `layout` are **required**. Values are
validated only as non-empty strings — a typo passes config validation and fails
later at runtime.

Currently meaningful provider ids include `worktrunk` / `noop-worktree`,
`tmux` / `noop-terminal`, and harness ids such as `claude`, `codex`, `cursor`,
`opencode`, `pi`, `scripted`, and `noop-harness`. Unknown ids are
accepted by config validation but become unavailable providers at runtime.

### `[worktree.worktrunk]` — worktree provider (optional)

| Key | Type | Notes |
| --- | --- | --- |
| `command` | string | Worktrunk CLI, e.g. `"wt"`. Overrides `STATION_WORKTRUNK_BIN`; fallback is `wt`. |
| `config_path` | string | Path to worktrunk's own config. `~` expands at load time. |
| `managed_root` | string | Root for managed worktrees, e.g. `~/.worktrees`; `~` expands at load time. |
| `base` | string | Default base branch for Worktrunk project listings and new worktrees. Project entries inherit this unless `[projects.worktrunk].base` is set. |
| `include_main` | bool | Default include-main policy for Worktrunk project listings. Project entries inherit this unless overridden. |
| `include_external` | bool | Default include-external policy for Worktrunk project listings. Project entries inherit this unless overridden. |
| `use_lifecycle_hooks` | bool | Worktrunk automation mode. `false` makes automated mutations pass `--no-hooks`; `true` passes `--yes`; unset uses Worktrunk defaults. |
| `hook_mode` | `required-for-mvp` \| `disabled` | Worktrunk lifecycle hook setup expectation. |
| `breadcrumb_location` | `external` \| `worktree` \| `provider-native` \| `disabled` | Default recovery breadcrumb location. |

### `[terminal.tmux]` — terminal provider (optional)

| Key | Type | Notes |
| --- | --- | --- |
| `command` | string | tmux binary path/name. Overrides `STATION_TMUX_BIN`; fallback is `tmux`. |
| `session_prefix` | string | |
| `topology` | `workbench` | Single-value enum. |
| `workbench_session` | string | |
| `window_naming` | `project-branch` | Single-value enum. |
| `primary_agent_pane` | bool | |
| `popup_width` / `popup_height` / `popup_position` | string | Free-form, e.g. `"50%"`, `"C"`. |

### `[harness.<id>]` — agent harnesses (optional)

The only loosely-typed provider table: `[harness.claude]` is known, and any other id
(`codex`, `opencode`, …) is accepted via a catchall — so a **misspelled harness id
is silently accepted** as an unused harness.

| Key | Type | Notes |
| --- | --- | --- |
| `enabled` | bool | |
| `command` | string | e.g. `"claude"`, `"codex"`. Overrides provider-specific `STATION_*_BIN` fallbacks. |
| `profile` | string | Named profile passed to the harness. |
| `permission_mode` | `standard` \| `yolo` | **`auto` is accepted only under `[harness.claude]`.** |
| `sandbox_mode` | string | Free-form, e.g. codex `"workspace-write"`. |
| `approval_policy` | string | Free-form, e.g. codex `"on-request"`. |
| `install_hooks` | bool | Whether STATION installs provider hooks for this harness. |
| `resume` | bool | Whether to resume sessions. |

Harness command fallback env vars:

| Harness | Env var | Default command |
| --- | --- | --- |
| Claude Code | `STATION_CLAUDE_BIN` | `claude` |
| Codex | `STATION_CODEX_BIN` | `codex` |
| Cursor Agent | `STATION_CURSOR_AGENT_BIN` | `agent` |
| OpenCode | `STATION_OPENCODE_BIN` | `opencode` |
| Pi | `STATION_PI_BIN` | `pi` |

### `[[hooks.event]]` — observer event hooks (optional, repeatable)

Run a command when an **observer** event fires. Distinct from provider *delivery*
hooks (how harnesses report events in — see [harness-ingress.md](./harness-ingress.md)).

| Key | Type | Notes |
| --- | --- | --- |
| `id` | string | **Required.** Hook identifier. |
| `events` | string[] (≥1) | **Required.** Event types to match. |
| `command` | string | **Required.** e.g. `"stn"`. |
| `args` | string[] | Command args. |
| `timeout_ms` | int > 0 | |
| `filter` | table | Optional narrowing (`agent_state`, `harness`, `change_source`, `harness_event_type`). |

`events` must contain one or more `StationEvent` types:

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
command.accepted
command.started
command.succeeded
command.failed
provider.healthChanged
providerHook.ingested
harness.eventReported
providerHook.spoolDrained
```

`filter` accepts:

| Key | Type | Notes |
| --- | --- | --- |
| `agent_state` | `none` \| `starting` \| `idle` \| `working` \| `needs_attention` \| `stuck` \| `exited` \| `unknown` | Matches observed agent state on `worktree.agentStateChanged` events. |
| `harness` | string | Harness provider id. |
| `change_source` | `harness_event_report` \| `reconcile` | Where an agent-state change came from. |
| `harness_event_type` | string | Native harness event type, when the event carried one. |

### `[[projects]]` — managed projects (REQUIRED array)

One entry per git-rooted project STATION manages. The array is required; an empty
array is valid. Cross-field rules: unique `id`s, no alias/id collisions, no duplicate
aliases, unique worktrunk managed roots, and **each `root` must exist at load time**.

| Key | Type | Notes |
| --- | --- | --- |
| `id` | string | **Required**, unique. Derived from root basename on `stn project add` if omitted. |
| `label` | string | **Required.** Display label. |
| `root` | string | **Required**, must be an existing dir. `~/` and relative paths resolve against the config dir. |
| `aliases` | string[] | Alternate names (validated for uniqueness). |
| `repo` | string | e.g. `"github.com/org/web"`. |
| `default_branch` | string | Inherits `[defaults].default_branch`. |
| `env` | table<string,string> | Per-project env vars. **Not** overridable by project-local config. |
| `[projects.defaults]` | table | `harness` / `terminal` / `layout` — each inherits `[defaults]`. |
| `[projects.commands]` | table<string,string> | Named commands (`dev`, `test`, …). |
| `[projects.display]` | table | `group`, `sort_order`. |
| `[projects.worktrunk]` | table | Per-project worktrunk overrides; `enabled` defaults to `true`. |
| `[projects.recovery_breadcrumbs]` | table | `location` (same enum as `breadcrumb_location`), `path`. |
| `[projects.local_config]` | table | Opt-in pointer to a project-local config file — see below. |

Nested project tables:

| Table | Key | Type | Notes |
| --- | --- | --- | --- |
| `[projects.defaults]` | `harness` | string | Per-project harness provider id. |
| `[projects.defaults]` | `terminal` | string | Per-project terminal provider id. Not overridable by project-local config. |
| `[projects.defaults]` | `layout` | string | Per-project layout id. |
| `[projects.commands]` | any label | string | Label-to-command map. Labels are preserved as authored. |
| `[projects.env]` | any key | string | Extra env for project launches; local overlays cannot set it. |
| `[projects.display]` | `group` | string | Optional grouping label. |
| `[projects.display]` | `sort_order` | int | Optional sort order. |
| `[projects.worktrunk]` | `enabled` | bool | Defaults to `true` when omitted. |
| `[projects.worktrunk]` | `base` | string | Overrides `[worktree.worktrunk].base` for this project. |
| `[projects.worktrunk]` | `managed_root` | string | Per-project Worktrunk managed root; relative paths resolve against `project.root`. If omitted and global `managed_root` is set, STATION derives a unique project child directory. |
| `[projects.worktrunk]` | `include_main` | bool | Overrides global `include_main`. |
| `[projects.worktrunk]` | `include_external` | bool | Overrides global `include_external`. |
| `[projects.recovery_breadcrumbs]` | `location` | `external` \| `worktree` \| `provider-native` \| `disabled` | Overrides global breadcrumb location. |
| `[projects.recovery_breadcrumbs]` | `path` | string | Optional breadcrumb path. |
| `[projects.local_config]` | `enabled` | bool | Required inside the table; only `true` reads the project-local file. |
| `[projects.local_config]` | `path` | string | Required inside the table; `~/` expands against `$HOME`, anything else resolves against `project.root`. |

### `[workspace]` — native Station UI behavior (optional, best-effort)

Read **only by the native Station TUI** (the observer and CLI ignore it). A bad value
degrades to defaults plus a diagnostic — it never crashes the daemon.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `scroll_on_output` | `freeze` \| `shift` \| `follow` | `freeze` | Scroll behavior while scrolled up. `freeze` preserves visible lines; `shift` preserves distance from bottom; `follow` snaps to live. At the bottom, all modes track live. |
| `overlay_width_percent` | int 10-100 | `60` | Width of the native Station overlay as a percentage of the terminal width, still clamped to the minimum dashboard size and available space. |
| `overlay_height_percent` | int 10-100 | `60` | Height of the native Station overlay as a percentage of the terminal height below the header row, still clamped to the minimum dashboard size and available space. |
| `welcome_on_boot` | bool | `true` | Show the welcome screen over the restored layout on cold boot. `false` boots straight in. |
| `automations` | `Automation[]` | one `see-diff` automation | Named, user-triggerable pane layouts in the pane context menu. Omit the key to keep the built-in `see-diff`; set `automations = []` to disable it. Automation ids must be unique. |

Each `Automation` is `{ id, label, enabled?, steps[] }`; each step under
`[[workspace.automations.steps]]` is `{ command, split?, anchor?, run?, focus? }`:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `command` | string | **required** | Command to write or execute in the new pane. |
| `split` | `right` \| `below` | `right` | Direction to split the new pane. |
| `anchor` | `origin` \| `previous` | `previous` | Split from the origin pane or the previously created pane. |
| `run` | `execute` \| `write` | `execute` | `execute` runs the command; `write` only types it. |
| `focus` | bool | `false` | Whether to focus the new pane. |
| (automation) `id` / `label` | string | **required** | Unique menu-row key / display label. |
| (automation) `enabled` | bool | `true` | `false` hides it from the menu. |
| (automation) `steps` | `AutomationStep[]` | **required** | One or more steps. |

### `[tui]` — runtime TUI widgets (optional, best-effort)

> **Decorative widgets only** — not the same as `[workspace]`. `[tui]` is the
> clock/weather strip; `[workspace]` is interaction behavior (scroll, welcome,
> automations). They never overlap.

`[tui].widgets` is an array discriminated on `type`. Every widget accepts an
optional `enabled` (bool; default true — `false` keeps the entry in config but
hides it). Array order is display order, left to right:

- **`type = "time"`** — optional `time_format` (`12h` \| `24h`).
- **`type = "weather"`** — required `city`; optional `label`, `temperature_unit`
  (`fahrenheit` \| `celsius`), `refresh_interval_minutes` (int > 0).
- **`type = "fleet"`** — live-agent count, derived from the observer snapshot.
- **`type = "prs"`** — open-PR count across sessions, derived from the snapshot.
- **`type = "tz"`** — a timezone pair; required `zones` (1–2 of
  `{ label, time_zone }`, IANA names — an unknown zone renders `--:--`);
  optional `time_format` (`12h` \| `24h`).
- **`type = "moon"`** — current moon phase.

`[tui.island]` — opt-in display modes for the floating Station island (top-right
button). Both default off:

| Key | Type | Notes |
| --- | --- | --- |
| `rest_counts` | bool | Collapsed island shows active working/ready counts instead of the bare mark; idle and zero lanes are hidden. |
| `project_rollup` | bool | Hovering the island lists each project's worst agent status instead of the working/idle totals. |

### `[repository.github]` — repository metadata provider (optional)

Enabled by default when omitted. Set `enabled = false` to disable GitHub metadata.

| Key | Type | Notes |
| --- | --- | --- |
| `enabled` | bool | `false` disables the GitHub provider entirely. |
| `command` | string | GitHub CLI path/name. Overrides `STATION_GH_BIN`; fallback is `gh`. |
| `timeout_ms` | int > 0 | Provider command timeout. Default is 3000 ms. |

### `[observability.retention]` — log, DB, bundle, and spool caps (optional)

Top-level retention caps:

| Key | Type | Notes |
| --- | --- | --- |
| `max_days` | int > 0 | Default age cap for retained files. |
| `max_total_mb` | int > 0 | Total local-state size cap. |
| `max_file_mb` | int > 0 | Per-file size cap. |
| `max_files_per_component` | int > 0 | Per-component log count cap. |

Nested retention tables:

| Table | Key | Type | Notes |
| --- | --- | --- | --- |
| `[observability.retention.components]` | `observer_max_mb` | int > 0 | Observer log cap. |
| `[observability.retention.components]` | `cli_max_mb` | int > 0 | CLI log cap. |
| `[observability.retention.components]` | `tui_max_mb` | int > 0 | TUI log cap. |
| `[observability.retention.components]` | `hook_runner_max_mb` | int > 0 | Hook-runner log cap. |
| `[observability.retention.components]` | `provider_max_mb` | int > 0 | Provider log cap. |
| `[observability.retention.sqlite]` | `events_max_days` | int > 0 | SQLite event-row age cap/reporting threshold. |
| `[observability.retention.sqlite]` | `commands_max_days` | int > 0 | SQLite command-row age cap/reporting threshold. |
| `[observability.retention.sqlite]` | `errors_max_days` | int > 0 | SQLite error-row age cap/reporting threshold. |
| `[observability.retention.sqlite]` | `provider_observations_max_days` | int > 0 | SQLite provider-observation age cap/reporting threshold. |
| `[observability.retention.debug_bundles]` | `max_bundles` | int > 0 | Debug bundle count cap. |
| `[observability.retention.debug_bundles]` | `max_days` | int > 0 | Debug bundle age cap. |
| `[observability.retention.hook_spool]` | `delivered_delete_immediately` | bool | Delete successfully delivered spool records immediately. |
| `[observability.retention.hook_spool]` | `failed_max_days` | int > 0 | Failed spool age cap. |
| `[observability.retention.hook_spool]` | `failed_max_items` | int > 0 | Failed spool item-count cap. |

See [diagnostics.md](./diagnostics.md) for current enforcement notes; some SQLite
limits are reported through diagnostics before pruning is implemented.

### `[feature_flags]` — temporary behavior gates (optional)

Strict boolean record. Unknown flag names are rejected.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `session_resume_agent` | bool | `false` | Enable resuming lost provider-native agent sessions. |
| `station_persistent_agents` | bool | `false` | Host Station agents in the standalone `station-station-host` daemon so they survive UI close and can reattach. |

---

## Project-local config (`.station/config.toml`)

An **opt-in** TOML file inside a project (conventionally
`<project.root>/.station/config.toml`) carrying a narrow set of overrides. It is
**hand-authored** — no command writes or scaffolds it. It has its **own required
`schema_version = 1`**.

### Enabling it

Point to it from the project's entry in the runtime config:

```toml
[projects.local_config]
enabled = true
path = ".station/config.toml"
```

- **`enabled` is the only gate.** The file is read and merged **only** when
  `enabled = true`. Absent or `false` → ignored entirely.
- **`path`** resolves specially: `~/`-prefixed paths expand against `$HOME`;
  **everything else (including absolute-looking paths) resolves against
  `project.root`**, not the cwd. There is no encoded default — `.station/config.toml`
  is convention only.

### What it can override

Only these keys are accepted (strict — anything else makes the **whole local file**
fail to load and emits a diagnostic, falling back to the bare project block):

| Section | Allowed | Type | Merge rule |
| --- | --- | --- | --- |
| root | `schema_version` | exactly `1` | Required in every local file. |
| `[defaults]` | `harness`, `layout` **only** | string | Local **wins** over the project block. `terminal` is intentionally **not** overridable locally. |
| `[commands]` | any command labels | table<string,string> | **Additive only.** A label that already exists globally is **rejected** (kept at the global value, emits `CONFIG_LOCAL_COMMAND_OVERRIDE`). New labels are added. |
| `[display]` | `group`, `sort_order` | string / int | Shallow merge; local keys **win**. |

`env` cannot be set locally.

### Failure behavior

If `enabled = true` but the file is missing, unreadable, invalid TOML, or
schema-invalid, the load **still succeeds**: STATION records an error-severity
diagnostic and uses the global-only project block. This is the opposite of a bad core
section in `config.toml`, which aborts the load. Surface project-local problems with
`stn doctor` or `stn setup check` (which reports them as a warning, not a clean OK).

---

## Locations & environment variables

Runtime path and socket overrides:

| Variable | Relocates / selects | Notes |
| --- | --- | --- |
| `STATION_CONFIG_PATH` | the entire `config.toml` (incl. `[workspace]` and `[tui]`) | `stn --config <path>` is the CLI equivalent. One knob now moves all config — there is no separate workspace file to relocate. |
| `XDG_RUNTIME_DIR` | observer + station-host **sockets** | When set, sockets move to `$XDG_RUNTIME_DIR/station/`. Does **not** move SQLite, logs, diagnostics, or hook spool. |
| `STATION_OBSERVER_SOCKET_PATH` | observer socket the **TUI/harness connects to** | Connection-side override; parallel to `observer.socket_path` in config. |
| `STATION_HOST_SOCKET_PATH` | native Station host socket | TUI-side override for warm reattach/listing. Otherwise it sits beside the observer socket. The observer's own host controller derives the host socket from config. |
| `STATION_LAYOUT_PATH` | native Station layout snapshot | Overrides the TUI layout snapshot path. Without it, the TUI uses `$XDG_STATE_HOME/station/station/layout.json` or `~/.local/state/station/station/layout.json`. |
| `XDG_STATE_HOME` | native Station layout default | Used only by the TUI layout resolver when `STATION_LAYOUT_PATH` is absent. |
| `HOME` | the `~` anchor for every default path | `config.toml` (`~/.config`), state dir, sockets, provider home defaults. |

Provider command overrides, used when the matching config `command` field is absent:

| Variable | Provider | Fallback without env |
| --- | --- | --- |
| `STATION_WORKTRUNK_BIN` | Worktrunk | `wt` |
| `STATION_TMUX_BIN` | tmux | `tmux` |
| `STATION_GH_BIN` | GitHub repository provider | `gh` |
| `STATION_CLAUDE_BIN` | Claude Code harness | `claude` |
| `STATION_CODEX_BIN` | Codex harness | `codex` |
| `STATION_CURSOR_AGENT_BIN` | Cursor Agent harness | `agent` |
| `STATION_OPENCODE_BIN` | OpenCode harness | `opencode` |
| `STATION_PI_BIN` | Pi harness | `pi` |

Provider config/home overrides:

| Variable | Used by | Notes |
| --- | --- | --- |
| `CODEX_HOME` | Codex hooks + launched Codex agents | Overrides the Codex config home. |
| `CLAUDE_CONFIG_DIR` | Claude hooks + launched Claude agents | Overrides Claude settings/config dir. |
| `STATION_CURSOR_HOME` | Cursor hooks + launched Cursor agents | Used as the isolated Cursor home; launch maps it to `HOME` for the agent process. |
| `STATION_CURSOR_HOOKS_PATH` | Cursor hook setup | Directly overrides the Cursor hooks file path. |
| `OPENCODE_CONFIG_DIR` | OpenCode plugin + launched OpenCode agents | Overrides OpenCode config dir. |

Advanced development/demo overrides:

| Variable | Used by | Accepted values / notes |
| --- | --- | --- |
| `STATION_SOURCE` | Native Station TUI data source | unset/empty/`observer` for live observer, `mock` for fixture data. |
| `STATION_SCENARIO` | Native Station mock data | Fixture scenario name when `STATION_SOURCE=mock`; defaults to `baseline`. |
| `STATION_PTY_IMPL` | Station local and persistent-host PTYs | unset, empty, or `bridge` uses the Node/node-pty bridge (default); `bun` uses `Bun.Terminal` through the controlling-terminal helper; `bun-nocctty` starts the payload directly without job-control or orphan-cleanup guarantees. |
| `STATION_NODE` | Station local PTY bridge | Node executable path/name; fallback is `node`. |
| `STATION_BUN` | Station host controller | Bun executable path/name; fallback is `bun`. |
| `STATION_HOST_ENTRY` | Station host controller | Non-standard override for the host entry file. Usually leave unset. |
| `STATION_DASHBOARD_COMMAND` | CLI TUI launcher | Override command for the read-only dashboard renderer. Development/testing only. |
| `STATION_TUI_COMMAND` / `STATION_TUI_SESSION_NAME` | tmux popup registry | Development popup routing overrides. |
| `STATION_SHELL_AUTOCLOSE` | Native Station TUI | `1`/`true` or `0`/`false`; auto-close overlay when a `+sh` shell opens. |
| `STATION_PROFILE` | Native Station TUI | `1`/`true` or `0`/`false`; enables dev render profiling. |

Source installs using `STATION_PTY_IMPL=bun` must first run
`cd station && bun run build:ctty-helper`. A missing, non-executable, or
`noexec`-blocked helper is a visible error; Station never falls back
automatically to `bun-nocctty`. Any other selector value is also an error.
An existing station host keeps the implementation setting it inherited at
startup, so stop and start the host when changing this variable.

Default state paths (all under `state_dir`, default `~/.local/state/station`):

- `observer.sqlite`, `logs/`, `diagnostics/`, `spool/hooks/` follow `state_dir`.
- `run/observer.sock` and sibling `run/station-host.sock` sit under a `run/` subdir of
  `state_dir`, **unless** `XDG_RUNTIME_DIR` is set (then `$XDG_RUNTIME_DIR/station/`).

Generated launch/hook env vars are internal context, not hand-authored config:
`STATION_PROJECT_ID`, `STATION_WORKTREE_ID`, `STATION_WORKTREE_PATH`,
`STATION_SESSION_ID`, `STATION_HARNESS_PROVIDER`, `STATION_TERMINAL_PROVIDER`,
`STATION_TERMINAL_TARGET_ID`, `STATION_OBSERVER_STATE_DIR`, `STATION_STATE_DIR`,
`STATION_HOOK_SPOOL_DIR`, `STATION_TUI_POPUP`, `STATION_FOCUS_PROVIDER`, and
`STATION_FOCUS_CLIENT_ID`. Hook scripts and launched agents receive these so they
can report back to the right observer/session. `STATION_STATE_DIR` is a hook-script
fallback for `stn-ingress --state-dir`; it is **not** a global observer relocation
knob. Use `observer.state_dir` in config for isolation.

---

## Gotchas / FAQ

**Which file does X go in?**

| I want to… | File | Section |
| --- | --- | --- |
| Add/remove a managed project | `config.toml` | `[[projects]]` (or `stn project add/remove`) |
| Change the default harness/terminal/layout | `config.toml` | `[defaults]` |
| Set a per-project harness or layout | project-local `.station/config.toml` (or `config.toml` `[projects.defaults]`) | `[defaults]` |
| Add project commands (dev/test/…) | `config.toml` `[projects.commands]`, or additively in project-local `[commands]` | |
| Tune the observer daemon | `config.toml` | `[observer]` |
| React to observer events with a command | `config.toml` | `[[hooks.event]]` |
| Change scroll behavior, the welcome screen, or pane automations | `config.toml` | `[workspace]` |
| Add a clock/weather widget | `config.toml` | `[tui].widgets` |
| Set log/DB retention caps | `config.toml` | `[observability.retention]` |
| Toggle a feature flag | `config.toml` | `[feature_flags]` |

**Why did my whole config fail to load over one typo?** `config.toml` is strict — any
unknown key aborts the load. The exceptions are `[harness.<id>]` (any id is accepted)
and the best-effort `[tui]`/`[workspace]` sections (a bad value there degrades to
defaults and a diagnostic instead of failing).

**What happens to `[workspace]` when another runtime section is invalid?** The native
TUI reads `[workspace]` through the full runtime config loader. If an unrelated core
section hard-fails validation, the TUI keeps running with workspace defaults and prints
a warning before rendering. Fix the core config error to restore custom scroll,
welcome, and automation settings.

**`[tui]` vs `[workspace]`?** `[tui]` is decorative widgets (clock/weather);
`[workspace]` is native-UI interaction behavior (scroll/welcome/automations). Both
live in `config.toml`; both are read only by the TUI.

**Why is `permission_mode = "auto"` rejected?** `auto` is Claude-only — valid only
under `[harness.claude]`, never as a global default or for other harnesses.

**Why doesn't my project-local `test` command override the global one?** Project-local
`[commands]` are additive-only; collisions keep the global value and emit a
`CONFIG_LOCAL_COMMAND_OVERRIDE` diagnostic.

**Why didn't my project-local file take effect?** Confirm
`[projects.local_config].enabled = true`. If it is enabled but broken, the project
loads global-only and the failure is a diagnostic (see `stn doctor`), not a hard error.

**Are `~` paths expanded?** Mostly. The config file path, `project.root`,
project-local paths, `observer.socket_path`, `observer.state_dir`,
`worktree.worktrunk.config_path`, and `worktree.worktrunk.managed_root` expand `~` at
load time. Other provider-specific path-like strings may be stored as authored unless
their provider documents otherwise.
