import type { SetupMessageCatalog, SetupMessageId } from "./types.js";

export const setupMessageCatalog = {
  "setup.heading": { terminal: "stn setup {mode}" },
  "setup.selection-summary": { terminal: "Agent selection: {source}" },
  "setup.introduction": {
    terminal: "Set up required tools and one or more agents. Add your first project in Station.",
  },
  "section.core": { terminal: "Core" },
  "section.recommended": { terminal: "Recommended" },
  "section.later": { terminal: "Later" },
  "section.actions": { terminal: "Actions" },
  "section.next": { terminal: "Next" },
  "section.remaining": { terminal: "Remaining" },
  "status.ok": { terminal: "OK" },
  "status.missing": { terminal: "MISSING" },
  "status.warning": { terminal: "WARN" },
  "status.skipped": { terminal: "SKIP" },
  "action.selected": { terminal: "WILL" },
  "action.skipped": { terminal: "SKIP" },
  "label.state-directory": { terminal: "STATION state directory" },
  "label.socket-evidence": { terminal: "Observer socket recovery" },
  "label.worktrunk": { terminal: "Worktrunk / wt" },
  "label.tmux": { terminal: "tmux" },
  "label.bun": { terminal: "Bun" },
  "label.git": { terminal: "Git" },
  "label.agent-cli": { terminal: "Agent CLI" },
  "label.config": { terminal: "STATION config" },
  "label.launchers": { terminal: "STATION launchers" },
  "label.station-ui": { terminal: "STATION UI dependencies" },
  "label.worktrunk-shell": { terminal: "Worktrunk shell integration" },
  "label.tmux-popup": { terminal: "tmux popup binding" },
  "label.worktrunk-hooks": { terminal: "Worktrunk hooks" },
  "label.harness-tracking": { terminal: "{harness} tracking" },
  "label.diffnav": { terminal: "diffnav" },
  "label.git-delta": { terminal: "git-delta" },
  "label.doctor": { terminal: "stn doctor" },
  "label.config-diagnostics": { terminal: "Station config diagnostics" },
  "label.command-line-tools": { terminal: "Command Line Tools" },
  "label.homebrew": { terminal: "Homebrew" },
  "label.node": { terminal: "Node.js" },
  "label.pnpm": { terminal: "pnpm" },
  "check.evidence": { terminal: "{message}" },
  "check.available": { terminal: "{label} is available." },
  "check.state-directory-ready": { terminal: "Station’s state directory is writable." },
  "check.socket-evidence-ready": {
    terminal: "lsof is available for safe Observer socket recovery and build handoff.",
  },
  "check.socket-evidence-missing": {
    terminal:
      "Fresh Observer startup can continue, but stale-socket recovery and build handoff require an executable lsof at {command}. Install lsof, then rerun stn setup check (Debian/Ubuntu: sudo apt-get install lsof; Fedora/RHEL: sudo dnf install lsof).",
  },
  "check.tmux-popup-skipped": { terminal: "Available after tmux is installed." },
  "check.tmux-popup-launcher-missing": {
    terminal: "Repair the stn-tmux-popup launcher, then rerun stn setup.",
  },
  "check.tmux-popup-ready": { terminal: "The tmux popup binding is installed." },
  "check.tmux-popup-persisted-missing": {
    terminal:
      "The tmux popup binding is persisted but is not loaded with that executable launcher; rerun stn setup to repair it.",
  },
  "check.tmux-popup-persisted-unknown": {
    terminal:
      "The binding is saved but could not be verified in this tmux server; rerun stn setup.",
  },
  "check.launchers-missing": { terminal: "These Station launchers are missing: {launchers}." },
  "check.launchers-mixed-path": {
    terminal:
      "These Station launchers do not resolve to setup’s selected executables on PATH: {launchers}. Use the installer’s PATH guidance for installed launchers; setup can link checkout launchers separately.",
  },
  "check.launchers-checkout-path": {
    terminal:
      "These bare launchers do not resolve to this checkout on PATH: {launchers}; setup will use their current-checkout paths.",
  },
  "check.launchers-installed-path": {
    terminal:
      "STATION is installed, but these bare launchers do not resolve to this installation on PATH: {launchers}. Use the installer's PATH guidance to repair bare launcher resolution.",
  },
  "check.launchers-ready": {
    terminal: "stn, stn-ingress, and stn-tmux-popup are available on PATH.",
  },
  "check.station-ui-ready": { terminal: "The station/ Bun UI lane is installed." },
  "check.station-ui-missing": {
    terminal:
      "{installHint} Until then, bare stn cannot render the terminal UI (stn doctor reports STATION_UI_NOT_INSTALLED).",
  },
  "check.station-ui-skipped": {
    terminal: "Available after Bun is installed, unless STATION_DASHBOARD_COMMAND is set.",
  },
  "check.worktrunk-hooks-skipped": { terminal: "Available after Worktrunk is installed." },
  "check.worktrunk-hooks-recommended": {
    terminal: "Install Worktrunk lifecycle hooks during setup.",
  },
  "check.worktrunk-hooks-defaults": {
    terminal: "Lifecycle automation uses Worktrunk defaults; no prompt flags are configured.",
  },
  "check.tracking-not-applicable": {
    terminal: "{harness} has no Station-managed external tracking artifact.",
  },
  "check.tracking-probe-failed": {
    terminal: "{harnessId} tracking status could not be inspected.",
  },
  "check.tracking-disabled": { terminal: "{harness} tracking is disabled in Station config." },
  "check.tracking-missing": {
    terminal: "{harnessId} tracking artifacts are absent or drifted.",
  },
  "check.tracking-prepared": {
    terminal: "{harness} Station tracking artifacts are prepared on disk.",
  },
  "check.diffnav-ready": {
    terminal: "diffnav is available for Station’s ‘See diff (split right)’ automation.",
  },
  "check.diffnav-missing": {
    terminal: "diffnav is required for Station’s ‘See diff (split right)’ automation.",
  },
  "check.git-delta-ready": {
    terminal: "git-delta is available; diffnav uses it to render Station’s ‘See diff’ automation.",
  },
  "check.git-delta-missing": {
    terminal:
      "git-delta is required because diffnav uses it to render Station’s ‘See diff’ automation.",
  },
  "check.git-outside-repository": {
    terminal: "Git is available; choose projects explicitly in Station.",
  },
  "check.git-repository-ready": {
    terminal: "Git is available; choose a project explicitly in STATION.",
  },
  "check.harness-selection-ambiguous": {
    terminal:
      "Several supported agent CLIs are available ({harnesses}); run guided setup and choose explicitly.",
  },
  "check.harness-none-available": {
    terminal: "Install one supported agent CLI: claude, codex, cursor agent, opencode, or pi.",
  },
  "check.harness-selection-unresolved": {
    terminal: "Agent selection could not be resolved from the current config.",
  },
  "check.harness-configured-unavailable": {
    terminal:
      "{harnessId} remains configured as the default agent CLI, but it is unavailable; another agent CLI cannot satisfy that default.",
  },
  "check.harness-explicit-unavailable": {
    terminal: "These selected agent CLIs are unavailable: {harnessIds}.",
  },
  "check.harness-inferred": {
    terminal: "{harness} was selected because it is the only runnable supported agent CLI.",
  },
  "check.harness-explicit": { terminal: "Selected agent CLIs: {harnesses}." },
  "check.harness-configured": {
    terminal: "{harness} remains the configured default agent CLI.",
  },
  "check.config-core-ready": {
    terminal: "Core STATION config is ready; projects are added explicitly in STATION.",
  },
  "check.config-worktree-provider": {
    terminal:
      "Config defaults use worktree provider {provider}; set defaults.worktree_provider to ‘worktrunk’ for setup.",
  },
  "check.config-terminal": {
    terminal: "Config defaults use terminal {terminal}; set defaults.terminal to ‘tmux’ for setup.",
  },
  "check.config-harness": {
    terminal:
      "Config defaults use unsupported harness {harness}; choose claude, codex, cursor, opencode, or pi.",
  },
  "check.config-diagnostics": {
    terminal: "Config loaded with {count} diagnostic(s): {messages}",
  },
  "check.doctor-reminder": {
    terminal: "Run stn doctor after setup to validate the Observer runtime.",
  },
  "action.install-label": { terminal: "Install {label}" },
  "action.install-homebrew": { terminal: "Install {label} with Homebrew." },
  "action.install-manually": {
    terminal: "Homebrew is unavailable; install {label} manually with: brew install {formula}",
  },
  "action.link-launchers-label": { terminal: "Link STATION launchers" },
  "action.link-launchers-message": {
    terminal: "Link stn, stn-ingress, and stn-tmux-popup for bare terminal commands.",
  },
  "action.worktrunk-shell-label": { terminal: "Install Worktrunk shell integration" },
  "action.worktrunk-shell-message": {
    terminal: "Install Worktrunk’s optional shell helpers after core setup.",
  },
  "action.worktrunk-hooks-label": { terminal: "Prepare Worktrunk tracking" },
  "action.worktrunk-hooks-message": {
    terminal: "Prepare Worktrunk lifecycle hooks that report worktree changes to Station.",
  },
  "action.harness-tracking-label": { terminal: "Install {harness} tracking" },
  "action.harness-tracking-message": {
    terminal: "Install Station-owned {harness} tracking artifacts.",
  },
  "action.tmux-persist-label": { terminal: "Save tmux popup binding" },
  "action.tmux-persist-message": {
    terminal: "Save tmux prefix + {key} for the Station popup in ~/.tmux.conf.",
  },
  "action.tmux-live-label": { terminal: "Load tmux popup binding" },
  "action.tmux-live-message": {
    terminal: "Load tmux prefix + {key} for the Station popup in the current tmux server.",
  },
  "action.config-directory-label": { terminal: "Create config directory" },
  "action.config-directory-message": {
    terminal: "Create the parent directory for Station’s config file.",
  },
  "action.config-create-label": { terminal: "Write STATION config" },
  "action.config-create-message": {
    terminal: "Create core Station config; add the first project in Station.",
  },
  "action.config-update-label": { terminal: "Update STATION config" },
  "action.config-update-message": {
    terminal: "Update selected agents and append safe missing setup blocks.",
  },
  "action.config-blocked-label": { terminal: "Update STATION config" },
  "next.doctor": { terminal: "stn doctor" },
  "next.launch": { terminal: "stn" },
  "next.install-worktrunk": { terminal: "Install Worktrunk." },
  "next.install-tmux": { terminal: "Install tmux." },
  "next.install-bun": { terminal: "Install Bun (brew install bun)." },
  "next.install-diff-tools": {
    terminal: "Install diffnav and git-delta (brew install diffnav git-delta).",
  },
  "next.resolve-required": { terminal: "Resolve the missing required setup items." },
  "progress.start": { terminal: "Applying: {label}" },
  "progress.complete": { terminal: "Completed: {label}" },
  "progress.failed": { terminal: "Failed: {label}" },
  "progress.failed-evidence": { terminal: "{message} ({code})" },
  "progress.hint": { terminal: "Recovery: {hint}" },
  "error.code": { terminal: "Code: {code}" },
  "error.hint": { terminal: "Hint: {hint}" },
  "activation.start": { terminal: "Activating observer configuration..." },
  "activation.complete": { terminal: "Observer configuration active." },
  "activation.failed": { terminal: "Config was written, but observer activation failed." },
  "activation.config-saved": {
    terminal: "The config is saved; remaining setup actions were not applied.",
  },
  "activation.recovery-introduction": {
    terminal: "Resolve the error above, then activate it with:",
  },
  "activation.restart-command": { terminal: "Run: {command}" },
  "activation.setup-command": { terminal: "Then rerun: {command}" },
  "completion.core": { terminal: "Core setup complete." },
  "completion.tracking": { terminal: "Tracking is prepared for {harnesses}." },
  "completion.codex-review": {
    terminal:
      "Codex may require review of Station’s current hook definition through /hooks; setup did not bypass or verify that review.",
  },
  "completion.current-shell-path-title": {
    terminal: "Current shell PATH recovery (does not edit startup files):",
  },
  "completion.short-launchers-title": {
    terminal: "Use stn instead of the absolute path (optional):",
  },
  "completion.short-launchers-explanation": {
    terminal:
      "The absolute commands under Next already work; these steps enable shorter launcher names.",
  },
  "completion.current-shell-path-step": {
    terminal: "To use stn in this shell, run the current-shell PATH block above.",
  },
  "completion.future-shell-path-step": {
    terminal: "For future shells, add {directory} to PATH in a shell configuration you choose.",
  },
  "completion.prefer-path": {
    terminal: "Use PATH rather than an alias so all three STATION launcher names resolve together.",
  },
  "completion.checkout-link-step": {
    terminal:
      "To use stn from this checkout, run the link command above; it exposes all three launcher names together.",
  },
  "completion.verify": { terminal: "Then verify:" },
  "completion.future-shell-unverified": {
    terminal:
      "Future login shell launcher resolution remains unverified until those checks pass in a new login shell.",
  },
  "recovery.selection-required": { terminal: "Agent CLI selection is required." },
  "recovery.selection-command": { terminal: "Run guided setup and choose an agent CLI:" },
  "recovery.command-line-tools": { terminal: "Finish installing the Command Line Tools." },
  "recovery.worktrunk": { terminal: "Worktrunk is still missing." },
  "recovery.tmux": { terminal: "tmux is still missing." },
  "recovery.bun": { terminal: "Bun is still missing; bare stn needs it to render the TUI." },
  "recovery.harness": { terminal: "Resolve the agent selection." },
  "recovery.tracking": { terminal: "Prepare the selected agent’s tracking." },
  "recovery.diffnav": { terminal: "diffnav is still missing." },
  "recovery.git-delta": { terminal: "git-delta is still missing; diffnav renders through it." },
  "recovery.core-incomplete": { terminal: "Core setup is incomplete." },
  "recovery.then-run": { terminal: "Then run:" },
  "recovery.run-command": { terminal: "Run: {command}" },
  "guided.tools-prompt": { terminal: "Install missing required tools?" },
  "guided.no-changes": { terminal: "No changes made." },
  "guided.harness-select-prompt": {
    terminal:
      "Select agent CLIs to prepare (comma-separated; the first is the default only for a new config).",
  },
  "guided.harness-select-required": { terminal: "Select at least one available agent CLI." },
  "guided.required-harnesses-unavailable": {
    terminal: "Required agent CLIs are unavailable: {harnesses}.",
  },
  "guided.config-write-prompt": { terminal: "Write core STATION config?" },
  "guided.config-not-written": { terminal: "Config was not written." },
  "guided.config-write-failed": { terminal: "Config write failed. Run: stn setup plan" },
  "guided.hook-install-failed": {
    terminal: "Hook install failed. Fix the error above, then run: stn setup",
  },
  "guided.worktrunk-shell-prompt": { terminal: "Install Worktrunk shell integration?" },
  "guided.tmux-popup-prompt": { terminal: "Install or load tmux popup binding?" },
  "guided.tmux-not-changed": { terminal: "The tmux popup binding was not changed." },
  "guided.tmux-not-persisted": {
    terminal: "Tmux popup binding was not persisted. Run stn setup to retry.",
  },
  "guided.tmux-loaded": {
    terminal:
      "Tmux popup binding: tmux prefix + {key} is persisted and loaded in the current tmux server.",
  },
  "guided.tmux-future": {
    terminal:
      "Tmux popup binding: tmux prefix + {key} is persisted for future tmux servers; no current server was live-loaded.",
  },
  "guided.tmux-repair-incomplete": {
    terminal: "Tmux popup binding repair was incomplete; run stn setup to retry.",
  },
  "guided.direct-fallback": { terminal: "Direct fallback: {command}" },
  "guided.worktrunk-shell-missing": {
    terminal: "Optional Worktrunk shell integration was not installed; core setup is complete.",
  },
  "guided.active-rc-missing": { terminal: "Active {shell} rc file not found: {path}" },
  "guided.command-line-tools-prompt": {
    terminal: "Install Xcode Command Line Tools now? (runs xcode-select --install)",
  },
  "guided.command-line-tools-started": {
    terminal:
      "Command Line Tools installation started in a separate window. Finish it, then run: stn setup",
  },
  "guided.command-line-tools-failed": {
    terminal:
      "Command Line Tools installation did not start. Run: xcode-select --install, then rerun: stn setup",
  },
  "guided.command-line-tools-declined": {
    terminal: "Install the Command Line Tools (xcode-select --install), then run: stn setup",
  },
  "guided.homebrew-prompt": {
    terminal: "Install Homebrew now? (runs the official Homebrew installer)",
  },
  "guided.homebrew-installing": { terminal: "Installing Homebrew..." },
  "guided.homebrew-failed": { terminal: "Homebrew install failed." },
  "guided.homebrew-manual": {
    terminal: "Install it from https://brew.sh, then run: stn setup",
  },
  "guided.homebrew-continue": {
    terminal: "Continuing with non-Homebrew agent installers where supported.",
  },
  "guided.homebrew-complete": { terminal: "Homebrew install completed." },
  "guided.homebrew-agents-only": {
    terminal:
      "Homebrew was not installed. Setup will offer non-Homebrew agent installers where supported.",
  },
  "guided.homebrew-core-required": {
    terminal: "Homebrew is required to install the missing core tools.",
  },
  "guided.homebrew-url": { terminal: "Install Homebrew first: https://brew.sh" },
  "guided.command-line-tools-hint": {
    terminal: "Command Line Tools: xcode-select --install",
  },
  "guided.launcher-link-prompt": { terminal: "Link STATION launchers globally?" },
  "guided.launcher-link-failed": {
    terminal: "STATION launcher link failed. Continuing with checkout launcher paths.",
  },
  "guided.worktrunk-hooks-prompt": { terminal: "Install Worktrunk lifecycle hooks?" },
  "guided.tracking-consent-prompt": {
    terminal: "{label}? Station requires tracking to observe the selected agent’s activity.",
  },
  "guided.tracking-declined": {
    terminal:
      "Required agent tracking was declined; config and provider tracking artifacts were not changed.",
  },
  "guided.no-agent-title": { terminal: "No supported agent CLI is available." },
  "guided.no-agent-explanation": {
    terminal: "Station needs one agent CLI. You can install one or more now.",
  },
  "guided.installer-prompt": { terminal: "{label}? ({description})" },
  "guided.no-agent-installed": { terminal: "No agent CLI was installed." },
  "guided.install-one-agent": { terminal: "Install one supported agent CLI, then run:" },
  "guided.installing-agent": { terminal: "Installing {label}..." },
  "guided.external-output": {
    terminal:
      "Live installer output is shown below. Station will continue when the installer exits.",
  },
  "guided.agent-install-complete": { terminal: "{label} install completed." },
  "guided.agent-install-failed": {
    terminal: "{label} install failed. Continuing to the next selected agent.",
  },
  "guided.agents-unavailable": { terminal: "These selected agent CLIs are still unavailable:" },
  "guided.no-agent-detected": {
    terminal: "No supported agent CLI was detected after installation.",
  },
  "guided.agent-path-hint": {
    terminal: "Make sure the installed CLI is on PATH, then run:",
  },
  "installer.codex-brew": { terminal: "Install Codex with the official Homebrew cask." },
  "installer.codex-script": {
    terminal: "Run OpenAI’s unattended Codex installer without launching Codex.",
  },
  "installer.cursor-script": { terminal: "Run Cursor’s unattended Agent CLI installer." },
  "installer.opencode-brew": {
    terminal: "Install OpenCode with the official Homebrew formula.",
  },
  "installer.opencode-script": {
    terminal: "Run OpenCode’s installer without modifying shell startup files.",
  },
  "installer.pi-brew": { terminal: "Install Pi with the official Homebrew formula." },
  "installer.pi-npm": { terminal: "Install Pi with npm without lifecycle scripts or prompts." },
  "installer.claude-brew": {
    terminal: "Install Claude Code with the official Homebrew cask.",
  },
  "installer.claude-npm": { terminal: "Install Claude Code with npm without prompts." },
  "installer.command-line-tools": {
    terminal: "Open the macOS Command Line Tools installer.",
  },
  "installer.homebrew": { terminal: "Run the official Homebrew installer." },
  "system.title": { terminal: "stn setup system" },
  "system.final-title": { terminal: "stn setup system final" },
  "system.install-failed": { terminal: "Install failed. Run: stn setup system --check" },
  "system.development-runtime": { terminal: "Development runtime:" },
  "system.node-hint": {
    terminal:
      "Use your Node version manager to install and select Node.js 24.2+ (and below 25), for example:",
  },
  "system.pnpm-hint": {
    terminal:
      "After Node.js 24.2+ (and below 25) is active, enable the repo-pinned package manager with:",
  },
  "system.unchanged-hint": {
    terminal: "STATION setup does not change Node or pnpm automatically.",
  },
} satisfies SetupMessageCatalog;

export const setupMessageIds = Object.freeze(Object.keys(setupMessageCatalog) as SetupMessageId[]);
