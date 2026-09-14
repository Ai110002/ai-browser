#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  printf '%s\n' 'Usage: ai-browser backup --output <file>.gpg' >&2
  exit 2
fi

OUTPUT_FILE="$(realpath -m -- "$1")"
USER_HOME_DIR="${HOME}"
DATA_PATH="${USER_HOME_DIR}/.local/share/ai-browser"
CONFIG_PATH="${USER_HOME_DIR}/.config/ai-browser"

if [[ -e "$OUTPUT_FILE" ]]; then
  printf 'Refusing to overwrite existing backup: %s\n' "$OUTPUT_FILE" >&2
  exit 3
fi
if [[ ! -d "$DATA_PATH" || ! -d "$CONFIG_PATH" ]]; then
  printf '%s\n' 'AI Browser data/config directories are missing' >&2
  exit 4
fi

mkdir -p "$(dirname -- "$OUTPUT_FILE")"
printf '%s\n' 'Creating encrypted backup. GPG will ask for a passphrase; it is not stored by this script.' >&2
tar --exclude='./.local/share/ai-browser/app/node_modules' \
  --exclude='./.local/share/ai-browser/profile/Singleton*' \
  -czf - -C "$USER_HOME_DIR" .local/share/ai-browser .config/ai-browser \
  | gpg --symmetric --cipher-algo AES256 --output "$OUTPUT_FILE"
chmod 600 "$OUTPUT_FILE"
printf 'Encrypted backup written: %s\n' "$OUTPUT_FILE"
