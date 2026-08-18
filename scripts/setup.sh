#!/usr/bin/env bash
# Sibling checkouts and pinned tools for building the demo site — the
# single source of truth shared by local developers and CI (the same
# shape as polymorph-iroh's scripts/setup.sh).
#
# The demo's deno.json resolves the deltic ports through SIBLING paths
# (../../../polymorph-*), so the checkouts must sit next to this repo.
# Idempotent: existing checkouts are fetched and pinned, never clobbered.
#
# Environment:
#   SIBLINGS_DIR         where sibling repos live (default: the parent dir)
#   WASM_TOOLS_VERSION   wasm-tools version (default below)
#   WAC_VERSION          wac-cli version (default below)
#   JUST_VERSION         just version (default below)
#   SKIP_TOOLS=1         skip tool installation (they are already present)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

SIBLINGS_DIR="${SIBLINGS_DIR:-$(cd .. && pwd)}"
WASM_TOOLS_VERSION="${WASM_TOOLS_VERSION:-1.247.0}"
WAC_VERSION="${WAC_VERSION:-0.10.1}"
JUST_VERSION="${JUST_VERSION:-1.54.0}"

# Pinned to the revisions the demo was last verified against. Bumping one
# is a deliberate act: the deltic ports carry embedder conventions that
# have already broken this demo once (see spikes/demo/README.md).
IROH_REPO=https://github.com/polymorph-components/polymorph-iroh.git
IROH_PIN=1808cccc437fd2eafe66003e3c0b00518fb94f78
WEBCRYPTO_REPO=https://github.com/polymorph-components/polymorph-webcrypto.git
WEBCRYPTO_PIN=b13d25230d34bbb65ba657be906fd59151a201f7
WEBRTC_REPO=https://github.com/polymorph-components/polymorph-webrtc-datachannels.git
WEBRTC_PIN=8a8347766df9035747fb87f85f13eee16c14c1f4

log() { printf '\n==> %s\n' "$1"; }

pin_repo() { # url pin dir
    local url="$1" pin="$2" dir="$3"
    if [ ! -d "$dir/.git" ]; then
        log "Cloning $(basename "$dir")"
        git clone --filter=blob:none "$url" "$dir"
    fi
    if ! git -C "$dir" cat-file -e "$pin^{commit}" 2>/dev/null; then
        git -C "$dir" fetch --filter=blob:none origin
    fi
    log "Pinning $(basename "$dir") at ${pin:0:12}"
    git -C "$dir" checkout --quiet --detach "$pin"
}

mkdir -p "$SIBLINGS_DIR"
pin_repo "$IROH_REPO" "$IROH_PIN" "$SIBLINGS_DIR/polymorph-iroh"
pin_repo "$WEBCRYPTO_REPO" "$WEBCRYPTO_PIN" "$SIBLINGS_DIR/polymorph-webcrypto"
pin_repo "$WEBRTC_REPO" "$WEBRTC_PIN" "$SIBLINGS_DIR/polymorph-webrtc-datachannels"

if [ "${SKIP_TOOLS:-0}" != "1" ]; then
    log "Installing pinned Rust toolchain (rust-toolchain.toml) and wasm targets"
    (cd "$REPO_ROOT/spikes/tasks-engine" && (rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install))
    # The engine + fetcher are wasip2 (pinned by rust-toolchain.toml); the
    # app and panel guests are plain wasm32-unknown-unknown and carry no
    # toolchain file, so that target is added explicitly.
    rustup target add wasm32-unknown-unknown

    for tool in "wasm-tools@$WASM_TOOLS_VERSION" "wac-cli@$WAC_VERSION" "just@$JUST_VERSION"; do
        name="${tool%@*}"
        if command -v "${name/wac-cli/wac}" >/dev/null 2>&1; then
            log "${name} already present"
        else
            log "Installing ${tool}"
            cargo install --locked "${name}" --version "${tool#*@}"
        fi
    done
fi

# polymorph-iroh vendors its own dependencies (a TLS profile crate among
# them) through its setup script, so a fresh clone cannot build the
# endpoint until that has run. Defer to its contract rather than
# reimplementing it here; it is idempotent.
log "Running polymorph-iroh's own setup (its vendored deps)"
(cd "$SIBLINGS_DIR/polymorph-iroh" && ./scripts/setup.sh)

log "Building the iroh endpoint component (the demo composite plugs it)"
(cd "$SIBLINGS_DIR/polymorph-iroh" && cargo build -p iroh-endpoint --target wasm32-wasip2 --release)

log "Setup complete. Siblings in $SIBLINGS_DIR"
