#!/usr/bin/env bash
# One-time GitHub setup:  npm run setup-github [owner]     (default owner: i-vetrov)
#   1. creates the public repo <owner>/terminvox and pushes main
#   2. creates the "release" environment: only v* tags may use it, and you approve each run
#   3. uploads the signing secrets into that environment (never into the repo)
# Safe to re-run: existing repo/environment are reused, secrets are overwritten.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }
ask() { local v; read -r -p "$1: " v; printf '%s' "$v"; }
ask_secret() { local v; read -r -s -p "$1: " v; echo >&2; printf '%s' "$v"; }

command -v gh >/dev/null || die "install the GitHub CLI first: brew install gh && gh auth login"
gh auth status >/dev/null 2>&1 || die "log in first: gh auth login"
gh auth setup-git # lets plain `git push` use your gh login

ME=$(gh api user -q .login)
OWNER=${1:-i-vetrov}
REPO="$OWNER/terminvox"

# ---- 1. repo ----
say "Repository $REPO"
sed -i '' "s#github.com/GITHUB_OWNER/#github.com/$OWNER/#" src-tauri/tauri.conf.json # updater endpoint
[ -d .git ] || git init -b main
if [ -z "$(git rev-parse --verify -q HEAD || true)" ]; then
  git add -A
  git commit -m "Initial commit"
elif [ -n "$(git status --porcelain src-tauri/tauri.conf.json)" ]; then
  git commit -m "Point the updater at $REPO" src-tauri/tauri.conf.json
fi
if gh repo view "$REPO" >/dev/null 2>&1; then
  echo "exists — reusing"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$REPO.git"
  if [ "$(gh repo view "$REPO" --json visibility -q .visibility)" != "PUBLIC" ]; then
    echo "It's private. The release approval gate (environment protection) needs a public repo on GitHub's free plan."
    if [ "$(ask 'Make it public now? [y/N]')" = "y" ]; then
      gh repo edit "$REPO" --visibility public --accept-visibility-change-consequences
    else
      echo "Leaving it private — setup of the protected environment may fail unless you're on GitHub Pro/Team."
    fi
  fi
else
  gh repo create "$REPO" --public --source . --remote origin \
    --description "IDE-style terminal manager for Claude Code, Codex and other coding agents" --homepage "https://terminvox.dev"
fi
git push -u origin main

# ---- 2. protected environment ----
say "Environment \"release\" (tags v* only, your approval required)"
MY_ID=$(gh api user -q .id)
gh api -X PUT "repos/$REPO/environments/release" --input - >/dev/null <<JSON
{ "reviewers": [{ "type": "User", "id": $MY_ID }],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
gh api "repos/$REPO/environments/release/deployment-branch-policies" -q '.branch_policies[].name' | grep -qx 'v\*' ||
  gh api -X POST "repos/$REPO/environments/release/deployment-branch-policies" -f name='v*' -f type=tag >/dev/null
echo "ok"

# ---- 3. secrets ----
secret() { gh secret set "$1" --env release --repo "$REPO" >/dev/null; echo "  ✓ $1"; } # value on stdin, never argv

say "Update signing key (from ~/.tauri)"
[ -f ~/.tauri/terminvox.key ] || die "~/.tauri/terminvox.key missing — run: npx tauri signer generate -w ~/.tauri/terminvox.key"
secret TAURI_SIGNING_PRIVATE_KEY <~/.tauri/terminvox.key
secret TAURI_SIGNING_PRIVATE_KEY_PASSWORD <~/.tauri/terminvox.key.password

say "Developer ID certificate (.p12 exported from Xcode / Keychain Access)"
P12=$(ask "Path to .p12")
P12=${P12/#\~/$HOME}
[ -f "$P12" ] || die "not found: $P12"
P12_PW=$(ask_secret "Its export password")
IDENTITY=$(openssl pkcs12 -in "$P12" -nokeys -passin "pass:$P12_PW" 2>/dev/null | openssl x509 -noout -subject -nameopt multiline 2>/dev/null |
  sed -n 's/^ *commonName *= *//p' | head -1 || true)
if [[ "$IDENTITY" != "Developer ID Application:"* ]]; then
  echo "Couldn't read the identity from the file (got: '${IDENTITY:-nothing}')."
  IDENTITY=$(ask 'Type it, e.g. Developer ID Application: Your Name (TEAMID)')
fi
echo "  identity: $IDENTITY"
base64 -i "$P12" | tr -d '\n' | secret APPLE_CERTIFICATE
printf '%s' "$P12_PW" | secret APPLE_CERTIFICATE_PASSWORD
printf '%s' "$IDENTITY" | secret APPLE_SIGNING_IDENTITY

say "App Store Connect API key (Users and Access → Integrations → Keys)"
P8=$(ask "Path to AuthKey_XXXXXXXXXX.p8")
P8=${P8/#\~/$HOME}
[ -f "$P8" ] || die "not found: $P8"
KEY_ID=$(basename "$P8" | sed -n 's/^AuthKey_\([A-Z0-9]*\)\.p8$/\1/p')
[ -n "$KEY_ID" ] || KEY_ID=$(ask "Key ID")
ISSUER=$(ask "Issuer ID (shown above the keys list)")
secret APPLE_API_KEY_P8 <"$P8"
printf '%s' "$KEY_ID" | secret APPLE_API_KEY
printf '%s' "$ISSUER" | secret APPLE_API_ISSUER

say "Done."
echo "Release with:  npm run release 0.1.0   → then approve at https://github.com/$REPO/actions"
echo "Back up ~/.tauri/terminvox.key and its .password (e.g. in your password manager):"
echo "without them, apps already installed can never receive another update."
