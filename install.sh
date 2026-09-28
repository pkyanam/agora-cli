#!/usr/bin/env bash
set -euo pipefail

REPO="pkyanam/agora-cli"
RAW_BASE="https://raw.githubusercontent.com/$REPO"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=9
DEST_DIR="${AGORA_INSTALL_DIR:-${HOME:?Set HOME before installing}/.local/bin}"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Agora needs Node.js 20.9 or newer. Install Node.js, then run this installer again.' >&2
  exit 1
fi
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1)'; then
  printf 'Agora needs Node.js 20.9 or newer; found %s. Install a supported Node.js release and retry.\n' "$(node --version)" >&2
  exit 1
fi

case "$DEST_DIR" in
  /*) ;;
  *) printf '%s\n' 'AGORA_INSTALL_DIR must be an absolute path.' >&2; exit 1 ;;
esac

mkdir -p "$DEST_DIR"
DEST_DIR="$(cd "$DEST_DIR" && pwd -P)"
DEST="$DEST_DIR/agora"
MARKER='// Agora managed CLI (pkyanam/agora-cli)'

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agora-install.XXXXXX")"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT INT TERM
SOURCE="$TMP_DIR/agora.mjs"

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
if [[ -f "$SCRIPT_SOURCE" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd -P)"
else
  SCRIPT_DIR=''
fi

if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/cli/agora.mjs" ]]; then
  cp "$SCRIPT_DIR/cli/agora.mjs" "$SOURCE"
else
  REF="${AGORA_REF:-main}"
  FETCHED=0
  if command -v curl >/dev/null 2>&1 && curl --fail --silent --show-error --location "$RAW_BASE/$REF/cli/agora.mjs" > "$SOURCE" 2>/dev/null; then
    FETCHED=1
  fi
  if (( FETCHED == 0 )) && command -v gh >/dev/null 2>&1; then
    : > "$SOURCE"
    if gh api --header 'Accept: application/vnd.github.raw' "repos/$REPO/contents/cli/agora.mjs?ref=$REF" > "$SOURCE"; then
      FETCHED=1
    fi
  fi
  if (( FETCHED == 0 )); then
    printf '%s\n' 'Could not download Agora CLI. Confirm `gh auth status` can access pkyanam/agora-cli, or retry when the public installer is available.' >&2
    exit 1
  fi
fi

if [[ "$(head -n 1 "$SOURCE")" != '#!/usr/bin/env node' ]] || ! grep -Fqx "$MARKER" "$SOURCE"; then
  printf '%s\n' 'The downloaded file did not match the expected Agora CLI. Nothing was installed.' >&2
  exit 1
fi

if [[ -e "$DEST" || -L "$DEST" ]]; then
  if [[ -L "$DEST" ]] || [[ ! -f "$DEST" ]] || ! grep -Fqx "$MARKER" "$DEST"; then
    printf 'Refusing to replace an existing command at %s; move it yourself if you want to install Agora there.\n' "$DEST" >&2
    exit 1
  fi
fi

STAGED="$(mktemp "$DEST_DIR/.agora-install.XXXXXX")"
trap 'rm -f "${STAGED:-}"; cleanup' EXIT INT TERM
if ! cat "$SOURCE" > "$STAGED"; then
  rm -f "$STAGED"
  printf '%s\n' 'Could not stage the CLI; the previous installation was left in place.' >&2
  exit 1
fi
chmod 755 "$STAGED"
if ! mv -f "$STAGED" "$DEST"; then
  rm -f "$STAGED"
  printf '%s\n' 'Could not install the CLI; the previous installation was left in place.' >&2
  exit 1
fi

PATH_ENTRY=''
case ":${PATH:-}:" in
  *":$DEST_DIR:"*) ;;
  *) PATH_ENTRY="$DEST_DIR" ;;
esac

if [[ -n "$PATH_ENTRY" ]]; then
  SHELL_NAME="$(basename "${SHELL:-}")"
  case "$SHELL_NAME" in
    zsh) RC_FILE="${HOME}/.zprofile" ;;
    bash)
      if [[ -e "${HOME}/.bash_profile" ]]; then
        RC_FILE="${HOME}/.bash_profile"
      elif [[ -e "${HOME}/.bash_login" ]]; then
        RC_FILE="${HOME}/.bash_login"
      elif [[ -e "${HOME}/.profile" ]]; then
        RC_FILE="${HOME}/.profile"
      else
        RC_FILE="${HOME}/.bash_profile"
      fi
      ;;
    *) RC_FILE='' ;;
  esac

  if [[ -z "$RC_FILE" ]]; then
    printf 'Agora is installed at %s. Add that directory to PATH to use `agora`.\n' "$DEST" >&2
  else
    mkdir -p "$(dirname "$RC_FILE")"
    START_MARKER='# >>> Agora CLI PATH >>>'
    END_MARKER='# <<< Agora CLI PATH <<<'
    HAS_START=0
    HAS_END=0
    [[ -f "$RC_FILE" ]] && grep -Fqx "$START_MARKER" "$RC_FILE" && HAS_START=1 || true
    [[ -f "$RC_FILE" ]] && grep -Fqx "$END_MARKER" "$RC_FILE" && HAS_END=1 || true
    if (( HAS_START != HAS_END )); then
      printf 'The PATH block in %s is incomplete. Repair that file before retrying.\n' "$RC_FILE" >&2
      exit 1
    elif (( HAS_START == 0 )); then
      if [[ -e "$RC_FILE" ]]; then
        BACKUP="${RC_FILE}.agora-backup.$(date +%Y%m%d%H%M%S).$$"
        cp -p "$RC_FILE" "$BACKUP"
      fi
      ESCAPED_PATH="${DEST_DIR//\\/\\\\}"
      ESCAPED_PATH="${ESCAPED_PATH//\"/\\\"}"
      ESCAPED_PATH="${ESCAPED_PATH//\$/\\\$}"
      ESCAPED_PATH="${ESCAPED_PATH//\`/\\\`}"
      {
        printf '\n%s\n' "$START_MARKER"
        printf 'export PATH="%s:$PATH"\n' "$ESCAPED_PATH"
        printf '%s\n' "$END_MARKER"
      } >> "$RC_FILE"
    fi
  fi
fi

printf 'Installed Agora CLI at %s\n' "$DEST"
if [[ -n "${BACKUP:-}" ]]; then
  printf 'Saved your previous shell config at %s\n' "$BACKUP"
fi
if [[ -n "$PATH_ENTRY" ]]; then
  printf 'Open a new %s login shell, then run `agora --help`.\n' "${SHELL_NAME:-new}"
else
  printf 'Run `agora --help` to get started.\n'
fi
