#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  printf '%s\n' 'Usage: ai-browser restore <file>.gpg' >&2
  exit 2
fi

ARCHIVE_FILE="$(realpath -- "$1")"
USER_HOME_DIR="${HOME}"
if [[ ! -f "$ARCHIVE_FILE" ]]; then
  printf 'Backup not found: %s\n' "$ARCHIVE_FILE" >&2
  exit 3
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE_DIR="$(mktemp -d -t ai-browser-restore.XXXXXX)"
trap 'rm -rf -- "$STAGE_DIR"' EXIT

printf '%s\n' 'Decrypting backup. GPG will ask for the backup passphrase.' >&2
gpg --decrypt "$ARCHIVE_FILE" | tar -xzf - -C "$STAGE_DIR"

if [[ ! -d "$STAGE_DIR/.local/share/ai-browser" || ! -d "$STAGE_DIR/.config/ai-browser" ]]; then
  printf '%s\n' 'Backup does not contain an AI Browser data/config tree' >&2
  exit 4
fi

for RELATIVE_PATH in .local/share/ai-browser .config/ai-browser; do
  TARGET_PATH="${USER_HOME_DIR}/${RELATIVE_PATH}"
  if [[ -e "$TARGET_PATH" ]]; then
    mv -- "$TARGET_PATH" "${TARGET_PATH}.pre-restore-${STAMP}"
    printf 'Existing path moved aside for rollback: %s.pre-restore-%s\n' "$TARGET_PATH" "$STAMP"
  fi
  mkdir -p "$(dirname -- "$TARGET_PATH")"
  mv -- "$STAGE_DIR/${RELATIVE_PATH}" "$TARGET_PATH"
  chmod 700 "$TARGET_PATH" || true
done

printf '%s\n' 'Encrypted AI Browser restore completed. GNOME Keyring entries are not contained in the archive and remain unchanged.'
