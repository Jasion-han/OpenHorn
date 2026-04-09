#!/usr/bin/env bash
set -euo pipefail

# Compiles the sidecar binary for the current host platform and writes
# it to apps/desktop/src-tauri/binaries/openhorn-sidecar-<triple> so
# that Tauri's sidecar bundler picks it up via bundle.externalBin.

unamestr="$(uname -s)"
arch="$(uname -m)"

case "${unamestr}-${arch}" in
  Darwin-arm64)
    target="bun-darwin-arm64"
    triple="aarch64-apple-darwin"
    ;;
  Darwin-x86_64)
    target="bun-darwin-x64"
    triple="x86_64-apple-darwin"
    ;;
  Linux-x86_64)
    target="bun-linux-x64"
    triple="x86_64-unknown-linux-gnu"
    ;;
  Linux-aarch64)
    target="bun-linux-arm64"
    triple="aarch64-unknown-linux-gnu"
    ;;
  *)
    echo "Unsupported host: ${unamestr}-${arch}" >&2
    exit 1
    ;;
esac

script_dir="$(cd "$(dirname "$0")" && pwd)"
sidecar_root="$(cd "${script_dir}/.." && pwd)"
out_dir="${sidecar_root}/../desktop/src-tauri/binaries"
mkdir -p "${out_dir}"

out_file="${out_dir}/openhorn-sidecar-${triple}"

echo "Compiling sidecar: target=${target} → ${out_file}"
cd "${sidecar_root}"
bun build src/index.ts --compile --target="${target}" --outfile "${out_file}"

echo "Done."
