#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
REAL_PATH="$PATH"
TEST_HOME="$(mktemp -d "${TMPDIR:-/tmp}/agora-installer-test.XXXXXX")"
trap 'rm -rf -- "$TEST_HOME"' EXIT INT TERM

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { grep -Fq -- "$2" "$1" || fail "Expected $1 to contain: $2"; }
assert_not_contains() { if grep -Fq -- "$2" "$1"; then fail "Expected $1 not to contain: $2"; fi; }
assert_ok() { "$@" >/dev/null 2>&1 || fail "Command failed: $*"; }

printf 'Agora installer checks\n'

# Local install into a custom path with spaces, including PATH persistence and backups.
HOME="$TEST_HOME/zsh home" SHELL=/bin/zsh AGORA_INSTALL_DIR="$TEST_HOME/zsh home/bin with spaces" bash "$ROOT/install.sh" >/dev/null
ZSH_BIN="$TEST_HOME/zsh home/bin with spaces/agora"
ZSH_RC="$TEST_HOME/zsh home/.zprofile"
[[ -x "$ZSH_BIN" ]] || fail 'Installer did not create an executable command at a path containing spaces.'
assert_contains "$ZSH_BIN" '// Agora managed CLI (pkyanam/agora-cli)'
assert_contains "$ZSH_RC" '# >>> Agora CLI PATH >>>'
assert_contains "$ZSH_RC" 'bin with spaces'
assert_ok "$ZSH_BIN" --help

BACKUP_COUNT_BEFORE="$(find "$TEST_HOME/zsh home" -maxdepth 1 -name '.zprofile.agora-backup.*' | wc -l | tr -d ' ')"
HOME="$TEST_HOME/zsh home" SHELL=/bin/zsh AGORA_INSTALL_DIR="$TEST_HOME/zsh home/bin with spaces" bash "$ROOT/install.sh" >/dev/null
BACKUP_COUNT_AFTER="$(find "$TEST_HOME/zsh home" -maxdepth 1 -name '.zprofile.agora-backup.*' | wc -l | tr -d ' ')"
[[ "$BACKUP_COUNT_BEFORE" == "$BACKUP_COUNT_AFTER" ]] || fail 'Repeat install made an unnecessary shell-config backup.'
[[ "$(grep -Fc '# >>> Agora CLI PATH >>>' "$ZSH_RC")" == 1 ]] || fail 'Repeat install duplicated the PATH block.'

# Existing unrelated command is never overwritten.
UNRELATED_DIR="$TEST_HOME/unrelated bin"
mkdir -p "$UNRELATED_DIR"
printf '#!/bin/sh\nprintf unrelated\n' > "$UNRELATED_DIR/agora"
chmod 755 "$UNRELATED_DIR/agora"
if HOME="$TEST_HOME/other" AGORA_INSTALL_DIR="$UNRELATED_DIR" bash "$ROOT/install.sh" >"$TEST_HOME/unrelated.out" 2>&1; then
  fail 'Installer unexpectedly replaced an unrelated command.'
fi
assert_contains "$UNRELATED_DIR/agora" 'printf unrelated'

# A piped install clones the GitHub source and accepts only the pinned client.
GH_BIN="$TEST_HOME/gh bin"
GH_REPO="$TEST_HOME/github repo"
mkdir -p "$GH_BIN" "$GH_REPO/cli"
cp "$ROOT/cli/agora.mjs" "$GH_REPO/cli/agora.mjs"
git -C "$GH_REPO" init -q -b main
git -C "$GH_REPO" -c user.name=Test -c user.email=test@example.invalid add cli/agora.mjs
git -C "$GH_REPO" -c user.name=Test -c user.email=test@example.invalid commit -qm fixture
cat > "$GH_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
case "$1" in
  auth) [[ "$2" == status ]] ;;
  repo) [[ "$2" == clone ]] && git clone -q "$TEST_GH_REPO" "$4" ;;
  *) exit 1 ;;
esac
EOF
chmod 755 "$GH_BIN/gh"
if env HOME="$TEST_HOME/github" SHELL=/bin/fish AGORA_INSTALL_DIR="$TEST_HOME/github/bin" TEST_GH_REPO="$GH_REPO" TEST_INSTALL_SCRIPT="$ROOT/install.sh" PATH="$GH_BIN:$REAL_PATH" bash -c 'set -o pipefail; cat "$TEST_INSTALL_SCRIPT" | bash -s' >"$TEST_HOME/github.out" 2>&1; then
  assert_contains "$TEST_HOME/github/bin/agora" '// Agora managed CLI (pkyanam/agora-cli)'
else
  cat "$TEST_HOME/github.out" >&2
  fail 'Installer did not accept the pinned client from its authenticated GitHub checkout.'
fi

printf '%s\n' 'tampered artifact' > "$GH_REPO/cli/agora.mjs"
git -C "$GH_REPO" -c user.name=Test -c user.email=test@example.invalid add cli/agora.mjs
git -C "$GH_REPO" -c user.name=Test -c user.email=test@example.invalid commit -qm tampered
if env HOME="$TEST_HOME/tampered" TEST_GH_REPO="$GH_REPO" TEST_INSTALL_SCRIPT="$ROOT/install.sh" PATH="$GH_BIN:$REAL_PATH" bash -c 'set -o pipefail; cat "$TEST_INSTALL_SCRIPT" | bash -s' >"$TEST_HOME/tampered.out" 2>&1; then
  fail 'Installer accepted a GitHub client with the wrong checksum.'
fi
assert_contains "$TEST_HOME/tampered.out" 'failed its SHA-256 check'

# Repeat updates are allowed only for our marked CLI and are replaced atomically.
UPDATE_REPO="$TEST_HOME/repo update"
mkdir -p "$UPDATE_REPO/cli"
cp "$ROOT/install.sh" "$UPDATE_REPO/install.sh"
cp "$ROOT/cli/agora.mjs" "$UPDATE_REPO/cli/agora.mjs"
cat >> "$UPDATE_REPO/cli/agora.mjs" <<'EOF'
// installer test update marker
EOF
HOME="$TEST_HOME/update" AGORA_INSTALL_DIR="$TEST_HOME/update/bin" bash "$UPDATE_REPO/install.sh" >/dev/null
assert_contains "$TEST_HOME/update/bin/agora" 'installer test update marker'

# Failed remote download leaves the previous working command intact.
MOCK_BIN="$TEST_HOME/mock bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
case "$*" in
  *cli/agora.mjs*) exit 1 ;;
  *) exit 1 ;;
esac
EOF
chmod 755 "$MOCK_BIN/gh"
cat > "$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod 755 "$MOCK_BIN/curl"
if env HOME="$TEST_HOME/update" SHELL=/bin/zsh TEST_INSTALL_SCRIPT="$ROOT/install.sh" PATH="$MOCK_BIN:$REAL_PATH" bash -c 'set -o pipefail; cat "$TEST_INSTALL_SCRIPT" | bash -s' >"$TEST_HOME/download-failed.out" 2>&1; then
  fail 'Installer unexpectedly succeeded when the authenticated CLI download failed.'
fi
assert_contains "$TEST_HOME/update/bin/agora" 'installer test update marker'

# Fail early with a clear Node requirement when Node is absent.
if env HOME="$TEST_HOME/no-node" PATH=/usr/bin:/bin bash "$ROOT/install.sh" >"$TEST_HOME/no-node.out" 2>&1; then
  fail 'Installer unexpectedly succeeded without Node.js.'
fi
assert_contains "$TEST_HOME/no-node.out" 'Node.js 20.9 or newer'

# A remote install needs authenticated gh after the runtime check passes.
NODE_ONLY_BIN="$TEST_HOME/node only bin"
mkdir -p "$NODE_ONLY_BIN"
ln -s "$(command -v node)" "$NODE_ONLY_BIN/node"
cat > "$NODE_ONLY_BIN/curl" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod 755 "$NODE_ONLY_BIN/curl"
if env HOME="$TEST_HOME/no-gh" SHELL=/bin/zsh TEST_INSTALL_SCRIPT="$ROOT/install.sh" PATH="$NODE_ONLY_BIN:/usr/bin:/bin" bash -c 'set -o pipefail; cat "$TEST_INSTALL_SCRIPT" | bash -s' >"$TEST_HOME/no-gh.out" 2>&1; then
  fail 'Installer unexpectedly succeeded without GitHub CLI.'
fi
assert_contains "$TEST_HOME/no-gh.out" 'Install GitHub CLI'

# Bash config is backed up once and receives one managed block.
mkdir -p "$TEST_HOME/bash home"
printf 'export EXISTING_SETTING=kept\n' > "$TEST_HOME/bash home/.bash_profile"
HOME="$TEST_HOME/bash home" SHELL=/bin/bash AGORA_INSTALL_DIR="$TEST_HOME/bash home/bin" bash "$ROOT/install.sh" >/dev/null
assert_contains "$TEST_HOME/bash home/.bash_profile" 'EXISTING_SETTING=kept'
assert_contains "$TEST_HOME/bash home/.bash_profile" '# >>> Agora CLI PATH >>>'
[[ "$(find "$TEST_HOME/bash home" -maxdepth 1 -name '.bash_profile.agora-backup.*' | wc -l | tr -d ' ')" == 1 ]] || fail 'Existing bash profile was not backed up.'

printf 'PASS: install, update, path quoting, shell backup, collision safety, pinned GitHub client integrity, and failed download\n'
