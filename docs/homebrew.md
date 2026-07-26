# Homebrew

Homebrew installation is not currently supported for Station.

The public installation path for experimental pre-alpha
`v0.0.0-pre-alpha.4` is the exact-tag native installer documented in
[Install Station](install.md). Do not use the historical tap for public
onboarding, and do not update it as part of pre-alpha publication.

This distribution policy is separate from first-run dependencies. On macOS,
`stn setup` may offer to install Homebrew after explicit consent, then use it to
install third-party workflow tools and the official Codex, Claude Code,
OpenCode, or Pi packages. Cursor Agent uses its unattended vendor installer.
The Homebrew bootstrap can request the administrator password required by the
official installer. Station does not use the historical Station tap.

The old `v0.1.0` source-formula release and `v0.7.1-rc.*` binary releases
were internal packaging previews, not predecessors in the public version line.

Source development still uses Node.js 24.2+ (and below 25), pnpm 11, and Bun
1.3.14 as documented in [Development](development.md). After a supported native
install, run:

```sh
stn setup
stn setup check --json
stn doctor
```

Report packaging feedback through
[GitHub Issues](https://github.com/jeremy0dell/station/issues).
