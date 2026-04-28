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
    if os.environ.get("OMNIAGENT_SEED_AUDIT_ACTIVE") == "1":
        return
    env = os.environ.copy()
    env["OMNIAGENT_SEED_AUDIT_ACTIVE"] = "1"
    os.execve(str(preferred), [str(preferred), str(Path(__file__).resolve()), *sys.argv[1:]], env)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Print a compact summary of current seeded assets and audit state.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print JSON only.",
    )
    parser.add_argument(
        "--check-demo-ready",
        action="store_true",
        help="Validate the current seeded assets against the demo checklist baseline.",
    )
    return parser


def build_summary() -> dict[str, object]:
    sys.path.insert(0, str(ROOT_DIR))
    from backend import server

    skills = server.DB.list_skills()
    workflows = server.DB.list_workflows()
    query_templates = server.DB.list_query_templates()
    workflow_audit = server.RUNTIME.audit_workflows()
    document_audit = server.RUNTIME.audit_documents()

    seeded_skill_ids = sorted(
        str(item.get("skill_id") or "").strip()
        for item in skills
        if str(item.get("skill_id") or "").strip()
    )
    bound_seed_workflows = [
        {
            "workflow_id": str(item.get("workflow_id") or "").strip(),
            "name": str(item.get("name") or "").strip(),
            "bind_skill_id": str(item.get("bind_skill_id") or "").strip(),
        }
        for item in workflows
        if str(item.get("source_type") or "").strip() == "seed"
    ]
    bound_seed_workflows.sort(key=lambda item: item["workflow_id"])

    return {
        "skills": {
            "total": len(skills),
            "seeded_skill_ids": seeded_skill_ids,
        },
        "query_templates": {
            "total": len(query_templates),
            "ids": [str(item.get("template_id") or "").strip() for item in query_templates],
        },
        "workflows": {
            "summary": workflow_audit.get("summary", {}),
            "bound_seed_workflows": bound_seed_workflows,
        },
        "documents": {
            "summary": document_audit.get("summary", {}),
        },
    }


def evaluate_demo_readiness(summary: dict[str, object]) -> dict[str, object]:
    skills = summary.get("skills", {}) if isinstance(summary, dict) else {}
    workflows = summary.get("workflows", {}) if isinstance(summary, dict) else {}
    documents = summary.get("documents", {}) if isinstance(summary, dict) else {}
    query_templates = summary.get("query_templates", {}) if isinstance(summary, dict) else {}

    workflow_summary = workflows.get("summary", {}) if isinstance(workflows, dict) else {}
    document_summary = documents.get("summary", {}) if isinstance(documents, dict) else {}
    bound_seed_workflows = workflows.get("bound_seed_workflows", []) if isinstance(workflows, dict) else []
    unbound_seed_workflow_ids = [
        str(item.get("workflow_id") or "").strip()
        for item in bound_seed_workflows
        if not str(item.get("bind_skill_id") or "").strip()
    ]

    checks = [
        {
            "id": "seeded_skills",
            "ok": len(skills.get("seeded_skill_ids", []) or []) >= 2,
            "message": f"seeded skills >= 2 (current {len(skills.get('seeded_skill_ids', []) or [])})",
        },
        {
            "id": "query_templates",
            "ok": int(query_templates.get("total", 0) or 0) >= 2,
            "message": f"query templates >= 2 (current {int(query_templates.get('total', 0) or 0)})",
        },
        {
            "id": "seeded_workflows",
            "ok": int(workflow_summary.get("seeded", 0) or 0) >= 2,
            "message": f"seeded workflows >= 2 (current {int(workflow_summary.get('seeded', 0) or 0)})",
        },
        {
            "id": "workflow_bindings",
            "ok": not unbound_seed_workflow_ids,
            "message": (
                "all seeded workflows are bound to a skill"
                if not unbound_seed_workflow_ids
                else "unbound seeded workflows: " + ", ".join(unbound_seed_workflow_ids)
            ),
        },
        {
            "id": "workflow_cleanup_candidates",
            "ok": int(workflow_summary.get("cleanup_candidates", 0) or 0) == 0,
            "message": f"workflow cleanup candidates == 0 (current {int(workflow_summary.get('cleanup_candidates', 0) or 0)})",
        },
        {
            "id": "seeded_documents",
            "ok": int(document_summary.get("seeded", 0) or 0) >= 2,
            "message": f"seeded documents >= 2 (current {int(document_summary.get('seeded', 0) or 0)})",
        },
        {
            "id": "document_cleanup_candidates",
            "ok": int(document_summary.get("cleanup_candidates", 0) or 0) == 0,
            "message": f"document cleanup candidates == 0 (current {int(document_summary.get('cleanup_candidates', 0) or 0)})",
        },
    ]
    failures = [item["message"] for item in checks if not item["ok"]]
    return {
        "ok": not failures,
        "checks": checks,
        "failures": failures,
    }


def print_human_readable(summary: dict[str, object], demo_ready: dict[str, object] | None = None) -> None:
    skills = summary.get("skills", {})
    workflows = summary.get("workflows", {})
    documents = summary.get("documents", {})
    query_templates = summary.get("query_templates", {})
    print("== Seed Audit Summary ==")
    print(
        f"skills: total={skills.get('total', 0)}"
        f" seeded={len(skills.get('seeded_skill_ids', []) or [])}"
    )
    print(
        f"query_templates: total={query_templates.get('total', 0)}"
    )
    workflow_summary = workflows.get("summary", {}) if isinstance(workflows, dict) else {}
    print(
        f"workflows: total={workflow_summary.get('total', 0)}"
        f" seeded={workflow_summary.get('seeded', 0)}"
        f" cleanup_candidates={workflow_summary.get('cleanup_candidates', 0)}"
    )
    for item in workflows.get("bound_seed_workflows", []) or []:
        print(
            f"  - {item.get('workflow_id')}: {item.get('name')}"
            f" -> {item.get('bind_skill_id') or '[unbound]'}"
        )
    document_summary = documents.get("summary", {}) if isinstance(documents, dict) else {}
    print(
        f"documents: total={document_summary.get('total', 0)}"
        f" seeded={document_summary.get('seeded', 0)}"
        f" cleanup_candidates={document_summary.get('cleanup_candidates', 0)}"
    )
    if demo_ready is not None:
        print("\n== Demo Ready Check ==")
        status = "PASS" if demo_ready.get("ok") else "FAIL"
        print(f"status: {status}")
        for item in demo_ready.get("checks", []) or []:
            marker = "ok" if item.get("ok") else "fail"
            print(f"  [{marker}] {item.get('message')}")
    print("\n== JSON ==")
    payload: dict[str, object] = {"summary": summary}
    if demo_ready is not None:
        payload["demo_ready"] = demo_ready
    print(json.dumps(payload if demo_ready is not None else summary, ensure_ascii=False, indent=2))


def main() -> int:
    maybe_reexec_in_venv()
    args = build_parser().parse_args()
    summary = build_summary()
    demo_ready = evaluate_demo_readiness(summary) if args.check_demo_ready else None
    if args.json:
        payload: dict[str, object] = {"summary": summary}
        if demo_ready is not None:
            payload["demo_ready"] = demo_ready
        print(json.dumps(payload if demo_ready is not None else summary, ensure_ascii=False, indent=2))
    else:
        print_human_readable(summary, demo_ready)
    if demo_ready is not None and not demo_ready.get("ok"):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
