#!/usr/bin/env bash
# opencli-crz one-paste installer (macOS / Linux / WSL)
# curl -fsSL https://raw.githubusercontent.com/Yakow13/opencli-crz/main/install.sh | bash
# Installs: Node 22+ (user-space, no sudo) → OpenCLI → the crz adapter set.
set -euo pipefail

REPO="Yakow13/opencli-crz"
NVM_VERSION="v0.40.1"
INSTALL_DIR="${CRZ_INSTALL_DIR:-$HOME/.opencli/clis/crz}"
TMP=""

say() { printf '\033[36mcrz-setup:\033[0m %s\n' "$*"; }
fail() { printf '\033[31mcrz-setup: %s\033[0m\n' "$*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail "curl is required but not found."

node_ok() {
    command -v node >/dev/null 2>&1 || return 1
    local v maj min rest
    v="$(node -v)"; v="${v#v}"
    maj="${v%%.*}"; rest="${v#*.}"; min="${rest%%.*}"
    [ "$maj" -gt 22 ] && return 0
    [ "$maj" -eq 22 ] && [ "$min" -ge 5 ] && return 0
    return 1
}

ensure_node() {
    node_ok && return 0
    say "Node 22.5+ not found (mirror commands need it; OpenCLI itself needs ≥ 20.18)."
    # 1) existing nvm
    if [ -s "$HOME/.nvm/nvm.sh" ]; then
        say "using existing nvm…"
        # shellcheck disable=SC1091
        . "$HOME/.nvm/nvm.sh" && nvm install 22 >/dev/null && nvm use 22 >/dev/null
    # 2) homebrew
    elif command -v brew >/dev/null 2>&1; then
        say "installing Node via Homebrew…"
        brew install node@22 >/dev/null 2>&1 || brew install node
        brew link node@22 >/dev/null 2>&1 || true
        export PATH="/opt/homebrew/opt/node@22/bin:/usr/local/opt/node@22/bin:$PATH"
    # 3) bootstrap nvm into user space (no sudo, official installer)
    else
        say "installing nvm ($NVM_VERSION) into ~/.nvm…"
        curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash >/dev/null
        export NVM_DIR="$HOME/.nvm"
        # shellcheck disable=SC1091
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
        nvm install 22 >/dev/null && nvm use 22 >/dev/null
    fi
    node_ok || fail "still no suitable node on PATH — open a new terminal and rerun the one-liner."
}

ensure_opencli() {
    command -v npm >/dev/null 2>&1 || fail "npm not found (came with Node) — open a new terminal and rerun."
    if command -v opencli >/dev/null 2>&1; then
        say "OpenCLI present: $(opencli --version 2>/dev/null || echo unknown)"
    else
        say "installing OpenCLI globally…"
        if ! npm install -g @jackwener/opencli --silent 2>/dev/null; then
            fail "npm global install failed (permissions). Easiest fix: rerun via nvm-installed Node — remove the old Node package or re-run with a fresh shell."
        fi
    fi
    command -v opencli >/dev/null 2>&1 || fail "opencli not on PATH after install — open a new terminal and rerun."
}

install_adapter() {
    say "downloading ${REPO}…"
    local url
    TMP="$(mktemp -d)"
    trap 'rm -rf "${TMP:-}"' EXIT
    url="$(curl -fsS "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
          | grep -o '"tarball_url": *"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
    [ -z "$url" ] && url="https://codeload.github.com/$REPO/tar.gz/refs/heads/main"
    say "source: $url"
    curl -fsSL "$url" -o "$TMP/crz.tar.gz"
    mkdir -p "$TMP/stage"
    tar -xzf "$TMP/crz.tar.gz" -C "$TMP/stage" --strip-components=1
    mkdir -p "$(dirname "$INSTALL_DIR")"
    rm -rf "$INSTALL_DIR"
    mv "$TMP/stage" "$INSTALL_DIR"
    say "installed to $INSTALL_DIR"
}

verify() {
    say "verifying…"
    local list n
    list="$(opencli list crz 2>/dev/null)" || fail "opencli list crz failed"
    n="$(printf '%s' "$list" | grep -o '"command":' | wc -l | tr -d ' ')"
    [ "$n" -ge 12 ] || fail "expected ≥12 crz commands, found $n"
    say "commands registered: $n ✓"
    # live shape check — asserts structure only; contract content is never printed
    if opencli crz feed --limit 1 -f json 2>/dev/null | grep -q '"ok":true'; then
        say "live smoke: feed ok ✓"
    else
        say "live smoke: CRZ unreachable right now (weekend maintenance?) — install itself is OK, retry later"
    fi
    echo
    say "✓ CRZ ready. Try:"
    echo "    opencli crz recent --limit 5"
    echo "    opencli crz search \"kúpna\" --min-amount 50000"
    echo "    opencli crz sync --since 2025-01-01   # builds the local mirror for crz sql / crz entity"
}

ensure_node
ensure_opencli
install_adapter
verify
