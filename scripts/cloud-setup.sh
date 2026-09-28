#!/usr/bin/env bash
# Setup for a Claude Code cloud session on catherd. Paste into the environment's "Setup script".
# Idempotent; each step warns and continues on failure, and CLAUDE.md says to finish a failed step by hand.
set -uo pipefail
warn() { echo "cloud-setup: $*" >&2; }

# 1. Bun >= 1.4. `bun upgrade` misreads its arguments in this container, so install from the release zip.
need_bun() { ! command -v bun >/dev/null || [ "$(printf '%s\n1.4.0\n' "$(bun --version)" | sort -V | head -1)" != "1.4.0" ]; }
if need_bun; then
  arch=$(uname -m); case "$arch" in x86_64) z=bun-linux-x64 ;; aarch64|arm64) z=bun-linux-aarch64 ;; *) z=bun-linux-x64 ;; esac
  tmp=$(mktemp -d)
  if curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/$z.zip" -o "$tmp/bun.zip" \
    && (cd "$tmp" && unzip -q bun.zip); then
    mkdir -p "$HOME/.bun/bin"
    cp "$tmp/$z/bun" "$HOME/.bun/bin/bun.new" && mv -f "$HOME/.bun/bin/bun.new" "$HOME/.bun/bin/bun"
    ln -sf "$HOME/.bun/bin/bun" "$HOME/.bun/bin/bunx"
  else
    warn "could not install Bun"
  fi
  rm -rf "$tmp"
fi
export PATH="$HOME/.bun/bin:$PATH"
grep -q '.bun/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.bashrc"
bun --version || warn "bun missing"

# 2. The superpowers plugin.
if command -v claude >/dev/null; then
  claude plugin marketplace add anthropics/claude-plugins-official >/dev/null 2>&1 || true
  claude plugin install superpowers@claude-plugins-official >/dev/null 2>&1 || warn "superpowers not installed"
else
  warn "claude CLI not found; install superpowers from inside the session"
fi

# 3. Worker agents: Opus 5.5 at low and medium effort.
mkdir -p "$HOME/.claude/agents"
for e in low medium; do
  cat > "$HOME/.claude/agents/opus-$e.md" <<EOF
---
name: opus-$e
description: Worker on Claude Opus 5.5 at $e effort, for plan tasks and reviews dispatched by the main session.
model: claude-opus-5-5
effort: $e
---
You are a worker dispatched by the main session. Follow the brief and the contract it names exactly.
EOF
done

# 4. The repo: dependencies and the dispatch contracts (only when the session starts inside the catherd clone).
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
if [ -f "$root/package.json" ] && grep -q '"name": "catherd-cli"' "$root/package.json"; then
  cd "$root"
  bun install --frozen-lockfile || warn "bun install failed"
  mkdir -p .superpowers/sdd && cp docs/handoff/process/*.md .superpowers/sdd/ || warn "contracts not copied"
else
  warn "not inside the catherd clone; run step 4 from the repo"
fi
echo "cloud-setup: done"
