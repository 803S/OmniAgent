from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = ROOT_DIR.parent


def preferred_python() -> Path | None:
    candidates = [
        ROOT_DIR / ".venv" / "bin" / "python",
        ROOT_DIR / ".venv" / "Scripts" / "python.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def maybe_reexec_in_venv() -> None:
    preferred = preferred_python()
    if not preferred:
        return
    venv_root = (ROOT_DIR / ".venv").resolve()
    if Path(sys.prefix).resolve() == venv_root:
        return
    if os.environ.get("OMNIAGENT_SELF_CHECK_ACTIVE") == "1":
        return
    env = os.environ.copy()
    env["OMNIAGENT_SELF_CHECK_ACTIVE"] = "1"
    os.execve(str(preferred), [str(preferred), str(Path(__file__).resolve())], env)


def section(title: str) -> None:
    print(f"\n== {title} ==", flush=True)


def run_command(label: str, command: list[str], env: dict[str, str]) -> None:
    print(f"[run] {label}: {' '.join(command)}", flush=True)
    completed = subprocess.run(command, cwd=ROOT_DIR, env=env)
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)


def local_api_probe(env: dict[str, str]) -> None:
    section("Local API Probe")
    sys.path.insert(0, str(ROOT_DIR))
    from backend import server

    client = server.app.test_client()
    checks: list[tuple[str, int]] = [
        ("/api/personas", 200),
        ("/api/skills", 200),
        ("/api/workflows", 200),
        ("/api/workflows/audit", 200),
        ("/api/query-templates", 200),
        ("/api/documents", 200),
        ("/api/documents/audit", 200),
        ("/frontend/page-agent.vendor.js", 200),
        ("/frontend/regression", 200),
        ("/frontend/regression/manifest.json", 200),
    ]
    for path, expected_status in checks:
        response = client.get(path)
        if response.status_code != expected_status:
            raise SystemExit(f"Probe failed for {path}: expected {expected_status}, got {response.status_code}")
        print(f"[ok] {path} -> {response.status_code}")
        response.close()
    manifest_response = client.get("/frontend/regression/manifest.json")
    try:
        manifest = json.loads(manifest_response.get_data(as_text=True) or "{}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Probe failed for /frontend/regression/manifest.json: invalid json ({exc})") from exc
    finally:
        manifest_response.close()
    fixtures = manifest.get("fixtures") or []
    if not isinstance(fixtures, list) or not fixtures:
        raise SystemExit("Probe failed for /frontend/regression/manifest.json: fixtures 不能为空")
    for item in fixtures:
        if not isinstance(item, dict):
            raise SystemExit("Probe failed for /frontend/regression/manifest.json: fixture entry 必须是对象")
        path = str(item.get("path", "")).strip()
        if not path.startswith("/frontend/regression/"):
            raise SystemExit(f"Probe failed for /frontend/regression/manifest.json: invalid fixture path {path!r}")
        response = client.get(path)
        if response.status_code != 200:
            raise SystemExit(f"Probe failed for {path}: expected 200, got {response.status_code}")
        print(f"[ok] {path} -> {response.status_code}")
        response.close()


def main() -> int:
    maybe_reexec_in_venv()
    section("Workspace")
    print(f"[info] root={ROOT_DIR}", flush=True)
    print(f"[info] project={PROJECT_DIR}", flush=True)
    print(f"[info] python={sys.executable}", flush=True)

    env = os.environ.copy()
    env["PYTHONPATH"] = str(PROJECT_DIR)
    with tempfile.TemporaryDirectory(prefix="omniagent-pycache-") as pycache_dir:
        env["PYTHONPYCACHEPREFIX"] = pycache_dir

        section("Python Syntax")
        run_command(
            "py_compile",
            [
                sys.executable,
                "-m",
                "py_compile",
                str(ROOT_DIR / "backend" / "server.py"),
                str(ROOT_DIR / "backend" / "db.py"),
                str(ROOT_DIR / "tests" / "test_baseline_smoke.py"),
                str(ROOT_DIR / "scripts" / "document_cleanup.py"),
                str(ROOT_DIR / "scripts" / "self_check.py"),
                str(ROOT_DIR / "scripts" / "seed_audit_summary.py"),
                str(ROOT_DIR / "scripts" / "workflow_cleanup.py"),
            ],
            env,
        )

        section("Backend Smoke")
        run_command(
            "unittest",
            [sys.executable, "-m", "unittest", "tests.test_baseline_smoke"],
            env,
        )

        section("Frontend Syntax")
        node_path = shutil.which("node")
        if node_path:
            run_command(
                "node --check",
                [node_path, "--check", str(ROOT_DIR / "frontend" / "omniagent.user.js")],
                env,
            )
        else:
            print("[skip] node not found; frontend syntax check skipped", flush=True)

        local_api_probe(env)

        section("Seed Audit")
        run_command(
            "seed_audit_summary --check-demo-ready",
            [sys.executable, str(ROOT_DIR / "scripts" / "seed_audit_summary.py"), "--check-demo-ready"],
            env,
        )

    section("Done")
    print("[ok] self-check passed", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
