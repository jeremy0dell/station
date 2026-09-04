# Homebrew

Homebrew installation is not currently supported for Station.

`stn update` does not change that distribution policy. When the running `stn`
already resolves into a Homebrew Cellar or Caskroom owned by a custom package,
the `homebrew` update adapter reports the exact `brew upgrade --formula` or
`brew upgrade --cask` command and defers to it. Station runs that native command
only with explicit `stn update --drive-package-manager`; it does not install a
tap, formula, or cask.

The public installation path for experimental pre-alpha
`v0.0.0-pre-alpha.14.7` is the exact-tag native installer documented in
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

Source development still uses Node.js 24.2+ (and below 25) and exact Bun 1.4.0,
as documented in [Development](development.md). After a supported native install,
run:

```sh
stn setup
stn setup check --json
stn doctor
```

Report packaging feedback through
[GitHub Issues](https://github.com/jeremy0dell/station/issues).
