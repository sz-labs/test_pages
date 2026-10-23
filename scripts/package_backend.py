"""Create a backend source bundle from an explicit, credential-free file list."""
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    ".dockerignore",
    "backend/__init__.py",
    "backend/app.py",
    "backend/check_connection.py",
    "backend/excel.py",
    "backend/repository.py",
    "backend/settings.py",
    "backend/requirements.txt",
    "backend/Dockerfile",
    "backend/compose.yaml",
    "backend/Caddyfile",
    "backend/.env.example",
    "backend/mysql.example.yaml",
    "backend/DEPLOY.md",
)


def main():
    output = ROOT / "dist"
    output.mkdir(exist_ok=True)
    archive = output / "inventory-backend.tar.gz"
    manifest = []
    with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT) as bundle:
        for name in FILES:
            source = ROOT / name
            if source.is_symlink() or not source.is_file():
                raise ValueError(f"Missing or unsafe bundle file: {name}")
            content = source.read_bytes()
            info = tarfile.TarInfo(name)
            info.size = len(content)
            info.mode = 0o644
            bundle.addfile(info, BytesIO(content))
            manifest.append({"path": name, "bytes": len(content), "sha256": sha256(content).hexdigest()})
    digest = sha256(archive.read_bytes()).hexdigest()
    (output / (archive.name + ".sha256")).write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
    (output / "inventory-backend.manifest.json").write_text(
        json.dumps({"archive": archive.name, "sha256": digest, "files": manifest}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Backend bundle: {archive}")
    print(f"Files: {len(manifest)}; size: {archive.stat().st_size} bytes")
    print(f"SHA-256: {digest}")
    print("Private MySQL YAML, .env, admin passwords, tests and business Excel files are excluded.")


if __name__ == "__main__":
    main()
