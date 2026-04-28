from __future__ import annotations

import argparse
import json
import os
import sys
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
    if os.environ.get("OMNIAGENT_WORKFLOW_CLEANUP_ACTIVE") == "1":
        return
    env = os.environ.copy()
    env["OMNIAGENT_WORKFLOW_CLEANUP_ACTIVE"] = "1"
    os.execve(str(preferred), [str(preferred), str(Path(__file__).resolve()), *sys.argv[1:]], env)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Dry-run or apply workflow cleanup based on audit flags.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually archive matched workflows. Default is dry-run only.",
    )
    parser.add_argument(
        "--audit-flag",
        action="append",
        dest="audit_flags",
        default=[],
        help="Audit flag to match. Can be repeated. Default: generic_name + invalid_steps.",
    )
    parser.add_argument(
        "--source-type",
        default="manual",
        help="Only match workflows with this source_type. Default: manual.",
    )
    return parser


def main() -> int:
    maybe_reexec_in_venv()
    parser = build_parser()
    args = parser.parse_args()

    sys.path.insert(0, str(ROOT_DIR))
    from backend import server

    audit_flags = args.audit_flags or ["generic_name", "invalid_steps"]
    payload = {
        "audit_flags": audit_flags,
        "source_type": args.source_type,
        "dry_run": not args.apply,
    }
    result = server.RUNTIME.archive_workflows(payload)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result.get("matched_count", 0) == 0:
        print("\n[info] no workflows matched the requested cleanup filter")
    elif args.apply:
        print(f"\n[ok] archived {result.get('archived_count', 0)} workflow(s)")
    else:
        print(f"\n[info] dry-run matched {result.get('matched_count', 0)} workflow(s); rerun with --apply to archive")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
