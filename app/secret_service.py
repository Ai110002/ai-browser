#!/usr/bin/env python3
"""Small, stdin/stdout-only GNOME Secret Service adapter."""

from __future__ import annotations

import json
import sys
from typing import Any

import secretstorage
from secretstorage.exceptions import (
    ItemNotFoundException,
    LockedException,
    PromptDismissedException,
    SecretServiceNotAvailableException,
    SecretStorageException,
)


class HelperError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def response(payload: dict[str, Any]) -> int:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    return 0


def error(code: str, message: str) -> int:
    return response({"ok": False, "code": code, "error": message})


def connect_collection():
    try:
        connection = secretstorage.dbus_init()
        collection = secretstorage.get_default_collection(connection)
        if collection.is_locked():
            if collection.unlock(timeout=15) or collection.is_locked():
                raise HelperError(
                    "KEYRING_LOCKED",
                    "GNOME Keyring is locked or its unlock prompt was dismissed",
                )
        return connection, collection
    except HelperError:
        raise
    except (PromptDismissedException, LockedException, TimeoutError) as exc:
        raise HelperError("KEYRING_LOCKED", "GNOME Keyring is locked") from exc
    except (SecretServiceNotAvailableException, SecretStorageException) as exc:
        raise HelperError("KEYRING_UNAVAILABLE", "GNOME Secret Service is unavailable") from exc
    except Exception as exc:
        raise HelperError("KEYRING_UNAVAILABLE", "GNOME Secret Service could not be opened") from exc


def close_connection(connection) -> None:
    try:
        connection.close()
    except Exception:
        pass


def items_for(collection, credential_id: str):
    try:
        return list(
            collection.search_items(
                {"service": "ai-browser", "credential-id": credential_id}
            )
        )
    except (LockedException, PromptDismissedException) as exc:
        raise HelperError("KEYRING_LOCKED", "GNOME Keyring is locked") from exc


def handle(request: dict[str, Any]) -> dict[str, Any]:
    operation = request.get("op")
    credential_id = str(request.get("credentialId") or "")

    if operation == "doctor":
        connection = None
        try:
            connection, _ = connect_collection()
            return {"ok": True, "available": True, "backend": "org.freedesktop.secrets"}
        finally:
            if connection is not None:
                close_connection(connection)

    if not credential_id:
        raise HelperError("INVALID_REQUEST", "credential id is required")

    connection = None
    try:
        connection, collection = connect_collection()
        items = items_for(collection, credential_id)

        if operation == "lookup":
            if not items:
                raise HelperError(
                    "CREDENTIAL_NOT_FOUND",
                    f"credential '{credential_id}' is not present in GNOME Keyring",
                )
            secret = items[0].get_secret()
            if not secret:
                raise HelperError("CREDENTIAL_EMPTY", f"credential '{credential_id}' is empty")
            return {"ok": True, "secret": secret.decode("utf-8")}

        if operation == "store":
            value = str(request.get("value") or "")
            if not value:
                raise HelperError("INVALID_REQUEST", "credential secret is required")
            label = str(request.get("label") or credential_id)
            host = str(request.get("host") or "")
            item = collection.create_item(
                f"AI Browser: {label}",
                {"service": "ai-browser", "credential-id": credential_id, "host": host},
                value.encode("utf-8"),
                replace=True,
                content_type="text/plain",
            )
            return {"ok": True, "stored": True, "item": str(item.item_path)}

        if operation == "delete":
            for item in items:
                item.delete()
            return {"ok": True, "deleted": len(items)}

        raise HelperError("INVALID_REQUEST", "unsupported Secret Service operation")
    except ItemNotFoundException as exc:
        raise HelperError("CREDENTIAL_NOT_FOUND", "credential is not present in GNOME Keyring") from exc
    finally:
        if connection is not None:
            close_connection(connection)


def main() -> int:
    try:
        line = sys.stdin.readline()
        if not line:
            return error("INVALID_REQUEST", "request is required")
        request = json.loads(line)
        if not isinstance(request, dict):
            return error("INVALID_REQUEST", "request must be an object")
        return response(handle(request))
    except HelperError as exc:
        return error(exc.code, str(exc))
    except (ValueError, TypeError, json.JSONDecodeError):
        return error("INVALID_REQUEST", "request must be valid JSON")
    except Exception:
        return error("KEYRING_ERROR", "GNOME Secret Service operation failed")


if __name__ == "__main__":
    raise SystemExit(main())
