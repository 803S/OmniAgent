from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def dumps_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def loads_json(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    if isinstance(value, (list, dict)):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def stable_id(prefix: str, seed: str) -> str:
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{digest}"


def decode_record(record: dict[str, Any]) -> dict[str, Any]:
    decoded = dict(record)
    for key, value in list(decoded.items()):
        if key.endswith("_json"):
            default = [] if isinstance(value, str) and value.strip().startswith("[") else {}
            decoded[key] = loads_json(value, default)
    return decoded


class Database:
    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def initialize(
        self,
        personas_seed: dict[str, Any],
        sops_seed: dict[str, Any],
        query_template_seed: dict[str, Any] | None = None,
        document_seed: dict[str, Any] | None = None,
        workflow_seed: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        with self.connect() as conn:
            self._create_schema(conn)
            seeded = self._seed_personas(conn, personas_seed)
            imported = self._seed_skills(conn, sops_seed)
            workflows_seeded = self._seed_workflows(conn, workflow_seed or {})
            templates_seeded = self._seed_query_templates(conn, query_template_seed or {})
            documents_seeded = self._seed_documents(conn, document_seed or {})
            conn.commit()
        return {
            "personas_seeded": seeded,
            "skills_imported": imported,
            "workflows_seeded": workflows_seeded,
            "query_templates_seeded": templates_seeded,
            "documents_seeded": documents_seeded,
        }

    def _create_schema(self, conn: sqlite3.Connection) -> None:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS personas (
                persona_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                system_prompt TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS skills (
                skill_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                role_id TEXT NOT NULL,
                activation_condition TEXT NOT NULL,
                exact_match_signatures_json TEXT NOT NULL,
                extraction_tasks_json TEXT NOT NULL,
                skills_json TEXT NOT NULL,
                site_scope_json TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_skills_role_id ON skills(role_id);
            CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);

            CREATE TABLE IF NOT EXISTS workflows (
                workflow_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                summary TEXT NOT NULL,
                bind_skill_id TEXT,
                site_scope_json TEXT NOT NULL,
                steps_json TEXT NOT NULL,
                require_human_confirm INTEGER NOT NULL,
                source_type TEXT NOT NULL DEFAULT 'manual',
                version INTEGER NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS traces (
                trace_id TEXT PRIMARY KEY,
                context_key TEXT NOT NULL,
                page_url TEXT,
                page_title TEXT,
                matched_persona TEXT,
                matched_skill_ids_json TEXT NOT NULL,
                extracted_fields_json TEXT NOT NULL,
                memory_selection_source TEXT,
                selected_memory_ids_json TEXT NOT NULL DEFAULT '[]',
                memory_selection_reason TEXT,
                workflow_selection_source TEXT,
                selected_workflow_ids_json TEXT NOT NULL DEFAULT '[]',
                workflow_selection_reason TEXT,
                workflow_matches_json TEXT NOT NULL DEFAULT '[]',
                executed_steps_json TEXT NOT NULL,
                failed_step_json TEXT NOT NULL,
                healing_detail_json TEXT NOT NULL DEFAULT '{}',
                healing_state TEXT,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_traces_context_key ON traces(context_key);
            CREATE INDEX IF NOT EXISTS idx_traces_created_at ON traces(created_at);

            CREATE TABLE IF NOT EXISTS workflow_heal_events (
                heal_id TEXT PRIMARY KEY,
                workflow_id TEXT NOT NULL,
                trace_id TEXT,
                step_index INTEGER NOT NULL,
                old_step_json TEXT NOT NULL,
                new_step_json TEXT NOT NULL,
                reason TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS query_templates (
                template_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                namespace TEXT NOT NULL,
                platform TEXT NOT NULL,
                summary TEXT NOT NULL,
                query_template TEXT NOT NULL,
                url_template TEXT,
                required_fields_json TEXT NOT NULL,
                tags_json TEXT NOT NULL,
                site_scope_json TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS documents (
                document_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                doc_type TEXT NOT NULL,
                namespace TEXT NOT NULL,
                source_type TEXT NOT NULL,
                content_text TEXT NOT NULL,
                tags_json TEXT NOT NULL,
                site_scope_json TEXT NOT NULL,
                rag_mode TEXT NOT NULL,
                chunk_count INTEGER NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS stats_calls (
                call_id TEXT PRIMARY KEY,
                request_type TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model_id TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                cost_usd REAL NOT NULL,
                latency_ms INTEGER NOT NULL,
                used_vision INTEGER NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        self._ensure_workflow_columns(conn)
        self._ensure_trace_columns(conn)

    def _ensure_workflow_columns(self, conn: sqlite3.Connection) -> None:
        workflow_columns = {row["name"] for row in conn.execute("PRAGMA table_info(workflows)").fetchall()}
        if "source_type" not in workflow_columns:
            conn.execute("ALTER TABLE workflows ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual'")

    def _ensure_trace_columns(self, conn: sqlite3.Connection) -> None:
        trace_columns = {row["name"] for row in conn.execute("PRAGMA table_info(traces)").fetchall()}
        if "memory_selection_source" not in trace_columns:
            conn.execute("ALTER TABLE traces ADD COLUMN memory_selection_source TEXT")
        if "selected_memory_ids_json" not in trace_columns:
            conn.execute("ALTER TABLE traces ADD COLUMN selected_memory_ids_json TEXT NOT NULL DEFAULT '[]'")
        if "memory_selection_reason" not in trace_columns:
            conn.execute("ALTER TABLE traces ADD COLUMN memory_selection_reason TEXT")
        if "workflow_selection_source" not in trace_columns:
            conn.execute("ALTER TABLE traces ADD COLUMN workflow_selection_source TEXT")
        if "selected_workflow_ids_json" not in trace_columns:
            conn.execute("ALTER TABLE traces ADD COLUMN selected_workflow_ids_json TEXT NOT NULL DEFAULT '[]'")
        if "workflow_selection_reason" not in trace_columns:
            conn.execute("ALTER TABLE traces ADD COLUMN workflow_selection_reason TEXT")
        if "workflow_matches_json" not in trace_columns:
            conn.execute("ALTER TABLE traces ADD COLUMN workflow_matches_json TEXT NOT NULL DEFAULT '[]'")
        if "healing_detail_json" not in trace_columns:
            conn.execute("ALTER TABLE traces ADD COLUMN healing_detail_json TEXT NOT NULL DEFAULT '{}'")

    def _seed_personas(self, conn: sqlite3.Connection, personas_seed: dict[str, Any]) -> int:
        count = 0
        for persona_id, persona in personas_seed.items():
            existing = conn.execute("SELECT persona_id FROM personas WHERE persona_id = ?", (persona_id,)).fetchone()
            if existing:
                continue
            now = now_iso()
            conn.execute(
                """
                INSERT INTO personas (persona_id, name, system_prompt, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    persona_id,
                    persona.get("name", persona_id),
                    persona.get("system_prompt", ""),
                    now,
                    now,
                ),
            )
            count += 1
        return count

    def _seed_skills(self, conn: sqlite3.Connection, sops_seed: dict[str, Any]) -> int:
        count = 0
        for skill_id, sop in sops_seed.items():
            existing = conn.execute("SELECT skill_id FROM skills WHERE skill_id = ?", (skill_id,)).fetchone()
            if existing:
                continue
            now = now_iso()
            conn.execute(
                """
                INSERT INTO skills (
                    skill_id, title, role_id, activation_condition, exact_match_signatures_json,
                    extraction_tasks_json, skills_json, site_scope_json, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    skill_id,
                    sop.get("domain_name", skill_id),
                    sop.get("role_id", "role_base"),
                    sop.get("activation_condition", ""),
                    dumps_json(sop.get("exact_match_signatures", [])),
                    dumps_json(sop.get("extraction_tasks", [])),
                    dumps_json(sop.get("skills", [])),
                    dumps_json(sop.get("site_scope", ["*"])),
                    "active",
                    now,
                    now,
                ),
            )
            count += 1
        return count

    def _seed_query_templates(self, conn: sqlite3.Connection, template_seed: dict[str, Any]) -> int:
        count = 0
        for template_id, template in template_seed.items():
            existing = conn.execute("SELECT template_id FROM query_templates WHERE template_id = ?", (template_id,)).fetchone()
            if existing:
                continue
            now = now_iso()
            conn.execute(
                """
                INSERT INTO query_templates (
                    template_id, name, namespace, platform, summary, query_template, url_template,
                    required_fields_json, tags_json, site_scope_json, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    template_id,
                    template.get("name", template_id),
                    template.get("namespace", "general"),
                    template.get("platform", "manual"),
                    template.get("summary", ""),
                    template.get("query_template", ""),
                    template.get("url_template", ""),
                    dumps_json(template.get("required_fields", [])),
                    dumps_json(template.get("tags", [])),
                    dumps_json(template.get("site_scope", ["*"])),
                    "active",
                    now,
                    now,
                ),
            )
            count += 1
        return count

    def _seed_workflows(self, conn: sqlite3.Connection, workflow_seed: dict[str, Any]) -> int:
        count = 0
        for workflow_id, workflow in workflow_seed.items():
            existing = conn.execute("SELECT * FROM workflows WHERE workflow_id = ?", (workflow_id,)).fetchone()
            if existing:
                existing_record = decode_record(dict(existing))
                if str(existing_record.get("source_type") or "").strip() == "seed":
                    expected_site_scope = workflow.get("site_scope", ["*"])
                    expected_steps = workflow.get("steps", [])
                    expected_bind_skill_id = workflow.get("bind_skill_id")
                    expected_require_confirm = 1 if workflow.get("require_human_confirm", True) else 0
                    expected_version = int(workflow.get("version", 1) or 1)
                    needs_refresh = any(
                        [
                            existing_record.get("name") != workflow.get("name", workflow_id),
                            existing_record.get("summary") != workflow.get("summary", ""),
                            existing_record.get("bind_skill_id") != expected_bind_skill_id,
                            (existing_record.get("site_scope_json") or ["*"]) != expected_site_scope,
                            (existing_record.get("steps_json") or []) != expected_steps,
                            int(existing_record.get("require_human_confirm", 1) or 0) != expected_require_confirm,
                            int(existing_record.get("version", 1) or 1) != expected_version,
                        ]
                    )
                    if needs_refresh:
                        conn.execute(
                            """
                            UPDATE workflows
                            SET name = ?, summary = ?, bind_skill_id = ?, site_scope_json = ?, steps_json = ?,
                                require_human_confirm = ?, source_type = 'seed', version = ?, updated_at = ?
                            WHERE workflow_id = ?
                            """,
                            (
                                workflow.get("name", workflow_id),
                                workflow.get("summary", ""),
                                expected_bind_skill_id,
                                dumps_json(expected_site_scope),
                                dumps_json(expected_steps),
                                expected_require_confirm,
                                expected_version,
                                now_iso(),
                                workflow_id,
                            ),
                        )
                continue
            now = now_iso()
            conn.execute(
                """
                INSERT INTO workflows (
                    workflow_id, name, summary, bind_skill_id, site_scope_json, steps_json,
                    require_human_confirm, source_type, version, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    workflow_id,
                    workflow.get("name", workflow_id),
                    workflow.get("summary", ""),
                    workflow.get("bind_skill_id"),
                    dumps_json(workflow.get("site_scope", ["*"])),
                    dumps_json(workflow.get("steps", [])),
                    1 if workflow.get("require_human_confirm", True) else 0,
                    workflow.get("source_type", "seed"),
                    int(workflow.get("version", 1) or 1),
                    "active",
                    now,
                    now,
                ),
            )
            count += 1
        return count

    def _seed_documents(self, conn: sqlite3.Connection, document_seed: dict[str, Any]) -> int:
        count = 0
        for document_id, document in document_seed.items():
            existing = conn.execute("SELECT document_id FROM documents WHERE document_id = ?", (document_id,)).fetchone()
            if existing:
                continue
            now = now_iso()
            content_text = str(document.get("content_text", ""))
            chunk_count = max(1, len([chunk for chunk in content_text.split("\n\n") if chunk.strip()]))
            conn.execute(
                """
                INSERT INTO documents (
                    document_id, name, doc_type, namespace, source_type, content_text,
                    tags_json, site_scope_json, rag_mode, chunk_count, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    document_id,
                    document.get("name", document_id),
                    document.get("doc_type", "text"),
                    document.get("namespace", "general"),
                    document.get("source_type", "seed"),
                    content_text,
                    dumps_json(document.get("tags", [])),
                    dumps_json(document.get("site_scope", ["*"])),
                    document.get("rag_mode", "snippet"),
                    chunk_count,
                    "ready",
                    now,
                    now,
                ),
            )
            count += 1
        return count

    def list_personas(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM personas ORDER BY name ASC").fetchall()
        return [dict(row) for row in rows]

    def list_skills(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM skills WHERE status = 'active' ORDER BY updated_at DESC").fetchall()
        return [decode_record(dict(row)) for row in rows]

    def get_skill(self, skill_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM skills WHERE skill_id = ?", (skill_id,)).fetchone()
        return decode_record(dict(row)) if row else None

    def upsert_skill(self, payload: dict[str, Any]) -> dict[str, Any]:
        domain_name = str(payload.get("domain_name", "")).strip()
        skill_id = str(payload.get("skill_id", "")).strip() or stable_id("skill", domain_name or str(uuid.uuid4()))
        now = now_iso()
        existing = self.get_skill(skill_id)
        existing_exact_match_signatures = existing.get("exact_match_signatures_json", []) if existing else []
        existing_extraction_tasks = existing.get("extraction_tasks_json", []) if existing else []
        existing_skills = existing.get("skills_json", []) if existing else []
        existing_site_scope = existing.get("site_scope_json", ["*"]) if existing else ["*"]
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO skills (
                    skill_id, title, role_id, activation_condition, exact_match_signatures_json,
                    extraction_tasks_json, skills_json, site_scope_json, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(skill_id) DO UPDATE SET
                    title=excluded.title,
                    role_id=excluded.role_id,
                    activation_condition=excluded.activation_condition,
                    exact_match_signatures_json=excluded.exact_match_signatures_json,
                    extraction_tasks_json=excluded.extraction_tasks_json,
                    skills_json=excluded.skills_json,
                    site_scope_json=excluded.site_scope_json,
                    status=excluded.status,
                    updated_at=excluded.updated_at
                """,
                (
                    skill_id,
                    domain_name or skill_id,
                    payload.get("role_id", "role_base"),
                    payload.get("activation_condition", ""),
                    dumps_json(payload.get("exact_match_signatures", existing_exact_match_signatures)),
                    dumps_json(payload.get("extraction_tasks", existing_extraction_tasks)),
                    dumps_json(payload.get("skills", existing_skills)),
                    dumps_json(payload.get("site_scope", existing_site_scope)),
                    "active",
                    existing.get("created_at", now) if existing else now,
                    now,
                ),
            )
            conn.commit()
        return {"skill_id": skill_id, "updated": bool(existing)}

    def list_workflows(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM workflows WHERE status = 'active' ORDER BY updated_at DESC").fetchall()
        return [decode_record(dict(row)) for row in rows]

    def get_workflow(self, workflow_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM workflows WHERE workflow_id = ?", (workflow_id,)).fetchone()
        return decode_record(dict(row)) if row else None

    def archive_workflows(self, workflow_ids: list[str]) -> int:
        normalized_ids = [str(item or "").strip() for item in (workflow_ids or []) if str(item or "").strip()]
        if not normalized_ids:
            return 0
        now = now_iso()
        placeholders = ",".join("?" for _ in normalized_ids)
        with self.connect() as conn:
            cursor = conn.execute(
                f"UPDATE workflows SET status = 'archived', updated_at = ? WHERE workflow_id IN ({placeholders}) AND status = 'active'",
                [now, *normalized_ids],
            )
            conn.commit()
            return int(cursor.rowcount or 0)

    def create_workflow(
        self,
        name: str,
        summary: str,
        site_scope: list[str],
        steps: list[dict[str, Any]],
        require_human_confirm: bool,
        bind_skill_id: str | None,
        source_type: str = "manual",
    ) -> dict[str, Any]:
        workflow_id = stable_id("wf", f"{name}|{summary}|{len(steps)}|{bind_skill_id or ''}|{uuid.uuid4()}")
        now = now_iso()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO workflows (
                    workflow_id, name, summary, bind_skill_id, site_scope_json, steps_json,
                    require_human_confirm, source_type, version, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    workflow_id,
                    name,
                    summary,
                    bind_skill_id,
                    dumps_json(site_scope or ["*"]),
                    dumps_json(steps),
                    1 if require_human_confirm else 0,
                    source_type or "manual",
                    1,
                    "active",
                    now,
                    now,
                ),
            )
            conn.commit()
        return {"workflow_id": workflow_id, "bound_skill_id": bind_skill_id}

    def heal_workflow(
        self,
        workflow_id: str,
        trace_id: str | None,
        step_index: int,
        replacement_step: dict[str, Any],
        reason: str | None,
    ) -> dict[str, Any]:
        workflow = self.get_workflow(workflow_id)
        if workflow is None:
            raise KeyError(workflow_id)
        steps = workflow.get("steps_json", [])
        if not (0 <= step_index < len(steps)):
            raise IndexError(step_index)
        old_step = steps[step_index]
        steps[step_index] = replacement_step
        version = int(workflow.get("version", 1)) + 1
        now = now_iso()
        heal_id = stable_id("heal", f"{workflow_id}|{step_index}|{uuid.uuid4()}")
        with self.connect() as conn:
            conn.execute(
                "UPDATE workflows SET steps_json = ?, version = ?, updated_at = ? WHERE workflow_id = ?",
                (dumps_json(steps), version, now, workflow_id),
            )
            conn.execute(
                """
                INSERT INTO workflow_heal_events (
                    heal_id, workflow_id, trace_id, step_index, old_step_json, new_step_json, reason, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    heal_id,
                    workflow_id,
                    trace_id,
                    step_index,
                    dumps_json(old_step),
                    dumps_json(replacement_step),
                    reason,
                    now,
                ),
            )
            conn.commit()
        return {"workflow_id": workflow_id, "version": version, "patched_step": replacement_step}

    def list_workflow_heal_events(self, workflow_id: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
        with self.connect() as conn:
            if workflow_id:
                rows = conn.execute(
                    "SELECT * FROM workflow_heal_events WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?",
                    (workflow_id, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM workflow_heal_events ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
        return [decode_record(dict(row)) for row in rows]

    def create_trace(
        self,
        context_key: str,
        page_url: str,
        page_title: str,
        matched_persona: str,
        matched_skill_ids: list[str],
        extracted_fields: dict[str, Any],
        memory_selection_source: str | None,
        selected_memory_ids: list[str],
        memory_selection_reason: str | None,
        workflow_selection_source: str | None,
        selected_workflow_ids: list[str],
        workflow_selection_reason: str | None,
        workflow_matches: list[dict[str, Any]],
        status: str,
    ) -> str:
        trace_id = stable_id("trace", f"{context_key}|{uuid.uuid4()}")
        now = now_iso()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO traces (
                    trace_id, context_key, page_url, page_title, matched_persona, matched_skill_ids_json,
                    extracted_fields_json, memory_selection_source, selected_memory_ids_json, memory_selection_reason,
                    workflow_selection_source, selected_workflow_ids_json, workflow_selection_reason,
                    workflow_matches_json, executed_steps_json, failed_step_json, healing_detail_json, healing_state, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    trace_id,
                    context_key,
                    page_url,
                    page_title,
                    matched_persona,
                    dumps_json(matched_skill_ids),
                    dumps_json(extracted_fields),
                    memory_selection_source or "",
                    dumps_json(selected_memory_ids),
                    memory_selection_reason or "",
                    workflow_selection_source or "",
                    dumps_json(selected_workflow_ids),
                    workflow_selection_reason or "",
                    dumps_json(workflow_matches),
                    dumps_json([]),
                    dumps_json({}),
                    dumps_json({}),
                    "none",
                    status,
                    now,
                    now,
                ),
            )
            conn.commit()
        return trace_id

    def update_trace(
        self,
        trace_id: str,
        executed_steps: list[dict[str, Any]],
        failed_step: dict[str, Any],
        healing_detail: dict[str, Any],
        healing_state: str | None,
        status: str | None,
    ) -> dict[str, Any]:
        now = now_iso()
        with self.connect() as conn:
            current = conn.execute("SELECT * FROM traces WHERE trace_id = ?", (trace_id,)).fetchone()
            if current is None:
                raise KeyError(trace_id)
            current_decoded = decode_record(dict(current))
            next_steps = current_decoded.get("executed_steps_json", [])
            if executed_steps:
                next_steps = executed_steps
            next_failed = failed_step or current_decoded.get("failed_step_json", {})
            next_healing_detail = healing_detail or current_decoded.get("healing_detail_json", {})
            next_healing = healing_state if healing_state is not None else current_decoded.get("healing_state")
            next_status = status or current_decoded.get("status", "running")
            conn.execute(
                """
                UPDATE traces
                SET executed_steps_json = ?, failed_step_json = ?, healing_detail_json = ?, healing_state = ?, status = ?, updated_at = ?
                WHERE trace_id = ?
                """,
                (dumps_json(next_steps), dumps_json(next_failed), dumps_json(next_healing_detail), next_healing, next_status, now, trace_id),
            )
            conn.commit()
        return {
            "trace_id": trace_id,
            "status": next_status,
            "healing_state": next_healing,
            "healing_detail": next_healing_detail,
        }

    def list_traces(self, context_key: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
        with self.connect() as conn:
            if context_key:
                rows = conn.execute(
                    "SELECT * FROM traces WHERE context_key = ? ORDER BY updated_at DESC LIMIT ?",
                    (context_key, limit),
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM traces ORDER BY updated_at DESC LIMIT ?", (limit,)).fetchall()
        return [decode_record(dict(row)) for row in rows]

    def add_document(
        self,
        name: str,
        doc_type: str,
        namespace: str,
        source_type: str,
        content_text: str,
        tags: list[str],
        site_scope: list[str],
        rag_mode: str,
    ) -> dict[str, Any]:
        document_id = stable_id("doc", f"{name}|{namespace}|{uuid.uuid4()}")
        now = now_iso()
        chunk_count = max(1, len([chunk for chunk in content_text.split("\n\n") if chunk.strip()]))
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO documents (
                    document_id, name, doc_type, namespace, source_type, content_text,
                    tags_json, site_scope_json, rag_mode, chunk_count, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    document_id,
                    name,
                    doc_type,
                    namespace,
                    source_type,
                    content_text,
                    dumps_json(tags),
                    dumps_json(site_scope),
                    rag_mode,
                    chunk_count,
                    "ready",
                    now,
                    now,
                ),
            )
            conn.commit()
        return {"document_id": document_id, "chunk_count": chunk_count, "rag_mode": rag_mode}

    def archive_documents(self, document_ids: list[str]) -> int:
        normalized_ids = [str(item or "").strip() for item in (document_ids or []) if str(item or "").strip()]
        if not normalized_ids:
            return 0
        now = now_iso()
        placeholders = ",".join("?" for _ in normalized_ids)
        with self.connect() as conn:
            cursor = conn.execute(
                f"UPDATE documents SET status = 'archived', updated_at = ? WHERE document_id IN ({placeholders}) AND status = 'ready'",
                [now, *normalized_ids],
            )
            conn.commit()
            return int(cursor.rowcount or 0)

    def list_documents(self, namespace: str | None = None) -> list[dict[str, Any]]:
        with self.connect() as conn:
            if namespace:
                rows = conn.execute(
                    "SELECT document_id, name, doc_type, namespace, source_type, tags_json, site_scope_json, rag_mode, chunk_count, status, created_at, updated_at FROM documents WHERE namespace = ? AND status = 'ready' ORDER BY updated_at DESC",
                    (namespace,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT document_id, name, doc_type, namespace, source_type, tags_json, site_scope_json, rag_mode, chunk_count, status, created_at, updated_at FROM documents WHERE status = 'ready' ORDER BY updated_at DESC"
                ).fetchall()
        return [decode_record(dict(row)) for row in rows]

    def search_documents(self, query: str, namespace: str | None, top_k: int = 5) -> dict[str, Any]:
        query_norm = query.lower().strip()
        structured_results: list[dict[str, Any]] = []
        semantic_results: list[dict[str, Any]] = []
        with self.connect() as conn:
            if namespace:
                docs = conn.execute("SELECT * FROM documents WHERE namespace = ? AND status = 'ready' ORDER BY updated_at DESC", (namespace,)).fetchall()
                templates = conn.execute("SELECT * FROM query_templates WHERE namespace = ? AND status = 'active' ORDER BY updated_at DESC", (namespace,)).fetchall()
            else:
                docs = conn.execute("SELECT * FROM documents WHERE status = 'ready' ORDER BY updated_at DESC").fetchall()
                templates = conn.execute("SELECT * FROM query_templates WHERE status = 'active' ORDER BY updated_at DESC").fetchall()

        for row in templates:
            item = decode_record(dict(row))
            haystack = " ".join(
                [
                    item.get("name", ""),
                    item.get("summary", ""),
                    item.get("query_template", ""),
                    " ".join(item.get("tags_json", [])),
                ]
            ).lower()
            if query_norm and query_norm in haystack:
                structured_results.append(item)
        for row in docs:
            item = decode_record(dict(row))
            content_text = str(item.get("content_text", ""))
            lowered = content_text.lower()
            if query_norm and query_norm in lowered:
                index = lowered.index(query_norm)
                start = max(0, index - 80)
                end = min(len(content_text), index + 120)
                semantic_results.append(
                    {
                        "document_id": item.get("document_id"),
                        "name": item.get("name"),
                        "namespace": item.get("namespace"),
                        "snippet": content_text[start:end].replace("\n", " ").strip(),
                    }
                )
        return {"structured_results": structured_results[:top_k], "semantic_results": semantic_results[:top_k]}

    def list_query_templates(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM query_templates WHERE status = 'active' ORDER BY updated_at DESC").fetchall()
        return [decode_record(dict(row)) for row in rows]

    def record_stat(
        self,
        request_type: str,
        provider_id: str,
        model_id: str,
        input_tokens: int,
        output_tokens: int,
        latency_ms: int,
        used_vision: bool,
        status: str,
        cost_usd: float = 0.0,
    ) -> None:
        call_id = stable_id("call", f"{request_type}|{provider_id}|{uuid.uuid4()}")
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO stats_calls (
                    call_id, request_type, provider_id, model_id, input_tokens, output_tokens,
                    cost_usd, latency_ms, used_vision, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    call_id,
                    request_type,
                    provider_id,
                    model_id,
                    input_tokens,
                    output_tokens,
                    cost_usd,
                    latency_ms,
                    1 if used_vision else 0,
                    status,
                    now_iso(),
                ),
            )
            conn.commit()

    def stats_summary(self, recent_limit: int = 8) -> dict[str, Any]:
        with self.connect() as conn:
            summary_row = conn.execute(
                """
                SELECT
                    COUNT(*) AS total_calls,
                    COALESCE(SUM(input_tokens), 0) AS input_tokens,
                    COALESCE(SUM(output_tokens), 0) AS output_tokens,
                    COALESCE(SUM(cost_usd), 0.0) AS cost_usd
                FROM stats_calls
                """
            ).fetchone()
            recent_rows = conn.execute(
                "SELECT * FROM stats_calls ORDER BY created_at DESC LIMIT ?",
                (recent_limit,),
            ).fetchall()
        return {
            "summary": dict(summary_row or {}),
            "recent": [dict(row) for row in recent_rows],
        }
