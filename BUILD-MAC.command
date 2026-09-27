#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
exec /bin/bash "$ROOT/scripts/usb-build-macos.sh"
