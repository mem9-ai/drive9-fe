"""TiDB Agent Workspace free public-sample report. Run with the installation's isolated Python."""

import argparse
import base64
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid
from collections import Counter
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from contextlib import contextmanager
from keyring.errors import KeyringError

PRODUCTION = "https://drive9.ai/studio"
SAMPLE_DIGEST = "d79064c635829b0aeac2824b49e3e189a838dd52f1669567f2efa8913c8e1f06"
LIFETIME = 48 * 3600


@contextmanager
def project_lock(path, timeout=40):
    """OS-owned lock; process exit releases it, including interrupted agents."""
    with open(path, "a+b") as lock:
        if os.name == "nt":
            import msvcrt
            if not os.fstat(lock.fileno()).st_size:
                lock.write(b"0")
                lock.flush()
            def acquire():
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            def release():
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            def acquire():
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            def release():
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        deadline = time.monotonic() + timeout
        while True:
            try:
                acquire()
                break
            except (BlockingIOError, PermissionError):
                if time.monotonic() >= deadline:
                    raise TimeoutError("Another agent is using this project. Retry when it finishes.")
                time.sleep(0.1)
        try:
            yield
        finally:
            release()


def native_store():
    if sys.platform == "darwin":
        from keyring.backends.macOS import Keyring

        return Keyring()
    if sys.platform == "win32":
        from keyring.backends.Windows import WinVaultKeyring

        store = WinVaultKeyring()
        store.persist = "local_machine"
        return store
    if sys.platform.startswith("linux"):
        from keyring.backends.SecretService import Keyring

        # Probe D-Bus before the first lookup. Headless hosts can lack a session bus.
        if Keyring.priority > 0:
            return Keyring()
    raise KeyringError("Unsupported operating-system credential store.")


def atomic_write(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temp = Path(handle.name)
        try:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
    try:
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def save_state(path, state):
    atomic_write(path, json.dumps(state, sort_keys=True).encode())


def encode(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class TrialError(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status = status


def api(base, route, *, token=None, payload=None, version=None, method=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Trial " + token
    if version is not None:
        headers["If-Match"] = f'"{version}"'
    data = json.dumps(payload).encode() if payload is not None else None
    req = Request(
        f"{base}/api/v1/agent-trial/{route}", data=data, headers=headers, method=method
    )
    try:
        with build_opener(NoRedirect).open(req, timeout=12) as response:
            raw = response.read(65537)
    except HTTPError as error:
        try:
            code = json.loads(error.read(4096))["error"]["code"]
        except (ValueError, KeyError, TypeError):
            code = f"HTTP_{error.code}"
        raise TrialError(error.code, str(code)) from None
    if len(raw) > 65536:
        raise ValueError("Oversized trial response.")
    return raw if route.endswith(".csv") else json.loads(raw)


def verify_sample(sample, products, saved=None):
    if hashlib.sha256(sample).hexdigest() != SAMPLE_DIGEST:
        raise ValueError("The public sales sample failed integrity verification.")
    rows = list(csv.DictReader(io.StringIO(sample.decode("utf-8"))))
    states = Counter()
    for row in rows:
        states[row["state"]] += int(row["sales_usd"])
    state, leading_sales = states.most_common(1)[0]
    if saved is not None and (
        saved["sample"] != "us-sales-v1" or saved["stateSales"] != states
    ):
        raise ValueError("Saved state totals differ from the verified public sample.")
    total = sum(states.values())
    finding = f"{state} leads with ${leading_sales:,.0f}, {leading_sales / total:.1%} of total sales."
    if products:
        breakdown = Counter()
        for row in rows:
            if row["state"] == state:
                breakdown[row["product"]] += int(row["sales_usd"])
        if saved is not None and saved["leadingStateProducts"] != breakdown:
            raise ValueError(
                "Saved product totals differ from the verified public sample."
            )
        product, sales = breakdown.most_common(1)[0]
        finding = f"{state}'s top product is {product}: ${sales:,.0f}, {sales / leading_sales:.1%} of the state's sales."
    return finding


def project_dir(path, exact=False):
    root = path.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Open the folder where you want to keep this report.")
    if exact:
        return root
    for candidate in (root, *root.parents):
        if candidate == Path.home().resolve() or candidate == candidate.parent:
            break
        if (candidate / ".git").exists():
            return candidate
    return root


class ProjectChoice(ValueError):
    def __init__(self, previous, current):
        self.previous, self.current = previous, current
        super().__init__(
            f"An earlier report or CSV workspace is saved under {previous}. "
            f"Choose: continue there, or start a separate report in {current}. "
            "Your existing files and key have not been changed."
        )


def resolve_project(path, home, binding_for, action, exact=False):
    project = project_dir(path, exact)
    def bound(root):
        return (home / binding_for(root) / "binding.json").is_file()
    if not exact:
        # An explicitly selected subfolder stays the project on later agent handoffs.
        for candidate in (path.resolve(strict=True), *path.resolve(strict=True).parents):
            if candidate == Path.home().resolve() or candidate == candidate.parent:
                break
            if bound(candidate):
                project = candidate
                break
            if (candidate / ".git").exists():
                break
    # Older helpers climbed past the home boundary. Never silently replace that identity.
    if not bound(project) and action != "new":
        root = path.resolve(strict=True)
        previous = next((p for p in (root, *root.parents) if (p / ".git").exists()), root)
        if previous != project and bound(previous):
            raise ProjectChoice(previous, project)
    if (project == Path.home().resolve() or project == project.parent) and (
        not bound(project) or action == "new"
    ):
        raise ValueError("Open or create a project folder first. A new report cannot use your entire home or filesystem root.")
    return project


def trial(base, project, home, action, store_factory=native_store, now=time.time, project_exact=False, announce=None):
    address = urlsplit(base)
    if base != PRODUCTION and not (
        address.scheme == "http"
        and address.hostname in ("127.0.0.1", "::1")
        and not address.username
        and not address.password
        and not address.query
        and not address.fragment
    ):
        raise ValueError(
            "Use the official Studio address or a local loopback test server."
        )
    def binding_for(root):
        return hashlib.sha256(f"{base}\0{os.path.normcase(str(root))}".encode()).hexdigest()
    project = resolve_project(project, home, binding_for, action, project_exact)
    if announce:
        announce(project)
    binding = binding_for(project)
    directory = home / binding
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with project_lock(str(directory / "binding.lock"), timeout=40):
        path = directory / "binding.json"
        state = json.loads(path.read_text()) if path.exists() else {}
        service = "Drive9 Agent Trial " + binding
        expired = state.get("expiresAt", float("inf")) <= now()
        terminal = state.get("status") in ("expired", "forgotten")
        cleanup = expired or action == "forget"
        if terminal and action not in ("new", "forget"):
            return {"status": state["status"], "report": state.get("projectFile", state.get("file"))}
        try:
            store = store_factory()
            secret = store.get_password(service, "project")
            if cleanup:
                if secret is not None:
                    store.delete_password(service, "project")
                secret = None
                state.update(status="forgotten" if action == "forget" else "expired")
                save_state(path, state)
                if action != "new":
                    return {"status": state["status"], "report": state.get("projectFile", state.get("file"))}
            if action == "new":
                if state and not (terminal or expired):
                    raise ValueError(
                        "This trial is active. Use start to reopen its report."
                    )
                state = {}
                terminal = False
                action = "start"
            if terminal:
                return {"status": state["status"], "report": state.get("projectFile", state.get("file"))}
            if secret is None:
                if state.get("reportId") or action != "start":
                    raise ValueError(
                        "Project credential unavailable. The existing local report is retained."
                    )
                if not state:
                    state = {"expiresAt": int(now()) + LIFETIME}
                    save_state(path, state)
                private = Ed25519PrivateKey.generate()
                secret = encode(private.private_bytes_raw())
                store.set_password(service, "project", secret)
            private = Ed25519PrivateKey.from_private_bytes(
                base64.urlsafe_b64decode(secret + "==")
            )
        except (KeyringError, ImportError, RuntimeError, OSError) as error:
            raise ValueError(
                "The OS credential store is unavailable or locked. Existing files and identity were preserved. Enable or unlock it before continuing; no replacement credential was created."
            ) from error

        sample_file = directory / "us-sales-v1.csv"
        if not sample_file.exists():
            downloaded = api(base, "us-sales-v1.csv")
            verify_sample(downloaded, False)
            atomic_write(sample_file, downloaded)
        sample = sample_file.read_bytes()
        try:
            return sync_report(
                base, action, private, path, state, directory, sample, store, service, project
            )
        except (URLError, TimeoutError, TrialError) as error:
            action_name = "Sharing revocation" if action == "unshare" else "Remote save"
            raise ValueError(
                f"{action_name} unconfirmed ({error}). Existing files and key were retained. Retry the same command to recover."
            ) from error


def sync_report(base, action, private, path, state, directory, sample, store, service, project):
    enroll = action == "start" and "reportId" not in state
    challenge = api(base, "challenges", payload={})["challenge"]
    message = f"drive9/trial/v1\n{challenge}\n{'start' if enroll else 'resume'}"
    proof = {
        "publicKey": encode(private.public_key().public_bytes_raw()),
        "signature": encode(private.sign(message.encode())),
        "challenge": challenge,
        "enroll": enroll,
    }
    try:
        session = api(base, "sessions", payload=proof)
    except TrialError as error:
        if error.status == 410:
            store.delete_password(service, "project")
            state["status"] = "expired"
            save_state(path, state)
            return {"status": "expired", "report": state.get("projectFile", state.get("file"))}
        raise
    report = session["report"]
    report_id = str(uuid.UUID(report["id"]))
    if state.get("reportId", report_id) != report_id:
        raise ValueError("Unexpected trial identity. Existing report preserved.")
    state.update(reportId=report_id, expiresAt=report["expiresAt"], status="active")
    save_state(path, state)
    token = session["token"]
    if action == "unshare":
        revoked = api(base, "report-sharing", token=token, method="DELETE")
        if not revoked.get("sharingRevoked"):
            raise ValueError("Sharing revocation was not confirmed. Keep your key and retry.")
        return {"status": "sharing-revoked", "report": state.get("projectFile", state.get("file")), "reportId": report_id}
    desired = 2 if action == "products" else 1
    result = api(base, "report", token=token)
    if action == "products" and result["revision"] == 0:
        raise ValueError(
            "Run the first sales report before adding the product breakdown."
        )
    # A retry reads the committed revision first, including after a lost write receipt.
    if result["revision"] < desired:
        try:
            api(
                base,
                "report",
                method="PUT",
                token=token,
                version=result["revision"],
                payload={"section": "products" if desired == 2 else "states"},
            )
        except TrialError as error:
            if error.status != 412:
                raise
        result = api(base, "report", token=token)
    if result["id"] != report_id or result["revision"] < desired:
        raise ValueError("Remote save unconfirmed. Resume to recover.")
    finding = verify_sample(sample, result["revision"] == 2, result)
    text = result.get("markdown")
    if not isinstance(text, str) or not text:
        raise ValueError("The server did not return the canonical report. Retry after the service update.")
    file = directory / f"{report_id}.md"
    atomic_write(file, text.encode())
    state["file"] = str(file)
    folder = project / "reports" / "tidb-agent-workspace"
    for parent in (project / "reports", folder):
        if parent.is_symlink() or (parent.exists() and not parent.is_dir()):
            raise ValueError("The report directory must be a regular project directory.")
        parent.mkdir(exist_ok=True)
    source = folder / "us-sales.csv"
    if source.is_symlink() or (source.exists() and source.read_bytes() != sample):
        raise ValueError("The project sample has local edits. Preserve them before continuing.")
    if not source.exists():
        atomic_write(source, sample)
    local = Path(state.get("projectFile", folder / "report.md"))
    if local.parent != folder or local.is_symlink():
        raise ValueError("Unexpected project report path.")
    if "projectFile" not in state:
        index = 2
        while local.exists():
            local = folder / f"report-{index}.md"
            index += 1
    elif local.exists() and hashlib.sha256(local.read_bytes()).hexdigest() != state.get("projectHash") and local.read_text() != text:
        raise ValueError("The project report has local edits. They were preserved.")
    atomic_write(local, text.encode())
    state.update(projectFile=str(local), projectHash=hashlib.sha256(text.encode()).hexdigest())
    save_state(path, state)
    expiry = result["expiresAt"]
    view_proof = private.sign(f"drive9/trial/report-view/v1\n{report_id}\n{expiry}".encode())
    grant = f"v1.{proof['publicKey']}.{report_id}.{expiry}.{encode(view_proof)}"
    return {
        "status": "synced",
        "finding": finding,
        "reportId": report_id,
        "version": result["revision"],
        **({"studioUrl": f"{base}/report/#{grant}", "insightsUrl": f"{base}/report/?view=markets#{grant}"} if not result.get("sharingRevoked") else {}),
        "sharingRevoked": result.get("sharingRevoked", False),
        "report": str(local),
        "source": str(source),
        "expiresAt": datetime.fromtimestamp(
            result["expiresAt"], timezone.utc
        ).isoformat(),
        "markdown": text,
    }


def human_result(result):
    status = result["status"]
    if status == "synced":
        lines = [result["finding"]]
        if result.get("studioUrl"):
            lines += [f"View report in Studio: {result['studioUrl']}",
                      f"Anyone with this link can view until {result['expiresAt']}. Ask your agent to close sharing (unshare) to revoke it."]
        else:
            lines += ["Sharing is closed. Your report remains available locally."]
        lines += [f"Local report: {result['report']}"]
        lines += ["Next: open the Studio report to explore its saved files in Workspace."] if result.get("studioUrl") else ["Next: continue with this project open in your agent."]
        return "\n".join(lines)
    lines = [{"expired": "This trial has expired. Local files are retained.",
              "forgotten": "The local credential was removed. Local files are retained; shared links were not revoked.",
              "sharing-revoked": "Shared links are closed. Your local report and editing access are retained."}.get(status, status)]
    if result.get("report"):
        lines.append(f"Local report: {result['report']}")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["start", "products", "unshare", "forget", "new"])
    parser.add_argument("--project", type=Path, help="Use this exact project folder")
    parser.add_argument("--json", action="store_true", help="Return the complete machine-readable result")
    parser.add_argument("--studio", default=PRODUCTION, help="Override only for loopback development")
    args = parser.parse_args()
    try:
        project = args.project if args.project is not None else Path.cwd()
        exact = args.project is not None
        def announce(resolved):
            print(f"Report folder: {resolved / 'reports' / 'tidb-agent-workspace'}", file=sys.stderr)
        result = trial(args.studio, project, Path.home() / ".drive9" / "agent-trials", args.action, project_exact=exact, announce=announce)
        print(json.dumps(result) if args.json else human_result(result))
        return 0
    except ProjectChoice as error:
        choices = {"status": "needs-project-choice", "message": str(error), "options": [
            {"label": "Continue the existing report", "action": args.action, "project": str(error.previous)},
            {"label": "Start a separate report here", "action": "new", "project": str(error.current)},
        ]}
        print(json.dumps(choices) if args.json else str(error))
        return 2
    except (ValueError, TrialError, URLError, OSError, KeyringError, TimeoutError) as error:
        print(f"TiDB Agent Workspace: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
