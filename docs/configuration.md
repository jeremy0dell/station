# Configuration

STATION is configured by a single file: `~/.config/station/config.toml`. A project
may optionally carry a second, narrow file (`.station/config.toml`) for per-project
overrides. This page is the single reference for both: what each controls, who
reads it, where it lives, and how to relocate it.

If you only ever edit one thing, it is `~/.config/station/config.toml`.

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

### `[worktree.worktrunk]` — worktree provider (optional)

| Key | Type | Notes |
| --- | --- | --- |
| `command` | string | Worktrunk CLI, e.g. `"wt"`. |
| `config_path` | string | Path to worktrunk's own config. `~` expands at load time. |
| `managed_root` | string | Root for managed worktrees, e.g. `~/.worktrees`; `~` expands at load time. |
| `base` | string | Default base branch for worktrees. |
| `include_main` / `include_external` | bool | |
| `use_lifecycle_hooks` | bool | |
| `hook_mode` | `required-for-mvp` \| `disabled` | |
| `breadcrumb_location` | `external` \| `worktree` \| `provider-native` \| `disabled` | |

### `[terminal.tmux]` — terminal provider (optional)

| Key | Type | Notes |
| --- | --- | --- |
| `command` | string | tmux binary path/name. |
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
| `command` | string | e.g. `"claude"`, `"codex"`. |
| `profile` | string | Named profile passed to the harness. |
| `permission_mode` | `standard` \| `yolo` | **`auto` is accepted only under `[harness.claude]`.** |
| `sandbox_mode` | string | Free-form, e.g. codex `"workspace-write"`. |
| `approval_policy` | string | Free-form, e.g. codex `"on-request"`. |
| `install_hooks` | bool | Whether STATION installs provider hooks for this harness. |
| `resume` | bool | Whether to resume sessions. |

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

### `[workspace]` — native Station UI behavior (optional, best-effort)

Read **only by the native Station TUI** (the observer and CLI ignore it). A bad value
degrades to defaults plus a diagnostic — it never crashes the daemon.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `scroll_on_output` | `freeze` \| `shift` \| `follow` | `freeze` | Scroll behavior while scrolled up. `freeze` preserves visible lines; `shift` preserves distance from bottom; `follow` snaps to live. At the bottom, all modes track live. |
| `welcome_on_boot` | bool | `true` | Show the welcome screen over the restored layout on cold boot. `false` boots straight in. |
| `automations` | `Automation[]` | one `see-diff` automation | Named, user-triggerable pane layouts in the pane context menu. Omit the key to keep the built-in `see-diff`; set `automations = []` to disable it. |

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

### `[tui]` — runtime TUI widgets (optional, best-effort)

> **Decorative widgets only** — not the same as `[workspace]`. `[tui]` is the
> clock/weather strip; `[workspace]` is interaction behavior (scroll, welcome,
> automations). They never overlap.

`[tui].widgets` is an array discriminated on `type`:

- **`type = "time"`** — optional `time_format` (`12h` \| `24h`).
- **`type = "weather"`** — required `city`; optional `label`, `temperature_unit`
  (`fahrenheit` \| `celsius`), `refresh_interval_minutes` (int > 0).

### Other runtime sections (valid, not in the example file)

- `[repository.github]` — `enabled`, `command` (e.g. `"gh"`), `timeout_ms`.
- `[observability.retention]` — log/db/bundle retention caps (`max_days`,
  `max_total_mb`, `max_file_mb`, `max_files_per_component`, plus nested
  `[...components]`, `[...sqlite]`, `[...debug_bundles]`, `[...hook_spool]`). See
  [diagnostics.md](./diagnostics.md).
- `[feature_flags]` — record of booleans; only `session_resume_agent` and
  `station_persistent_agents` are allowed (both default `false`).

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

| Section | Allowed | Merge rule |
| --- | --- | --- |
| `[defaults]` | `harness`, `layout` **only** | Local **wins** over the project block. `terminal` is intentionally **not** overridable locally. |
| `[commands]` | any command labels | **Additive only.** A label that already exists globally is **rejected** (kept at the global value, emits `CONFIG_LOCAL_COMMAND_OVERRIDE`). New labels are added. |
| `[display]` | `group`, `sort_order` | Shallow merge; local keys **win**. |

`env` cannot be set locally.

### Failure behavior

If `enabled = true` but the file is missing, unreadable, invalid TOML, or
schema-invalid, the load **still succeeds**: STATION records an error-severity
diagnostic and uses the global-only project block. This is the opposite of a bad core
section in `config.toml`, which aborts the load. Surface project-local problems with
`stn doctor` or `stn setup check` (which reports them as a warning, not a clean OK).

---

## Locations & environment variables

| Variable | Relocates | Notes |
| --- | --- | --- |
| `STATION_CONFIG_PATH` | the entire `config.toml` (incl. `[workspace]` and `[tui]`) | `stn --config <path>` is the CLI equivalent. One knob now moves all config — there is no separate workspace file to relocate. |
| `XDG_RUNTIME_DIR` | observer + station-host **sockets** | When set, sockets move to `$XDG_RUNTIME_DIR/station/`. Does **not** move SQLite, logs, diagnostics, or hook spool. |
| `STATION_OBSERVER_SOCKET_PATH` | observer socket the **TUI/harness connects to** | Connection-side override; parallel to `observer.socket_path` in config. |
| `HOME` | the `~` anchor for every default path | `config.toml` (`~/.config`), state dir, sockets. |

Default state paths (all under `state_dir`, default `~/.local/state/station`):

- `observer.sqlite`, `logs/`, `diagnostics/`, `spool/hooks/` follow `state_dir`.
- `run/observer.sock` and sibling `run/station-host.sock` sit under a `run/` subdir of
  `state_dir`, **unless** `XDG_RUNTIME_DIR` is set (then `$XDG_RUNTIME_DIR/station/`).

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
