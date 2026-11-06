"""Open or resume the selected private CSV in this project's 24-hour TiDB Agent Workspace."""

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import runpy
import secrets
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener
from uuid import UUID

from filelock import FileLock
from keyring.errors import KeyringError, PasswordDeleteError

# Isolated Python intentionally omits the script directory from sys.path.
shared = runpy.run_path(str(Path(__file__).with_name("report.py")))
PRODUCTION = shared["PRODUCTION"]
LIMIT = 1024 * 1024


class Rejected(Exception):
    def __init__(self, status, code):
        self.status = status
        super().__init__(f"TiDB Agent Workspace returned {status} ({code}).")


def request(base, key, route, method="GET", body=None, headers=None):
    req = Request(
        base + "/api/v1/agent-csv/" + route,
        method=method,
        data=body,
        headers={"Authorization": "CsvWorkspace " + key, **(headers or {})},
    )
    try:
        with build_opener(shared["NoRedirect"]()).open(req, timeout=45) as response:
            data = response.read(LIMIT + 1)
            if len(data) > LIMIT:
                raise ValueError("Remote file exceeds the 1 MiB limit.")
            return data
    except HTTPError as error:
        with error:
            try:
                code = json.loads(error.read(2048))["error"]["code"]
            except (ValueError, KeyError, TypeError):
                code = "REQUEST_REJECTED"
            if not isinstance(code, str) or not re.fullmatch("[A-Z_0-9]+", code):
                code = "REQUEST_REJECTED"
            raise Rejected(error.code, code) from None


def selected_csv(file):
    if not file or file.suffix.lower() != ".csv" or not file.is_file():
        raise ValueError("Attach your CSV in the chat or tell your agent its filename.")
    with file.open("rb") as handle:
        data = handle.read(LIMIT + 1)
    if not data or len(data) > LIMIT or b"\0" in data:
        raise ValueError("Select a nonempty UTF-8 CSV of at most 1 MiB.")
    try:
        csv.field_size_limit(LIMIT)
        reader = csv.reader(io.StringIO(data.decode("utf-8-sig"), newline=""), strict=True)
        if not next(reader, []):
            raise ValueError("The CSV needs a header row.")
        for _ in reader:
            pass
    except (UnicodeError, csv.Error) as error:
        raise ValueError("Select a valid UTF-8 CSV.") from error
    return data


def digest(data):
    return hashlib.sha256(data).hexdigest()


def private_csv(
    base, project, home, action, file=None, store_factory=shared["native_store"], now=time.time
):
    url = urlsplit(base)
    if base != PRODUCTION and not (
        url.scheme == "http"
        and url.hostname in ("127.0.0.1", "::1")
        and not (url.username or url.password or url.query or url.fragment)
    ):
        raise ValueError("Use the official Studio or a loopback test server.")
    binding = digest((base + "\n" + str(shared["project_dir"](project))).encode())
    service = "drive9.private-csv." + binding
    directory = home / binding
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path, cache = directory / "binding.json", directory / "source.csv"
    with FileLock(str(directory / "binding.lock")):
        if action == "resume" and not path.exists():
            return {"status": "needs-file"}
        state = json.loads(path.read_text()) if path.exists() else {}
        store = store_factory()
        if action == "forget" or state.get("expiresAt", now() + 1) <= now():
            try:
                if store.get_password(service, "project") is not None:
                    store.delete_password(service, "project")
            except PasswordDeleteError:
                raise ValueError("Unlock the system credential store to finish key removal.") from None
            state["status"] = "forgotten" if action == "forget" else "expired"
            shared["save_state"](path, state)
        if action == "new":
            if state.get("status") not in ("expired", "forgotten"):
                raise ValueError("Use upload or resume with the current project.")
            state = {}
            action = "upload"
        if state.get("status") in ("expired", "forgotten"):
            return {"status": state["status"], "localSource": str(cache) if cache.is_file() else None}
        data = selected_csv(file) if action in ("upload", "replace") else None
        key = store.get_password(service, "project")
        if not key:
            if state or action != "upload":
                raise ValueError("No usable project credential. An existing workspace cannot be replaced by resuming.")
            key = secrets.token_hex(32)
            store.set_password(service, "project", key)
        if "workspaceId" not in state:
            if action != "upload":
                raise ValueError("Upload the selected CSV first.")
            # Persist an in-progress binding before the request. On a lost response
            # the same key selects the same server-side Workspace.
            state = {
                "status": "opening",
                "expiresAt": state.get("expiresAt", int(now()) + 86400),
            }
            shared["save_state"](path, state)
            receipt = json.loads(request(base, key, "workspaces", "POST", b""))
            workspace = str(UUID(receipt["workspaceId"]))
            resource = receipt["resourceId"]
            if (
                workspace != receipt["workspaceId"]
                or not re.fullmatch(r"fs_[a-zA-Z0-9_-]{1,90}", resource)
                or not isinstance(receipt["expiresAt"], int)
                or receipt["expiresAt"] <= now()
            ):
                raise ValueError("Invalid Workspace receipt.")
            state.update(
                status="active", workspaceId=workspace, resourceId=resource, expiresAt=receipt["expiresAt"]
            )
            shared["save_state"](path, state)
        return sync_source(base, key, state, path, cache, data, action)


def sync_source(base, key, state, path, cache, data, action):
    prefix = "workspaces/{workspaceId}/sources/{resourceId}/".format(**state)

    def metadata():
        try:
            item = json.loads(request(base, key, prefix + "metadata"))["data"]
        except Rejected as error:
            if error.status == 404:
                return None
            raise
        if item.get("type") != "file" or not item.get("version"):
            raise ValueError("Cannot verify the stored CSV version.")
        return item["version"]

    version = metadata()
    content = None
    if version:
        if state.get("version") == version and cache.is_file() and cache.stat().st_size <= LIMIT:
            cached = cache.read_bytes()
            if digest(cached) == state.get("sha256"):
                content = cached
        if content is None:
            content = request(base, key, prefix + "content")
            if metadata() != version:
                raise ValueError("The stored CSV changed while opening. Resume again.")
    if data is None and content is None:
        raise ValueError("The CSV has not been saved. Retry upload with the original file.")
    uploaded = False
    if data is not None and data != content:
        if version and action != "replace":
            raise ValueError("This workspace already has a different CSV. Resume it, or explicitly request replacement.")
        if action == "replace" and version and state.get("version") not in (None, version):
            raise ValueError("The remote CSV changed. Resume it before replacing the source.")
        headers = {"If-Match": version} if version else {"If-None-Match": "*"}
        headers["Content-Type"] = "text/csv"
        request(base, key, prefix + "content", "PUT", data, headers)
        version = metadata()
        if not version or request(base, key, prefix + "content") != data or metadata() != version:
            raise ValueError("The upload could not be confirmed. Retry with the same file.")
        content, uploaded = data, True
    if not cache.is_file() or cache.stat().st_size != len(content) or cache.read_bytes() != content:
        shared["atomic_write"](cache, content)
    checksum = digest(content)
    if state.get("version") != version or state.get("sha256") != checksum:
        state.update(version=version, sha256=checksum)
        shared["save_state"](path, state)
    return {
        "status": "ready",
        "workspaceId": state["workspaceId"],
        "fileVersion": version,
        "uploaded": uploaded,
        "source": str(cache),
        "expiresAt": state["expiresAt"],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["upload", "resume", "replace", "forget", "new"])
    parser.add_argument("file", nargs="?", type=Path)
    parser.add_argument("--project", type=Path, default=Path.cwd())
    args = parser.parse_args()
    if (args.action in ("upload", "replace", "new")) != bool(args.file):
        parser.error("Select a file for upload, replace or new. Resume uses the saved remote file.")
    try:
        state_root = Path.home() / ".drive9" / "private-csv"
        result = private_csv(PRODUCTION, args.project, state_root, args.action, args.file)
        print(json.dumps(result))
    except (Rejected, ValueError, OSError, URLError, KeyringError, RuntimeError, ImportError) as error:
        sys.exit(str(error))
