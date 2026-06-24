# Demo & screenshot runbook

Goal: capture clean images/GIFs for the README without leaking your real
projects or local data into the screenshots. Two acts — a deterministic mock
overview, and the live interactions staged by `scripts/demo/stage.sh`.

## Setup

- **Act 1 (mock):** nothing to stage.
- **Act 2 (live):** `scripts/demo/stage.sh` → launch `stn --config ~/.station-demo/config.toml` → tear down with `scripts/demo/reset.sh`.

Everything in Act 2 is isolated under `~/.station-demo`; it never touches your real `~/.config/station` or observer state.

## Terminal setup for clean captures

- Fixed window size — **120×34** is a good default (structure shows, text stays legible).
- A clean dark, high-contrast theme; a Nerd Font so the glyphs (⌘, braille throbbers) render.
- Fresh window, full-screen, no prompt clutter behind the popup.

## The shots → README placement

| # | Shot | How | README spot |
|---|------|-----|-------------|
| 1 | **Hero — overview** | `cd station && STATION_SOURCE=mock STATION_SCENARIO=showcase bun run station` → wait for first frame (throbber shows `⠋`) → capture → `Ctrl-Q` | top, under the tagline |
| 2 | **New session (any harness)** | `N` → name → project → **pick agent: claude / codex** → agent launches into a pane | "What it does" |
| 3 | **Add project** | `A` → folder picker → `~/.station-demo/repos/web` → review → success → `N` to start a session there | "What it does" |
| 4 | **Split + run a command** | open `is-even` (`[+sh]` or a session) → split (`Ctrl-\`) → run `./check.sh` | optional |
| 5 | **Split + see diff** | focus the `is-even` worktree → right-click → **See diff (split right)** → `diffnav` renders the planted O(n)→O(1) diff | the automations money shot |

Shot 1 is the reliable hero — zero setup, no real data. The others are live.

## Stills vs GIFs

- Hero + any single-state shot → **PNG**.
- Interactions (new session, add project, see-diff) → **GIF** — they prove it actually works.

## Reproducible GIFs with VHS (recommended)

`brew install vhs`. VHS scripts keystrokes in a `.tape` file and records a clean GIF at a fixed size/theme — no fumbling, no personal data. Skeleton:

```tape
Output docs/images/see-diff.gif
Set FontSize 16
Set Width 1200
Set Height 720
Set Shell bash
Type "stn --config ~/.station-demo/config.toml" Enter
Sleep 4s
# …drive the keys for the flow here (Type/Enter/Ctrl+… /Sleep)…
Sleep 2s
```

VHS runs Station in its own PTY; the dual-runtime renderer usually records fine, but if a flow misbehaves under VHS, fall back to a screen recording → GIF (`gifski`/QuickTime).

## Putting the images in the README

- Commit to `docs/images/` and embed: `![Station — live worktree dashboard](docs/images/overview.png)`. Works in private and public; GitHub serves them.
- Keep GIFs lean (<~5 MB) or upload to a GitHub release/issue to get a CDN URL and avoid repo bloat.
- **No-real-data guarantee:** Act 1 is mock (famous repos, no real data); Act 2 uses the isolated `is-even`/`web` repos. Never capture against your real observer.
- Suggested layout: hero PNG at the top, one "it works" GIF (see-diff or new session) in "What it does".

## Optional: make the command split a one-tap automation

The **See diff** automation ships by default. To also expose "Run checks (split below)", write `~/.config/station/station.toml` — note that providing `automations` **replaces** the default list, so include both:

```toml
[[automations]]
id = "see-diff"
label = "See diff (split right)"
[[automations.steps]]
split = "right"
anchor = "origin"
command = "git -c color.ui=always diff | delta --paging=always"
run = "execute"
focus = true

[[automations]]
id = "run-checks"
label = "Run checks (split below)"
[[automations.steps]]
split = "below"
command = "./check.sh"
run = "execute"
focus = true
```

For the demo you can skip this and just split + type `./check.sh`.

## Live-demo talking points

- "One dashboard for every agent across every repo — see who's working, idle, or stuck at a glance."
- New session: "Pick a project and a harness; Station creates the worktree and drops the agent into a pane."
- See diff: "Right-click → See diff splits a pane and renders the change — that's the automations primitive; you can wire any command to a pane layout."

## Fallback

If a live agent hangs or errors mid-demo, `Ctrl-Q` and cut to the mock overview (Act 1) — it's deterministic. Keep `STATION_SCENARIO=showcase` running in a second tab as your safety net.
