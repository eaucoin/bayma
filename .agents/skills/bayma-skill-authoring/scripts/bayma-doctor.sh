#!/usr/bin/env sh
# Can this machine find and run bayma at all? Pass a runtime to check just
# that one; the default reports every runtime and proves the available ones.
set -eu

runtime="${1:-all}"
binary="${BAYMA_BIN:-npx -y @bayma-repl/bayma}"

echo "==> bayma doctor: $runtime"
echo "expected: Linux or macOS"
echo "detected: $(uname -s)/$(uname -m)"

if ! command -v "${binary%% *}" >/dev/null 2>&1; then
  echo "error: could not find ${binary%% *} on PATH"
  exit 1
fi

$binary version
$binary doctor --runtime "$runtime" --cwd "${BAYMA_DOCTOR_CWD:-$(pwd)}"
