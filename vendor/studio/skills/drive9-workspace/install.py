"""Install only the TiDB Agent Workspace skill and its private Python environment."""

from contextlib import contextmanager
import hashlib
import json
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
    if sys.version_info < (3, 9, 2):
        sys.exit("The TiDB Agent Workspace report tool requires Python 3.9.2 or later.")
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
    previous_path = skills / ".drive9-assets.json"
    previous = json.loads(previous_path.read_text()) if previous_path.is_file() else LEGACY_ASSETS
    for name, expected in ASSETS.items():
        installed = skills / name
        if installed.is_symlink():
            sys.exit("Preserve the existing symlinked skill before installing.")
        if installed.exists() and hashlib.sha256(installed.read_bytes()).hexdigest() not in (expected, previous.get(name)):
            sys.exit(f"Local changes in {name} were preserved. Reconcile them before updating the skill.")
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
    if not python.is_file():
        venv.EnvBuilder(with_pip=True).create(runtime)
    versions = subprocess.run([str(python), "-I", "-c", "import importlib.metadata as m; print(','.join(m.version(n) for n in ('keyring', 'cryptography')))"], capture_output=True, text=True)
    if versions.returncode != 0 or versions.stdout.strip() != "25.6.0,46.0.5":
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
    previous_path.write_text(json.dumps(ASSETS))
    print(f"Installed. Run {python} -I {skills / 'report.py'} start in your project.")


# fmt: off
LEGACY_ASSETS = {"SKILL.md":"69989c9db22cb59664962886bc0fd2f2ade4b1c1e07b249b38ab3038d165fdce","report.py":"4124d8ce10041b0fe6ff06f5ce22d975ccd1f433338ed51071441eda43db6f06","private_csv.py":"2f964c6b234456a80e5d5ace57d3a70882375dbeddbedee87fe22d970d3cc262"}
ASSETS = {"SKILL.md":"ee88d6bf0f5a97220e4d75a1b03ae058e534c745cf52dc15f38fd82b55cd90d8","private-csv.md":"d0aa435ed87d90b1e08b3066ff0ea3d8c012efc93f0eb73caa91859bdcfcb627","workspace-api.md":"93d3acc36e4f55d34bf4700a3634373cfbedd96514a12171af51f9e44cb4ed0b","report.py":"ab4eacd8a92efe48089bb6a74e7bddbcdf0db01af69baae1684b1d04abbc45e0","private_csv.py":"2041a22bec056115359f7ba6982e662f587437d6fc442895898b371814233171"}
# fmt: on

if __name__ == "__main__":
    install()
