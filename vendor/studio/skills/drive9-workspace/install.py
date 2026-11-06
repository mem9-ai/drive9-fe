"""Install only the TiDB Agent Workspace skill and its private Python environment."""

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
        sys.exit("The TiDB Agent Workspace report tool requires Python 3.10 or later.")
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
            "A custom skill already occupies the install directory. Preserve it before installing."
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
ASSETS = {"SKILL.md":"144dc9559f7025a3c7a061ee53a235fb16c6a0fd55261ef9c652ebdadf050b71","report.py":"4124d8ce10041b0fe6ff06f5ce22d975ccd1f433338ed51071441eda43db6f06","private_csv.py":"2f964c6b234456a80e5d5ace57d3a70882375dbeddbedee87fe22d970d3cc262"}
# fmt: on

if __name__ == "__main__":
    install()
