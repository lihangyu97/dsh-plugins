#!/bin/bash
# Build the menu bar helper. No bundle, no signing, no notarization: a bare
# Mach-O executable is enough to own an NSStatusItem, and DSH launches it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$here/bin"
/usr/bin/swiftc -O -o "$here/bin/dsh-menubar" "$here/src/status-item.swift"
echo "built: $here/bin/dsh-menubar"
