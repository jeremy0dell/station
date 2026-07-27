#!/bin/sh

set -eu

require_result() {
  lane=$1
  actual=$2
  expected=$3
  if [ "$actual" != "$expected" ]; then
    printf '%s must end with %s, received %s.\n' "$lane" "$expected" "$actual" >&2
    exit 1
  fi
}

require_boolean() {
  selector=$1
  value=$2
  case "$value" in
    true|false) ;;
    *)
      printf '%s must be true or false, received %s.\n' "$selector" "$value" >&2
      exit 1
      ;;
  esac
}

require_selected_result() {
  lane=$1
  selected=$2
  actual=$3
  if [ "$selected" = true ]; then
    require_result "$lane" "$actual" success
  else
    require_result "$lane" "$actual" skipped
  fi
}

require_boolean docs_only "$DOCS_ONLY"
require_boolean installer "$INSTALLER_SELECTED"
require_boolean binary "$BINARY_SELECTED"
require_boolean claim_stress "$CLAIM_STRESS_SELECTED"
require_boolean shell_matrix "$SHELL_MATRIX_SELECTED"
require_result classify "$CLASSIFY" success
require_result static "$STATIC" success

if [ "$DOCS_ONLY" = true ]; then
  require_result fast-tests "$FAST_TESTS" skipped
  require_result integration-tests "$INTEGRATION_TESTS" skipped
  require_result setup-e2e "$SETUP_E2E" skipped
  require_result observer-e2e "$OBSERVER_E2E" skipped
  require_result sqlite-cross-runtime "$SQLITE_CROSS_RUNTIME" skipped
  require_result station-tests "$STATION_TESTS" skipped
  require_result installer-smoke "$INSTALLER_SMOKE" skipped
  require_result binary-smoke "$BINARY_SMOKE" skipped
  require_result installer-selector "$INSTALLER_SELECTED" false
  require_result binary-selector "$BINARY_SELECTED" false
  require_result claim-stress-selector "$CLAIM_STRESS_SELECTED" false
  require_result shell-matrix-selector "$SHELL_MATRIX_SELECTED" false
  exit 0
fi

require_result fast-tests "$FAST_TESTS" success
require_result integration-tests "$INTEGRATION_TESTS" success
require_result setup-e2e "$SETUP_E2E" success
require_result observer-e2e "$OBSERVER_E2E" success
require_result sqlite-cross-runtime "$SQLITE_CROSS_RUNTIME" success
require_result station-tests "$STATION_TESTS" success
require_selected_result installer-smoke "$INSTALLER_SELECTED" "$INSTALLER_SMOKE"
require_selected_result binary-smoke "$BINARY_SELECTED" "$BINARY_SMOKE"
