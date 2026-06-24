# Station Demo Script

A presenter's walkthrough of **STATION Station** — the OpenTUI/Bun terminal workspace
that fronts the STATION observer. The demo is ordered so you can run it top to bottom;
each scene **names every feature** it shows, with the exact key/click to trigger it.

> Station is the OpenTUI terminal workspace in `station/`. It is a real terminal
> multiplexer (its own VT engine, PTYs, splits, mouse) **plus** a live dashboard over
> the STATION observer (projects, worktrees, agents, sessions).

---

## Part 0 — Setup: how to run the demo

Pick a lane. **Mock mode is the safe demo default** — deterministic data, no observer required.

```bash
# Host lane (local dev):
station/scripts/doctor.sh          # pre-flight: Bun/Node/deps/built packages
station/scripts/run-host.sh --mock  # deterministic fixture data
station/scripts/run-host.sh          # live observer data

# Container lane (isolated, preferred for clean deps):
station/scripts/run-container.sh --mock
```

**Run-mode features to mention:**

| Feature | Trigger |
|---|---|
| **Host run mode** | `run-host.sh` (Bun + Node sidecar on the host) |
| **Container run mode** | `run-container.sh` (Docker, named volumes for `node_modules`/Bun cache) |
| **Mock data source** | `--mock` or `STATION_SOURCE=mock` |
| **Live observer source** | unset / `STATION_SOURCE=observer` (Unix socket via `@station/client`) |
| **Hot reload (HMR)** | `--hot` — edit code, panes/PTYs survive the reload |
| **Mock scenario picker** | `STATION_SCENARIO=baseline\|many-projects\|attention-and-failures\|disconnected` |
| **Doctor pre-flight** | `scripts/doctor.sh` (clear failure messages, never auto-installs) |
| **node-pty repair** | auto-runs before spawn (re-asserts `spawn-helper` +x bit that Bun strips) |
| **STATION package symlink** | `scripts/link-station-packages.sh` (auto-run before `station`/`dev`/`test`) |
| **Node sidecar override** | `STATION_NODE=/path/to/node` |

> **Recommended demo recipe:** `run-host.sh --mock --hot` with
> `STATION_SCENARIO=many-projects` for a rich dashboard, and a second pass with
> `attention-and-failures` to show alert states.

---

## Part 1 — First boot: the Welcome screen

Launch cold. You land on the **Welcome screen** (the "Station" wordmark + CTAs).

- **Welcome screen on cold boot** — branded intro overlay.
- **Welcome CTA: "Continue →"** — `Enter`/`Space` or click; drops into restored panes.
- **Welcome CTA: "Open project view"** — `Enter`/`Space` or click; opens the dashboard to start a session.
- **Welcome shimmer animation** — light-pass sweep across the focused button on hover.
- **Welcome skip** — `Esc` slips past the intro into restored panes (no-op if none).

> Talking point: on a warm machine, Welcome is the intro over **restored** sessions, not an empty screen. (See Part 7.)

---

## Part 2 — The terminal pane (real VT engine)

Press a CTA into the workspace. You're now in a **PTY-backed shell pane** with a real
terminal screen model — not ANSI-stripped text. Run `vim`, `htop`, `less`, `ls --color`.

**Terminal / VT engine features (built on xterm.js headless, engine-agnostic view):**

- **PTY-backed local shell** — node-pty in a Node sidecar; Bun owns OpenTUI.
- **Lazy PTY spawn** — a pane spawns only on first layout/resize (unseen panes never spawn).
- **Full VT100/xterm screen model** — cursor positioning/movement, save/restore, show/hide.
- **Colors** — ANSI 16, 256-color cube + grayscale ramp, and 24-bit truecolor.
- **Text attributes** — bold, dim, italic, underline, inverse, hidden, strikethrough (blink deliberately dropped).
- **Line wrap** — autowrap with pending-wrap semantics; no-wrap mode honored.
- **Erase / line edit** — ED/EL/ECH, insert/delete line & char, with background-color-on-erase.
- **Alternate screen** — full-screen apps (vim/less/htop) take over and restore the primary buffer on exit; alt-screen output never pollutes scrollback.
- **Scrolling regions, origin mode, insert mode, reverse index, RIS reset.**
- **Wide characters** — CJK and emoji occupy two cells correctly (Unicode 11 widths).
- **DEC special graphics / box drawing, tab stops (set/clear), repeat-char.**
- **Terminal query replies** — DA1/DA2, cursor-position report, OSC 10/11 color queries, mode queries (answered correctly so apps detect capabilities).
- **Bracketed paste** (DECSET 2004) and **application cursor keys** (DECCKM).
- **Kitty keyboard protocol** with **kitty→legacy transcoding** when the child app can't speak it.
- **VS Code Dark theme** palette, **span merging** + trailing-whitespace trim for efficient redraws.
- **Flush coalescing** — bursty output collapses to one render notification (~33ms).
- **Resize handling** — debounced SIGWINCH, text reflow, min-size clamp (2×1).
- **Exit reporting** — pane title shows `pid N` → `exited 0` / `killed SIGTERM`.

> Quick demo: split-screen `vim` to prove alt-screen + cursor + colors, then `:q` to show the primary buffer restored intact.

---

## Part 3 — Panes, splits & layout

Station is a multiplexer. Drive it from the keyboard (all reserved chords pierce the shell):

- **Split right** — `Ctrl-\`
- **Split below** — `Ctrl-^` (i.e. `Ctrl-6`)
- **Focus next pane** — `Ctrl-]` (cycles, wraps)
- **Close active pane** — `Ctrl-/` (a.k.a. `Ctrl-_`; no-op on the main/only pane)
- **Quit Station** — `Ctrl-Q`

**Layout features to point out:**

- **Tree-based pane grid** — nested splits (split a split).
- **Main pane** — the boot shell, always present, can't be closed.
- **Active-pane border highlight** — bright blue focused, dim blue idle.
- **Split accent colors** — green/purple/yellow/cyan borders distinguish split shells.
- **Pane title bar** — shows role + status (`shell — pid 1234`, `Agent: claude`, exit code).
- **PTY survives reshape** — splitting/closing never respawns an existing pane's shell (registry owns PTYs, not React).
- **Split inherits cwd** — a new split opens in the parent pane's directory.

---

## Part 4 — Mouse, selection, copy & context menu

Station forwards mouse to mouse-aware apps **and** keeps native selection for you.

**Selection & copy:**

- **Drag to select** — release copies to clipboard.
- **Double-click** = word selection; **triple-click** = line selection (trailing space trimmed).
- **Selection works in alt-screen apps and even while an app has mouse reporting on** (drag is never forwarded).
- **Selection highlight** — blue background while selecting.
- **Multi-sink copy** — writes to (1) **internal buffer**, (2) **OSC 52** to the host terminal (crosses SSH), and (3) **platform clipboard** (`pbcopy`/`wl-copy`/`xclip`/`clip`); platform sink is skipped on SSH; graceful if a tool is missing.
- **Copy toast** — "Copied N chars" confirmation.

**Mouse passthrough:**

- **Left-click forwarded** to mouse-reporting apps (press+release).
- **Right-click reserved** for the context menu; **Shift-click / Ctrl-click reserved** for selection (never forwarded).
- **Mouse reporting protocols** — X10 (9), VT200 (1000), button-event (1002), any-event (1003), SGR encoding (1006), legacy byte clamp at col 223.
- **Wheel forwarding** — scrolls scrollback in the normal buffer; in alt-screen sends arrow keys (pagers); with mouse reporting sends SGR wheel events at viewport center.

**Context menu (right-click):**

- **Pane menu** — Split Right, Split Below, Close Pane (Close disabled on main/only pane).
- **Header / dashboard menu** — "No Actions Available" placeholder.
- **Navigation** — `↑`/`↓` move, `Enter`/`Space` select, `Esc`/`Ctrl-O`/backdrop-click close; hover keeps the highlight in lockstep with the keyboard.

**Paste handling:**

- **Bracketed paste to shell**, **sanitized paste into the dashboard** (search/editors), strips outer-terminal reply sequences; consumed (no-op) while a context menu is open.

---

## Part 5 — The Station Button & the STATION dashboard overlay

### The Station Button (always-on corner indicator)

- **Collapsed base state** — `⌘` glyph; click toggles the dashboard.
- **Expanded on hover** — shows `working: N` / `idle: N` counts.
- **Attention state** — frames the icon with `! ⌘ !` when a session needs attention/is stuck; click **focuses the flagged session's pane** (falls back to opening the dashboard).
- **Animated expand/collapse** — icon glides, text fades in left-to-right (~300ms), stable widths so the hover target doesn't jump.

### Toggle the dashboard — `Ctrl-O`

A centered, bordered **STATION overlay** appears (≈half the terminal, clamped to 60×16),
sized live to terminal resize. While it's open, **keystrokes are swallowed** (the hidden
shell can't receive them) until `Ctrl-O` closes it.

**Dashboard surface features:**

- **Header line** — `stn` label + connection status + top-row widgets (e.g. clock from `[tui.widgets]`).
- **Project headers (collapsible)** — bold, with worktree/agent counts; click to fold/expand.
- **Worktree rows** — branch name, git status badge, diff `±` counts, PR number + state, CI checks, agent-state label, terminal/session info — each segment color-coded.
- **Agent-state throbber** — animated spinner for working/starting; pulsing `!` for attention (shared 120ms clock).
- **Status labels** — idle / working / starting / needs-attention / stuck / unknown / exited / no-agent, sorted by priority within a project.
- **Empty-project message** and **first-run empty state** (prompt to add a project).
- **Scroll indicators** — "(N hidden above/below)", clickable to page.
- **Footer line** — `Q/esc:close` + counts.
- **Divider lines** between sections.

**Dashboard navigation & actions:**

- **Scroll** — `↑`/`↓` or wheel.
- **Slot activation** — `1-9`/`a-z` (or click a row) launches/focuses that worktree's primary agent in a pane.
- **`[+sh]` shell affordance** — click on a row opens a shell in that worktree's checkout; on a project header opens a shell at the project root.
- **Clickable PR / checks links** — underlined segments open the GitHub URL in your browser.
- **Search/filter** — `/` opens a live filter over branches/projects; `Enter` applies, `Esc` cancels.
- **Collapse/fold** — `C` then a slot key folds that project (state persists across toggles).
- **Refresh snapshot** — `Z` forces a fresh observer snapshot.
- **Help overlay** — `H` or `?` lists every keybinding by context; click backdrop to close.
- **Close** — `Q` / `Esc` / click outside the popup; the backdrop absorbs stray clicks so they never fall through to the shell.
- **View-state persistence** — search text, scroll position, collapsed set, and open sheet survive closing/reopening the overlay.

---

## Part 6 — Session lifecycle (the wizards)

All of these are bottom **sheets** layered over the dashboard (titled, backdrop-dismissable,
slot-selectable lines, toast feedback, inline validation errors).

- **New Session** — `N`. Four steps: **Review** → edit **N**ame, pick **P**roject, pick **A**gent (harness). `Enter` on Review creates a worktree and launches its agent into a pane. Pickers show provider health (healthy/degraded/unavailable).
- **Rename Session** — `R`, choose a row by slot, edit the branch name, `Enter` to commit.
- **Remove Session** — `X`, choose a row, then `Y` to confirm / `N`/`Esc` to cancel the worktree deletion.
- **Add Project** — `A`. Five sub-modes: **Start** (location), **Choose** (folder picker with up/down nav + search), **Review** (git-root detection), **Success**, **Failed** (error detail).
- **Editable text input** — shared cursor/backspace/delete/arrow editor used by name/rename/folder-search fields.
- **Toast notifications** — success/warning/error, color-coded, auto-expiry (paused while a sheet is open), click to dismiss; e.g. "agent runs in tmux — Station can't display it", "no observer connection", "worktree created but didn't appear in time".

---

## Part 7 — Persistence & the host (the "wow" moment)

Station can keep your shells and agents alive across UI restarts.

- **Layout snapshot persistence** — pane tree, roles, and aux-shell identity are saved to JSON (debounced, atomic write, flushed on quit).
- **Cold-boot restore (cold shells)** — on restart with no host, the saved tree respawns fresh local shells.
- **Warm reattach to host PTYs** — with the persistent host running, panes reconnect to the *same live* shells/agents instead of respawning.
- **Persistent host daemon** — `station-station-host` (Bun) owns long-lived PTYs and survives the UI; observer spawns/monitors it.
- **Aux PTY persistence** — splits/`[+sh]` shells spawn into the host when available (survive UI restart), fall back to local when not.
- **Host-backed agent terminal** — the UI re-attaches to a running agent; the observer owns its lifecycle, the UI only detaches.
- **Layout path override** — `STATION_LAYOUT_PATH=...`.

**Demo the lifecycle with the isolated lane:**

```bash
cd station
bun run station:isolated        # observer + persistent agents + Station
bun run host:list               # list live host PTYs/agents
bun run e2e:persist             # scripted spawn → reattach proof
bun run station:isolated:stop   # teardown
```

> Live demo: launch an agent, **quit Station (`Ctrl-Q`)**, relaunch — the agent is still
> running and the pane re-attaches. That's warm reattach.

---

## Part 8 — Connection states & resilience

Best shown with `STATION_SCENARIO=disconnected`, or by stopping the observer mid-demo.

- **live** (green) — connected, current data.
- **loading** — "Loading observer snapshot…" before the first snapshot.
- **reconnecting since HH:MM:SS** (yellow) — retrying; last-good snapshot stays visible; commands queue.
- **display-only since HH:MM:SS (last good snapshot shown)** (yellow) — extended outage, read-only.
- **halted: <message>** (red) — permanent failure, frozen at last-good snapshot.
- **idle** (gray) — mock/never-queried.
- **Snapshot alerts** — e.g. the "Static many-projects fixture" banner that self-identifies mock data.
- **Resilience** — broken `station.toml` boots with defaults; missing host falls back to cold shells; failed clipboard tool doesn't block copy.

**Mock scenarios to flip through:** `baseline` (1 project), `many-projects` (3 projects / 11 worktrees / every state), `attention-and-failures` (red throbbers, stuck agents, failed CI, degraded providers), `disconnected` (display-only over a retained snapshot).

---

## Part 9 — Config & developer tooling

- **`~/.config/station/station.toml`** — user config:
  - **`scroll_on_output = "freeze" | "shift" | "follow"`** — what the viewport does when output arrives while you're scrolled up (freeze=hold lines, shift=slide, follow=snap to bottom).
  - **`welcome_on_boot = true|false`** — show the Welcome screen on cold boot.
- **`[tui.widgets]`** — header widgets (shared `@station/config` loader).
- **Shell auto-close overlay** — `STATION_SHELL_AUTOCLOSE=1` dismisses the overlay when a `[+sh]` shell opens.
- **Hot reload (HMR)** — `--hot`; edits preserve panes/PTYs and reattach.
- **React DevTools** — `bun run station:devtools`.
- **Render profiling** — `STATION_PROFILE=1` (or `station:profile`) logs commit timeline to `.dev-state/render-profile.jsonl`.
- **Smoke / e2e tests** — `bun run test:pty`, `test:agents`, `e2e:persist`, VT stress (`STATION_VT_STRESS=1`).

---

## Appendix A — Keybinding cheat-sheet (from in-app Help, `?`)

| Key | Action |
|---|---|
| `Ctrl-O` | open/close project view (dashboard) |
| `Ctrl-Q` | quit Station |
| `Ctrl-\` | split pane right |
| `Ctrl-^` | split pane below (`Ctrl-6`) |
| `Ctrl-]` | focus next pane |
| `Ctrl-/` | close split pane (`Ctrl-_`) |
| `Enter`/`Space` | welcome CTA / context-menu select |
| `Esc` `↑` `↓` | context-menu close / move |
| `↑`/`↓`, wheel | scroll project list (dashboard) |
| `1-9`/`a-z` | start or focus visible row (slot) |
| `N` `A` `R` `X` `C` | new / add-project / rename / remove / fold |
| `/`, `Z` | search / refresh snapshot |
| `H`, `?` | help |
| `Q`/`Esc` | close / back / cancel |

---

## Appendix B — Full feature index (every feature, by area)

**Run modes & data sources:** host run · container run · mock source · live observer source · hot reload (HMR) · scenario picker · isolated observer lane · doctor pre-flight · node-pty repair · package symlink · Node sidecar override · layout-path override · config-path override.

**Welcome / onboarding:** cold-boot welcome · Continue CTA · Open-project-view CTA · shimmer animation · Esc skip · first-run empty state.

**Terminal / VT engine:** PTY-backed shell · lazy spawn · cursor control · ANSI-16/256/truecolor · bold/dim/italic/underline/inverse/hidden/strikethrough · autowrap + pending-wrap + no-wrap · erase + line/char edit · BCE · alternate screen · scrolling region · origin/insert mode · reverse index · RIS · wide-char (CJK/emoji) · DEC graphics/box-drawing · tab stops · repeat-char · device-attribute & cursor-position replies · OSC 10/11 color queries · mode queries · bracketed paste · application cursor keys · kitty keyboard + kitty→legacy transcoding · VS Code Dark theme · span merging · flush coalescing · resize/reflow/min-clamp · exit reporting.

**Panes & layout:** split right · split below · focus next · close pane · nested splits · main pane · active-border highlight · split accent colors · pane title bar · PTY-survives-reshape · cwd inheritance.

**Mouse / selection / copy:** drag select · double/triple-click select · selection in alt-screen / under mouse-reporting · selection highlight · internal + OSC 52 + platform clipboard sinks · SSH-aware platform skip · copy toast · left-click passthrough · right/shift/ctrl-click reservation · X10/VT200/1002/1003/1006 mouse protocols · wheel forwarding (scrollback / arrows / SGR) · bracketed + sanitized paste.

**Context menu:** pane menu (split×2, close) · header/dashboard placeholder · keyboard nav · hover-sync · backdrop close.

**Station Button:** collapsed base · hover-expand counts · attention frame + focus-flagged-pane · animated expand/collapse.

**Dashboard overlay:** Ctrl-O toggle · input swallow · adaptive popup sizing · header + connection status + widgets · collapsible project headers · worktree rows (branch/status/diff/PR/checks/agent/session) · throbber · status labels · empty/first-run states · scroll indicators · footer · dividers · scroll · slot activation · `[+sh]` shell affordance (row + project) · clickable PR/checks links · search/filter · collapse/fold · refresh · help overlay · close/backdrop · view-state persistence · backdrop click absorb.

**Session lifecycle:** New Session wizard (review/name/project/agent) · Rename · Remove (+confirm) · Add Project (start/choose/review/success/failed + folder search) · editable text input · provider-health in pickers · toast notifications (success/warning/error, auto-expiry, click-dismiss).

**Persistence & host:** layout snapshot · cold-boot restore · warm reattach · persistent host daemon · host socket protocol · aux PTY persistence · host-backed agent terminal · host listing CLI · host lifecycle log · e2e reattach demo.

**Connection & resilience:** live · loading · reconnecting · display-only · halted · idle · snapshot alerts · config/host/clipboard degradation.

**Config & dev tooling:** `scroll_on_output` · `welcome_on_boot` · `[tui.widgets]` · shell auto-close · HMR · DevTools · render profiling · smoke/e2e/VT-stress tests.
