"""Install only the public Drive9 report skill and its private Python environment."""

from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.request
import venv


@contextmanager
def installation_lock(path):
    # This lock must work before any third-party packages have been installed.
    with path.open("a+b") as lock:
        if os.name == "nt":
            import msvcrt

            if not path.stat().st_size:
                lock.write(b"0")
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        yield


def install():
    if sys.version_info < (3, 10):
        sys.exit("The Drive9 report tool requires Python 3.10 or later.")
    skills = Path.home() / ".agents" / "skills" / "drive9-workspace"
    runtime = Path.home() / ".drive9" / "report-runtime"
    runtime.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with installation_lock(runtime.parent / "report-install.lock"):
        install_assets(skills, runtime)


def install_assets(skills, runtime):
    base = "https://drive9.ai/studio/skills/drive9-workspace/"
    # Refuse to overwrite a personal skill with the same name.
    marker = skills / ".drive9-installed"
    if skills.exists() and not marker.is_file():
        sys.exit(
            "An unmanaged drive9-workspace skill already exists. Preserve it before installing."
        )
    python = runtime / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if (
        marker.is_file()
        and python.is_file()
        and all(
            (skills / name).is_file()
            and hashlib.sha256((skills / name).read_bytes()).hexdigest() == digest
            for name, digest in ASSETS.items()
        )
    ):
        return
    assets = {}
    for name, digest in ASSETS.items():
        with urllib.request.urlopen(base + name, timeout=15) as response:
            if response.geturl() != base + name:
                sys.exit("Unexpected Studio asset redirect.")
            data = response.read(131073)
        if hashlib.sha256(data).hexdigest() != digest:
            sys.exit(
                "Studio assets changed. Read the current official skill and retry installation."
            )
        assets[name] = data
    venv.EnvBuilder(with_pip=True).create(runtime)
    subprocess.run(
        [
            str(python),
            "-I",
            "-m",
            "pip",
            "install",
            "--only-binary=:all:",
            "keyring==25.6.0",
            "cryptography==46.0.5",
            "filelock==3.25.2",
        ],
        check=True,
    )
    skills.mkdir(parents=True, exist_ok=True)
    marker.touch()
    for name, data in assets.items():
        with tempfile.NamedTemporaryFile(dir=skills, delete=False) as handle:
            handle.write(data)
            file = handle.name
        os.replace(file, skills / name)
    print(f"Installed. Run {python} -I {skills / 'report.py'} start in your project.")


# fmt: off
ASSETS = {"SKILL.md":"7d450110b83a54a738fac3b9cd9a5d86fa8fa473f202cb7db8f8b63bb80aedbf","report.py":"bd2171049e246037074b1f6e9ed8f6af9b6bd863890552be707c0ad4005497e4"}
# fmt: on

if __name__ == "__main__":
    install()
