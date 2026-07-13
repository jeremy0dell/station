# Tier 3 (see docs/setup-testing.md): build the "STATION happy-path" macOS image
# with Tart + Packer. Provisions the Brewfile dependencies `stn setup` expects.
# Note: this image does NOT bake an agent-CLI harness, so the required `harness`
# check stays missing; a clone reaches requiredOk only after a supported agent CLI
# is installed AND a config is written.
#
# Prereqs: Tart (https://tart.run) and the cirruslabs/tart Packer plugin on an
# Apple-Silicon Mac.  Build:  packer init . && packer build station-happy.pkr.hcl
#
# The `no-brew` / `no-xcode-clt` profiles do NOT use this image; clone a
# cirruslabs `ghcr.io/cirruslabs/macos-sequoia-vanilla:latest` (no brew, no Xcode)
# directly for those deprivation states.

packer {
  required_plugins {
    tart = {
      source  = "github.com/cirruslabs/tart"
      version = ">= 1.12.0"
    }
  }
}

variable "base_image" {
  type    = string
  default = "ghcr.io/cirruslabs/macos-sequoia-base:latest" # brew preinstalled, no Xcode
}

source "tart-cli" "station-happy" {
  vm_base_name = var.base_image
  vm_name      = "station-happy"
  cpu_count    = 4
  memory_gb    = 8
  ssh_username = "admin"
  ssh_password = "admin"
  ssh_timeout  = "120s"
  headless     = true
}

build {
  sources = ["source.tart-cli.station-happy"]

  # Mirror the Brewfile so a clone has every required STATION dependency.
  provisioner "shell" {
    inline = [
      "set -euo pipefail",
      "brew update",
      "brew install node@24 bun tmux git-delta",
      "brew install diffnav",
      "brew install worktrunk",
    ]
  }
}
