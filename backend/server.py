from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
import sqlite3
import socket
import sys
import time
import zipfile
from dataclasses import dataclass, field
from fnmatch import fnmatch
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from xml.etree import ElementTree as ET

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python < 3.11 fallback
    tomllib = None

import requests
from flask import Flask, jsonify, request, send_file

try:
    from flask_cors import CORS
except ImportError:  # pragma: no cover - optional dependency
    def CORS(app: Flask) -> Flask:
        return app

from .db import Database, stable_id


LOGGER = logging.getLogger("omniagent_gemini_baseline")

REBUILD_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = Path(__file__).resolve().parents[2]
MEMORY_DIR = REBUILD_ROOT / "backend" / "memory"
MEMORY_DIR.mkdir(parents=True, exist_ok=True)
SOPS_FILE = MEMORY_DIR / "sops.json"
PERSONAS_FILE = MEMORY_DIR / "personas.json"
WORKFLOWS_FILE = MEMORY_DIR / "workflows.json"
QUERY_TEMPLATES_FILE = MEMORY_DIR / "query_templates.json"
DOCUMENTS_FILE = MEMORY_DIR / "documents.json"
DB_FILE = MEMORY_DIR / "omniagent.db"
FRONTEND_DIR = REBUILD_ROOT / "frontend"
FRONTEND_VENDOR_DIR = FRONTEND_DIR / "vendor"
FRONTEND_REGRESSION_DIR = FRONTEND_DIR / "regression"

app = Flask(__name__)
CORS(app)


AGENT_TOOLS = [
    {
        "name": "create_or_update_sop",
        "description": "当用户明确要求“记住这个规则”“以后这样做”“建立规则/SOP/Skill”时，才允许调用这个工具把经验写入长期记忆。",
        "input_schema": {
            "type": "object",
            "properties": {
                "domain_name": {"type": "string"},
                "role_id": {"type": "string"},
                "activation_condition": {"type": "string"},
                "exact_match_signatures": {"type": "array", "items": {"type": "string"}},
                "extraction_tasks": {"type": "array", "items": {"type": "object"}},
                "skills": {"type": "array", "items": {"type": "object"}},
                "skill_id": {"type": "string"},
            },
            "required": ["domain_name", "activation_condition"],
        },
    }
]

MAX_SUGGESTED_WORKFLOWS = 2
MAX_SUGGESTED_WORKFLOWS_WITH_PAGE_ACTIONS = 1
MAX_WORKFLOW_AI_SHORTLIST = 5
MAX_ROUTER_AI_SHORTLIST = 6
MAX_ROUTER_ROLE_SHORTLIST = 4
MAX_CHAT_BROWSER_ACTIONS = 12
MAX_BROWSER_STATE_PROMPT_CANDIDATES = 60
MEMORY_KIND_PRIORITY = {
    "structured": 3,
    "query_template": 2,
    "document": 1,
}
GENERIC_WORKFLOW_NAME_PATTERN = re.compile(r"(测试|test|demo|sample|example|录制流程|workflow|tmp|temp)", re.IGNORECASE)
GENERIC_DOCUMENT_NAME_PATTERN = re.compile(r"^(doc_[a-f0-9]{8,}|test|demo|sample|example|tmp|temp)$", re.IGNORECASE)
GENERIC_PERSONA_NAME_PATTERN = re.compile(r"^(测试.*|test.*|demo.*|sample.*|example.*|tmp.*|temp.*|未命名.*)$", re.IGNORECASE)
GENERIC_SKILL_NAME_PATTERN = re.compile(r"(测试|test|demo|sample|example|tmp|temp|未命名)", re.IGNORECASE)
CCSWITCH_APP_TYPES = ("claude", "codex", "gemini")
RECALL_STOPWORDS = {
    "alert", "alerts", "rule", "rules", "event", "events", "attack", "attacks", "exploit", "exploits",
    "true", "false", "user", "users", "page", "pages", "general", "generic", "skill", "skills",
    "判断", "分析", "规则", "页面", "用户", "以后", "这样", "记住", "当前", "需要", "进行", "并且", "以及", "相关",
}
GENERIC_ATTACK_LABEL_TERMS = {
    "sql注入",
    "sql injection",
    "sqli",
    "xss",
    "命令执行",
    "漏洞",
    "攻击",
}


class ApiError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}


@dataclass
class ProviderConfig:
    provider_id: str
    provider_type: str
    base_url: str
    api_key: str
    auth_token: str
    model_name: str
    supports_vision: bool
    supports_tool_use: bool
    source_env_provider: str = ""
    source_app_type: str = ""
    source_label: str = ""


@dataclass
class RuntimeConfig:
    host: str
    port: int
    debug: bool
    db_path: str
    selected_provider_id: str
    active_provider: ProviderConfig | None
    router_model: str
    analyzer_model: str
    chat_model: str
    teach_model: str
    health_ttl_seconds: int = 20
    ccswitch_endpoint_url: str = ""
    ccswitch_proxy_url: str = ""
    system_proxy_url: str = ""
    loaded_env_files: list[str] = field(default_factory=list)


@dataclass
class ProbeResult:
    ready: bool
    reason: str
    checked_at: float


@dataclass
class ContextSnapshot:
    context_key: str
    text: str
    images: list[str] = field(default_factory=list)
    image_meta: dict[str, Any] = field(default_factory=dict)
    page_meta: dict[str, Any] = field(default_factory=dict)
    scope_meta: dict[str, Any] = field(default_factory=dict)
    browser_state: dict[str, Any] = field(default_factory=dict)
    updated_at: float = field(default_factory=time.time)


def load_env_file(path: Path, override: bool = False) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if override or key not in os.environ:
            os.environ[key] = value


def env_first(*keys: str, default: str = "") -> str:
    for key in keys:
        value = os.getenv(key, "").strip()
        if value:
            return value
    return default


def parse_bool(value: str | None, default: bool) -> bool:
    if value is None or value == "":
        return default
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def normalize_base_url(value: str) -> str:
    return value.strip().rstrip("/")


def normalize_proxy_url(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if "://" not in raw:
        raw = f"http://{raw}"
    return raw.rstrip("/")


def parse_windows_proxy_server(proxy_server: str) -> str:
    raw = str(proxy_server or "").strip()
    if not raw:
        return ""
    if ";" not in raw and "=" not in raw:
        return normalize_proxy_url(raw)
    mapping: dict[str, str] = {}
    for chunk in raw.split(";"):
        part = str(chunk or "").strip()
        if not part:
            continue
        if "=" in part:
            key, value = part.split("=", 1)
            mapping[key.strip().lower()] = value.strip()
        else:
            mapping["http"] = part
            mapping["https"] = part
    for key in ("https", "http"):
        candidate = normalize_proxy_url(mapping.get(key, ""))
        if candidate:
            return candidate
    return ""


def is_local_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    return (parsed.hostname or "").lower() in {"127.0.0.1", "localhost", "::1"}


def build_proxy_url_from_host_port(host: str, port: str | int, default_host: str = "") -> str:
    normalized_host = str(host or "").strip() or str(default_host or "").strip()
    raw_port = str(port or "").strip()
    if not normalized_host or not raw_port:
        return ""
    try:
        port_number = int(raw_port)
    except ValueError:
        return ""
    if port_number <= 0 or port_number > 65535:
        return ""
    return normalize_proxy_url(f"http://{normalized_host}:{port_number}")


def first_reachable_proxy(candidates: list[str], require_local: bool = False) -> str:
    seen: set[str] = set()
    for candidate in candidates:
        normalized = normalize_proxy_url(candidate)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        if require_local and not is_local_url(normalized):
            continue
        if probe_local_proxy(normalized):
            return normalized
    return ""


def ccswitch_home_dir() -> Path:
    return Path.home() / ".cc-switch"


def load_optional_json_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def normalize_lookup_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def first_non_empty_string(values: list[Any]) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def recursively_collect_string_values(node: Any, lookup_keys: set[str]) -> list[str]:
    matches: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            normalized_key = normalize_lookup_key(key)
            if normalized_key in lookup_keys and not isinstance(value, (dict, list)):
                text = str(value).strip()
                if text:
                    matches.append(text)
            matches.extend(recursively_collect_string_values(value, lookup_keys))
    elif isinstance(node, list):
        for item in node:
            matches.extend(recursively_collect_string_values(item, lookup_keys))
    return matches


def parse_toml_document(text: str) -> dict[str, Any]:
    raw = str(text or "").strip()
    if not raw:
        return {}
    if tomllib is not None:
        try:
            parsed = tomllib.loads(raw)
        except Exception:
            parsed = {}
        if isinstance(parsed, dict) and parsed:
            return parsed

    # Minimal TOML fallback for Python 3.9 environments used in local smoke runs.
    result: dict[str, Any] = {}
    current: dict[str, Any] = result
    for raw_line in raw.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section_name = line[1:-1].strip()
            if not section_name:
                current = result
                continue
            current = result
            for part in section_name.split("."):
                key = part.strip()
                if not key:
                    current = result
                    break
                existing = current.get(key)
                if not isinstance(existing, dict):
                    existing = {}
                    current[key] = existing
                current = existing
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        normalized_key = key.strip()
        if not normalized_key:
            continue
        normalized_value = value.strip()
        if "#" in normalized_value:
            normalized_value = normalized_value.split("#", 1)[0].rstrip()
        if len(normalized_value) >= 2 and normalized_value[0] == normalized_value[-1] and normalized_value[0] in {'"', "'"}:
            parsed_value: Any = normalized_value[1:-1]
        elif normalized_value.lower() in {"true", "false"}:
            parsed_value = normalized_value.lower() == "true"
        else:
            try:
                parsed_value = int(normalized_value)
            except ValueError:
                parsed_value = normalized_value
        current[normalized_key] = parsed_value
    return result


def resolve_env_reference(env_key: str) -> str:
    key = str(env_key or "").strip()
    return os.getenv(key, "").strip() if key else ""


def should_trust_system_proxy() -> bool:
    return parse_bool(
        env_first(
            "OMNIAGENT_TRUST_SYSTEM_PROXY",
            "CCSWITCH_TRUST_SYSTEM_PROXY",
            "CC_SWITCH_TRUST_SYSTEM_PROXY",
        ),
        False,
    )


def discover_system_http_proxy() -> str:
    env_proxy = normalize_proxy_url(env_first("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"))
    if env_proxy:
        return env_proxy
    if os.name != "nt":
        return ""
    try:
        import winreg  # type: ignore
    except ImportError:
        return ""
    registry_path = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, registry_path) as key:
            proxy_enable = winreg.QueryValueEx(key, "ProxyEnable")[0]
            proxy_server = winreg.QueryValueEx(key, "ProxyServer")[0] if proxy_enable else ""
    except OSError:
        return ""
    return parse_windows_proxy_server(str(proxy_server or "")) if proxy_enable else ""


def resolve_model_name_for_provider_type(provider_type: str, default: str = "") -> str:
    if provider_type == "anthropic":
        return env_first(
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_REASONING_MODEL",
            default=default,
        )
    return default


def resolve_auth_token_for_provider_type(provider_type: str, default: str = "") -> str:
    if provider_type == "anthropic":
        return env_first("ANTHROPIC_AUTH_TOKEN", default=default)
    return default


def resolve_api_key_for_provider_type(provider_type: str, default: str = "") -> str:
    if provider_type == "anthropic":
        return env_first("ANTHROPIC_API_KEY", default=default)
    if provider_type == "openai_compatible":
        return env_first("OPENAI_API_KEY", default=default)
    return default


def normalize_provider_type_alias(value: str, default: str = "openai_compatible") -> str:
    normalized = re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())
    if normalized in {"anthropic", "anthropicmessages", "claude", "messages"}:
        return "anthropic"
    if normalized in {"openai", "openaicompatible", "chatcompletions"}:
        return "openai_compatible"
    return default


def resolve_internal_provider_type(base_url: str) -> str:
    explicit = normalize_provider_type_alias(env_first("INTERNAL_PROVIDER_TYPE", "INTERNAL_API_FORMAT"), "")
    if explicit:
        return explicit
    if env_first("ANTHROPIC_BASE_URL"):
        return "anthropic"
    if env_first("OPENAI_BASE_URL"):
        return "openai_compatible"
    normalized_url = normalize_base_url(base_url)
    if normalized_url.endswith("/v1/messages"):
        return "anthropic"
    return "openai_compatible"


def resolve_internal_base_url(provider_type: str) -> str:
    if provider_type == "anthropic":
        return normalize_base_url(env_first("INTERNAL_BASE_URL", "ANTHROPIC_BASE_URL"))
    if provider_type == "openai_compatible":
        return normalize_base_url(env_first("INTERNAL_BASE_URL", "OPENAI_BASE_URL"))
    return normalize_base_url(env_first("INTERNAL_BASE_URL", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"))


def resolve_internal_api_key(provider_type: str) -> str:
    if provider_type == "anthropic":
        return env_first("INTERNAL_API_KEY", "ANTHROPIC_API_KEY")
    if provider_type == "openai_compatible":
        return env_first("INTERNAL_API_KEY", "OPENAI_API_KEY")
    return env_first("INTERNAL_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY")


def resolve_internal_auth_token(provider_type: str) -> str:
    if provider_type == "anthropic":
        return env_first("INTERNAL_AUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN")
    return env_first("INTERNAL_AUTH_TOKEN")


def resolve_internal_model(provider_type: str) -> str:
    if provider_type == "anthropic":
        return env_first("INTERNAL_MODEL", default=resolve_model_name_for_provider_type("anthropic", "internal-default"))
    if provider_type == "openai_compatible":
        return env_first("INTERNAL_MODEL", "OPENAI_MODEL", default="internal-default")
    return env_first("INTERNAL_MODEL", "OPENAI_MODEL", default=resolve_model_name_for_provider_type("anthropic", "internal-default"))


def resolve_internal_supports_vision(provider_type: str) -> bool:
    if provider_type == "anthropic":
        return parse_bool(env_first("INTERNAL_SUPPORTS_VISION", "ANTHROPIC_SUPPORTS_VISION"), True)
    if provider_type == "openai_compatible":
        return parse_bool(env_first("INTERNAL_SUPPORTS_VISION", "OPENAI_SUPPORTS_VISION"), True)
    return parse_bool(env_first("INTERNAL_SUPPORTS_VISION", "ANTHROPIC_SUPPORTS_VISION", "OPENAI_SUPPORTS_VISION"), True)


def resolve_internal_supports_tool_use(provider_type: str) -> bool:
    if provider_type == "anthropic":
        return parse_bool(env_first("INTERNAL_SUPPORTS_TOOL_USE", "ANTHROPIC_SUPPORTS_TOOL_USE"), True)
    if provider_type == "openai_compatible":
        return parse_bool(env_first("INTERNAL_SUPPORTS_TOOL_USE", "OPENAI_SUPPORTS_TOOL_USE"), True)
    return parse_bool(env_first("INTERNAL_SUPPORTS_TOOL_USE", "ANTHROPIC_SUPPORTS_TOOL_USE", "OPENAI_SUPPORTS_TOOL_USE"), True)


def infer_provider_from_env() -> str:
    if env_first(
        "INTERNAL_BASE_URL",
        "INTERNAL_API_KEY",
        "INTERNAL_AUTH_TOKEN",
        "INTERNAL_MODEL",
        "INTERNAL_PROVIDER_TYPE",
        "INTERNAL_API_FORMAT",
    ):
        return "internal"

    anthropic_base_url = normalize_base_url(env_first("ANTHROPIC_BASE_URL"))
    if env_first(
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_REASONING_MODEL",
    ) or anthropic_base_url:
        if env_first("ANTHROPIC_AUTH_TOKEN") or (anthropic_base_url and not is_official_provider_url("anthropic", anthropic_base_url)):
            return "internal"
        return "anthropic"

    openai_base_url = normalize_base_url(env_first("OPENAI_BASE_URL"))
    if env_first("OPENAI_API_KEY", "OPENAI_MODEL") or openai_base_url:
        if openai_base_url and not is_official_provider_url("openai", openai_base_url):
            return "internal"
        return "openai"

    if env_first("DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "DEEPSEEK_BASE_URL"):
        return "deepseek"
    if env_first("LOCAL_MODEL_URL", "LOCAL_MODEL_NAME", "LOCAL_MODEL_API_KEY"):
        return "local"
    return ""


def pick_http_url(candidates: list[Any]) -> str:
    for candidate in candidates:
        raw = normalize_base_url(str(candidate or ""))
        if not raw:
            continue
        parsed = urlparse(raw)
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            return raw
    return ""


def infer_ccswitch_provider_type(app_type: str, hints: list[Any]) -> str:
    joined = " ".join(str(item or "") for item in hints).lower()
    if app_type == "codex" or any(token in joined for token in ["openai", "chat/completions", "chat completions", "/responses"]):
        return "openai_compatible"
    if app_type == "claude" or any(token in joined for token in ["anthropic", "/v1/messages", "messages"]):
        return "anthropic"
    if app_type == "gemini" and any(token in joined for token in ["openai", "chat/completions", "/v1"]):
        return "openai_compatible"
    return ""


def parse_ccswitch_saved_provider_row(row: sqlite3.Row, endpoint_urls: list[str]) -> ProviderConfig | None:
    row_id = first_non_empty_string([row["id"]])
    app_type = first_non_empty_string([row["app_type"]]).lower()
    row_name = first_non_empty_string([row["name"], row_id])
    if not row_id or app_type not in CCSWITCH_APP_TYPES:
        return None

    try:
        settings_config = json.loads(row["settings_config"] or "{}")
    except (TypeError, json.JSONDecodeError):
        settings_config = {}
    if not isinstance(settings_config, dict):
        settings_config = {}

    base_url = pick_http_url(endpoint_urls)
    model_name = ""
    api_key = ""
    auth_token = ""
    type_hints: list[Any] = [row["provider_type"], row_name, row_id]

    if app_type == "codex" and isinstance(settings_config.get("config"), str):
        parsed_config = parse_toml_document(settings_config.get("config") or "")
        type_hints.append(settings_config.get("config") or "")
        if parsed_config:
            model_name = first_non_empty_string([parsed_config.get("model")])
            model_provider_name = first_non_empty_string([parsed_config.get("model_provider")])
            providers_block = parsed_config.get("model_providers")
            model_providers = providers_block if isinstance(providers_block, dict) else {}
            selected_provider = model_providers.get(model_provider_name) if model_provider_name else None
            if selected_provider is None and len(model_providers) == 1:
                selected_provider = next(iter(model_providers.values()))
            if isinstance(selected_provider, dict):
                base_url = pick_http_url([selected_provider.get("base_url"), *endpoint_urls]) or base_url
                env_key = first_non_empty_string(
                    [
                        selected_provider.get("env_key"),
                        selected_provider.get("api_key_env"),
                        selected_provider.get("key_env"),
                    ]
                )
                api_key = resolve_env_reference(env_key)
                if not api_key:
                    api_key = first_non_empty_string(
                        [
                            selected_provider.get("api_key"),
                            selected_provider.get("access_token"),
                        ]
                    )
                if not auth_token:
                    auth_token = first_non_empty_string(
                        [
                            selected_provider.get("auth_token"),
                            selected_provider.get("access_token"),
                            selected_provider.get("token"),
                        ]
                    )

    if not base_url:
        base_url = pick_http_url(
            [
                *endpoint_urls,
                *recursively_collect_string_values(
                    settings_config,
                    {
                        "requesturl",
                        "baseurl",
                        "apibaseurl",
                        "apibase",
                        "endpointurl",
                        "endpoint",
                        "apiurl",
                        "serverurl",
                        "url",
                    },
                ),
            ]
        )

    if not model_name:
        model_name = first_non_empty_string(
            recursively_collect_string_values(settings_config, {"model", "modelname", "defaultmodel", "modelid"})
        )

    if not api_key:
        env_key = first_non_empty_string(
            recursively_collect_string_values(settings_config, {"envkey", "apikeyenv", "tokenenv", "keyenv"})
        )
        api_key = resolve_env_reference(env_key)
    if not api_key:
        auth_block = settings_config.get("auth")
        auth_candidates: list[Any] = []
        if isinstance(auth_block, dict):
            auth_candidates.extend(
                [
                    auth_block.get("api_key"),
                    auth_block.get("x_api_key"),
                    auth_block.get("OPENAI_API_KEY"),
                    auth_block.get("ANTHROPIC_API_KEY"),
                    auth_block.get("access_token"),
                ]
            )
        auth_candidates.extend(recursively_collect_string_values(settings_config, {"apikey", "xapikey", "accesstoken"}))
        api_key = first_non_empty_string(auth_candidates)
    if not auth_token:
        auth_block = settings_config.get("auth")
        auth_candidates = []
        if isinstance(auth_block, dict):
            auth_candidates.extend(
                [
                    auth_block.get("auth_token"),
                    auth_block.get("access_token"),
                    auth_block.get("token"),
                    auth_block.get("ANTHROPIC_AUTH_TOKEN"),
                ]
            )
        auth_candidates.extend(recursively_collect_string_values(settings_config, {"authtoken", "token", "accesstoken"}))
        auth_token = first_non_empty_string(auth_candidates)

    type_hints.extend(recursively_collect_string_values(settings_config, {"apiformat", "apitype", "format", "providertype"}))
    provider_type = infer_ccswitch_provider_type(app_type, [*type_hints, base_url])
    if not base_url or not provider_type:
        return None

    return ProviderConfig(
        provider_id="ccswitch",
        provider_type=provider_type,
        base_url=base_url,
        api_key=api_key,
        auth_token=auth_token,
        model_name=model_name or "auto",
        supports_vision=True,
        supports_tool_use=True,
        source_env_provider=row_id,
        source_app_type=app_type,
        source_label=row_name,
    )


def discover_ccswitch_saved_provider() -> ProviderConfig | None:
    base_dir = ccswitch_home_dir()
    db_path = base_dir / "cc-switch.db"
    if not db_path.exists():
        return None

    settings_data = load_optional_json_file(base_dir / "settings.json")
    preferred_app_type = env_first("CCSWITCH_APP_TYPE", "CC_SWITCH_APP_TYPE").strip().lower()
    app_priority = [preferred_app_type] if preferred_app_type in CCSWITCH_APP_TYPES else []
    for app_type in CCSWITCH_APP_TYPES:
        if app_type not in app_priority:
            app_priority.append(app_type)
    app_rank = {app_type: index for index, app_type in enumerate(app_priority)}
    current_provider_ids = {
        app_type: first_non_empty_string([settings_data.get(f"currentProvider{app_type.capitalize()}")])
        for app_type in CCSWITCH_APP_TYPES
    }

    try:
        with sqlite3.connect(db_path) as conn:
            conn.row_factory = sqlite3.Row
            provider_rows = conn.execute(
                """
                SELECT id, app_type, name, settings_config, provider_type, is_current
                FROM providers
                ORDER BY app_type, is_current DESC, id
                """
            ).fetchall()
            endpoint_rows = conn.execute(
                """
                SELECT provider_id, app_type, url
                FROM provider_endpoints
                ORDER BY app_type, provider_id, id
                """
            ).fetchall()
    except sqlite3.Error:
        return None

    endpoint_map: dict[tuple[str, str], list[str]] = {}
    for endpoint_row in endpoint_rows:
        provider_id = first_non_empty_string([endpoint_row["provider_id"]])
        app_type = first_non_empty_string([endpoint_row["app_type"]]).lower()
        url = first_non_empty_string([endpoint_row["url"]])
        if provider_id and app_type and url:
            endpoint_map.setdefault((provider_id, app_type), []).append(url)

    candidates: list[tuple[int, int, int, int, ProviderConfig]] = []
    for row in provider_rows:
        row_id = first_non_empty_string([row["id"]])
        app_type = first_non_empty_string([row["app_type"]]).lower()
        parsed_provider = parse_ccswitch_saved_provider_row(row, endpoint_map.get((row_id, app_type), []))
        if parsed_provider is None:
            continue
        settings_current = current_provider_ids.get(app_type, "") == row_id
        db_current = bool(row["is_current"])
        candidates.append(
            (
                0 if settings_current else 1 if db_current else 2,
                app_rank.get(app_type, len(app_rank)),
                0 if parsed_provider.model_name and parsed_provider.model_name != "auto" else 1,
                0 if (parsed_provider.api_key or parsed_provider.auth_token) else 1,
                parsed_provider,
            )
        )

    if not candidates:
        return None
    candidates.sort(key=lambda item: item[:-1])
    return candidates[0][-1]


def discover_host_ccswitch_proxy_candidates() -> list[str]:
    candidates: list[str] = []
    db_path = ccswitch_home_dir() / "cc-switch.db"
    if db_path.exists():
        try:
            with sqlite3.connect(db_path) as conn:
                rows = conn.execute(
                    """
                    SELECT DISTINCT listen_address, listen_port
                    FROM proxy_config
                    WHERE listen_address IS NOT NULL
                      AND listen_address != ''
                      AND listen_port IS NOT NULL
                      AND listen_port > 0
                    ORDER BY CASE WHEN enabled = 1 OR proxy_enabled = 1 THEN 0 ELSE 1 END, app_type
                    """
                ).fetchall()
            for listen_address, listen_port in rows:
                candidates.append(f"http://{listen_address}:{listen_port}")
        except sqlite3.Error:
            pass
    candidates.extend(
        [
            "http://127.0.0.1:15721",
            "http://localhost:15721",
            "http://127.0.0.1:7890",
            "http://localhost:7890",
        ]
    )
    return candidates


def is_official_provider_url(provider_id: str, base_url: str) -> bool:
    hostname = (urlparse(base_url).hostname or "").lower()
    if provider_id == "deepseek":
        return hostname == "api.deepseek.com"
    if provider_id == "openai":
        return hostname == "api.openai.com"
    if provider_id == "anthropic":
        return hostname == "api.anthropic.com"
    return False


def provider_allows_keyless(provider: ProviderConfig) -> bool:
    if provider.api_key or provider.auth_token:
        return False
    if is_local_url(provider.base_url):
        return True
    upstream_provider = provider.source_env_provider or provider.provider_id
    if upstream_provider in {"deepseek", "openai", "anthropic"}:
        return not is_official_provider_url(upstream_provider, provider.base_url)
    hostname = (urlparse(provider.base_url).hostname or "").lower()
    if provider.provider_type == "anthropic" and hostname == "api.anthropic.com":
        return False
    if provider.provider_type == "openai_compatible" and hostname in {"api.openai.com", "api.deepseek.com"}:
        return False
    return True


def provider_uses_custom_gateway(provider_id: str, base_url: str) -> bool:
    if not base_url:
        return False
    if is_local_url(base_url):
        return True
    return not is_official_provider_url(provider_id, base_url)


def build_openai_chat_urls(base_url: str) -> list[str]:
    base = normalize_base_url(base_url)
    urls: list[str] = []
    if base.endswith("/chat/completions"):
        urls.append(base)
    elif base.endswith("/v1"):
        urls.append(f"{base}/chat/completions")
    else:
        urls.append(f"{base}/chat/completions")
        urls.append(f"{base}/v1/chat/completions")
    deduped: list[str] = []
    for item in urls:
        if item not in deduped:
            deduped.append(item)
    return deduped


def build_openai_models_urls(base_url: str) -> list[str]:
    base = normalize_base_url(base_url)
    urls: list[str] = []
    if base.endswith("/models"):
        urls.append(base)
    elif base.endswith("/v1"):
        urls.append(f"{base}/models")
    else:
        urls.append(f"{base}/models")
        urls.append(f"{base}/v1/models")
    deduped: list[str] = []
    for item in urls:
        if item not in deduped:
            deduped.append(item)
    return deduped


def build_anthropic_messages_url(base_url: str) -> str:
    base = normalize_base_url(base_url)
    if base.endswith("/v1/messages"):
        return base
    if base.endswith("/v1"):
        return f"{base}/messages"
    return f"{base}/v1/messages"


def probe_local_proxy(proxy_url: str) -> bool:
    try:
        parsed = urlparse(proxy_url)
        if not parsed.hostname or not parsed.port:
            return False
        with socket.create_connection((parsed.hostname, parsed.port), timeout=0.4):
            return True
    except OSError:
        return False


def detect_local_ccswitch_proxy() -> str:
    explicit_proxy = first_reachable_proxy([env_first("CCSWITCH_PROXY_URL", "CC_SWITCH_PROXY_URL")], require_local=False)
    if explicit_proxy:
        return explicit_proxy
    configured_host_port_proxy = build_proxy_url_from_host_port(
        env_first("CCSWITCH_PROXY_HOST", "CC_SWITCH_PROXY_HOST", default="127.0.0.1"),
        env_first("CCSWITCH_PROXY_PORT", "CC_SWITCH_PROXY_PORT", default="15721"),
    )
    configured_proxy = first_reachable_proxy([configured_host_port_proxy], require_local=False)
    if configured_proxy:
        return configured_proxy
    trust_system_proxy = should_trust_system_proxy()
    if trust_system_proxy:
        system_proxy = first_reachable_proxy([discover_system_http_proxy()], require_local=False)
        if system_proxy:
            return system_proxy
    host_proxy = first_reachable_proxy(discover_host_ccswitch_proxy_candidates(), require_local=True)
    if host_proxy:
        return host_proxy
    return ""


def resolve_ccswitch_base_url(detected_endpoint_url: str) -> str:
    explicit_base_url = normalize_base_url(env_first("CCSWITCH_BASE_URL", "CC_SWITCH_BASE_URL"))
    if explicit_base_url:
        return explicit_base_url
    if detected_endpoint_url:
        return normalize_base_url(detected_endpoint_url)
    return ""


def should_use_ccswitch_http_proxy() -> bool:
    return parse_bool(env_first("CCSWITCH_USE_HTTP_PROXY", "CC_SWITCH_USE_HTTP_PROXY"), False)


def describe_routing_mode(config: RuntimeConfig, provider: ProviderConfig | None) -> str:
    if config.ccswitch_proxy_url and provider and not is_local_url(provider.base_url):
        if provider.provider_id == "ccswitch":
            return "ccswitch_http_proxy"
        return "direct_via_ccswitch_proxy"
    if config.system_proxy_url and provider and not is_local_url(provider.base_url):
        if provider.provider_id == "ccswitch":
            return "direct_ccswitch_via_system_proxy"
        return "direct_via_system_proxy"
    if provider and provider.provider_id == "ccswitch":
        return "direct_ccswitch"
    return "direct"


def describe_upstream_provider(provider: ProviderConfig | None) -> str | None:
    if provider is None:
        return None
    return provider.source_env_provider or provider.provider_id


def setup_logging(debug: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if debug else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
        stream=sys.stdout,
        force=True,
    )


def ensure_json_file(path: Path, default_data: dict[str, Any]) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(default_data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_json(path: Path) -> dict[str, Any]:
    ensure_json_file(path, {})
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ApiError("BROKEN_MEMORY", f"记忆文件损坏: {path.name}", 500, {"reason": str(exc)}) from exc
    return data if isinstance(data, dict) else {}


def default_personas_seed() -> dict[str, Any]:
    return {
        "role_base": {
            "name": "客观总结助手",
            "system_prompt": "你是一个严谨、客观的通用文本分析助手。只依据页面文本和真实视觉输入作答，不能编造未看到的事实。",
        },
        "role_tech_reader": {
            "name": "技术阅读助手",
            "system_prompt": "你擅长阅读技术文章、项目 README、工程文档和工具介绍。优先用清晰、克制的方式总结概念、结构和使用要点，不要无端带入网络安全处置口吻。",
        },
        "role_life_helper": {
            "name": "生活实践助手",
            "system_prompt": "你擅长帮助用户处理日常网页内容，如做菜、购物、论坛浏览、信息整理。回答要自然、简洁、实用。",
        },
        "role_sec_expert": {
            "name": "网络安全专家",
            "system_prompt": "你是一名经验丰富的网络安全专家，擅长 SOC 研判、SRC 漏洞分析、日志理解与自动化研判。",
        },
    }


def default_sops_seed() -> dict[str, Any]:
    return {
        "skill_hash_alert_triage": {
            "domain_name": "文件 Hash 告警基础研判",
            "role_id": "role_sec_expert",
            "activation_condition": "页面同时出现文件哈希、IOC 或隔离样本等特征时，进入安全告警基础研判。",
            "exact_match_signatures": ["md5", "sha256", "ioc", "quarantine", "malware"],
            "extraction_tasks": [
                {
                    "field_name": "file_md5",
                    "instruction": "提取页面中最相关的 32 位 MD5，如果不存在则留空。",
                },
                {
                    "field_name": "process_name",
                    "instruction": "提取相关进程名，如 xxx.exe。",
                },
                {
                    "field_name": "file_path",
                    "instruction": "提取主要文件路径或隔离路径。",
                },
            ],
            "skills": [
                {
                    "skill_name": "查询微步文件情报",
                    "action_type": "url_render",
                    "template": "https://x.threatbook.com/v5/file/{file_md5}",
                }
            ],
        },
        "skill_src_vuln_report": {
            "domain_name": "SRC 漏洞报告基础提取",
            "role_id": "role_sec_expert",
            "activation_condition": "页面包含漏洞、payload、PoC、复现步骤、接口路径等特征时，进入漏洞报告基础提取。",
            "exact_match_signatures": ["payload", "poc", "xss", "sqli", "sql injection", "漏洞"],
            "extraction_tasks": [
                {
                    "field_name": "page_url",
                    "instruction": "提取漏洞页面或主要接口路径，如 /login、/api/user/list。",
                },
                {
                    "field_name": "payload",
                    "instruction": "提取页面中出现的核心 payload 或复现语句。",
                },
                {
                    "field_name": "impact",
                    "instruction": "概括漏洞影响点，优先提取原文已有描述。",
                },
            ],
            "skills": [],
        },
    }


def default_query_templates_seed() -> dict[str, Any]:
    return {
        "tpl_hash_lookup": {
            "name": "文件 MD5 情报查询",
            "namespace": "security",
            "platform": "threatbook",
            "summary": "把页面里提取出的 MD5 带入情报平台查询，适合 hash 告警初判。",
            "query_template": "file_md5:{file_md5}",
            "url_template": "https://x.threatbook.com/v5/file/{file_md5}",
            "required_fields": ["file_md5"],
            "tags": ["hash", "md5", "threat-intel", "sandbox"],
            "site_scope": ["*"],
        },
        "tpl_src_payload_review": {
            "name": "SRC Payload 复核查询",
            "namespace": "security",
            "platform": "manual_review",
            "summary": "围绕页面路径、payload 和影响点整理复核查询语句，便于二次核验。",
            "query_template": "url:\"{page_url}\" payload:\"{payload}\" impact:\"{impact}\"",
            "url_template": "",
            "required_fields": ["page_url", "payload"],
            "tags": ["src", "payload", "review"],
            "site_scope": ["*"],
        },
    }


def default_workflows_seed() -> dict[str, Any]:
    return {
        "wf_seed_hash_alert_review": {
            "name": "Hash 告警证据复核",
            "summary": "围绕当前告警里的 MD5、进程和路径先做页面内证据核对，再决定是否转外部情报补查。",
            "bind_skill_id": "skill_hash_alert_triage",
            "site_scope": ["*"],
            "require_human_confirm": True,
            "source_type": "seed",
            "steps": [
                {
                    "type": "page_agent_task",
                    "instruction": "在当前告警页面优先定位 MD5 {file_md5}、相关进程 {process_name} 和文件路径 {file_path}，必要时展开详情、滚动证据区或切换标签，把三项信息保持在可见区域。",
                    "success_criteria": "页面上已能同时看到 MD5、进程名和文件路径，或已明确记录哪一项缺失。",
                },
                {
                    "type": "ask_human",
                    "question": "这条 Hash 告警当前更接近哪种研判结论？",
                    "reason": "先收敛初判结论和补充说明，再继续整理待补查项，会比直接跳到下一步更稳定。",
                    "suggested_action": "请结合当前页面证据选择结论，并补一条简短说明。",
                    "input_fields": [
                        {
                            "name": "triage_verdict",
                            "label": "初判结论",
                            "type": "select",
                            "required": True,
                            "help_text": "用于区分真实风险、待补查和疑似误报。",
                            "options": [
                                {"label": "更像真实风险", "value": "真实风险"},
                                {"label": "仍需补查", "value": "待补查"},
                                {"label": "更像疑似误报", "value": "疑似误报"},
                            ],
                        },
                        {
                            "name": "triage_note",
                            "label": "补充说明",
                            "type": "textarea",
                            "required": True,
                            "default_value": "先记录当前页面已有证据，再决定是否打开外部情报补查。",
                            "help_text": "可简要记录证据充分性、缺失项或后续动作。",
                        },
                    ],
                    "options": [
                        {
                            "id": "continue",
                            "label": "继续整理结论",
                            "value": "continue",
                            "branch_steps": [
                                {
                                    "type": "page_agent_task",
                                    "instruction": "根据用户给出的初判结论 {{triage_verdict}} 和补充说明 {{triage_note}}，继续在当前页面整理结论、缺失证据和下一步补查建议；如果仍缺外部情报，请明确提示后续打开情报查询。",
                                    "success_criteria": "已把当前结论、缺失证据和下一步建议分开整理，便于继续处置。",
                                }
                            ],
                        },
                        {
                            "id": "cancel",
                            "label": "先停在这里",
                            "value": "cancel",
                            "replace_remaining": True,
                        },
                    ],
                },
                {
                    "type": "page_agent_task",
                    "instruction": "继续核对处置状态、隔离/拦截结论、最近命中时间和上下游证据。如果页面里没有情报结论，明确提示需要打开外部情报查询进一步补查。",
                    "success_criteria": "已确认当前告警更偏向真实风险、待补查还是疑似误报，并把关键证据保留在当前可见范围。",
                },
            ],
        },
        "wf_seed_src_report_review": {
            "name": "SRC 报告证据复核",
            "summary": "围绕接口路径和 payload 复核漏洞报告证据，先确认可复现性，再检查前置条件和影响描述。",
            "bind_skill_id": "skill_src_vuln_report",
            "site_scope": ["*"],
            "require_human_confirm": True,
            "source_type": "seed",
            "steps": [
                {
                    "type": "page_agent_task",
                    "instruction": "在当前漏洞报告页面定位接口路径 {page_url}、核心 payload {payload} 和影响描述，必要时展开复现步骤、请求示例或截图区域，把关键证据保持在可见区域。",
                    "success_criteria": "页面上已能同时看到接口路径、payload 和影响描述，或已明确记录缺失项。",
                },
                {
                    "type": "ask_human",
                    "question": "这份 SRC 报告当前更接近哪种复核结论？",
                    "reason": "先收敛复核结论和待补信息，再继续整理影响判断，会更贴近真实复核流程。",
                    "suggested_action": "请选择当前结论，并补充仍需作者说明或继续核验的点。",
                    "input_fields": [
                        {
                            "name": "review_decision",
                            "label": "复核结论",
                            "type": "select",
                            "required": True,
                            "options": [
                                {"label": "可复现，需继续确认影响", "value": "可复现待确认影响"},
                                {"label": "信息不足，需补充说明", "value": "信息不足待补充"},
                                {"label": "更像低风险或误报", "value": "低风险或误报"},
                            ],
                        },
                        {
                            "name": "review_note",
                            "label": "待补信息",
                            "type": "textarea",
                            "required": True,
                            "default_value": "先记录当前页面已能确认的证据，再列出缺少的前置条件、影响边界或复现细节。",
                            "help_text": "可填写仍缺失的权限前提、影响范围或作者需补充的复现信息。",
                        },
                    ],
                    "options": [
                        {
                            "id": "continue",
                            "label": "继续整理复核意见",
                            "value": "continue",
                            "branch_steps": [
                                {
                                    "type": "page_agent_task",
                                    "instruction": "根据用户选择的复核结论 {{review_decision}} 和待补信息 {{review_note}}，继续整理当前报告的可复现证据、影响判断和待确认项，并明确下一步补充建议。",
                                    "success_criteria": "已把可复现证据、影响判断和待确认项分别整理清楚，便于继续复核。",
                                }
                            ],
                        },
                        {
                            "id": "cancel",
                            "label": "先停在这里",
                            "value": "cancel",
                            "replace_remaining": True,
                        },
                    ],
                },
                {
                    "type": "page_agent_task",
                    "instruction": "继续核对是否存在鉴权前提、用户角色限制、复现稳定性和影响边界；如果页面证据不足，明确标出需要作者补充的内容。",
                    "success_criteria": "已确认这份报告更偏向可复现待确认影响、信息不足待补充，还是低风险/误报，并保留关键证据位置。",
                },
            ],
        },
    }


def default_documents_seed() -> dict[str, Any]:
    return {
        "doc_hash_triage_checklist": {
            "name": "文件 Hash 告警研判清单",
            "doc_type": "text",
            "namespace": "security",
            "source_type": "seed",
            "content_text": "\n".join(
                [
                    "1. 先确认页面里提取到的 MD5、进程名和文件路径是否来自同一条告警上下文。",
                    "2. 优先查看情报平台对该 MD5 的首检时间、流行度、厂商检出和家族标签。",
                    "3. 如果只有告警名命中、没有 payload 或执行链证据，先保留误报可能，不要直接判定为真实攻击。",
                    "4. 输出结论时，把已确认事实、仍缺失证据和建议补查项分开描述。",
                ]
            ),
            "tags": ["hash", "triage", "soc"],
            "site_scope": ["*"],
            "rag_mode": "snippet",
        },
        "doc_src_report_checklist": {
            "name": "SRC 漏洞报告复核清单",
            "doc_type": "text",
            "namespace": "security",
            "source_type": "seed",
            "content_text": "\n".join(
                [
                    "1. 先提取漏洞页面或接口路径、核心 payload、复现步骤和影响描述。",
                    "2. 区分页面现象、接口行为和真正的安全影响，避免把功能缺陷误写成漏洞。",
                    "3. 如果报告缺少鉴权前提、用户角色或触发条件，先列为待补信息，不要擅自补齐。",
                    "4. 输出复核意见时，按“可复现证据 / 影响判断 / 待确认项”三段式整理。",
                ]
            ),
            "tags": ["src", "vulnerability", "review"],
            "site_scope": ["*"],
            "rag_mode": "snippet",
        },
    }


def extract_json_from_text(text: str) -> dict[str, Any]:
    if not text or not isinstance(text, str):
        raise ValueError("AI 返回空文本")
    try:
        return json.loads(text)
    except Exception:
        match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
        if not match:
            match = re.search(r"(\{.*\})", text, re.DOTALL)
        if match:
            return json.loads(match.group(1))
    raise ValueError("AI 没有返回合法 JSON")


def latest_user_message_text(messages: list[dict[str, Any]]) -> str:
    for item in reversed(messages or []):
        if str(item.get("role", "")).strip() != "user":
            continue
        blocks = normalize_message_blocks(item.get("content"))
        parts = [str(block.get("text", "")).strip() for block in blocks if block.get("type") == "text"]
        text = "\n".join(part for part in parts if part).strip()
        if text:
            return text
    return ""


def parse_image_base64(b64_str: str) -> dict[str, str]:
    match = re.match(r"data:(image/[a-zA-Z0-9.+-]+);base64,(.*)", b64_str)
    if match:
        return {"media_type": match.group(1), "data": match.group(2)}
    return {"media_type": "image/jpeg", "data": b64_str}


def data_url_from_any_image(value: str) -> str:
    raw = str(value or "").strip()
    if raw.startswith("data:image/"):
        return raw
    return f"data:image/jpeg;base64,{raw}"


def normalize_message_blocks(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if not isinstance(content, list):
        return [{"type": "text", "text": str(content)}]
    blocks: list[dict[str, Any]] = []
    for item in content:
        if isinstance(item, str):
            blocks.append({"type": "text", "text": item})
            continue
        if not isinstance(item, dict):
            blocks.append({"type": "text", "text": str(item)})
            continue
        block_type = str(item.get("type", "")).strip()
        if block_type == "text":
            blocks.append({"type": "text", "text": str(item.get("text", ""))})
        elif block_type in {"image", "image_url"}:
            image_value = ""
            if block_type == "image":
                source = item.get("source", {})
                if isinstance(source, dict) and source.get("type") == "base64":
                    image_value = f"data:{source.get('media_type', 'image/jpeg')};base64,{source.get('data', '')}"
                else:
                    image_value = str(item.get("data_url", "")).strip()
            else:
                image_url = item.get("image_url", {})
                image_value = str(image_url.get("url", "")) if isinstance(image_url, dict) else str(image_url)
            if image_value:
                blocks.append({"type": "image", "data_url": image_value})
        else:
            blocks.append({"type": "text", "text": json.dumps(item, ensure_ascii=False)})
    return blocks


def normalize_chat_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for message in messages:
        role = str(message.get("role", "user")).strip() or "user"
        if role not in {"user", "assistant", "system"}:
            role = "user"
        content = message.get("content", "")
        normalized.append({"role": role, "content": normalize_message_blocks(content)})
    return normalized


def openai_tools_from_agent_tools(agent_tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "parameters": tool.get("input_schema", {"type": "object", "properties": {}}),
            },
        }
        for tool in agent_tools
    ]


def anthropic_tools_from_agent_tools(agent_tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "name": tool["name"],
            "description": tool.get("description", ""),
            "input_schema": tool.get("input_schema", {"type": "object", "properties": {}}),
        }
        for tool in agent_tools
    ]


def decode_bytes_to_text(raw_bytes: bytes) -> str:
    for encoding in ("utf-8", "utf-8-sig", "gb18030", "latin-1"):
        try:
            return raw_bytes.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw_bytes.decode("utf-8", errors="ignore")


def strip_xml_text(xml_bytes: bytes) -> str:
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return decode_bytes_to_text(xml_bytes)
    parts: list[str] = []
    for node in root.iter():
        if node.text and node.text.strip():
            parts.append(node.text.strip())
    return "\n".join(parts)


def extract_text_from_docx(raw_bytes: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(raw_bytes)) as archive:
        data = archive.read("word/document.xml")
    return strip_xml_text(data)


def extract_text_from_xlsx(raw_bytes: bytes) -> str:
    texts: list[str] = []
    with zipfile.ZipFile(io.BytesIO(raw_bytes)) as archive:
        for name in archive.namelist():
            if not name.startswith("xl/") or not name.endswith(".xml"):
                continue
            texts.append(strip_xml_text(archive.read(name)))
    return "\n".join(part for part in texts if part.strip())


def extract_text_from_upload(name: str, raw_bytes: bytes) -> tuple[str, str]:
    suffix = Path(name or "upload.bin").suffix.lower()
    if suffix in {".txt", ".md", ".csv", ".json", ".log", ".html", ".htm", ".xml", ".yml", ".yaml", ".ini", ".cfg", ".conf", ".sql"}:
        return decode_bytes_to_text(raw_bytes), suffix.lstrip(".") or "text"
    if suffix == ".docx":
        return extract_text_from_docx(raw_bytes), "docx"
    if suffix == ".xlsx":
        return extract_text_from_xlsx(raw_bytes), "xlsx"
    raise ApiError("UNSUPPORTED_UPLOAD", f"当前基线仅支持 txt/md/csv/html/json/docx/xlsx 等可解析文本文件，暂不支持 {suffix or '未知类型'}", 400)


def estimate_tokens(text: str) -> int:
    stripped = text.strip()
    if not stripped:
        return 0
    return max(1, len(stripped) // 4)


def usage_from_raw(raw: dict[str, Any]) -> tuple[int, int]:
    usage = raw.get("usage") or {}
    input_tokens = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
    output_tokens = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
    return input_tokens, output_tokens


SKILL_SIGNATURE_HINT_TERMS = (
    "sql injection",
    "sqli",
    "sql注入",
    "xss",
    "命令执行",
    "远程代码执行",
    "rce",
    "payload",
    "poc",
    "漏洞",
    "告警",
    "安全告警",
    "攻击告警",
    "误报",
    "真实攻击",
    "日志",
    "研判",
    "ioc",
    "md5",
    "sha1",
    "sha256",
    "quarantine",
    "malware",
    "webshell",
    "waf",
)
SKILL_SIGNATURE_STOPWORDS = {
    "页面",
    "出现",
    "遇到",
    "如果",
    "以后",
    "这种",
    "当前",
    "需要",
    "进入",
    "进行",
    "相关",
    "内容",
    "信息",
    "说明",
    "处理",
    "判断",
    "分析",
    "时激活",
    "激活",
    "规则",
    "长期规则",
    "长期记忆",
}
ALERT_CONTEXT_PATTERN = re.compile(r"(告警|alert|waf|soc|攻击告警|安全事件|事件详情|日志研判|拦截记录|规则命中)", re.IGNORECASE)


def _clean_skill_term(term: Any) -> str:
    text = re.sub(r"\s+", " ", str(term or "")).strip()
    if not text:
        return ""
    text = re.sub(r"^(页面|出现|遇到|如果|以后|当|针对|关于)+", "", text)
    text = re.sub(r"(时激活|时进入|时触发|时优先|等|等场景|场景|内容|信息|规则)$", "", text)
    text = text.strip(" ,，。；;、:：()（）[]【】\"'“”")
    if not text or text.lower() in SKILL_SIGNATURE_STOPWORDS or text in SKILL_SIGNATURE_STOPWORDS:
        return ""
    return text[:32]


def derive_skill_exact_match_signatures(domain_name: str, activation_condition: str, extraction_tasks: list[dict[str, Any]] | None = None) -> list[str]:
    sources = [str(domain_name or ""), str(activation_condition or "")]
    if extraction_tasks:
        sources.extend(str(item.get("instruction", "")) for item in extraction_tasks if isinstance(item, dict))
    combined = " | ".join(item for item in sources if item).strip()
    if not combined:
        return []
    combined_lower = combined.lower()
    candidates: list[str] = []
    for hint in SKILL_SIGNATURE_HINT_TERMS:
        if hint in combined_lower:
            candidates.append(hint)
    for pattern in (r"[（(]([^）)]+)[）)]", r"[“\"']([^”\"']+)[”\"']"):
        for match in re.findall(pattern, combined, re.IGNORECASE):
            for chunk in re.split(r"[，,、/|；;]", match):
                cleaned = _clean_skill_term(chunk)
                if cleaned:
                    candidates.append(cleaned)
    for token in re.findall(r"[A-Za-z][A-Za-z0-9_./-]{2,}", combined):
        cleaned = _clean_skill_term(token.lower())
        if cleaned:
            candidates.append(cleaned)
    deduped: list[str] = []
    for item in candidates:
        normalized = _clean_skill_term(item)
        if normalized and normalized not in deduped:
            deduped.append(normalized)
    return deduped[:10]


def build_skill_lookup_terms(runtime_skill: dict[str, Any]) -> list[str]:
    explicit_terms = [_clean_skill_term(item) for item in (runtime_skill.get("exact_match_signatures") or [])]
    explicit_terms = [item for item in explicit_terms if item]
    if explicit_terms:
        return explicit_terms
    return derive_skill_exact_match_signatures(
        str(runtime_skill.get("domain_name", "")),
        str(runtime_skill.get("activation_condition", "")),
        runtime_skill.get("extraction_tasks") or [],
    )


def score_skill_match_terms(text: str, runtime_skill: dict[str, Any]) -> tuple[int, list[str]]:
    text_lower = str(text or "").lower()
    matched_terms: list[str] = []
    score = 0
    for term in build_skill_lookup_terms(runtime_skill):
        normalized = str(term or "").strip().lower()
        if not normalized or normalized not in text_lower:
            continue
        matched_terms.append(term)
        if " " in normalized or len(normalized) >= 6 or re.search(r"[\u4e00-\u9fff]{3,}", normalized):
            score += 2
        else:
            score += 1
    return score, matched_terms


def looks_like_security_alert_context(text: str, page_meta: dict[str, Any] | None = None, browser_state: dict[str, Any] | None = None) -> bool:
    page_meta = page_meta or {}
    browser_state = browser_state or {}
    sample = "\n".join(
        [
            str(page_meta.get("title", "")),
            str(page_meta.get("url", "")),
            str(browser_state.get("page_kind", "")),
            str(browser_state.get("page_agent_header", ""))[:300],
            str(text or "")[:1200],
        ]
    )
    return bool(ALERT_CONTEXT_PATTERN.search(sample))


def site_scope_matches(site_scope: list[str] | None, host: str) -> bool:
    rules = [str(item or "").strip().lower() for item in (site_scope or ["*"])]
    clean_host = str(host or "").strip().lower()
    if not rules:
        return True
    if "*" in rules or not clean_host:
        return True
    for rule in rules:
        if not rule:
            continue
        if rule == clean_host:
            return True
        if fnmatch(clean_host, rule):
            return True
        if rule.startswith("*.") and clean_host.endswith(rule[1:]):
            return True
        if clean_host.endswith(f".{rule}"):
            return True
    return False


def site_scope_specificity(site_scope: list[str] | None) -> int:
    rules = [str(item or "").strip().lower() for item in (site_scope or []) if str(item or "").strip()]
    if not rules:
        return 0
    return 0 if all(rule == "*" for rule in rules) else 1


def workflow_step_looks_executable(step: Any) -> bool:
    if not isinstance(step, dict):
        return False
    step_type = str(step.get("type") or step.get("action") or "").strip().lower()
    if not step_type:
        return False
    if step_type == "page_agent_task":
        return bool(str(step.get("instruction", "")).strip())
    if step_type == "wait":
        return True
    if step_type == "ask_human":
        options = step.get("options") or []
        has_options = isinstance(options, list) and any(
            isinstance(item, dict) and str(item.get("label", "")).strip()
            for item in options
        )
        return bool(
            str(step.get("message", "")).strip()
            or str(step.get("question", "")).strip()
            or str(step.get("reason", "")).strip()
            or has_options
        )
    if step_type == "fill_form":
        fields = step.get("fields") or []
        if not isinstance(fields, list) or not fields:
            return False
        return all(workflow_step_looks_executable(_normalize_form_field_step(field)) for field in fields)
    if step_type == "press_key":
        key = str(step.get("key") or step.get("value") or "").strip()
        if not key:
            return False
    elif step_type not in {"click", "fill", "select", "focus", "highlight"}:
        return False
    if isinstance(step.get("page_agent_index"), int):
        return True
    if str(step.get("selector", "")).strip():
        return True
    if any(str(item or "").strip() for item in (step.get("selector_candidates") or [])):
        return True
    if str(step.get("element_id", "")).strip():
        return True
    if str(step.get("target_desc", "")).strip():
        return True
    return bool(step.get("semantic_anchors"))


def workflow_steps_look_executable(steps: Any) -> bool:
    return isinstance(steps, list) and bool(steps) and all(workflow_step_looks_executable(step) for step in steps)


def choose_preferred_workflow_steps(primary_steps: Any, fallback_steps: Any) -> list[dict[str, Any]]:
    normalized_primary = json.loads(json.dumps(primary_steps, ensure_ascii=False)) if isinstance(primary_steps, list) else []
    normalized_fallback = json.loads(json.dumps(fallback_steps, ensure_ascii=False)) if isinstance(fallback_steps, list) else []
    if workflow_steps_look_executable(normalized_primary):
        return normalized_primary
    if workflow_steps_look_executable(normalized_fallback):
        return normalized_fallback
    if normalized_primary:
        return normalized_primary
    return normalized_fallback


def workflow_step_preview_text(step: Any) -> str:
    if not isinstance(step, dict):
        return "未知步骤"
    step_type = str(step.get("type") or step.get("action") or "step").strip().lower() or "step"
    if step_type == "page_agent_task":
        instruction = str(step.get("instruction", "")).strip()
        return f"{step_type} -> {instruction or '未命名任务'}"
    if step_type == "ask_human":
        question = str(step.get("question", "")).strip()
        message = str(step.get("message", "")).strip()
        reason = str(step.get("reason", "")).strip()
        summary = question or message or reason or "等待确认"
        options = step.get("options") or []
        option_count = sum(1 for item in options if isinstance(item, dict) and str(item.get("label", "")).strip()) if isinstance(options, list) else 0
        if reason and reason != summary:
            summary = f"{summary} | {reason}"
        if option_count:
            summary = f"{summary} | 选项={option_count}"
        return f"{step_type} -> {summary}"
    if step_type == "fill_form":
        fields = step.get("fields") or []
        if not isinstance(fields, list):
            fields = []
        field_labels = []
        for field in fields[:3]:
            normalized = _normalize_form_field_step(field)
            field_labels.append(str(normalized.get("target_desc") or normalized.get("field_name") or "字段").strip() or "字段")
        extra = max(0, len(fields) - len(field_labels))
        joined = " / ".join(item for item in field_labels if item) or "表单字段"
        if extra:
            joined += f" / +{extra}"
        return f"{step_type} -> {joined}"
    if step_type == "press_key":
        key = str(step.get("key") or step.get("value") or "").strip() or "按键"
        target = str(
            step.get("target_desc")
            or step.get("label")
            or step.get("selector")
            or step.get("element_id")
            or "当前焦点"
        ).strip() or "当前焦点"
        return f"{step_type} -> {key} @ {target}"
    target = str(
        step.get("target_desc")
        or step.get("label")
        or step.get("selector")
        or step.get("element_id")
        or ""
    ).strip()
    return f"{step_type} -> {target or '目标'}"


def _normalize_form_field_step(field: Any) -> dict[str, Any]:
    if not isinstance(field, dict):
        return {}
    normalized = json.loads(json.dumps(field, ensure_ascii=False))
    target_desc = str(
        normalized.get("target_desc")
        or normalized.get("label")
        or normalized.get("field_name")
        or normalized.get("name")
        or ""
    ).strip()
    field_type = str(normalized.get("type") or "").strip().lower()
    candidate_tag = str(normalized.get("tag") or "").strip().lower()
    candidate_role = str(normalized.get("role") or "").strip().lower()
    candidate_input_type = str(normalized.get("input_type") or "").strip().lower()
    if field_type not in {"fill", "select"}:
        field_type = "select" if candidate_is_select_like(candidate_tag, candidate_role, candidate_input_type, normalized.get("has_datalist")) else "fill"
    normalized["type"] = field_type
    if target_desc and not normalized.get("target_desc"):
        normalized["target_desc"] = target_desc
    return normalized


def candidate_is_select_like(tag: str, role: str, input_type: str = "", has_datalist: Any = False) -> bool:
    normalized_tag = str(tag or "").strip().lower()
    normalized_role = str(role or "").strip().lower()
    normalized_input_type = str(input_type or "").strip().lower()
    if normalized_tag in {"select", "option", "datalist"}:
        return True
    if normalized_role in {"combobox", "listbox", "option"}:
        return True
    if normalized_input_type in {"date", "datetime-local", "month", "time", "week"}:
        return True
    return bool(has_datalist)


def render_placeholders_in_data(node: Any, values: dict[str, str]) -> Any:
    if isinstance(node, str):
        rendered = node
        for field_name, field_value in values.items():
            if field_value:
                rendered = rendered.replace(f"{{{field_name}}}", field_value)
        return rendered
    if isinstance(node, list):
        return [render_placeholders_in_data(item, values) for item in node]
    if isinstance(node, dict):
        return {key: render_placeholders_in_data(value, values) for key, value in node.items()}
    return node


def collect_workflow_placeholders(node: Any, found: list[str]) -> None:
    placeholder_pattern = re.compile(r"(?<!\{)\{([a-zA-Z0-9_]+)\}(?!\})")
    if isinstance(node, str):
        for match in placeholder_pattern.findall(node):
            if match not in found:
                found.append(match)
        return
    if isinstance(node, list):
        for item in node:
            collect_workflow_placeholders(item, found)
        return
    if isinstance(node, dict):
        for value in node.values():
            collect_workflow_placeholders(value, found)


def workflow_parameter_label(name: Any) -> str:
    normalized = str(name or "").strip()
    if not normalized:
        return "参数"
    explicit_labels = {
        "url": "接口路径",
        "page_url": "页面路径",
        "file_md5": "文件 MD5",
        "md5": "MD5",
        "sha256": "SHA256",
        "file_path": "文件路径",
        "process_name": "进程名",
        "payload": "Payload",
        "impact": "影响说明",
        "status": "状态",
        "priority": "优先级",
        "severity": "风险等级",
        "level": "等级",
        "start_time": "开始时间",
        "assignee": "负责人",
        "owner": "处理人",
        "reviewer": "复核人",
        "keyword": "关键词",
        "kind": "类型",
        "type": "类型",
        "triage_verdict": "初判结论",
        "review_decision": "复核结论",
        "note": "备注",
        "comment": "备注",
        "reason": "说明",
        "description": "说明",
        "triage_note": "补充说明",
        "pending_items": "待补信息",
    }
    if normalized in explicit_labels:
        return explicit_labels[normalized]
    parts = [part for part in re.split(r"[_\-\s]+", normalized) if part]
    if not parts:
        return normalized
    return " ".join(part.upper() if part.isupper() else part.capitalize() for part in parts)


def _placeholder_names_in_text(text: Any) -> list[str]:
    if not isinstance(text, str):
        return []
    pattern = re.compile(r"(?<!\{)\{([a-zA-Z0-9_]+)\}(?!\})")
    return [str(item).strip() for item in pattern.findall(text) if str(item).strip()]


def collect_workflow_placeholder_contexts(
    node: Any,
    contexts: dict[str, list[dict[str, Any]]],
    inherited: dict[str, Any] | None = None,
) -> None:
    inherited = inherited or {}
    if isinstance(node, list):
        for item in node:
            collect_workflow_placeholder_contexts(item, contexts, inherited)
        return
    if not isinstance(node, dict):
        return
    local = {
        "step_type": str(node.get("source_action_type") or node.get("type") or node.get("action") or inherited.get("step_type") or "").strip().lower(),
        "target_desc": str(node.get("target_desc") or node.get("label") or node.get("field_name") or inherited.get("target_desc") or "").strip(),
        "field_name": str(node.get("field_name") or inherited.get("field_name") or "").strip(),
        "selector": str(node.get("selector") or inherited.get("selector") or "").strip(),
        "input_type": str(node.get("input_type") or inherited.get("input_type") or "").strip().lower(),
        "role": str(node.get("role") or inherited.get("role") or "").strip().lower(),
        "option_candidates": node.get("option_candidates") or inherited.get("option_candidates") or [],
    }
    for value in node.values():
        if isinstance(value, str):
            for placeholder in _placeholder_names_in_text(value):
                contexts.setdefault(placeholder, []).append(dict(local))
    for value in node.values():
        if isinstance(value, (dict, list)):
            collect_workflow_placeholder_contexts(value, contexts, local)


def clean_workflow_parameter_label(label: Any) -> str:
    text = str(label or "").strip()
    if not text:
        return ""
    return re.sub(r"(输入框|下拉框|文本框|选择框|组合框|搜索框|按钮|字段)$", "", text).strip() or text


def workflow_parameter_name_tokens(name: Any) -> set[str]:
    return {
        part
        for part in re.split(r"[_\-\s]+", str(name or "").strip().lower())
        if part
    }


def normalize_workflow_parameter_options(options: Any) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in options or []:
        if isinstance(item, dict):
            label = re.sub(r"\s+", " ", str(item.get("label") or item.get("text") or item.get("value") or "")).strip()
            value = re.sub(r"\s+", " ", str(item.get("value") or item.get("label") or item.get("text") or "")).strip()
        else:
            label = re.sub(r"\s+", " ", str(item or "")).strip()
            value = label
        normalized_label = label.casefold()
        normalized_value = value.casefold()
        if (
            not label
            or not value
            or normalized_value in seen
            or len(label) > 80
            or len(value) > 120
            or re.fullmatch(r"[\W_]+", label)
            or re.fullmatch(r"[\W_]+", value)
            or normalized_label in {"null", "undefined", "n/a", "na", "none"}
            or normalized_value in {"null", "undefined", "n/a", "na", "none"}
            or re.fullmatch(r"(请选择|请先选择|请选择\.\.\.|请输入|输入或选择|点击选择|搜索|搜索\.\.\.|select|choose)(.*)", label, re.IGNORECASE)
            or re.fullmatch(r"(请选择|请先选择|请选择\.\.\.|请输入|输入或选择|点击选择|搜索|搜索\.\.\.|select|choose)(.*)", value, re.IGNORECASE)
        ):
            continue
        seen.add(normalized_value)
        normalized.append({"label": label, "value": value})
    return normalized


def workflow_parameter_option_signature(semantic_key: str, option: dict[str, Any] | None) -> str:
    if not semantic_key or not isinstance(option, dict):
        return ""
    label = str(option.get("label") or "").strip().casefold()
    value = str(option.get("value") or "").strip().casefold()
    sample = f"{label} {value}".strip()
    if not sample:
        return ""
    signature_aliases = {
        "status": {
            "pending": {"pending", "待处理", "待办", "open", "todo"},
            "in_progress": {"in_progress", "processing", "处理中", "进行中", "处理中"},
            "blocked": {"blocked", "已阻塞", "阻塞", "挂起", "暂停"},
            "done": {"done", "completed", "已完成", "完成", "closed", "关闭"},
        },
        "priority": {
            "low": {"low", "低"},
            "medium": {"medium", "中", "normal", "普通"},
            "high": {"high", "高"},
            "critical": {"critical", "紧急", "urgent", "最高", "严重"},
        },
        "triage_verdict": {
            "真实风险": {"真实风险", "更像真实风险", "confirmed", "real_risk"},
            "待补查": {"待补查", "仍需补查", "needs_followup", "follow_up"},
            "疑似误报": {"疑似误报", "更像疑似误报", "false_positive"},
        },
        "review_decision": {
            "可复现待确认影响": {"可复现待确认影响", "可复现，需继续确认影响"},
            "信息不足待补充": {"信息不足待补充", "信息不足，需补充说明"},
            "低风险或误报": {"低风险或误报", "更像低风险或误报"},
        },
    }
    for canonical, aliases in signature_aliases.get(semantic_key, {}).items():
        if any(alias.casefold() in sample for alias in aliases):
            return canonical
    return ""


def merge_workflow_parameter_options(
    semantic_key: str,
    *option_groups: list[dict[str, Any]] | None,
) -> list[dict[str, str]]:
    merged: list[dict[str, str]] = []
    signature_index: dict[str, int] = {}
    exact_values: set[str] = set()
    for group_index, group in enumerate(option_groups):
        for item in normalize_workflow_parameter_options(group):
            value_key = str(item.get("value") or "").strip().casefold()
            if not value_key:
                continue
            signature = workflow_parameter_option_signature(semantic_key, item)
            if signature and signature in signature_index:
                # Later groups win so page-recorded options can replace generic defaults.
                merged[signature_index[signature]] = item
                exact_values.add(value_key)
                continue
            if value_key in exact_values:
                continue
            exact_values.add(value_key)
            merged.append(item)
            if signature:
                signature_index[signature] = len(merged) - 1
    return merged


def workflow_parameter_context_blob(contexts: list[dict[str, Any]] | None = None) -> str:
    contexts = contexts or []
    return " ".join(
        [
            str(item.get("target_desc") or "")
            for item in contexts
        ]
        + [
            str(item.get("field_name") or "")
            for item in contexts
        ]
        + [
            str(item.get("selector") or "")
            for item in contexts
        ]
        + [
            str(item.get("input_type") or "")
            for item in contexts
        ]
        + [
            str(item.get("role") or "")
            for item in contexts
        ]
    ).lower()


def workflow_parameter_semantic_key(name: Any, contexts: list[dict[str, Any]] | None = None) -> str:
    normalized = str(name or "").strip().lower()
    tokens = workflow_parameter_name_tokens(normalized)
    context_blob = workflow_parameter_context_blob(contexts)
    if normalized in {"file_md5", "md5"} or "md5" in tokens or "md5" in context_blob or "hash" in tokens or "hash" in context_blob:
        return "md5"
    if normalized == "sha256" or "sha256" in tokens or "sha256" in context_blob:
        return "sha256"
    if normalized in {"url", "page_url"} or "url" in tokens or "接口" in context_blob or "链接" in context_blob:
        return "url"
    if ("file" in tokens and "path" in tokens) or "文件路径" in context_blob:
        return "file_path"
    if "process" in tokens or "进程" in context_blob:
        return "process_name"
    if "date" in tokens or "日期" in context_blob:
        return "date"
    if "time" in tokens or "时间" in context_blob:
        return "time"
    if "status" in tokens or "状态" in context_blob:
        return "status"
    if {"priority", "severity", "level"} & tokens or "优先级" in context_blob or "风险等级" in context_blob or context_blob.endswith("等级"):
        return "priority"
    if normalized == "triage_verdict" or {"triage", "verdict"} <= tokens or "初判结论" in context_blob:
        return "triage_verdict"
    if normalized == "review_decision" or {"review", "decision"} <= tokens or "复核结论" in context_blob:
        return "review_decision"
    if normalized in {"kind", "type"} or "类型" in context_blob:
        return "kind"
    if normalized in {"assignee", "owner", "reviewer"}:
        return normalized
    if "负责人" in context_blob:
        return "assignee"
    if "处理人" in context_blob:
        return "owner"
    if "复核人" in context_blob:
        return "reviewer"
    if any(token in normalized for token in ["note", "comment", "reason", "description", "payload", "impact", "pending", "remark"]):
        return "note"
    if any(token in context_blob for token in ["备注", "说明", "描述", "payload", "影响"]):
        return "note"
    return ""


def workflow_parameter_default_options(semantic_key: str) -> list[dict[str, str]]:
    if semantic_key == "priority":
        return [
            {"label": "低", "value": "low"},
            {"label": "中", "value": "medium"},
            {"label": "高", "value": "high"},
            {"label": "紧急", "value": "critical"},
        ]
    if semantic_key == "status":
        return [
            {"label": "待处理", "value": "pending"},
            {"label": "处理中", "value": "in_progress"},
            {"label": "已阻塞", "value": "blocked"},
            {"label": "已完成", "value": "done"},
        ]
    if semantic_key == "triage_verdict":
        return [
            {"label": "更像真实风险", "value": "真实风险"},
            {"label": "仍需补查", "value": "待补查"},
            {"label": "更像疑似误报", "value": "疑似误报"},
        ]
    if semantic_key == "review_decision":
        return [
            {"label": "可复现，需继续确认影响", "value": "可复现待确认影响"},
            {"label": "信息不足，需补充说明", "value": "信息不足待补充"},
            {"label": "更像低风险或误报", "value": "低风险或误报"},
        ]
    return []


def workflow_parameter_compatibility_key(semantic_key: str) -> str:
    if semantic_key in {"assignee", "owner", "reviewer"}:
        return "actor"
    return semantic_key


def workflow_parameter_options_from_extracted_fields(
    name: Any,
    extracted_fields: dict[str, Any] | None = None,
    contexts: list[dict[str, Any]] | None = None,
) -> list[dict[str, str]]:
    extracted_fields = extracted_fields if isinstance(extracted_fields, dict) else {}
    semantic_key = workflow_parameter_semantic_key(name, contexts)
    compatibility_key = workflow_parameter_compatibility_key(semantic_key)
    if not compatibility_key or not extracted_fields:
        return []
    derived_options: list[dict[str, str]] = []
    for raw_key, raw_value in extracted_fields.items():
        candidate_key = str(raw_key or "").strip()
        candidate_value = str(raw_value or "").strip()
        if not candidate_key or not candidate_value:
            continue
        candidate_semantic_key = workflow_parameter_semantic_key(candidate_key)
        if workflow_parameter_compatibility_key(candidate_semantic_key) != compatibility_key:
            continue
        derived_options.append({"label": candidate_value, "value": candidate_value})
    return normalize_workflow_parameter_options(derived_options)


def lookup_workflow_parameter_value(
    name: Any,
    extracted_fields: dict[str, Any] | None = None,
    contexts: list[dict[str, Any]] | None = None,
) -> str:
    normalized = str(name or "").strip()
    extracted_fields = extracted_fields if isinstance(extracted_fields, dict) else {}
    if not normalized or not extracted_fields:
        return ""
    exact_value = extracted_fields.get(normalized)
    if exact_value not in (None, ""):
        return str(exact_value)
    semantic_key = workflow_parameter_semantic_key(normalized, contexts)
    if not semantic_key:
        return ""
    normalized_tokens = workflow_parameter_name_tokens(normalized)
    best_value = ""
    best_score = -1
    for raw_key, raw_value in extracted_fields.items():
        if raw_value in (None, ""):
            continue
        candidate_key = str(raw_key or "").strip()
        if not candidate_key:
            continue
        if workflow_parameter_semantic_key(candidate_key) != semantic_key:
            continue
        candidate_tokens = workflow_parameter_name_tokens(candidate_key)
        score = 10 + len(normalized_tokens & candidate_tokens) * 4
        if candidate_key.lower() == normalized.lower():
            score += 100
        if candidate_tokens == normalized_tokens:
            score += 30
        if semantic_key in candidate_tokens:
            score += 6
        if score > best_score:
            best_score = score
            best_value = str(raw_value)
    return best_value


def resolve_workflow_parameter_values(
    steps: list[dict[str, Any]] | None,
    extracted_fields: dict[str, Any] | None = None,
) -> dict[str, Any]:
    resolved_fields = dict(extracted_fields or {}) if isinstance(extracted_fields, dict) else {}
    placeholders: list[str] = []
    collect_workflow_placeholders(steps or [], placeholders)
    if not placeholders:
        return resolved_fields
    placeholder_contexts: dict[str, list[dict[str, Any]]] = {}
    collect_workflow_placeholder_contexts(steps or [], placeholder_contexts)
    for placeholder in placeholders:
        if resolved_fields.get(placeholder) not in (None, ""):
            continue
        resolved_value = lookup_workflow_parameter_value(placeholder, resolved_fields, placeholder_contexts.get(placeholder, []))
        if resolved_value not in (None, ""):
            resolved_fields[placeholder] = resolved_value
    return resolved_fields


def build_workflow_parameter_field(
    name: Any,
    extracted_fields: dict[str, Any] | None = None,
    contexts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    normalized = str(name or "").strip()
    contexts = contexts or []
    technical_labels_preferred = {
        "file_md5", "md5", "sha256", "file_path", "process_name", "url", "page_url", "payload", "impact"
    }
    preferred_context_label = next(
        (
            clean_workflow_parameter_label(item.get("target_desc") or item.get("field_name") or "")
            for item in contexts
            if clean_workflow_parameter_label(item.get("target_desc") or item.get("field_name") or "")
        ),
        "",
    )
    base_label = workflow_parameter_label(normalized)
    label = base_label if normalized in technical_labels_preferred else (preferred_context_label or base_label)
    extracted_fields = extracted_fields if isinstance(extracted_fields, dict) else {}
    entry: dict[str, Any] = {
        "name": normalized,
        "label": label,
        "placeholder": f"请输入{label}",
        "required": True,
        "type": "text",
    }
    lowered = normalized.lower()
    tokens = workflow_parameter_name_tokens(normalized)
    context_blob = workflow_parameter_context_blob(contexts)
    semantic_key = workflow_parameter_semantic_key(normalized, contexts)
    context_option_candidates = normalize_workflow_parameter_options(
        option
        for item in contexts
        for option in (item.get("option_candidates") or [])
    )
    is_priority_like = bool({"priority", "severity", "level"} & tokens)
    is_status_like = "status" in tokens
    is_triage_verdict_like = lowered == "triage_verdict" or {"triage", "verdict"} <= tokens
    is_review_decision_like = lowered == "review_decision" or {"review", "decision"} <= tokens
    is_textarea_like = any(token in lowered for token in ["note", "comment", "reason", "description", "payload", "impact", "pending", "remark"]) or any(
        token in context_blob for token in ["备注", "说明", "描述", "payload", "影响"]
    )
    if is_textarea_like:
        entry["type"] = "textarea"
        entry["min_length"] = 2 if "impact" in lowered else 4
    is_select_like = lowered in {"kind", "type"} or is_status_like or is_priority_like or is_triage_verdict_like or is_review_decision_like or any(
        item.get("step_type") == "select" or item.get("role") in {"combobox", "listbox", "option"}
        for item in contexts
    ) or any(token in context_blob for token in ["下拉", "选择", "状态", "类型", "优先级", "负责人", "处理人", "复核人", "结论"])
    if is_select_like:
        entry["type"] = "select"
    if is_priority_like:
        entry["options"] = workflow_parameter_default_options("priority")
        entry["help_text"] = "请选择更接近当前流程的等级。"
    elif is_status_like:
        entry["options"] = workflow_parameter_default_options("status")
        entry["help_text"] = "可用于工单、任务或复核流程状态。"
    elif is_triage_verdict_like:
        entry["options"] = workflow_parameter_default_options("triage_verdict")
        entry["help_text"] = "用于区分真实风险、待补查和疑似误报。"
    elif is_review_decision_like:
        entry["options"] = workflow_parameter_default_options("review_decision")
        entry["help_text"] = "用于沉淀当前复核结论，便于继续核验。"
    else:
        resolved_default_value = lookup_workflow_parameter_value(normalized, extracted_fields, contexts)
        if lowered in {"kind", "type"} and resolved_default_value not in (None, ""):
            entry["options"] = [{"label": str(resolved_default_value), "value": str(resolved_default_value)}]
    if context_option_candidates:
        if not entry.get("options"):
            entry["options"] = context_option_candidates
        else:
            entry["options"] = merge_workflow_parameter_options(semantic_key, entry.get("options") or [], context_option_candidates)
    if lowered in {"file_md5", "md5"}:
        entry["pattern"] = r"^[A-Fa-f0-9]{32}$"
        entry["validation_message"] = "请输入 32 位 MD5。"
        entry["help_text"] = "示例：44d88612fea8a8f36de82e1278abb02f"
    elif lowered == "sha256":
        entry["pattern"] = r"^[A-Fa-f0-9]{64}$"
        entry["validation_message"] = "请输入 64 位 SHA256。"
    elif lowered in {"url", "page_url"}:
        entry["min_length"] = 2
        entry["help_text"] = "可填写 /login 或完整 URL。"
    elif "date" in tokens or "日期" in context_blob:
        entry["pattern"] = r"^\d{4}-\d{2}-\d{2}$"
        entry["validation_message"] = "请输入 YYYY-MM-DD 格式的日期。"
        entry["help_text"] = "示例：2026-04-25"
    elif "time" in tokens or "时间" in context_blob:
        entry["pattern"] = r"^(?:[01]\d|2[0-3]):[0-5]\d$"
        entry["validation_message"] = "请输入 24 小时制 HH:MM 格式的时间。"
        entry["help_text"] = "示例：09:30"
    elif lowered == "file_path":
        entry["min_length"] = 3
        entry["help_text"] = "示例：C:/temp/sample.exe"
    elif lowered == "process_name":
        entry["min_length"] = 2
        entry["help_text"] = "示例：powershell.exe"
    default_value = lookup_workflow_parameter_value(normalized, extracted_fields, contexts)
    if default_value not in (None, ""):
        entry["default_value"] = str(default_value)
    if entry.get("type") == "select" and entry.get("default_value"):
        default_signature = workflow_parameter_option_signature(
            semantic_key,
            {"label": str(entry["default_value"]), "value": str(entry["default_value"])},
        )
        matched_option = next(
            (
                item for item in entry.get("options") or []
                if workflow_parameter_option_signature(semantic_key, item) == default_signature
            ),
            None,
        ) if default_signature else None
        if matched_option and str(matched_option.get("value") or "").strip():
            entry["default_value"] = str(matched_option.get("value"))
        else:
            entry["options"] = merge_workflow_parameter_options(
                semantic_key,
                entry.get("options") or [],
                [{"label": str(entry["default_value"]), "value": str(entry["default_value"])}],
            )
    return entry


def build_workflow_parameter_fields(
    parameter_names: list[str],
    extracted_fields: dict[str, Any] | None = None,
    steps: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    fields: list[dict[str, Any]] = []
    seen: set[str] = set()
    placeholder_contexts: dict[str, list[dict[str, Any]]] = {}
    collect_workflow_placeholder_contexts(steps or [], placeholder_contexts)
    for item in parameter_names or []:
        normalized = str(item or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        fields.append(build_workflow_parameter_field(normalized, extracted_fields, placeholder_contexts.get(normalized, [])))
    return fields


def build_parameterized_workflow_steps(
    steps: list[dict[str, Any]],
    extracted_fields: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    normalized_steps = choose_preferred_workflow_steps(steps, [])
    if not normalized_steps:
        return normalized_steps
    first_step = normalized_steps[0] if normalized_steps else {}
    if (
        isinstance(first_step, dict)
        and str(first_step.get("type") or first_step.get("action") or "").strip().lower() == "ask_human"
        and isinstance(first_step.get("input_fields"), list)
        and first_step.get("input_fields")
    ):
        return normalized_steps
    placeholders: list[str] = []
    collect_workflow_placeholders(normalized_steps, placeholders)
    if not placeholders:
        return normalized_steps
    extracted_fields = extracted_fields if isinstance(extracted_fields, dict) else {}
    input_fields = build_workflow_parameter_fields(placeholders, extracted_fields, normalized_steps)
    return [
        {
            "type": "ask_human",
            "question": f"执行流程前，请先确认这 {len(input_fields)} 个可变参数。",
            "reason": "这条流程来自录制步骤，里面包含可复用占位参数；先确认参数，再继续执行会更稳定。",
            "suggested_action": "可直接沿用默认值，也可以按当前页面改成新的参数。",
            "confirm_label": "继续执行",
            "cancel_label": "先取消",
            "input_fields": input_fields,
            "options": [
                {
                    "id": "continue",
                    "label": "继续执行",
                    "value": "continue",
                    "branch_steps": normalized_steps,
                    "replace_remaining": True,
                },
                {
                    "id": "cancel",
                    "label": "先取消",
                    "value": "cancel",
                    "replace_remaining": True,
                },
            ],
        }
    ]


def collect_missing_placeholders(node: Any, values: dict[str, str], missing: list[str]) -> None:
    placeholder_pattern = re.compile(r"(?<!\{)\{([a-zA-Z0-9_]+)\}(?!\})")
    if isinstance(node, str):
        for match in placeholder_pattern.findall(node):
            if values.get(match) in (None, "") and match not in missing:
                missing.append(match)
        return
    if isinstance(node, list):
        for item in node:
            collect_missing_placeholders(item, values, missing)
        return
    if isinstance(node, dict):
        for value in node.values():
            collect_missing_placeholders(value, values, missing)


def workflow_name_looks_generic(name: Any) -> bool:
    normalized = re.sub(r"\s+", "", str(name or "")).strip().lower()
    if not normalized:
        return True
    return bool(GENERIC_WORKFLOW_NAME_PATTERN.search(normalized))


def normalize_workflow_source_type(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"seed", "manual", "recorded", "teach"}:
        return normalized
    return "manual"


def annotate_workflow_record(workflow: dict[str, Any]) -> dict[str, Any]:
    annotated = dict(workflow)
    source_type = normalize_workflow_source_type(workflow.get("source_type"))
    step_count = len(workflow.get("steps_json") or [])
    generic_name = workflow_name_looks_generic(workflow.get("name"))
    executable = workflow_steps_look_executable(workflow.get("steps_json") or [])
    product_ready = bool(executable and not generic_name)
    flags: list[str] = []
    if source_type == "seed":
        flags.append("seed")
    if generic_name:
        flags.append("generic_name")
    if not executable:
        flags.append("invalid_steps")
    annotated["source_type"] = source_type
    annotated["step_count"] = step_count
    annotated["name_generic"] = generic_name
    annotated["steps_executable"] = executable
    annotated["product_ready"] = product_ready
    annotated["audit_flags"] = flags
    return annotated


def workflow_audit_summary(workflows: list[dict[str, Any]]) -> dict[str, Any]:
    cleanup_candidates = [
        item
        for item in workflows
        if item.get("name_generic") or not item.get("steps_executable")
    ]
    source_counts: dict[str, int] = {}
    for item in workflows:
        source_type = str(item.get("source_type") or "manual").strip() or "manual"
        source_counts[source_type] = source_counts.get(source_type, 0) + 1
    return {
        "total": len(workflows),
        "product_ready": sum(1 for item in workflows if item.get("product_ready")),
        "generic_name": sum(1 for item in workflows if item.get("name_generic")),
        "seeded": sum(1 for item in workflows if item.get("source_type") == "seed"),
        "cleanup_candidates": len(cleanup_candidates),
        "source_counts": source_counts,
    }


def normalize_document_source_type(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"seed", "text", "file_base64", "manual"}:
        return normalized
    return normalized or "manual"


def document_name_looks_generic(name: Any) -> bool:
    normalized = re.sub(r"\s+", "", str(name or "")).strip().lower()
    if not normalized:
        return True
    return bool(GENERIC_DOCUMENT_NAME_PATTERN.search(normalized))


def annotate_document_record(document: dict[str, Any]) -> dict[str, Any]:
    annotated = dict(document)
    source_type = normalize_document_source_type(document.get("source_type"))
    generic_name = document_name_looks_generic(document.get("name"))
    chunk_count = int(document.get("chunk_count") or 0)
    product_ready = bool(chunk_count >= 1 and not generic_name)
    flags: list[str] = []
    if source_type == "seed":
        flags.append("seed")
    if generic_name:
        flags.append("generic_name")
    if chunk_count <= 0:
        flags.append("empty_chunks")
    annotated["source_type"] = source_type
    annotated["name_generic"] = generic_name
    annotated["product_ready"] = product_ready
    annotated["audit_flags"] = flags
    return annotated


def document_audit_summary(documents: list[dict[str, Any]]) -> dict[str, Any]:
    cleanup_candidates = [
        item
        for item in documents
        if item.get("name_generic") or "empty_chunks" in (item.get("audit_flags") or [])
    ]
    source_counts: dict[str, int] = {}
    for item in documents:
        source_type = str(item.get("source_type") or "manual").strip() or "manual"
        source_counts[source_type] = source_counts.get(source_type, 0) + 1
    return {
        "total": len(documents),
        "product_ready": sum(1 for item in documents if item.get("product_ready")),
        "generic_name": sum(1 for item in documents if item.get("name_generic")),
        "seeded": sum(1 for item in documents if item.get("source_type") == "seed"),
        "cleanup_candidates": len(cleanup_candidates),
        "source_counts": source_counts,
    }


def persona_name_looks_generic(name: Any) -> bool:
    normalized = re.sub(r"\s+", "", str(name or "")).strip().lower()
    if not normalized:
        return True
    return bool(GENERIC_PERSONA_NAME_PATTERN.search(normalized))


def annotate_persona_record(persona: dict[str, Any], skill_counts: dict[str, int]) -> dict[str, Any]:
    annotated = dict(persona)
    persona_id = str(persona.get("persona_id") or "").strip()
    system_prompt = str(persona.get("system_prompt") or "").strip()
    prompt_length = len(system_prompt)
    skill_count = int(skill_counts.get(persona_id, 0) or 0)
    generic_name = persona_name_looks_generic(persona.get("name"))
    flags: list[str] = []
    if generic_name:
        flags.append("generic_name")
    if not system_prompt:
        flags.append("empty_prompt")
    elif prompt_length < 20:
        flags.append("short_prompt")
    if skill_count == 0:
        flags.append("no_bound_skills")
    annotated["skill_count"] = skill_count
    annotated["prompt_length"] = prompt_length
    annotated["name_generic"] = generic_name
    annotated["product_ready"] = not any(flag in {"generic_name", "empty_prompt", "short_prompt"} for flag in flags)
    annotated["audit_flags"] = flags
    return annotated


def persona_audit_summary(personas: list[dict[str, Any]]) -> dict[str, Any]:
    review_candidates = [
        item
        for item in personas
        if any(flag in {"generic_name", "empty_prompt", "short_prompt"} for flag in (item.get("audit_flags") or []))
    ]
    return {
        "total": len(personas),
        "product_ready": sum(1 for item in personas if item.get("product_ready")),
        "generic_name": sum(1 for item in personas if item.get("name_generic")),
        "without_skills": sum(1 for item in personas if int(item.get("skill_count", 0) or 0) == 0),
        "review_candidates": len(review_candidates),
    }


def skill_name_looks_generic(name: Any) -> bool:
    normalized = re.sub(r"\s+", "", str(name or "")).strip().lower()
    if not normalized:
        return True
    return bool(GENERIC_SKILL_NAME_PATTERN.search(normalized))


def annotate_skill_record(skill: dict[str, Any], persona_ids: set[str]) -> dict[str, Any]:
    annotated = dict(skill)
    title = str(skill.get("title") or skill.get("domain_name") or "").strip()
    role_id = str(skill.get("role_id") or "").strip()
    activation_condition = str(skill.get("activation_condition") or "").strip()
    signatures = skill.get("exact_match_signatures_json") or []
    extraction_tasks = skill.get("extraction_tasks_json") or []
    memory_actions = skill.get("skills_json") or []
    site_scope = skill.get("site_scope_json") or []
    generic_name = skill_name_looks_generic(title)
    flags: list[str] = []
    if generic_name:
        flags.append("generic_name")
    if not role_id or role_id not in persona_ids:
        flags.append("missing_role")
    if not activation_condition:
        flags.append("empty_activation")
    if not signatures and not extraction_tasks:
        flags.append("no_matchers")
    if not memory_actions:
        flags.append("no_actions")
    if not site_scope:
        flags.append("empty_scope")
    annotated["title"] = title
    annotated["name_generic"] = generic_name
    annotated["signature_count"] = len(signatures)
    annotated["extraction_task_count"] = len(extraction_tasks)
    annotated["action_count"] = len(memory_actions)
    annotated["scope_count"] = len(site_scope)
    annotated["product_ready"] = not any(flag in {"generic_name", "missing_role", "empty_activation"} for flag in flags)
    annotated["audit_flags"] = flags
    return annotated


def skill_audit_summary(skills: list[dict[str, Any]]) -> dict[str, Any]:
    review_candidates = [
        item
        for item in skills
        if any(flag in {"generic_name", "missing_role", "empty_activation"} for flag in (item.get("audit_flags") or []))
    ]
    role_counts: dict[str, int] = {}
    for item in skills:
        role_id = str(item.get("role_id") or "role_base").strip() or "role_base"
        role_counts[role_id] = role_counts.get(role_id, 0) + 1
    return {
        "total": len(skills),
        "product_ready": sum(1 for item in skills if item.get("product_ready")),
        "generic_name": sum(1 for item in skills if item.get("name_generic")),
        "missing_role": sum(1 for item in skills if "missing_role" in (item.get("audit_flags") or [])),
        "without_actions": sum(1 for item in skills if int(item.get("action_count", 0) or 0) == 0),
        "without_matchers": sum(1 for item in skills if "no_matchers" in (item.get("audit_flags") or [])),
        "review_candidates": len(review_candidates),
        "role_counts": role_counts,
    }


def workflow_display_priority(workflow: dict[str, Any], active_skill_ids: list[str]) -> tuple[int, int, int]:
    bind_skill_id = str(workflow.get("bind_skill_id") or "").strip()
    preferred_bind = 0 if bind_skill_id and bind_skill_id in active_skill_ids else 1
    generic_name = 1 if workflow_name_looks_generic(workflow.get("name")) else 0
    short_steps = 1 if len(workflow.get("steps_json") or []) < 2 else 0
    return (generic_name, preferred_bind, short_steps)


def shorten_json_text(value: Any, limit: int = 1200) -> str:
    text = json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value or "")
    normalized = re.sub(r"\s+", " ", text).strip()
    if len(normalized) <= limit:
        return normalized
    return normalized[:limit] + " ..."


def extract_recall_terms(text: Any) -> list[str]:
    raw = str(text or "").strip().lower()
    if not raw:
        return []
    terms: list[str] = []
    seen: set[str] = set()
    for match in re.findall(r"[a-z0-9_./:-]{3,}|[\u4e00-\u9fff]{2,12}", raw):
        term = str(match or "").strip().lower()
        if not term or term in seen or term in RECALL_STOPWORDS:
            continue
        if term.isdigit():
            continue
        seen.add(term)
        terms.append(term)
    return terms


def merge_unique_strings(values: list[Any], limit: int = 12) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = str(value or "").strip()
        normalized = text.lower()
        if not text or normalized in seen:
            continue
        seen.add(normalized)
        merged.append(text)
        if len(merged) >= limit:
            break
    return merged


def derive_skill_signatures(domain_name: str, activation_condition: str, context_text: str = "", limit: int = 10) -> list[str]:
    candidates: list[str] = []
    for source in [domain_name, activation_condition]:
        text = str(source or "").strip()
        if text and 2 <= len(text) <= 48:
            candidates.append(text)
    shared_context_terms = set(extract_recall_terms(context_text))
    for source in [domain_name, activation_condition]:
        for term in extract_recall_terms(source):
            if shared_context_terms and term not in shared_context_terms and len(term) < 5:
                continue
            candidates.append(term)
    return merge_unique_strings(candidates, limit=limit)


def looks_like_vulnerability_report_skill(runtime_skill: dict[str, Any]) -> bool:
    sample = "\n".join(
        [
            str(runtime_skill.get("domain_name", "")),
            str(runtime_skill.get("activation_condition", "")),
            " ".join(str(item or "") for item in (runtime_skill.get("exact_match_signatures") or [])),
        ]
    ).lower()
    return any(term in sample for term in ("漏洞", "payload", "poc", "复现", "接口路径", "sql injection", "sqli", "xss"))


def build_default_skill_extraction_tasks(domain_name: str, activation_condition: str, existing_tasks: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    if isinstance(existing_tasks, list) and existing_tasks:
        return existing_tasks
    instruction = str(activation_condition or "").strip() or str(domain_name or "").strip() or "结合页面上下文做出审慎判断"
    return [
        {"field_name": "judgement", "instruction": instruction},
        {"field_name": "evidence_basis", "instruction": "提取支撑结论的关键证据，区分原始观察、推断结论与待确认点"},
    ]


def _clone_json_data(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False))


def default_namespace_for_persona(persona_id: str) -> str:
    normalized = str(persona_id or "").strip()
    if normalized == "role_sec_expert":
        return "security"
    if normalized == "role_tech_reader":
        return "research"
    if normalized == "role_life_helper":
        return "life"
    return "general"


def normalize_skill_memory_actions(raw_actions: Any) -> list[dict[str, Any]]:
    normalized_actions: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_actions if isinstance(raw_actions, list) else []:
        if not isinstance(item, dict):
            continue
        action_type = str(item.get("action_type", "")).strip()
        skill_name = str(item.get("skill_name") or item.get("title") or item.get("label") or "").strip()
        normalized: dict[str, Any] = {
            "skill_name": skill_name or "技能动作",
            "action_type": action_type,
        }
        if action_type == "url_render":
            template = str(item.get("template", "")).strip()
            if not template.startswith("http"):
                continue
            normalized["template"] = template
        elif action_type == "browser_action":
            actions = [
                _clone_json_data(action)
                for action in (item.get("actions") or [])
                if isinstance(action, dict) and workflow_step_looks_executable(action)
            ]
            if not actions:
                continue
            normalized["actions"] = actions
        else:
            continue
        dedupe_key = json.dumps(normalized, ensure_ascii=False, sort_keys=True)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        normalized_actions.append(normalized)
    return normalized_actions


def build_skill_memory_actions_from_seed(current_seed: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(current_seed, dict):
        return []
    derived_actions: list[dict[str, Any]] = []

    quick_actions = current_seed.get("quick_actions") or current_seed.get("suggested_actions") or []
    for action in quick_actions if isinstance(quick_actions, list) else []:
        if not isinstance(action, dict):
            continue
        action_type = str(action.get("action_type", "")).strip()
        label = str(action.get("label") or "").strip()
        if action_type == "open_link":
            url = str(action.get("url", "")).strip()
            if url.startswith("http"):
                derived_actions.append(
                    {
                        "skill_name": label or "打开链接",
                        "action_type": "url_render",
                        "template": url,
                    }
                )
        elif action_type == "execute_browser_actions":
            browser_actions = [
                _clone_json_data(step)
                for step in (action.get("browser_actions") or [])
                if isinstance(step, dict) and workflow_step_looks_executable(step)
            ]
            if browser_actions:
                derived_actions.append(
                    {
                        "skill_name": label or "执行页面动作",
                        "action_type": "browser_action",
                        "actions": browser_actions,
                    }
                )

    if not derived_actions:
        for link in current_seed.get("action_links") if isinstance(current_seed.get("action_links"), list) else []:
            if not isinstance(link, dict):
                continue
            url = str(link.get("url", "")).strip()
            if not url.startswith("http"):
                continue
            derived_actions.append(
                {
                    "skill_name": str(link.get("title") or "打开链接").strip() or "打开链接",
                    "action_type": "url_render",
                    "template": url,
                }
            )
        browser_actions = current_seed.get("browser_actions") if isinstance(current_seed.get("browser_actions"), list) else []
        if browser_actions:
            executable_actions = [
                _clone_json_data(step)
                for step in browser_actions
                if isinstance(step, dict) and workflow_step_looks_executable(step)
            ]
            if executable_actions:
                derived_actions.append(
                    {
                        "skill_name": "执行页面动作",
                        "action_type": "browser_action",
                        "actions": executable_actions,
                    }
                )

    return normalize_skill_memory_actions(derived_actions)


def load_runtime_config() -> RuntimeConfig:
    loaded_env_files: list[str] = []
    rebuild_env_file = REBUILD_ROOT / ".env"
    load_env_file(rebuild_env_file)
    loaded_env_files.append(str(rebuild_env_file))
    allow_project_root_env = parse_bool(os.getenv("OMNIAGENT_ALLOW_PROJECT_ROOT_ENV"), False)
    if allow_project_root_env:
        project_root_env_file = PROJECT_ROOT / ".env"
        load_env_file(project_root_env_file)
        loaded_env_files.append(str(project_root_env_file))

    provider_order = ["ccswitch", "deepseek", "openai", "anthropic", "internal", "local"]
    legacy_provider_raw = os.getenv("MODEL_PROVIDER", "").strip().lower()
    inferred_provider = infer_provider_from_env()
    legacy_provider = legacy_provider_raw or inferred_provider or ""
    discovered_ccswitch_provider = discover_ccswitch_saved_provider()
    ccswitch_endpoint_url = detect_local_ccswitch_proxy()
    ccswitch_base_url = resolve_ccswitch_base_url(ccswitch_endpoint_url)
    if discovered_ccswitch_provider and not env_first("CCSWITCH_BASE_URL", "CC_SWITCH_BASE_URL"):
        ccswitch_base_url = discovered_ccswitch_provider.base_url or ccswitch_base_url
    ccswitch_proxy_url = ccswitch_endpoint_url if should_use_ccswitch_http_proxy() else ""
    system_proxy_url = discover_system_http_proxy() if should_trust_system_proxy() else ""
    ccswitch_source_provider = (
        discovered_ccswitch_provider if discovered_ccswitch_provider and discovered_ccswitch_provider.base_url == ccswitch_base_url else None
    )
    internal_provider_type = resolve_internal_provider_type(os.getenv("INTERNAL_BASE_URL", ""))

    provider_catalog: dict[str, ProviderConfig] = {
        "ccswitch": ProviderConfig(
            provider_id="ccswitch",
            provider_type=ccswitch_source_provider.provider_type if ccswitch_source_provider else "openai_compatible",
            base_url=ccswitch_base_url,
            api_key=env_first("CCSWITCH_API_KEY", "CC_SWITCH_API_KEY")
            or resolve_api_key_for_provider_type(
                ccswitch_source_provider.provider_type if ccswitch_source_provider else "",
                ccswitch_source_provider.api_key if ccswitch_source_provider else "",
            ),
            auth_token=env_first("CCSWITCH_AUTH_TOKEN", "CC_SWITCH_AUTH_TOKEN")
            or resolve_auth_token_for_provider_type(
                ccswitch_source_provider.provider_type if ccswitch_source_provider else "",
                ccswitch_source_provider.auth_token if ccswitch_source_provider else "",
            ),
            model_name=env_first(
                "CCSWITCH_MODEL",
                "CC_SWITCH_MODEL",
                default=resolve_model_name_for_provider_type(
                    ccswitch_source_provider.provider_type if ccswitch_source_provider else "",
                    ccswitch_source_provider.model_name if ccswitch_source_provider else "auto",
                ),
            ),
            supports_vision=parse_bool(
                env_first("CCSWITCH_SUPPORTS_VISION", "CC_SWITCH_SUPPORTS_VISION"),
                ccswitch_source_provider.supports_vision if ccswitch_source_provider else True,
            ),
            supports_tool_use=parse_bool(
                env_first("CCSWITCH_SUPPORTS_TOOL_USE", "CC_SWITCH_SUPPORTS_TOOL_USE"),
                ccswitch_source_provider.supports_tool_use if ccswitch_source_provider else True,
            ),
            source_env_provider=ccswitch_source_provider.source_env_provider if ccswitch_source_provider else "",
            source_app_type=ccswitch_source_provider.source_app_type if ccswitch_source_provider else "",
            source_label=ccswitch_source_provider.source_label if ccswitch_source_provider else "",
        ),
        "deepseek": ProviderConfig(
            provider_id="deepseek",
            provider_type="openai_compatible",
            base_url=normalize_base_url(os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")),
            api_key=os.getenv("DEEPSEEK_API_KEY", "").strip(),
            auth_token="",
            model_name=os.getenv("DEEPSEEK_MODEL", "").strip() or "deepseek-chat",
            supports_vision=parse_bool(os.getenv("DEEPSEEK_SUPPORTS_VISION"), False),
            supports_tool_use=parse_bool(os.getenv("DEEPSEEK_SUPPORTS_TOOL_USE"), False),
        ),
        "openai": ProviderConfig(
            provider_id="openai",
            provider_type="openai_compatible",
            base_url=normalize_base_url(os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")),
            api_key=os.getenv("OPENAI_API_KEY", "").strip(),
            auth_token="",
            model_name=os.getenv("OPENAI_MODEL", "").strip() or "gpt-4o-mini",
            supports_vision=parse_bool(os.getenv("OPENAI_SUPPORTS_VISION"), True),
            supports_tool_use=parse_bool(os.getenv("OPENAI_SUPPORTS_TOOL_USE"), True),
        ),
        "anthropic": ProviderConfig(
            provider_id="anthropic",
            provider_type="anthropic",
            base_url=normalize_base_url(os.getenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com")),
            api_key=resolve_api_key_for_provider_type("anthropic", ""),
            auth_token=resolve_auth_token_for_provider_type("anthropic", ""),
            model_name=resolve_model_name_for_provider_type("anthropic", "claude-3-5-haiku-latest"),
            supports_vision=parse_bool(os.getenv("ANTHROPIC_SUPPORTS_VISION"), True),
            supports_tool_use=parse_bool(os.getenv("ANTHROPIC_SUPPORTS_TOOL_USE"), True),
        ),
        "internal": ProviderConfig(
            provider_id="internal",
            provider_type=internal_provider_type,
            base_url=resolve_internal_base_url(internal_provider_type),
            api_key=resolve_internal_api_key(internal_provider_type),
            auth_token=resolve_internal_auth_token(internal_provider_type),
            model_name=resolve_internal_model(internal_provider_type),
            supports_vision=resolve_internal_supports_vision(internal_provider_type),
            supports_tool_use=resolve_internal_supports_tool_use(internal_provider_type),
            source_label="internal-env",
        ),
        "local": ProviderConfig(
            provider_id="local",
            provider_type="openai_compatible",
            base_url=normalize_base_url(os.getenv("LOCAL_MODEL_URL", "")),
            api_key=os.getenv("LOCAL_MODEL_API_KEY", "").strip(),
            auth_token="",
            model_name=os.getenv("LOCAL_MODEL_NAME", "").strip() or "local-default",
            supports_vision=parse_bool(os.getenv("LOCAL_MODEL_SUPPORTS_VISION"), False),
            supports_tool_use=parse_bool(os.getenv("LOCAL_MODEL_SUPPORTS_TOOL_USE"), False),
        ),
    }

    def wrap_provider_as_ccswitch(upstream: ProviderConfig) -> ProviderConfig:
        return ProviderConfig(
            provider_id="ccswitch",
            provider_type=upstream.provider_type,
            base_url=upstream.base_url,
            api_key=upstream.api_key,
            auth_token=upstream.auth_token,
            model_name=upstream.model_name or "auto",
            supports_vision=upstream.supports_vision,
            supports_tool_use=upstream.supports_tool_use,
            source_env_provider=upstream.provider_id,
            source_app_type=upstream.source_app_type,
            source_label=upstream.source_label or upstream.provider_id,
        )

    if not legacy_provider_raw and not inferred_provider and (ccswitch_source_provider or ccswitch_endpoint_url):
        legacy_provider = "ccswitch"

    if not legacy_provider:
        legacy_provider = "deepseek"

    configured_provider_id = legacy_provider if legacy_provider in provider_catalog else "deepseek"
    selected_provider_id = configured_provider_id
    active_provider = provider_catalog.get(selected_provider_id)
    if active_provider and not active_provider.base_url:
        active_provider = None
    if active_provider is None and configured_provider_id != "ccswitch":
        for provider_id in provider_order:
            candidate = provider_catalog.get(provider_id)
            if candidate and candidate.base_url:
                active_provider = candidate
                selected_provider_id = provider_id
                break

    if ccswitch_proxy_url and configured_provider_id == "ccswitch":
        explicit_ccswitch = provider_catalog.get("ccswitch")
        if configured_provider_id == "ccswitch" and explicit_ccswitch and explicit_ccswitch.base_url:
            active_provider = explicit_ccswitch
            selected_provider_id = "ccswitch"

    active_model = active_provider.model_name if active_provider else ""
    return RuntimeConfig(
        host=os.getenv("HOST", os.getenv("OMNIAGENT_HOST", "127.0.0.1")).strip() or "127.0.0.1",
        port=int(os.getenv("PORT", os.getenv("OMNIAGENT_PORT", "8765")).strip() or "8765"),
        debug=parse_bool(os.getenv("DEBUG", os.getenv("OMNIAGENT_DEBUG")), True),
        db_path=str(DB_FILE),
        selected_provider_id=selected_provider_id,
        active_provider=active_provider,
        router_model=os.getenv("ROUTER_MODEL", "").strip() or active_model,
        analyzer_model=os.getenv("ANALYZER_MODEL", "").strip() or active_model,
        chat_model=os.getenv("CHAT_MODEL", "").strip() or active_model,
        teach_model=os.getenv("TEACH_MODEL", "").strip() or active_model,
        health_ttl_seconds=int(os.getenv("HEALTH_TTL_SECONDS", "20").strip() or "20"),
        ccswitch_endpoint_url=ccswitch_endpoint_url,
        ccswitch_proxy_url=ccswitch_proxy_url,
        system_proxy_url=system_proxy_url,
        loaded_env_files=loaded_env_files,
    )


class GeminiBaselineRuntime:
    def __init__(self, config: RuntimeConfig, db: Database):
        self.config = config
        self.db = db
        self._probe_cache: dict[tuple[str, str], ProbeResult] = {}
        self._context_sessions: dict[str, ContextSnapshot] = {}

    def active_provider(self) -> ProviderConfig:
        provider = self.config.active_provider
        if provider is None:
            raise ApiError("PROVIDER_UNCONFIGURED", "当前未配置可用的模型 Provider", 503)
        return provider

    def provider_configured(self) -> tuple[bool, str]:
        provider = self.config.active_provider
        if provider is None:
            return False, "no provider selected"
        if not provider.base_url:
            return False, "base_url missing"
        if not self.task_model("analyzer"):
            return False, "model missing"
        if provider.api_key:
            return True, "configured"
        if provider.auth_token:
            return True, "configured"
        if provider_allows_keyless(provider):
            return True, "configured (keyless gateway)"
        return False, "auth missing"

    def task_model(self, task_name: str) -> str:
        if task_name == "router":
            return self.config.router_model
        if task_name == "analyzer":
            return self.config.analyzer_model
        if task_name == "chat":
            return self.config.chat_model
        if task_name == "teach":
            return self.config.teach_model
        return self.config.analyzer_model

    def _request_kwargs(self, provider: ProviderConfig) -> dict[str, Any]:
        kwargs: dict[str, Any] = {}
        if self.config.ccswitch_proxy_url and not is_local_url(provider.base_url):
            kwargs["proxies"] = {
                "http": self.config.ccswitch_proxy_url,
                "https": self.config.ccswitch_proxy_url,
            }
        elif self.config.system_proxy_url and not is_local_url(provider.base_url):
            kwargs["proxies"] = {
                "http": self.config.system_proxy_url,
                "https": self.config.system_proxy_url,
            }
        return kwargs

    def _cache_probe(self, model_name: str, ready: bool, reason: str) -> ProbeResult:
        provider = self.active_provider()
        result = ProbeResult(ready=ready, reason=reason, checked_at=time.time())
        self._probe_cache[(provider.provider_id, model_name)] = result
        return result

    def _get_cached_probe(self, model_name: str) -> ProbeResult | None:
        provider = self.config.active_provider
        if provider is None:
            return None
        result = self._probe_cache.get((provider.provider_id, model_name))
        if result is None:
            return None
        if time.time() - result.checked_at > self.config.health_ttl_seconds:
            return None
        return result

    def _headers_for_openai_compatible(self, provider: ProviderConfig) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if provider.api_key:
            headers["Authorization"] = f"Bearer {provider.api_key}"
        elif provider.auth_token:
            headers["Authorization"] = f"Bearer {provider.auth_token}"
        return headers

    def _headers_for_anthropic(self, provider: ProviderConfig) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}
        if provider.api_key:
            headers["x-api-key"] = provider.api_key
        if provider.auth_token:
            headers["Authorization"] = f"Bearer {provider.auth_token}"
        return headers

    def _extract_response_error_message(self, response: requests.Response) -> str:
        try:
            body = response.json() if response.content else {}
        except Exception:
            body = {}
        if isinstance(body, dict):
            error_block = body.get("error")
            if isinstance(error_block, dict):
                text = first_non_empty_string(
                    [
                        error_block.get("message"),
                        error_block.get("error"),
                        error_block.get("detail"),
                        error_block.get("type"),
                    ]
                )
                if text:
                    return text
            return first_non_empty_string([body.get("message"), body.get("detail"), body.get("error")])
        if isinstance(body, list):
            return first_non_empty_string(body)
        return ""

    def _raise_for_status_with_detail(self, response: requests.Response, context: str, provider: ProviderConfig, model_name: str) -> None:
        if response.status_code < 400:
            return
        detail = self._extract_response_error_message(response)
        hints: list[str] = []
        if provider.provider_type == "anthropic":
            if str(model_name).strip().lower() == "auto":
                hints.append("当前 model=auto，这类 Anthropic 兼容入口通常需要明确模型名")
            if not provider.api_key and not provider.auth_token:
                hints.append("当前未携带 x-api-key / Authorization")
        if provider.provider_id == "ccswitch" and provider.provider_type == "anthropic":
            hints.append("如果 VSCode Claude Code 正常，但这里失败，说明 VSCode 插件里的 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_DEFAULT_*_MODEL 不会自动传给 OmniAgent 进程")
        suffix = []
        if detail:
            suffix.append(f"detail={detail}")
        suffix.append(f"model={model_name or '<empty>'}")
        suffix.append(f"api_key={'present' if provider.api_key else 'missing'}")
        suffix.append(f"auth_token={'present' if provider.auth_token else 'missing'}")
        if provider.source_app_type:
            suffix.append(f"source_app={provider.source_app_type}")
        if provider.source_label:
            suffix.append(f"source_label={provider.source_label}")
        suffix.extend(hints)
        raise RuntimeError(f"{context}: HTTP {response.status_code} for url: {response.url}; " + " | ".join(suffix))

    def _extract_openai_model_ids(self, payload: Any) -> list[str]:
        if not isinstance(payload, dict):
            return []
        data = payload.get("data")
        if not isinstance(data, list):
            return []
        model_ids: list[str] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            model_id = str(item.get("id", "")).strip()
            if model_id and model_id not in model_ids:
                model_ids.append(model_id)
        return model_ids

    def _diagnose_local_openai_compatible_failure(self, provider: ProviderConfig, model_name: str, last_error: Exception | None) -> str:
        error_text = str(last_error or "unknown error")
        if not provider.base_url or not is_local_url(provider.base_url):
            return error_text

        models_lookup_error: Exception | None = None
        for url in build_openai_models_urls(provider.base_url):
            try:
                response = requests.get(
                    url,
                    headers=self._headers_for_openai_compatible(provider),
                    timeout=(2, 6),
                    **self._request_kwargs(provider),
                )
                if response.status_code in {401, 403}:
                    return f"{error_text}; 本地网关可达，但 {url} 拒绝认证（HTTP {response.status_code}）"
                response.raise_for_status()
                body = response.json() if response.content else {}
                model_ids = self._extract_openai_model_ids(body)
                if model_ids:
                    preview = ", ".join(model_ids[:4])
                    if str(model_name).strip().lower() == "auto":
                        return (
                            f"{error_text}; 本地网关可达，/models 暴露了 [{preview}]；"
                            "当前 model=auto 可能不被该入口接受，请把 CCSWITCH_MODEL 改成实际模型名"
                        )
                    if model_name and model_name not in model_ids:
                        return (
                            f"{error_text}; 本地网关可达，/models 暴露了 [{preview}]；"
                            f"当前 model={model_name} 不在已暴露模型列表里"
                        )
                    return (
                        f"{error_text}; 本地网关可达，/models 暴露了 [{preview}]；"
                        "补全接口仍不可用，请检查 CC Switch 的上游登录状态、当前 Provider 与代理应用开关"
                    )
                return f"{error_text}; 本地网关可达，但 /models 返回为空"
            except Exception as exc:
                models_lookup_error = exc

        if provider.provider_id == "ccswitch" and ("503" in error_text or "Service Unavailable" in error_text):
            suffix = "本地 ccswitch 端口可达，但上游 provider/channel 当前不可用；请检查 CC Switch 登录状态、当前 Provider，以及是否启用了匹配的代理应用（通常是 Codex/OpenAI-compatible 通道）"
            if str(model_name).strip().lower() == "auto":
                suffix += "；另外当前 CCSWITCH_MODEL=auto，若仍失败，建议改成实际模型名"
            return f"{error_text}; {suffix}"

        if models_lookup_error is not None:
            return f"{error_text}; 本地网关诊断失败：{models_lookup_error}"
        return error_text

    def _probe_openai_compatible(self, provider: ProviderConfig, model_name: str) -> None:
        payload = {
            "model": model_name,
            "messages": [{"role": "user", "content": "health probe"}],
            "max_tokens": 1,
            "temperature": 0,
        }
        last_error: Exception | None = None
        for url in build_openai_chat_urls(provider.base_url):
            try:
                response = requests.post(
                    url,
                    headers=self._headers_for_openai_compatible(provider),
                    json=payload,
                    timeout=(2, 12),
                    **self._request_kwargs(provider),
                )
                response.raise_for_status()
                body = response.json()
                if body.get("choices"):
                    return
                raise RuntimeError("empty choices")
            except Exception as exc:
                last_error = exc
        reason = self._diagnose_local_openai_compatible_failure(provider, model_name, last_error)
        raise RuntimeError(f"openai-compatible probe failed: {reason}")

    def _probe_anthropic(self, provider: ProviderConfig, model_name: str) -> None:
        payload = {
            "model": model_name,
            "max_tokens": 1,
            "temperature": 0,
            "messages": [{"role": "user", "content": [{"type": "text", "text": "health probe"}]}],
        }
        response = requests.post(
            build_anthropic_messages_url(provider.base_url),
            headers=self._headers_for_anthropic(provider),
            json=payload,
            timeout=(2, 12),
            **self._request_kwargs(provider),
        )
        self._raise_for_status_with_detail(response, "anthropic probe failed", provider, model_name)
        body = response.json()
        if not body.get("content"):
            raise RuntimeError("empty anthropic content")

    def probe_task(self, task_name: str, force: bool = False) -> ProbeResult:
        configured, configured_reason = self.provider_configured()
        if not configured:
            return ProbeResult(False, configured_reason, time.time())
        model_name = self.task_model(task_name)
        if not model_name:
            return ProbeResult(False, "task model missing", time.time())
        if not force:
            cached = self._get_cached_probe(model_name)
            if cached is not None:
                return cached
        provider = self.active_provider()
        try:
            if provider.provider_type == "anthropic":
                self._probe_anthropic(provider, model_name)
            else:
                self._probe_openai_compatible(provider, model_name)
            return self._cache_probe(model_name, True, "ready")
        except Exception as exc:
            LOGGER.warning("Probe failed task=%s provider=%s error=%s", task_name, provider.provider_id, exc)
            return self._cache_probe(model_name, False, str(exc))

    def ensure_task_ready(self, task_name: str) -> None:
        result = self.probe_task(task_name)
        if result.ready:
            return
        prefix = {
            "router": "路由模型当前不可用，本次分析未生成结果",
            "analyzer": "分析模型当前不可用，本次分析未生成结果",
            "chat": "聊天模型当前不可用，本次对话未生成结果",
            "teach": "教导模型当前不可用，本次教导未生成结果",
        }.get(task_name, "模型当前不可用")
        raise ApiError("MODEL_UNAVAILABLE", f"{prefix}：{result.reason}", 503, {"task": task_name, "reason": result.reason})

    def _to_openai_messages(self, messages: list[dict[str, Any]], allow_vision: bool) -> list[dict[str, Any]]:
        converted: list[dict[str, Any]] = []
        for message in messages:
            blocks = []
            text_parts: list[str] = []
            for block in message.get("content", []):
                if block.get("type") == "text":
                    text = str(block.get("text", ""))
                    text_parts.append(text)
                    blocks.append({"type": "text", "text": text})
                elif block.get("type") == "image" and allow_vision:
                    blocks.append({"type": "image_url", "image_url": {"url": data_url_from_any_image(block.get("data_url", ""))}})
            if not blocks:
                content: Any = ""
            elif all(block.get("type") == "text" for block in blocks):
                content = "\n".join(text_parts)
            else:
                content = blocks
            converted.append({"role": message.get("role", "user"), "content": content})
        return converted

    def _to_anthropic_messages(self, messages: list[dict[str, Any]], allow_vision: bool) -> list[dict[str, Any]]:
        converted: list[dict[str, Any]] = []
        for message in messages:
            content_blocks: list[dict[str, Any]] = []
            for block in message.get("content", []):
                if block.get("type") == "text":
                    content_blocks.append({"type": "text", "text": str(block.get("text", ""))})
                elif block.get("type") == "image" and allow_vision:
                    parsed = parse_image_base64(data_url_from_any_image(block.get("data_url", "")))
                    content_blocks.append(
                        {
                            "type": "image",
                            "source": {"type": "base64", "media_type": parsed["media_type"], "data": parsed["data"]},
                        }
                    )
            converted.append({"role": message.get("role", "user"), "content": content_blocks or [{"type": "text", "text": ""}]})
        return converted

    def _call_openai_compatible(
        self,
        provider: ProviderConfig,
        model_name: str,
        system_prompt: str,
        messages: list[dict[str, Any]],
        max_tokens: int,
        temperature: float,
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model_name,
            "messages": [{"role": "system", "content": system_prompt}, *self._to_openai_messages(messages, provider.supports_vision)],
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if tools and provider.supports_tool_use:
            payload["tools"] = openai_tools_from_agent_tools(tools)
            payload["tool_choice"] = "auto"

        last_error: Exception | None = None
        for url in build_openai_chat_urls(provider.base_url):
            try:
                response = requests.post(
                    url,
                    headers=self._headers_for_openai_compatible(provider),
                    json=payload,
                    timeout=(3, 60),
                    **self._request_kwargs(provider),
                )
                self._raise_for_status_with_detail(response, "openai-compatible call failed", provider, model_name)
                body = response.json()
                message = ((body.get("choices") or [{}])[0] or {}).get("message") or {}
                text_parts: list[str] = []
                content = message.get("content", "")
                if isinstance(content, str):
                    text_parts.append(content)
                elif isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and item.get("type") == "text":
                            text_parts.append(str(item.get("text", "")))
                tool_calls = []
                for tool_call in message.get("tool_calls", []) or []:
                    function = tool_call.get("function", {})
                    try:
                        parsed_args = json.loads(function.get("arguments", "{}"))
                    except json.JSONDecodeError:
                        parsed_args = {}
                    tool_calls.append({"name": function.get("name", ""), "input": parsed_args})
                return {"text": "\n".join(part for part in text_parts if part).strip(), "tool_calls": tool_calls, "raw": body}
            except Exception as exc:
                last_error = exc
        raise RuntimeError(f"openai-compatible call failed: {last_error}")

    def _call_anthropic(
        self,
        provider: ProviderConfig,
        model_name: str,
        system_prompt: str,
        messages: list[dict[str, Any]],
        max_tokens: int,
        temperature: float,
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model_name,
            "system": system_prompt,
            "messages": self._to_anthropic_messages(messages, provider.supports_vision),
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if tools and provider.supports_tool_use:
            payload["tools"] = anthropic_tools_from_agent_tools(tools)
        response = requests.post(
            build_anthropic_messages_url(provider.base_url),
            headers=self._headers_for_anthropic(provider),
            json=payload,
            timeout=(3, 60),
            **self._request_kwargs(provider),
        )
        self._raise_for_status_with_detail(response, "anthropic call failed", provider, model_name)
        body = response.json()
        text_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        for block in body.get("content", []) or []:
            if block.get("type") == "text":
                text_parts.append(str(block.get("text", "")))
            elif block.get("type") == "tool_use":
                tool_calls.append({"name": block.get("name", ""), "input": block.get("input", {})})
        return {"text": "\n".join(part for part in text_parts if part).strip(), "tool_calls": tool_calls, "raw": body}

    def call_task(
        self,
        task_name: str,
        system_prompt: str,
        messages: list[dict[str, Any]],
        max_tokens: int,
        temperature: float,
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        self.ensure_task_ready(task_name)
        provider = self.active_provider()
        model_name = self.task_model(task_name)
        try:
            if provider.provider_type == "anthropic":
                return self._call_anthropic(provider, model_name, system_prompt, messages, max_tokens, temperature, tools)
            return self._call_openai_compatible(provider, model_name, system_prompt, messages, max_tokens, temperature, tools)
        except Exception as exc:
            self._cache_probe(model_name, False, str(exc))
            raise ApiError(
                "MODEL_CALL_FAILED",
                f"{task_name} 模型调用失败：{exc}",
                502,
                {"task": task_name, "provider": provider.provider_id, "reason": str(exc)},
            ) from exc

    def _persona_map(self) -> dict[str, dict[str, Any]]:
        personas = {item["persona_id"]: item for item in self.db.list_personas()}
        if "role_base" not in personas:
            seed = default_personas_seed()["role_base"]
            personas["role_base"] = {"persona_id": "role_base", "name": seed["name"], "system_prompt": seed["system_prompt"]}
        return personas

    def _skill_records(self) -> list[dict[str, Any]]:
        return self.db.list_skills()

    def _skill_to_runtime(self, record: dict[str, Any]) -> dict[str, Any]:
        return {
            "skill_id": record.get("skill_id"),
            "domain_name": record.get("title"),
            "role_id": record.get("role_id", "role_base"),
            "activation_condition": record.get("activation_condition", ""),
            "exact_match_signatures": record.get("exact_match_signatures_json", []) or [],
            "extraction_tasks": record.get("extraction_tasks_json", []) or [],
            "skills": record.get("skills_json", []) or [],
            "site_scope": record.get("site_scope_json", ["*"]) or ["*"],
        }

    def _score_skill_recall(self, text: str, runtime_skill: dict[str, Any]) -> tuple[int, list[str], list[str]]:
        text_lower = str(text or "").lower()
        strong_hits: list[str] = []
        weak_hits: list[str] = []
        score = 0

        for signature in runtime_skill.get("exact_match_signatures", []) or []:
            normalized = str(signature or "").strip().lower()
            if normalized and normalized in text_lower:
                strong_hits.append(str(signature).strip())
                score += 5 if len(normalized) >= 4 else 3

        semantic_sources = [
            runtime_skill.get("domain_name", ""),
            runtime_skill.get("activation_condition", ""),
        ]
        for source in semantic_sources:
            for term in extract_recall_terms(source):
                if term in text_lower and term not in {item.lower() for item in strong_hits}:
                    weak_hits.append(term)
                    score += 2 if len(term) >= 4 else 1

        score += min(len(strong_hits), 3) * 2
        score += min(len(set(weak_hits)), 4)
        return score, merge_unique_strings(strong_hits, limit=6), merge_unique_strings(weak_hits, limit=8)

    def get_health(self, force: bool = False) -> dict[str, Any]:
        configured, configured_reason = self.provider_configured()
        task_readiness: dict[str, bool] = {}
        reasons: dict[str, str] = {}
        for task_name in ("router", "analyzer", "chat", "teach"):
            result = self.probe_task(task_name, force=force) if configured else ProbeResult(False, configured_reason, time.time())
            task_readiness[task_name] = result.ready
            reasons[task_name] = result.reason
        overall_ok = configured and all(task_readiness.values())
        provider = self.config.active_provider
        provider_status = {
            "provider_id": provider.provider_id if provider else None,
            "upstream_provider_id": describe_upstream_provider(provider),
            "provider_type": provider.provider_type if provider else None,
            "source_app_type": provider.source_app_type if provider else "",
            "source_label": provider.source_label if provider else "",
            "configured": configured,
            "ok": overall_ok,
            "status_reason": "ready" if overall_ok else configured_reason if not configured else "; ".join(
                f"{task}={reason}" for task, reason in reasons.items() if not task_readiness.get(task)
            ),
            "supports_vision": bool(provider and provider.supports_vision),
            "supports_tool_use": bool(provider and provider.supports_tool_use),
            "model_name": provider.model_name if provider else "",
            "base_url": provider.base_url if provider else "",
            "routing_mode": describe_routing_mode(self.config, provider),
        }
        return {
            "status": "ok" if overall_ok else "degraded",
            "status_reason": "ready" if overall_ok else "provider or task unavailable",
            "provider": provider.provider_id if provider else None,
            "upstream_provider": describe_upstream_provider(provider),
            "provider_type": provider.provider_type if provider else None,
            "source_app_type": provider.source_app_type if provider else "",
            "source_label": provider.source_label if provider else "",
            "configured": configured,
            "configured_reason": configured_reason,
            "task_readiness": task_readiness,
            "task_reasons": reasons,
            "supports": {
                "vision": bool(provider and provider.supports_vision),
                "tool_use": bool(provider and provider.supports_tool_use),
            },
            "models": {
                "router": self.config.router_model,
                "analyzer": self.config.analyzer_model,
                "chat": self.config.chat_model,
                "teach": self.config.teach_model,
            },
            "env_files": list(self.config.loaded_env_files),
            "ccswitch_endpoint": self.config.ccswitch_endpoint_url or "",
            "proxy": self.config.ccswitch_proxy_url or "",
            "system_proxy": self.config.system_proxy_url or "",
            "sessions": len(self._context_sessions),
            "db": {"sqlite": self.db.db_path.exists(), "path": str(self.db.db_path)},
            "providers": [provider_status],
        }

    def save_context_snapshot(
        self,
        context_key: str,
        text: str,
        images: list[str],
        image_meta: dict[str, Any],
        page_meta: dict[str, Any],
        scope_meta: dict[str, Any],
        browser_state: dict[str, Any] | None = None,
    ) -> None:
        self._context_sessions[context_key] = ContextSnapshot(
            context_key=context_key,
            text=text[:4000],
            images=images[:4],
            image_meta=image_meta or {},
            page_meta=page_meta,
            scope_meta=scope_meta,
            browser_state=browser_state or {},
        )

    def get_context_snapshot(self, context_key: str) -> ContextSnapshot | None:
        return self._context_sessions.get(context_key)

    def local_keyword_recall(
        self,
        text: str,
        skills: list[dict[str, Any]],
        host: str = "",
        page_meta: dict[str, Any] | None = None,
        browser_state: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        alert_context = looks_like_security_alert_context(text, page_meta=page_meta, browser_state=browser_state)
        candidates: list[dict[str, Any]] = []
        for record in skills:
            runtime_skill = self._skill_to_runtime(record)
            if not site_scope_matches(runtime_skill.get("site_scope", ["*"]), host):
                continue
            score, strong_hits, weak_hits = self._score_skill_recall(text, runtime_skill)
            if (
                alert_context
                and looks_like_vulnerability_report_skill(runtime_skill)
                and strong_hits
                and all(str(item).strip().lower() in GENERIC_ATTACK_LABEL_TERMS for item in strong_hits)
                and not weak_hits
            ):
                continue
            include = bool(strong_hits) or score >= 2 or len(weak_hits) >= 2
            if include:
                runtime_skill["recall_score"] = score
                runtime_skill["strong_hits"] = strong_hits
                runtime_skill["weak_hits"] = weak_hits
                candidates.append(runtime_skill)
        candidates.sort(key=lambda item: int(item.get("recall_score", 0)), reverse=True)
        return candidates

    def _local_route_fallback(
        self,
        candidates: list[dict[str, Any]],
        personas: dict[str, dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
        if not candidates:
            return [], personas["role_base"], "fallback_to_local_recall: no_candidates"
        selected: list[dict[str, Any]] = []
        top_score = int(candidates[0].get("recall_score", 0))
        primary_role_id = str(candidates[0].get("role_id", "role_base")).strip() or "role_base"
        score_floor = max(2, top_score - 1)
        for candidate in candidates:
            candidate_role_id = str(candidate.get("role_id", "role_base")).strip() or "role_base"
            candidate_score = int(candidate.get("recall_score", 0))
            if not selected:
                selected.append(candidate)
                continue
            if len(selected) >= 2:
                break
            if candidate_role_id != primary_role_id or candidate_score < score_floor:
                continue
            selected.append(candidate)
        persona = personas.get(primary_role_id, personas["role_base"])
        return selected, persona, f"fallback_to_local_recall: role={primary_role_id}, score_floor={score_floor}"

    def _local_sop_fallback(self, candidates: list[dict[str, Any]], selected_role_id: str) -> tuple[list[dict[str, Any]], str]:
        role_candidates = [
            candidate
            for candidate in candidates
            if (str(candidate.get("role_id", "role_base")).strip() or "role_base") == selected_role_id
        ]
        if not role_candidates:
            return [], f"fallback_to_local_role_scoped_recall: role={selected_role_id}, no_role_candidates"
        selected: list[dict[str, Any]] = []
        top_score = int(role_candidates[0].get("recall_score", 0))
        score_floor = max(2, top_score - 1)
        for candidate in role_candidates:
            candidate_score = int(candidate.get("recall_score", 0))
            if candidate_score < score_floor:
                continue
            selected.append(candidate)
            if len(selected) >= 2:
                break
        if not selected and role_candidates:
            selected = role_candidates[:1]
        return selected, f"fallback_to_local_role_scoped_recall: role={selected_role_id}, score_floor={score_floor}"

    def _build_role_shortlist(
        self,
        text: str,
        page_meta: dict[str, Any],
        browser_state: dict[str, Any],
        candidates: list[dict[str, Any]],
        personas: dict[str, dict[str, Any]],
        limit: int = MAX_ROUTER_ROLE_SHORTLIST,
    ) -> list[dict[str, Any]]:
        corpus_parts = [
            str(text or "").strip(),
            str(page_meta.get("title", "")).strip(),
            str(page_meta.get("url", "")).strip(),
            str(page_meta.get("host", "")).strip(),
            str((browser_state or {}).get("page_kind", "")).strip(),
            str((browser_state or {}).get("page_agent_header", "")).strip(),
            str((browser_state or {}).get("page_agent_content", "")).strip()[:2000],
        ]
        recall_corpus = "\n".join(part for part in corpus_parts if part)
        recall_terms = set(extract_recall_terms(recall_corpus))
        alert_context = looks_like_security_alert_context(text, page_meta=page_meta, browser_state=browser_state)
        host = str(page_meta.get("host", "")).strip().lower()
        title = str(page_meta.get("title", "")).strip().lower()
        role_candidates: list[dict[str, Any]] = []

        for role_id, persona in personas.items():
            persona_name = str(persona.get("name", role_id)).strip()
            persona_prompt = str(persona.get("system_prompt", "")).strip()
            persona_terms = extract_recall_terms(f"{persona_name}\n{persona_prompt}")
            matched_terms = [term for term in persona_terms if term in recall_terms]
            role_skill_candidates = [
                candidate
                for candidate in candidates
                if (str(candidate.get("role_id", "role_base")).strip() or "role_base") == role_id
            ]
            candidate_count = len(role_skill_candidates)
            max_candidate_score = max((int(item.get("recall_score", 0) or 0) for item in role_skill_candidates), default=0)
            score = max_candidate_score * 2 + min(candidate_count, 2)
            if matched_terms:
                score += len(matched_terms) * 2
            if role_id == "role_sec_expert" and alert_context:
                score += 4
            if role_id == "role_tech_reader" and (
                "github.com" in host
                or "readme" in title
                or "文档" in title
                or "docs" in title
                or "api" in title
            ):
                score += 3
            if role_id == "role_life_helper" and any(term in recall_terms for term in {"菜谱", "购物", "论坛", "商品", "做菜"}):
                score += 3
            if role_id == "role_base":
                score = max(score, 1)
            role_candidates.append(
                {
                    "role_id": role_id,
                    "name": persona_name,
                    "system_prompt": persona_prompt,
                    "max_score": max_candidate_score,
                    "candidate_count": candidate_count,
                    "score": score,
                    "domain_names": merge_unique_strings([item.get("domain_name", "") for item in role_skill_candidates], limit=4),
                    "strong_hits": merge_unique_strings([term for term in matched_terms if len(term) >= 4], limit=6),
                    "weak_hits": merge_unique_strings([term for term in matched_terms if len(term) < 4], limit=6),
                }
            )

        ranked_roles = sorted(
            role_candidates,
            key=lambda item: (-int(item.get("score", 0)), -int(item.get("max_score", 0)), -int(item.get("candidate_count", 0)), str(item.get("role_id", ""))),
        )
        shortlist = ranked_roles[: max(1, limit)]
        role_base = personas.get("role_base")
        if role_base and not any(item.get("role_id") == "role_base" for item in shortlist):
            shortlist.append(
                {
                    "role_id": "role_base",
                    "name": role_base.get("name", "role_base"),
                    "system_prompt": role_base.get("system_prompt", ""),
                    "max_score": 0,
                    "candidate_count": 0,
                    "score": 1,
                    "domain_names": [],
                    "strong_hits": [],
                    "weak_hits": [],
                }
            )
        return shortlist

    def _select_role_with_ai(
        self,
        text: str,
        page_meta: dict[str, Any],
        browser_state: dict[str, Any],
        role_shortlist: list[dict[str, Any]],
    ) -> tuple[str, str]:
        persona_catalog = [
            {
                "role_id": item.get("role_id"),
                "name": item.get("name", item.get("role_id", "")),
                "candidate_count": item.get("candidate_count", 0),
                "max_score": item.get("max_score", 0),
                "domain_names": item.get("domain_names", []),
                "strong_hits": item.get("strong_hits", []),
                "weak_hits": item.get("weak_hits", []),
            }
            for item in role_shortlist
        ]
        router_prompt = f"""你是 OmniAgent 的角色裁决器。

代码已经做过角色初筛；你只需要在这批候选角色里判断当前页面最应该进入哪个角色语境。

规则：
1. 必须只从 shortlist 里选 1 个 `role_id`。
2. 候选角色只是代码初筛结果，不代表一定正确；请优先看页面整体语义、上下文和任务目标。
3. 如果候选角色都不够确定，优先返回 `role_base`。

角色 shortlist: {json.dumps(persona_catalog, ensure_ascii=False, indent=2)}

必须返回 JSON：
{{
  "thought_process": "为什么选择这个角色",
  "role_id": "角色ID"
}}"""
        router_response = self.call_task(
            "router",
            router_prompt,
            [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "请结合以下页面上下文决定主角色：\n"
                            f"host={str(page_meta.get('host', '')).strip() or '[unknown]'}\n"
                            f"title={str(page_meta.get('title', '')).strip() or '[unknown]'}\n"
                            f"url={str(page_meta.get('url', '')).strip() or '[unknown]'}\n"
                            f"scope={str((browser_state or {}).get('scope_signature', '')).strip() or '[page]'}\n"
                            f"page_kind={str((browser_state or {}).get('page_kind', '')).strip() or '[unknown]'}\n"
                            f"page_agent_header={str((browser_state or {}).get('page_agent_header', '')).strip()[:600] or '[none]'}\n"
                            f"page_agent_content={str((browser_state or {}).get('page_agent_content', '')).strip()[:1500] or '[none]'}\n"
                            f"分析文本前1500字：\n{text[:1500]}"
                        }
                    ],
                }
            ],
            max_tokens=700,
            temperature=0.1,
        )
        decision = extract_json_from_text(router_response.get("text", ""))
        role_id = str(decision.get("role_id", "")).strip()
        shortlist_ids = {str(item.get("role_id", "")).strip() for item in role_shortlist}
        if not role_id or role_id not in shortlist_ids:
            raise ApiError("INVALID_ROUTER_OUTPUT", "路由模型返回了不在 shortlist 内的 role_id", 502)
        return role_id, str(decision.get("thought_process", "")).strip()

    def _select_sops_with_ai(
        self,
        text: str,
        page_meta: dict[str, Any],
        browser_state: dict[str, Any],
        persona: dict[str, Any],
        shortlist: list[dict[str, Any]],
    ) -> tuple[list[str], str]:
        sop_catalog = {
            item["skill_id"]: {
                "domain_name": item.get("domain_name", ""),
                "role_id": item.get("role_id", "role_base"),
                "score": item.get("recall_score", 0),
                "activation_condition": item.get("activation_condition", "无"),
                "strong_hits": item.get("strong_hits", []),
                "weak_hits": item.get("weak_hits", []),
            }
            for item in shortlist
        }
        router_prompt = f"""你是 OmniAgent 的 SOP 裁决器。

当前主角色已经确定，你只需要在该角色作用域下的候选 SOP shortlist 中判断哪些规则真的应该激活。

当前角色:
{json.dumps({"role_id": persona.get("persona_id", "role_base"), "name": persona.get("name", "role_base")}, ensure_ascii=False)}

规则：
1. 只允许从 shortlist 里选择 `0..n` 个 `sop_ids`。
2. 不要因为少量关键词命中就强行激活；优先看页面整体语义、任务目标和上下文是否真的支持。
3. 如果证据不足以支持任何候选 SOP，返回空数组。

候选 SOP shortlist: {json.dumps(sop_catalog, ensure_ascii=False, indent=2)}

必须返回 JSON：
{{
  "thought_process": "为什么选/不选这些 SOP",
  "sop_ids": ["技能ID_1", "技能ID_2"]
}}"""
        router_response = self.call_task(
            "router",
            router_prompt,
            [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "请结合以下页面上下文决定当前角色下应激活哪些 SOP：\n"
                            f"host={str(page_meta.get('host', '')).strip() or '[unknown]'}\n"
                            f"title={str(page_meta.get('title', '')).strip() or '[unknown]'}\n"
                            f"url={str(page_meta.get('url', '')).strip() or '[unknown]'}\n"
                            f"scope={str((browser_state or {}).get('scope_signature', '')).strip() or '[page]'}\n"
                            f"page_kind={str((browser_state or {}).get('page_kind', '')).strip() or '[unknown]'}\n"
                            f"page_agent_header={str((browser_state or {}).get('page_agent_header', '')).strip()[:600] or '[none]'}\n"
                            f"page_agent_content={str((browser_state or {}).get('page_agent_content', '')).strip()[:1500] or '[none]'}\n"
                            f"分析文本前1500字：\n{text[:1500]}"
                        }
                    ],
                }
            ],
            max_tokens=800,
            temperature=0.1,
        )
        decision = extract_json_from_text(router_response.get("text", ""))
        if "sop_ids" not in decision:
            raise ApiError("INVALID_ROUTER_OUTPUT", "路由模型结果缺少 sop_ids", 502)
        sop_ids = decision.get("sop_ids", [])
        if not isinstance(sop_ids, list):
            raise ApiError("INVALID_ROUTER_OUTPUT", "路由模型的 sop_ids 不是数组", 502)
        shortlist_map = {item["skill_id"]: item for item in shortlist}
        normalized_sop_ids: list[str] = []
        seen_sop_ids: set[str] = set()
        for sop_id in sop_ids:
            normalized_sop_id = str(sop_id or "").strip()
            if not normalized_sop_id or normalized_sop_id in seen_sop_ids or normalized_sop_id not in shortlist_map:
                continue
            seen_sop_ids.add(normalized_sop_id)
            normalized_sop_ids.append(normalized_sop_id)
        return normalized_sop_ids, str(decision.get("thought_process", "")).strip()

    def route_text(self, text: str, page_meta: dict[str, Any] | None = None, browser_state: dict[str, Any] | None = None) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
        personas = self._persona_map()
        skills = self._skill_records()
        page_meta = page_meta or {}
        browser_state = browser_state or {}
        host = str(page_meta.get("host", "")).strip().lower()
        candidates = self.local_keyword_recall(text, skills, host=host, page_meta=page_meta, browser_state=browser_state)
        shortlist = candidates[:MAX_ROUTER_AI_SHORTLIST]
        role_shortlist = self._build_role_shortlist(text, page_meta, browser_state, candidates, personas)
        alert_context = looks_like_security_alert_context(text, page_meta=page_meta, browser_state=browser_state)
        trace = {
            "host": host,
            "local_candidate_sop_ids": [item.get("skill_id") for item in candidates],
            "local_candidate_domains": [item.get("domain_name", "") for item in candidates],
            "role_shortlist_persona_ids": [item.get("role_id") for item in role_shortlist],
            "role_shortlist_truncated": len(personas) > len(role_shortlist),
            "router_shortlist_sop_ids": [item.get("skill_id") for item in shortlist],
            "router_shortlist_truncated": len(candidates) > len(shortlist),
            "role_router_used": False,
            "role_router_reason": "",
            "sop_router_used": False,
            "sop_router_reason": "",
            "role_scoped_shortlist_sop_ids": [],
            "router_fallback_used": False,
            "candidate_skills": [
                {
                    "skill_id": item.get("skill_id"),
                    "title": item.get("domain_name", ""),
                    "activation_condition": item.get("activation_condition", ""),
                    "site_scope": item.get("site_scope", ["*"]),
                    "score": item.get("recall_score", 0),
                    "strong_hits": item.get("strong_hits", []),
                    "weak_hits": item.get("weak_hits", []),
                    "shortlisted_for_ai": index < len(shortlist),
                }
                for index, item in enumerate(candidates)
            ],
            "gateway_personas": [{"persona_id": key, "name": value.get("name", key)} for key, value in personas.items()],
            "router_used": False,
            "router_reason": "",
            "selected_role_id": "role_base",
            "selected_sop_ids": [],
            "alert_context": alert_context,
        }

        try:
            role_id, role_reason = self._select_role_with_ai(text, page_meta, browser_state, role_shortlist)
            trace["role_router_used"] = True
            trace["role_router_reason"] = role_reason
            trace["selected_role_id"] = role_id
            persona = personas.get(role_id, personas["role_base"])
            role_scoped_shortlist = [
                item
                for item in shortlist
                if (str(item.get("role_id", "role_base")).strip() or "role_base") == role_id
            ]
            trace["role_scoped_shortlist_sop_ids"] = [item.get("skill_id") for item in role_scoped_shortlist]
            normalized_sop_ids: list[str] = []
            sop_reason = ""
            if role_scoped_shortlist:
                try:
                    normalized_sop_ids, sop_reason = self._select_sops_with_ai(text, page_meta, browser_state, persona, role_scoped_shortlist)
                    trace["sop_router_used"] = True
                    trace["sop_router_reason"] = sop_reason
                except Exception as sop_exc:
                    active_sops, fallback_reason = self._local_sop_fallback(candidates, role_id)
                    trace["router_fallback_used"] = True
                    trace["sop_router_reason"] = f"{fallback_reason}; error={sop_exc}"
                    trace["selected_sop_ids"] = [item.get("skill_id") for item in active_sops if item.get("skill_id")]
                    trace["router_reason"] = f"role={role_reason or '[none]'}; sop={trace['sop_router_reason']}"
                    return active_sops, persona, trace
            shortlist_map = {item["skill_id"]: item for item in role_scoped_shortlist}
            trace["selected_sop_ids"] = normalized_sop_ids
            active_sops = [shortlist_map[sop_id] for sop_id in normalized_sop_ids]
            trace["router_used"] = True
            trace["router_reason"] = f"role={role_reason or '[none]'}; sop={sop_reason or '[none]'}"
        except Exception as exc:
            active_sops, persona, fallback_reason = self._local_route_fallback(candidates, personas)
            trace["router_fallback_used"] = True
            trace["router_reason"] = f"{fallback_reason}; error={exc}"
            fallback_role_id = next((str(item.get('role_id', 'role_base')).strip() or "role_base" for item in active_sops), "role_base")
            if not active_sops and role_shortlist:
                fallback_role_id = str(role_shortlist[0].get("role_id", "role_base")).strip() or "role_base"
                persona = personas.get(fallback_role_id, personas["role_base"])
            trace["selected_role_id"] = fallback_role_id
            trace["selected_sop_ids"] = [item.get("skill_id") for item in active_sops if item.get("skill_id")]
        return active_sops, persona, trace

    def assemble_system_prompt(
        self,
        active_sops: list[dict[str, Any]],
        persona_config: dict[str, Any],
        vision_used: bool,
        vision_requested: bool,
        visual_grounded: bool,
        alert_context: bool = False,
    ) -> str:
        prompt = f"【你的角色设定】\n{persona_config.get('system_prompt', '')}\n\n"
        if active_sops:
            prompt += "【当前激活了多重业务执行技能，请综合提取以下所有字段】：\n"
            for sop in active_sops:
                prompt += f"\n--- 规则来源：[{sop.get('domain_name', '特定领域')}] ---\n"
                prompt += f"- 判断准则: {str(sop.get('activation_condition', '')).strip() or '无'}\n"
                for task in sop.get("extraction_tasks", []):
                    prompt += f"- 提取 [{task.get('field_name')}]: {task.get('instruction')}\n"
        else:
            prompt += "【自由发挥模式】未触发特定 SOP，请直接精准研判。\n"
        prompt += "\n【通用分析约束】页面标题、标签、按钮文案、分类名、规则名或摘要词都只能视为线索，不能直接等同于最终结论。必须结合当前上下文里的原始内容、结构信息和证据项进行判断；如果证据不足，应明确写“待确认/信息不足”，不要把推测写成事实。\n"
        if alert_context:
            prompt += "\n【上下文提醒】当前页面可能包含结构化记录、系统标签或分类字段。遇到名词标签和结论冲突时，优先区分“页面写了什么”和“这些信息能否直接支持最终判断”。\n"
        if vision_requested and not vision_used:
            prompt += "\n【视觉限制说明】本次请求附带了图片，但当前模型不支持视觉输入。你绝对不能声称看到了图片内容，只能基于文本回答。\n"
        elif vision_used and not visual_grounded:
            prompt += "\n【视觉输入说明】本次附带的是前端生成的文本卡片或降级快照，不是原网页真实像素截图。你可以读取其中明确写出的文字，但绝对禁止声称看到了网页原图、论坛附件或截图细节。\n"
        prompt += """
【操作系统绝对红线】：
1. summary 必须直接说结论，尽量在 50 字内。
2. 绝对禁止编造任何 http/https 链接。
3. 如果图片没有真正输入给你，绝对禁止说“结合截图可见”。
4. 必须返回闭合纯 JSON，格式如下：
{
  "summary": "结论",
  "extracted_values": [{"field": "字段名", "exact_match_text": "原文或图中的真实值", "color": "red"}],
  "evidence_items": [{"title": "字段命中", "quote": "证据原文", "reason": "为什么相关", "match_terms": ["词1"]}],
  "text_advice": ["短句动作指令1"],
  "relevant_memory_ids": ["最相关的 memory id，可为空；可填写 workflow_id/template_id/document_id"],
  "memory_relevance_reason": "为什么这些记忆和当前分析相关，可为空",
  "relevant_workflow_ids": ["最相关的workflow_id，可为空"],
  "workflow_relevance_reason": "为什么这些 workflow 和当前分析相关，可为空"
}
"""
        return prompt

    def _browser_state_prompt(self, browser_state: dict[str, Any] | None, dom_candidates: list[dict[str, Any]] | None) -> str:
        browser_state = browser_state or {}
        dom_candidates = dom_candidates or []
        lines: list[str] = []
        if browser_state:
            lines.append("【页面状态摘要】")
            lines.append(
                f"- page_kind={browser_state.get('page_kind', '') or '[unknown]'} | scope={browser_state.get('scope_signature', '') or '[page]'} | interactive_count={browser_state.get('interactive_count', 0)}"
            )
            if browser_state.get("viewport_summary"):
                lines.append(f"- viewport={browser_state.get('viewport_summary')}")
            if browser_state.get("interactive_summary"):
                lines.append(f"- 可交互元素摘要：{browser_state.get('interactive_summary')}")
            if browser_state.get("page_agent_header"):
                lines.append(f"- page_agent_header={str(browser_state.get('page_agent_header'))[:800]}")
            if browser_state.get("page_agent_content"):
                lines.append(f"- page_agent_content={str(browser_state.get('page_agent_content'))[:2200]}")
            if browser_state.get("page_agent_footer"):
                lines.append(f"- page_agent_footer={str(browser_state.get('page_agent_footer'))[:400]}")
        if dom_candidates:
            lines.append("【当前可操作页面元素候选】")
            visible_candidates = dom_candidates[:MAX_BROWSER_STATE_PROMPT_CANDIDATES]
            for index, item in enumerate(visible_candidates, start=1):
                selector = (item.get("selector_candidates") or [""])[0]
                label = item.get("label") or item.get("text") or item.get("placeholder") or item.get("element_id")
                nearby = item.get("nearby_text") or ""
                visibility = "visible" if item.get("is_visible") else "offscreen"
                planner_score = item.get("planner_score")
                input_type = str(item.get("input_type") or "").strip()
                select_like = "yes" if candidate_is_select_like(item.get("tag", ""), item.get("role", ""), input_type, item.get("has_datalist")) else "no"
                lines.append(
                    f"{index}. page_agent_index={item.get('page_agent_index') if item.get('page_agent_index') is not None else '[none]'} tag={item.get('tag') or ''} role={item.get('role') or ''} input_type={input_type or '[none]'} select_like={select_like} visibility={visibility} planner_score={planner_score if planner_score is not None else '[none]'} label={label or '[none]'} selector={selector or '[none]'} nearby={nearby[:80] or '[none]'}"
                )
            hidden_count = max(0, len(dom_candidates) - len(visible_candidates))
            if hidden_count:
                lines.append(f"- 其余可交互元素已折叠：{hidden_count} 个")
        overflow_summary = browser_state.get("dom_candidate_overflow_summary") or []
        overflow_count = int(browser_state.get("dom_candidate_overflow_count", 0) or 0)
        total_count = int(browser_state.get("dom_candidate_total", 0) or 0)
        if total_count:
            lines.append(f"【DOM 候选总量】total={total_count}")
        if overflow_count or overflow_summary:
            lines.append(f"【已折叠的候选摘要】count={overflow_count or len(overflow_summary)}")
            for index, item in enumerate(overflow_summary[:12], start=1):
                if not isinstance(item, dict):
                    continue
                lines.append(
                    f"{index}. tag={item.get('tag') or '[unknown]'} role={item.get('role') or '[none]'} count={item.get('count', 0)} sample_labels={item.get('sample_labels') or []}"
                )
        return "\n".join(lines).strip()

    def render_action_links(self, analysis: dict[str, Any], active_sops: list[dict[str, Any]]) -> list[dict[str, str]]:
        value_dict = {str(item.get("field", "")): str(item.get("exact_match_text", "")) for item in analysis.get("extracted_values", [])}
        action_links: list[dict[str, str]] = []
        for sop in active_sops:
            for skill in sop.get("skills", []):
                if skill.get("action_type") != "url_render":
                    continue
                url = str(skill.get("template", ""))
                for field_name, field_value in value_dict.items():
                    if field_value:
                        url = url.replace(f"{{{field_name}}}", field_value)
                if "{" in url or not url.startswith("http"):
                    continue
                action_links.append({"title": str(skill.get("skill_name", "动作链接")), "url": url})
        return action_links

    def _score_dom_candidate_for_action(self, action: dict[str, Any], candidate: dict[str, Any]) -> int:
        score = 0
        candidate_tag = str(candidate.get("tag", "")).strip().lower()
        candidate_role = str(candidate.get("role", "")).strip().lower()
        candidate_input_type = str(candidate.get("input_type", "")).strip().lower()
        corpus = " ".join(
            [
                str(candidate.get("label", "")),
                str(candidate.get("text", "")),
                str(candidate.get("placeholder", "")),
                str(candidate.get("nearby_text", "")),
                candidate_tag,
                candidate_role,
                candidate_input_type,
                " ".join(candidate.get("selector_candidates") or []),
            ]
        ).lower()
        target_desc = str(action.get("target_desc", "")).strip().lower()
        if target_desc:
            if target_desc in corpus:
                score += 8
            for token in re.split(r"[\s,/|:：;；\-]+", target_desc):
                token = token.strip()
                if token and len(token) >= 2 and token in corpus:
                    score += 2
        for anchor in action.get("semantic_anchors") or []:
            tag = str(anchor.get("tag", "")).strip().lower()
            role = str(anchor.get("role", "")).strip().lower()
            label = str(anchor.get("label", "")).strip().lower()
            placeholder = str(anchor.get("placeholder", "")).strip().lower()
            nearby_text = str(anchor.get("nearby_text", "")).strip().lower()
            if tag and tag == candidate_tag:
                score += 3
            if role and role == candidate_role:
                score += 2
            if label and label in corpus:
                score += 5
            if placeholder and placeholder in corpus:
                score += 4
            if nearby_text and nearby_text in corpus:
                score += 3
        if action.get("type") == "select" and candidate_is_select_like(candidate_tag, candidate_role, candidate_input_type, candidate.get("has_datalist")):
            score += 4
            if candidate_tag == "select":
                score += 2
            if candidate_role == "combobox":
                score += 3
            if candidate_role == "listbox":
                score += 2
            if candidate_input_type in {"date", "datetime-local", "month", "time", "week"}:
                score += 2
            if candidate.get("has_datalist"):
                score += 2
        if action.get("type") == "fill" and candidate_tag in {"input", "textarea"}:
            score += 2
        return score

    def _pick_dom_candidate_for_action(self, action: dict[str, Any], dom_candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
        best_candidate = None
        best_score = -1
        for candidate in dom_candidates or []:
            score = self._score_dom_candidate_for_action(action, candidate)
            tag = str(candidate.get("tag", "")).strip().lower()
            role = str(candidate.get("role", "")).strip().lower()
            if action.get("type") == "click" and tag in {"button", "a", "label"}:
                score += 2
            if action.get("type") == "click" and role == "button":
                score += 2
            if score > best_score:
                best_score = score
                best_candidate = candidate
        return best_candidate if best_score >= 4 else None

    def _build_browser_action_from_candidate(
        self,
        action_type: str,
        target_desc: str,
        dom_candidates: list[dict[str, Any]],
        value: str | None = None,
    ) -> dict[str, Any]:
        action: dict[str, Any] = {"type": action_type, "target_desc": target_desc}
        if value is not None:
            action["value"] = value
        best_candidate = self._pick_dom_candidate_for_action(action, dom_candidates)
        if best_candidate:
            page_agent_index = best_candidate.get("page_agent_index")
            if isinstance(page_agent_index, int):
                action["page_agent_index"] = page_agent_index
            selectors = [str(item).strip() for item in (best_candidate.get("selector_candidates") or []) if str(item).strip()]
            if selectors:
                action["selector"] = selectors[0]
                action["selector_candidates"] = selectors
            if best_candidate.get("semantic_anchors"):
                action["semantic_anchors"] = best_candidate.get("semantic_anchors")
            element_id = str(best_candidate.get("element_id", "")).strip()
            if element_id:
                action["element_id"] = element_id
            role = str(best_candidate.get("role", "")).strip()
            if role:
                action["role"] = role
            input_type = str(best_candidate.get("input_type", "")).strip()
            if input_type:
                action["input_type"] = input_type
            if best_candidate.get("has_datalist"):
                action["has_datalist"] = True
            label = str(best_candidate.get("label") or best_candidate.get("text") or target_desc).strip()
            if label:
                action["target_desc"] = label
            action["tag"] = action.get("tag") or best_candidate.get("tag") or ""
        return action

    def _enrich_single_browser_action(self, action: dict[str, Any], dom_candidates: list[dict[str, Any]]) -> dict[str, Any]:
        normalized = json.loads(json.dumps(action, ensure_ascii=False))
        best_candidate = self._pick_dom_candidate_for_action(normalized, dom_candidates)
        if best_candidate:
            page_agent_index = best_candidate.get("page_agent_index")
            if isinstance(page_agent_index, int):
                normalized["page_agent_index"] = page_agent_index
            selectors = [str(item).strip() for item in (best_candidate.get("selector_candidates") or []) if str(item).strip()]
            if selectors:
                normalized["selector"] = normalized.get("selector") or selectors[0]
                normalized["selector_candidates"] = normalized.get("selector_candidates") or selectors
            if best_candidate.get("semantic_anchors"):
                normalized["semantic_anchors"] = normalized.get("semantic_anchors") or best_candidate.get("semantic_anchors")
            element_id = str(best_candidate.get("element_id", "")).strip()
            if element_id and not normalized.get("element_id"):
                normalized["element_id"] = element_id
            role = str(best_candidate.get("role", "")).strip()
            if role and not normalized.get("role"):
                normalized["role"] = role
            input_type = str(best_candidate.get("input_type", "")).strip()
            if input_type and not normalized.get("input_type"):
                normalized["input_type"] = input_type
            if best_candidate.get("has_datalist") and not normalized.get("has_datalist"):
                normalized["has_datalist"] = True
            label = str(best_candidate.get("label") or best_candidate.get("text") or normalized.get("target_desc") or "").strip()
            if label:
                normalized["target_desc"] = label
            normalized["tag"] = normalized.get("tag") or best_candidate.get("tag") or ""
        return normalized

    def _extract_click_targets_from_text(self, text: str, limit: int = MAX_CHAT_BROWSER_ACTIONS) -> list[str]:
        source = str(text or "").strip()
        if not source:
            return []
        targets = [
            str(match.group(1) or "").strip()
            for match in re.finditer(r"(?:点击|点一下|点下|点按|单击)[“\"'‘]([^”\"'’]{1,40})[”\"'’](?:按钮|链接)?", source, re.IGNORECASE)
            if str(match.group(1) or "").strip()
        ]
        if targets:
            return targets[:limit]
        targets = [
            str(match.group(1) or "").strip()
            for match in re.finditer(r"(?:点击|点一下|点下|点按|单击)(?:页面上的)?([^\s，。；;、（）()]{1,20})(?:按钮|链接)", source, re.IGNORECASE)
            if str(match.group(1) or "").strip()
        ]
        if targets:
            return targets[:limit]
        repeat_count_match = re.search(r"(\d{1,2})\s*次", source)
        repeat_count = max(1, min(int(repeat_count_match.group(1)), limit)) if repeat_count_match else 1
        if re.search(r"(下一页|下页|next\s*page)", source, re.IGNORECASE):
            targets.extend(["下一页"] * repeat_count)
        elif re.search(r"(上一页|上页|prev(?:ious)?\s*page)", source, re.IGNORECASE):
            targets.extend(["上一页"] * repeat_count)
        elif re.search(r"(关闭|关掉|关闭弹窗|关闭窗口|dismiss|close)", source, re.IGNORECASE):
            targets.append("关闭")
        elif re.search(r"(提交|确认|确定|保存|搜索|查询)", source, re.IGNORECASE):
            targets.append("提交")
        return targets[:limit]

    def _recover_browser_actions_from_text_plan(
        self,
        latest_instruction: str,
        raw_reply: str,
        dom_candidates: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        click_targets = self._extract_click_targets_from_text(raw_reply, MAX_CHAT_BROWSER_ACTIONS)
        if not click_targets:
            click_targets = self._extract_click_targets_from_text(latest_instruction, MAX_CHAT_BROWSER_ACTIONS)
        actions: list[dict[str, Any]] = []
        for target in click_targets[:MAX_CHAT_BROWSER_ACTIONS]:
            actions.append(self._build_browser_action_from_candidate("click", target, dom_candidates))
        return [item for item in actions if workflow_step_looks_executable(item)]

    def materialize_browser_actions(self, analysis: dict[str, Any], active_sops: list[dict[str, Any]], dom_candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
        extracted_fields = {
            str(item.get("field", "")).strip(): str(item.get("exact_match_text", "")).strip()
            for item in analysis.get("extracted_values", [])
            if str(item.get("field", "")).strip()
        }
        actions: list[dict[str, Any]] = []
        for sop in active_sops:
            for skill in sop.get("skills", []):
                if skill.get("action_type") != "browser_action":
                    continue
                for raw_action in skill.get("actions", []) or []:
                    action = render_placeholders_in_data(raw_action, extracted_fields)
                    if not isinstance(action, dict):
                        continue
                    action_type = str(action.get("type") or action.get("action") or "").strip().lower()
                    if action_type == "fill_form":
                        fields = []
                        for field in action.get("fields") or []:
                            normalized_field = _normalize_form_field_step(render_placeholders_in_data(field, extracted_fields))
                            if not normalized_field:
                                continue
                            fields.append(self._enrich_single_browser_action(normalized_field, dom_candidates))
                        if fields:
                            action["fields"] = fields
                        submit_action = action.get("submit_action")
                        if isinstance(submit_action, dict):
                            action["submit_action"] = self._enrich_single_browser_action(
                                render_placeholders_in_data(submit_action, extracted_fields),
                                dom_candidates,
                            )
                        actions.append(action)
                        continue
                    actions.append(self._enrich_single_browser_action(action, dom_candidates))
        return actions

    def _render_workflow_steps(self, workflow: dict[str, Any], extracted_fields: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str], list[str]]:
        browser_actions: list[dict[str, Any]] = []
        preview_steps: list[str] = []
        missing_parameters: list[str] = []
        workflow_id = str(workflow.get("workflow_id", "")).strip()
        workflow_name = str(workflow.get("name", "执行流程")).strip() or "执行流程"
        resolved_fields = resolve_workflow_parameter_values(workflow.get("steps_json", []) or [], extracted_fields)
        for step_index, step in enumerate(workflow.get("steps_json", []) or []):
            if not workflow_step_looks_executable(step):
                continue
            collect_missing_placeholders(step, resolved_fields, missing_parameters)
            rendered = render_placeholders_in_data(step, resolved_fields)
            rendered["workflow_id"] = workflow_id
            rendered["workflow_step_index"] = step_index
            rendered["workflow_name"] = workflow_name
            browser_actions.append(rendered)
            preview_steps.append(workflow_step_preview_text(rendered))
        if browser_actions and bool(workflow.get("require_human_confirm")):
            preview_lines = "\n".join(f"{index + 1}. {line}" for index, line in enumerate(preview_steps[:8]))
            more_count = max(0, len(preview_steps) - 8)
            more_suffix = f"\n... 还有 {more_count} 步" if more_count else ""
            browser_actions = [
                {
                    "type": "ask_human",
                    "message": f"确认执行流程「{workflow_name}」？\n\n{preview_lines}{more_suffix}",
                    "question": f"是否执行流程「{workflow_name}」？",
                    "reason": "该流程包含真实页面操作，执行前需要用户确认。",
                    "suggested_action": "确认后按既定步骤继续执行。",
                    "confirm_label": "确认执行",
                    "cancel_label": "暂不执行",
                    "options": [
                        {"id": "confirm", "label": "确认执行", "value": "continue"},
                        {"id": "cancel", "label": "暂不执行", "value": "cancel", "replace_remaining": True},
                    ],
                    "workflow_id": workflow_id,
                    "workflow_step_index": -1,
                    "workflow_name": workflow_name,
                },
                *browser_actions,
            ]
        return browser_actions, preview_steps, missing_parameters

    def _rank_workflow_candidates_with_ai(
        self,
        candidates: list[dict[str, Any]],
        analysis: dict[str, Any],
        extracted_fields: dict[str, Any],
        active_sops: list[dict[str, Any]],
        page_meta: dict[str, Any] | None = None,
        workflow_limit: int = MAX_SUGGESTED_WORKFLOWS,
    ) -> tuple[list[str], str]:
        if len(candidates) <= 1:
            return [str(item.get("workflow_id", "")).strip() for item in candidates[:workflow_limit] if str(item.get("workflow_id", "")).strip()], ""

        page_meta = page_meta or {}
        shortlist = candidates[:MAX_WORKFLOW_AI_SHORTLIST]
        workflow_catalog = []
        for item in shortlist:
            workflow_catalog.append(
                {
                    "workflow_id": item.get("workflow_id"),
                    "name": item.get("name", "执行流程"),
                    "summary": item.get("summary", ""),
                    "bind_skill_id": item.get("bind_skill_id"),
                    "site_scope": item.get("site_scope", ["*"]),
                    "require_confirmation": bool(item.get("require_confirmation")),
                    "preview_steps": (item.get("preview_steps") or [])[:4],
                    "missing_parameters": item.get("missing_parameters") or [],
                    "priority_hint": item.get("priority_hint"),
                }
            )

        prompt = f"""你是 OmniAgent 的 workflow 推荐裁决器。

目标：只在【当前分析结论 + 当前页面 + 当前参数】明显支持时，才推荐执行 workflow。
代码已经做过初筛；你只需要在这批候选里判断“是不是真的相关、哪条最值得推荐”。

规则：
1. 最多选择 {workflow_limit} 条 workflow，按最推荐到次推荐排序。
2. 如果候选 workflow 只是站点匹配、技能绑定匹配，但和当前分析结论不贴合，必须排除。
3. 优先推荐与当前目标最直接相关、所需参数最完整、执行意图最明确的 workflow；不要推荐泛泛的浏览流程。
4. 如果 workflow 缺少关键参数而当前又没有足够字段支撑，也可以排除。
5. 必须返回闭合 JSON：
{{
  "thought_process": "为什么选/不选",
  "selected_workflow_ids": ["wf_x", "wf_y"]
}}"""

        user_text = "\n".join(
            [
                f"host={str(page_meta.get('host', '')).strip() or '[unknown]'}",
                f"title={str(page_meta.get('title', '')).strip() or '[unknown]'}",
                f"url={str(page_meta.get('url', '')).strip() or '[unknown]'}",
                f"analysis_summary={str(analysis.get('summary', '')).strip() or '[none]'}",
                f"text_advice={shorten_json_text(analysis.get('text_advice') or [], 400)}",
                f"matched_skills={shorten_json_text([item.get('domain_name', '') for item in active_sops if item.get('domain_name')], 300)}",
                f"extracted_fields={shorten_json_text(extracted_fields, 800)}",
                f"workflow_candidates={shorten_json_text(workflow_catalog, 2200)}",
            ]
        )
        response = self.call_task(
            "router",
            prompt,
            [{"role": "user", "content": [{"type": "text", "text": user_text}]}],
            max_tokens=900,
            temperature=0.1,
        )
        decision = extract_json_from_text(response.get("text", ""))
        if "selected_workflow_ids" not in decision:
            raise ApiError("INVALID_WORKFLOW_ROUTER_OUTPUT", "workflow 路由结果缺少 selected_workflow_ids", 502)
        selected_ids = decision.get("selected_workflow_ids", [])
        if not isinstance(selected_ids, list):
            raise ApiError("INVALID_WORKFLOW_ROUTER_OUTPUT", "workflow 路由结果 selected_workflow_ids 不是数组", 502)
        normalized_ids = []
        seen: set[str] = set()
        candidate_ids = {str(item.get("workflow_id", "")).strip() for item in shortlist}
        for item in selected_ids:
            workflow_id = str(item or "").strip()
            if not workflow_id or workflow_id in seen or workflow_id not in candidate_ids:
                continue
            seen.add(workflow_id)
            normalized_ids.append(workflow_id)
            if len(normalized_ids) >= workflow_limit:
                break
        return normalized_ids, str(decision.get("thought_process", "")).strip()

    def _workflow_context_prompt(
        self,
        active_sops: list[dict[str, Any]],
        extracted_fields: dict[str, Any],
        page_meta: dict[str, Any] | None = None,
        limit: int = 4,
    ) -> str:
        candidates = self._collect_workflow_memory_candidates(active_sops, extracted_fields, page_meta=page_meta, limit=limit)
        if not candidates:
            return ""
        lines = ["【可复用 workflow 候选】"]
        for index, item in enumerate(candidates[: max(1, limit)], start=1):
            lines.append(
                f"{index}. workflow_id={item.get('workflow_id') or '[unknown]'}"
                f" | name={item.get('name') or '执行流程'}"
                f" | bind_skill_id={item.get('bind_skill_id') or '[none]'}"
                f" | require_confirmation={bool(item.get('require_confirmation'))}"
            )
            if item.get("summary"):
                lines.append(f"   summary={str(item.get('summary'))[:240]}")
            if item.get("preview_steps"):
                lines.append(f"   preview_steps={item.get('preview_steps')}")
            if item.get("missing_parameters"):
                lines.append(f"   missing_parameters={item.get('missing_parameters')}")
        return "\n".join(lines).strip()

    def _collect_workflow_memory_candidates(
        self,
        active_sops: list[dict[str, Any]],
        extracted_fields: dict[str, Any],
        page_meta: dict[str, Any] | None = None,
        limit: int = 4,
    ) -> list[dict[str, Any]]:
        page_meta = page_meta or {}
        host = str(page_meta.get("host", "")).strip().lower()
        active_skill_ids = [item.get("skill_id") for item in active_sops if item.get("skill_id")]
        candidates: list[dict[str, Any]] = []
        for workflow in self.db.list_workflows():
            bind_skill_id = workflow.get("bind_skill_id")
            site_scope = workflow.get("site_scope_json") or ["*"]
            if not site_scope_matches(site_scope, host):
                continue
            if bind_skill_id and bind_skill_id not in active_skill_ids:
                continue
            workflow_browser_actions, preview_steps, missing_parameters = self._render_workflow_steps(workflow, extracted_fields)
            if not workflow_browser_actions:
                continue
            missing_parameter_defs = build_workflow_parameter_fields(missing_parameters, extracted_fields, workflow.get("steps_json", []) or [])
            priority_reasons = ["workflow_memory"]
            priority_score = 36
            if bind_skill_id and bind_skill_id in active_skill_ids:
                priority_score += 14
                priority_reasons.append("bind_skill_match")
            if site_scope_specificity(site_scope):
                priority_score += 6
                priority_reasons.append("site_scoped")
            if not missing_parameters:
                priority_score += 8
                priority_reasons.append("ready_to_run")
            else:
                priority_score += max(0, 6 - min(len(missing_parameters), 3) * 2)
                priority_reasons.append(f"needs_{len(missing_parameters)}_params")
            if not workflow_name_looks_generic(workflow.get("name")):
                priority_score += 4
                priority_reasons.append("named_workflow")
            if len(preview_steps) >= 2:
                priority_score += 3
                priority_reasons.append("multi_step")
            candidates.append(
                {
                    "priority_hint": workflow_display_priority(workflow, active_skill_ids),
                    "priority_score": priority_score,
                    "priority_reason": priority_reasons,
                    "workflow_id": workflow.get("workflow_id"),
                    "name": workflow.get("name", "执行流程"),
                    "summary": workflow.get("summary", ""),
                    "bind_skill_id": bind_skill_id,
                    "require_confirmation": bool(workflow.get("require_human_confirm")),
                    "missing_parameters": missing_parameters,
                    "missing_parameter_defs": missing_parameter_defs,
                    "preview_steps": preview_steps[:3],
                }
            )
        return sorted(
            candidates,
            key=lambda candidate: (
                -int(candidate.get("priority_score", 0)),
                candidate["priority_hint"],
                len(candidate.get("missing_parameters") or []),
                str(candidate.get("name", "")),
            ),
        )[: max(1, limit)]

    def _build_memory_hits(
        self,
        workflow_candidates: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        hits: list[dict[str, Any]] = []
        for item in workflow_candidates:
            hits.append(
                {
                    "kind": "structured",
                    "name": str(item.get("name") or "执行流程").strip() or "执行流程",
                    "summary": str(item.get("summary") or "").strip(),
                    "workflow_id": str(item.get("workflow_id") or "").strip(),
                    "bind_skill_id": str(item.get("bind_skill_id") or "").strip(),
                    "missing_parameters": item.get("missing_parameters") or [],
                    "missing_parameter_defs": item.get("missing_parameter_defs") or [],
                    "preview_steps": item.get("preview_steps") or [],
                    "priority_score": int(item.get("priority_score", 0)),
                    "priority_reason": item.get("priority_reason") or [],
                }
            )
        return hits

    def _collect_reference_memory_hits(
        self,
        text: str,
        persona_config: dict[str, Any],
        page_meta: dict[str, Any] | None = None,
        browser_state: dict[str, Any] | None = None,
        limit: int = 4,
    ) -> list[dict[str, Any]]:
        page_meta = page_meta or {}
        browser_state = browser_state or {}
        host = str(page_meta.get("host", "")).strip().lower()
        primary_namespace = default_namespace_for_persona(str(persona_config.get("persona_id", "")).strip())
        namespace_candidates = [primary_namespace]
        if "general" not in namespace_candidates:
            namespace_candidates.append("general")
        recall_corpus = "\n".join(
            part for part in [
                str(text or "").strip(),
                str(page_meta.get("title", "")).strip(),
                str(browser_state.get("page_kind", "")).strip(),
                str(browser_state.get("page_agent_header", "")).strip(),
                str(browser_state.get("page_agent_content", "")).strip()[:2000],
            ] if part
        )
        recall_corpus_lower = recall_corpus.lower()
        recall_terms = set(extract_recall_terms(recall_corpus))
        if not recall_terms:
            return []

        hits: list[dict[str, Any]] = []
        for template in self.db.list_query_templates():
            namespace = str(template.get("namespace", "")).strip() or "general"
            if namespace not in namespace_candidates:
                continue
            site_scope = template.get("site_scope_json") or ["*"]
            if not site_scope_matches(site_scope, host):
                continue
            haystack_terms = set(
                extract_recall_terms(
                    "\n".join(
                        [
                            str(template.get("name", "")),
                            str(template.get("summary", "")),
                            str(template.get("query_template", "")),
                            " ".join(template.get("tags_json", []) or []),
                            " ".join(template.get("required_fields_json", []) or []),
                        ]
                    )
                )
            )
            matched_terms = sorted(recall_terms.intersection(haystack_terms))
            phrase_hits = [
                phrase for phrase in [
                    str(template.get("name", "")).strip(),
                    str(template.get("summary", "")).strip(),
                    *(template.get("tags_json", []) or []),
                ]
                if str(phrase).strip() and str(phrase).strip().lower() in recall_corpus_lower
            ]
            if not matched_terms and not phrase_hits:
                continue
            priority_reasons = ["query_template_memory"]
            priority_score = 28 + min(18, len(matched_terms) * 4 + len(phrase_hits) * 5)
            if namespace == primary_namespace:
                priority_score += 6
                priority_reasons.append("persona_namespace")
            elif namespace == "general":
                priority_score += 3
                priority_reasons.append("general_namespace")
            if site_scope_specificity(site_scope):
                priority_score += 6
                priority_reasons.append("site_scoped")
            hits.append(
                {
                    "kind": "query_template",
                    "name": str(template.get("name", "")).strip() or "查询模板",
                    "summary": str(template.get("summary", "")).strip(),
                    "namespace": namespace,
                    "template_id": str(template.get("template_id", "")).strip(),
                    "score": len(matched_terms) + len(phrase_hits),
                    "match_terms": merge_unique_strings([*matched_terms[:4], *phrase_hits[:4]], limit=4),
                    "priority_score": priority_score,
                    "priority_reason": priority_reasons,
                }
            )

        for document in self.db.list_documents():
            namespace = str(document.get("namespace", "")).strip() or "general"
            if namespace not in namespace_candidates:
                continue
            site_scope = document.get("site_scope_json") or ["*"]
            if not site_scope_matches(site_scope, host):
                continue
            content_text = str(document.get("content_text", "")).strip()
            haystack = "\n".join(
                [
                    str(document.get("name", "")),
                    content_text[:6000],
                    " ".join(document.get("tags_json", []) or []),
                ]
            )
            haystack_terms = set(extract_recall_terms(haystack))
            matched_terms = sorted(recall_terms.intersection(haystack_terms))
            phrase_hits = [
                phrase for phrase in [
                    str(document.get("name", "")).strip(),
                    *(document.get("tags_json", []) or []),
                ]
                if str(phrase).strip() and str(phrase).strip().lower() in recall_corpus_lower
            ]
            if not matched_terms and not phrase_hits:
                continue
            snippet = ""
            lowered = content_text.lower()
            for term in [*matched_terms, *phrase_hits]:
                term_lower = str(term).lower()
                if term_lower in lowered:
                    index = lowered.index(term_lower)
                    start = max(0, index - 70)
                    end = min(len(content_text), index + 110)
                    snippet = content_text[start:end].replace("\n", " ").strip()
                    break
            priority_reasons = ["document_memory"]
            priority_score = 18 + min(18, len(matched_terms) * 4 + len(phrase_hits) * 5)
            if namespace == primary_namespace:
                priority_score += 6
                priority_reasons.append("persona_namespace")
            elif namespace == "general":
                priority_score += 3
                priority_reasons.append("general_namespace")
            if site_scope_specificity(site_scope):
                priority_score += 6
                priority_reasons.append("site_scoped")
            hits.append(
                {
                    "kind": "document",
                    "name": str(document.get("name", "")).strip() or "文档记忆",
                    "summary": snippet or str(document.get("doc_type", "")).strip(),
                    "namespace": namespace,
                    "document_id": str(document.get("document_id", "")).strip(),
                    "score": len(matched_terms) + len(phrase_hits),
                    "match_terms": merge_unique_strings([*matched_terms[:4], *phrase_hits[:4]], limit=4),
                    "priority_score": priority_score,
                    "priority_reason": priority_reasons,
                }
            )
        hits.sort(
            key=lambda item: (
                -int(item.get("priority_score", 0)),
                -int(item.get("score", 0)),
                str(item.get("name", "")),
            )
        )
        return hits[: max(1, limit)]

    def _reference_memory_context_prompt(self, memory_hits: list[dict[str, Any]], limit: int = 4) -> str:
        if not memory_hits:
            return ""
        lines = ["【可复用文档/模板记忆】"]
        for index, item in enumerate(memory_hits[: max(1, limit)], start=1):
            kind = str(item.get("kind", "")).strip() or "memory"
            lines.append(
                f"{index}. kind={kind}"
                f" | name={item.get('name') or '[unknown]'}"
                f" | namespace={item.get('namespace') or 'general'}"
            )
            if item.get("summary"):
                lines.append(f"   summary={str(item.get('summary'))[:240]}")
            if item.get("match_terms"):
                lines.append(f"   match_terms={item.get('match_terms')}")
        return "\n".join(lines).strip()

    def _memory_sort_key(self, item: dict[str, Any]) -> tuple[int, int, int, str, str]:
        kind = str(item.get("kind", "")).strip()
        missing_parameters = item.get("missing_parameters") or []
        identity = str(
            item.get("workflow_id")
            or item.get("template_id")
            or item.get("document_id")
            or item.get("name")
            or ""
        ).strip()
        return (
            -int(item.get("priority_score", 0)),
            -int(MEMORY_KIND_PRIORITY.get(kind, 0)),
            len(missing_parameters),
            str(item.get("name", "")),
            identity,
        )

    def _memory_identity(self, item: dict[str, Any]) -> str:
        return str(
            item.get("workflow_id")
            or item.get("template_id")
            or item.get("document_id")
            or item.get("name")
            or ""
        ).strip()

    def _memory_context_prompt(self, memory_hits: list[dict[str, Any]], limit: int = 6) -> str:
        if not memory_hits:
            return ""
        lines = ["【planner 前多源记忆层】"]
        for index, item in enumerate(memory_hits[: max(1, limit)], start=1):
            kind = str(item.get("kind", "")).strip() or "memory"
            identifier = str(
                item.get("workflow_id")
                or item.get("template_id")
                or item.get("document_id")
                or "[unknown]"
            ).strip()
            lines.append(
                f"{index}. kind={kind}"
                f" | id={identifier}"
                f" | name={item.get('name') or '[unknown]'}"
                f" | priority={int(item.get('priority_score', 0))}"
            )
            if item.get("namespace"):
                lines.append(f"   namespace={item.get('namespace')}")
            if item.get("summary"):
                lines.append(f"   summary={str(item.get('summary'))[:240]}")
            if item.get("match_terms"):
                lines.append(f"   match_terms={item.get('match_terms')}")
            if item.get("bind_skill_id"):
                lines.append(f"   bind_skill_id={item.get('bind_skill_id')}")
            if item.get("preview_steps"):
                lines.append(f"   preview_steps={item.get('preview_steps')}")
            if item.get("missing_parameters"):
                lines.append(f"   missing_parameters={item.get('missing_parameters')}")
            if item.get("priority_reason"):
                lines.append(f"   priority_reason={item.get('priority_reason')}")
        return "\n".join(lines).strip()

    def _select_memory_hits_with_analyzer(
        self,
        preloaded_memory_hits: list[dict[str, Any]],
        analysis: dict[str, Any],
        limit: int = 6,
    ) -> tuple[list[dict[str, Any]], list[str], str, str]:
        available_hits = [item for item in (preloaded_memory_hits or []) if isinstance(item, dict)]
        if not available_hits:
            return [], [], "none", ""

        available_map = {self._memory_identity(item): item for item in available_hits if self._memory_identity(item)}
        raw_selected_ids = analysis.get("relevant_memory_ids")
        memory_reason = str(analysis.get("memory_relevance_reason", "")).strip()
        if not isinstance(raw_selected_ids, list):
            return available_hits[: max(1, limit)], [self._memory_identity(item) for item in available_hits[: max(1, limit)]], "code_ranker", ""

        selected_hits: list[dict[str, Any]] = []
        selected_ids: list[str] = []
        seen: set[str] = set()
        for item in raw_selected_ids:
            memory_id = str(item or "").strip()
            if not memory_id or memory_id in seen or memory_id not in available_map:
                continue
            seen.add(memory_id)
            selected_ids.append(memory_id)
            selected_hits.append(available_map[memory_id])
            if len(selected_hits) >= max(1, limit):
                break
        return selected_hits, selected_ids, "analyzer", memory_reason or ("selected_by_analyzer" if selected_hits else "")

    def _build_context_bar(
        self,
        persona_config: dict[str, Any],
        active_sops: list[dict[str, Any]],
        memory_hits: list[dict[str, Any]],
        page_meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        page_meta = page_meta or {}
        skill_titles = [str(item.get("domain_name", "")).strip() for item in active_sops if str(item.get("domain_name", "")).strip()]
        primary_skill_id = next((str(item.get("skill_id", "")).strip() for item in active_sops if str(item.get("skill_id", "")).strip()), "")
        return {
            "persona_label": str(persona_config.get("name", "客观总结助手")).strip() or "客观总结助手",
            "persona_id": str(persona_config.get("persona_id", "")).strip(),
            "skill_label": " + ".join(skill_titles) if skill_titles else "通用分析",
            "skill_titles": skill_titles,
            "skill_id": primary_skill_id,
            "memory_label": f"记忆 {len(memory_hits)}",
            "host": str(page_meta.get("host", "")).strip(),
        }

    def _merge_memory_hits(
        self,
        workflow_hits: list[dict[str, Any]],
        reference_hits: list[dict[str, Any]],
        limit: int = 8,
    ) -> list[dict[str, Any]]:
        merged: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in [*(workflow_hits or []), *(reference_hits or [])]:
            if not isinstance(item, dict):
                continue
            identity = str(
                item.get("workflow_id")
                or item.get("template_id")
                or item.get("document_id")
                or item.get("name")
                or ""
            ).strip()
            dedupe_key = f"{item.get('kind', 'memory')}::{identity}"
            if not identity or dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            merged.append(item)
        merged.sort(key=self._memory_sort_key)
        return merged[: max(1, limit)]

    def build_quick_actions(
        self,
        analysis: dict[str, Any],
        active_sops: list[dict[str, Any]],
        extracted_fields: dict[str, Any],
        page_meta: dict[str, Any] | None = None,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str, list[str], str]:
        actions: list[dict[str, Any]] = []
        workflow_trace: list[dict[str, Any]] = []
        workflow_candidates: list[dict[str, Any]] = []
        host = str((page_meta or {}).get("host", "")).strip().lower()
        for link in self.render_action_links(analysis, active_sops):
            actions.append({"action_type": "open_link", "label": link["title"], "url": link["url"]})

        analysis_browser_actions = analysis.get("browser_actions") or []
        if isinstance(analysis_browser_actions, list) and analysis_browser_actions:
            actions.append(
                {
                    "action_type": "execute_browser_actions",
                    "label": "执行页面动作",
                    "browser_actions": analysis_browser_actions,
                    "preview_steps": [workflow_step_preview_text(item) for item in analysis_browser_actions[:4]],
                }
            )

        active_skill_ids = [item.get("skill_id") for item in active_sops if item.get("skill_id")]
        workflows = self.db.list_workflows()
        for workflow in workflows:
            bind_skill_id = workflow.get("bind_skill_id")
            site_scope = workflow.get("site_scope_json") or ["*"]
            site_match = site_scope_matches(site_scope, host)
            skill_match = not bind_skill_id or bind_skill_id in active_skill_ids
            include = bool(site_match and skill_match)
            reason = "matched"
            if not site_match:
                reason = f"site_scope_miss:{host or '[unknown]'}"
            elif bind_skill_id and not skill_match:
                reason = f"skill_miss:{bind_skill_id}"
            workflow_trace.append(
                {
                    "workflow_id": workflow.get("workflow_id"),
                    "name": workflow.get("name", "执行流程"),
                    "bind_skill_id": bind_skill_id,
                    "site_scope": site_scope,
                    "site_match": site_match,
                    "skill_match": skill_match,
                    "included": include,
                    "reason": reason,
                    "selected_by_ai": False,
                    "ai_reason": "",
                }
            )
            if not site_match:
                continue
            if bind_skill_id and bind_skill_id not in active_skill_ids:
                continue
            workflow_browser_actions, preview_steps, missing_parameters = self._render_workflow_steps(workflow, extracted_fields)
            if not workflow_browser_actions:
                workflow_trace[-1]["included"] = False
                workflow_trace[-1]["reason"] = "invalid_steps"
                continue
            missing_parameter_defs = build_workflow_parameter_fields(missing_parameters, extracted_fields, workflow.get("steps_json", []) or [])
            workflow_candidates.append(
                {
                    "priority_hint": workflow_display_priority(workflow, active_skill_ids),
                    "order_hint": len(workflow_candidates),
                    "trace_index": len(workflow_trace) - 1,
                    "workflow_id": workflow.get("workflow_id"),
                    "name": workflow.get("name", "执行流程"),
                    "summary": workflow.get("summary", ""),
                    "bind_skill_id": bind_skill_id,
                    "site_scope": site_scope,
                    "preview_steps": preview_steps[:4],
                    "missing_parameters": missing_parameters,
                    "missing_parameter_defs": missing_parameter_defs,
                    "require_confirmation": bool(workflow.get("require_human_confirm")),
                    "action": {
                        "action_type": "execute_workflow",
                        "label": workflow.get("name", "执行流程"),
                        "workflow_id": workflow.get("workflow_id"),
                        "browser_actions": workflow_browser_actions,
                        "preview_steps": preview_steps[:4],
                        "injected_params": extracted_fields,
                        "missing_parameters": missing_parameters,
                        "missing_parameter_defs": missing_parameter_defs,
                        "require_confirmation": bool(workflow.get("require_human_confirm")),
                    },
                }
            )
        workflow_limit = MAX_SUGGESTED_WORKFLOWS_WITH_PAGE_ACTIONS if analysis_browser_actions else MAX_SUGGESTED_WORKFLOWS
        sorted_candidates = sorted(workflow_candidates, key=lambda item: (item["priority_hint"], item["order_hint"]))
        selected_candidates = sorted_candidates[:workflow_limit]
        ai_router_used = False
        ai_router_reason = ""
        selection_source = "code_ranker"
        ai_selected_ids: list[str] = []
        analysis_selected_ids: list[str] = []
        raw_analysis_selected_ids = analysis.get("relevant_workflow_ids") or []
        if isinstance(raw_analysis_selected_ids, list):
            candidate_ids = {str(item.get("workflow_id", "")).strip() for item in sorted_candidates}
            seen_analysis_ids: set[str] = set()
            for item in raw_analysis_selected_ids:
                workflow_id = str(item or "").strip()
                if not workflow_id or workflow_id in seen_analysis_ids or workflow_id not in candidate_ids:
                    continue
                seen_analysis_ids.add(workflow_id)
                analysis_selected_ids.append(workflow_id)
                if len(analysis_selected_ids) >= workflow_limit:
                    break
        analysis_relevance_reason = str(analysis.get("workflow_relevance_reason", "")).strip()
        if analysis_selected_ids:
            selected_candidates = [
                item for workflow_id in analysis_selected_ids for item in sorted_candidates if str(item.get("workflow_id", "")).strip() == workflow_id
            ]
            ai_router_used = True
            ai_router_reason = analysis_relevance_reason or "selected_by_analyzer"
            selection_source = "analyzer"
        elif len(sorted_candidates) > 1:
            try:
                ai_selected_ids, ai_router_reason = self._rank_workflow_candidates_with_ai(
                    sorted_candidates,
                    analysis,
                    extracted_fields,
                    active_sops,
                    page_meta=page_meta,
                    workflow_limit=workflow_limit,
                )
                if ai_selected_ids:
                    selected_candidates = [
                        item for workflow_id in ai_selected_ids for item in sorted_candidates if str(item.get("workflow_id", "")).strip() == workflow_id
                    ]
                else:
                    selected_candidates = []
                ai_router_used = True
                selection_source = "router"
            except Exception as exc:
                ai_router_reason = f"fallback_to_code_ranker: {exc}"
                selection_source = "code_ranker"

        selected_trace_indices: set[int] = set()
        selected_workflow_ids = {str(item.get("workflow_id", "")).strip() for item in selected_candidates}
        for candidate in selected_candidates:
            actions.append(candidate["action"])
            selected_trace_indices.add(candidate["trace_index"])
            workflow_trace[candidate["trace_index"]]["selected_by_ai"] = ai_router_used and str(candidate.get("workflow_id", "")).strip() in selected_workflow_ids
            workflow_trace[candidate["trace_index"]]["ai_reason"] = ai_router_reason
        for candidate in sorted_candidates:
            trace_index = candidate["trace_index"]
            if trace_index in selected_trace_indices:
                continue
            workflow_trace[trace_index]["included"] = False
            if ai_router_used and selected_candidates:
                workflow_trace[trace_index]["reason"] = "filtered_by_ai"
                workflow_trace[trace_index]["ai_reason"] = ai_router_reason
            elif ai_router_used and not selected_candidates:
                workflow_trace[trace_index]["reason"] = "rejected_by_ai"
                workflow_trace[trace_index]["ai_reason"] = ai_router_reason
            else:
                workflow_trace[trace_index]["reason"] = "hidden_by_limit"
        return actions, workflow_trace, selection_source, [item for item in selected_workflow_ids if item], ai_router_reason

    def analyze(self, payload: dict[str, Any]) -> dict[str, Any]:
        started_at = time.time()
        text = str(payload.get("text", "") or "").strip()
        images = [item for item in (payload.get("images") or []) if str(item).strip()]
        image_meta = payload.get("image_meta") or {}
        context_key = str(payload.get("context_key", "")).strip() or "standalone"
        page_meta = payload.get("page_meta") or {}
        scope_meta = payload.get("scope_meta") or {}
        browser_state = payload.get("browser_state") or {}
        dom_candidates = payload.get("dom_candidates") or []
        if not text and not images:
            raise ApiError("EMPTY_INPUT", "文本和图片不能同时为空", 400)

        provider = self.active_provider()
        vision_requested = bool(images)
        vision_used = vision_requested and provider.supports_vision
        visual_grounded = bool(image_meta.get("visual_grounded")) if vision_requested else False
        alert_context = looks_like_security_alert_context(text, page_meta=page_meta, browser_state=browser_state)
        if images and not text and not vision_used:
            raise ApiError("VISION_UNAVAILABLE", "当前模型不支持视觉输入，无法处理纯图片分析请求", 503)

        active_sops, persona_config, route_trace = self.route_text(text, page_meta=page_meta, browser_state=browser_state)
        system_prompt = self.assemble_system_prompt(active_sops, persona_config, vision_used, vision_requested, visual_grounded, alert_context=alert_context)
        pre_analysis_workflow_candidates = self._collect_workflow_memory_candidates(active_sops, {}, page_meta=page_meta, limit=4)
        workflow_memory_hits = self._build_memory_hits(pre_analysis_workflow_candidates)
        reference_memory_hits = self._collect_reference_memory_hits(text, persona_config, page_meta=page_meta, browser_state=browser_state, limit=4)
        preloaded_memory_hits = self._merge_memory_hits(workflow_memory_hits, reference_memory_hits, limit=8)

        user_blocks: list[dict[str, Any]] = []
        if vision_used:
            for image in images[:4]:
                user_blocks.append({"type": "image", "data_url": data_url_from_any_image(image)})
        memory_context_prompt = self._memory_context_prompt(preloaded_memory_hits)
        browser_state_prompt = self._browser_state_prompt(browser_state, dom_candidates)
        combined_text = f"分析以下文本，并给出结构化结论：\n```text\n{text or '[NO_TEXT]'}\n```"
        if memory_context_prompt:
            combined_text += f"\n\n{memory_context_prompt}"
        if browser_state_prompt:
            combined_text += f"\n\n{browser_state_prompt}"
        user_blocks.append({"type": "text", "text": combined_text})

        response = self.call_task(
            "analyzer",
            system_prompt,
            [{"role": "user", "content": user_blocks}],
            max_tokens=3000,
            temperature=0.1,
        )
        analysis = extract_json_from_text(response.get("text", ""))
        extracted_values = analysis.get("extracted_values", [])
        if not isinstance(extracted_values, list):
            raise ApiError("INVALID_ANALYZER_OUTPUT", "分析模型的 extracted_values 不是数组", 502)
        evidence_items = analysis.get("evidence_items", [])
        if not isinstance(evidence_items, list):
            evidence_items = []
        text_advice = analysis.get("text_advice", [])
        if not isinstance(text_advice, list):
            text_advice = []
        if not isinstance(analysis.get("browser_actions"), list):
            analysis["browser_actions"] = []
        memory_hits, selected_memory_ids, memory_selection_source, memory_selection_reason = self._select_memory_hits_with_analyzer(
            preloaded_memory_hits,
            analysis,
            limit=6,
        )
        context_bar = self._build_context_bar(persona_config, active_sops, memory_hits, page_meta=page_meta)

        extracted_fields = {
            str(item.get("field", "")).strip(): str(item.get("exact_match_text", "")).strip()
            for item in extracted_values
            if str(item.get("field", "")).strip()
        }
        materialized_browser_actions = self.materialize_browser_actions(analysis, active_sops, dom_candidates)
        if materialized_browser_actions:
            analysis["browser_actions"] = materialized_browser_actions
        matched_persona_id = route_trace.get("selected_role_id", "role_base")
        matched_skill_ids = route_trace.get("selected_sop_ids", [])
        quick_actions, workflow_trace, workflow_selection_source, selected_workflow_ids, workflow_selection_reason = self.build_quick_actions(
            analysis,
            active_sops,
            extracted_fields,
            page_meta=page_meta,
        )
        trace_id = self.db.create_trace(
            context_key=context_key,
            page_url=str(page_meta.get("url", "")),
            page_title=str(page_meta.get("title", "")),
            matched_persona=matched_persona_id,
            matched_skill_ids=matched_skill_ids,
            extracted_fields=extracted_fields,
            memory_selection_source=memory_selection_source,
            selected_memory_ids=selected_memory_ids,
            memory_selection_reason=memory_selection_reason,
            workflow_selection_source=workflow_selection_source,
            selected_workflow_ids=selected_workflow_ids,
            workflow_selection_reason=workflow_selection_reason,
            workflow_matches=workflow_trace,
            status="completed",
        )
        self.save_context_snapshot(context_key, text, images, image_meta, page_meta, scope_meta, browser_state=browser_state)
        input_tokens, output_tokens = usage_from_raw(response.get("raw", {}))
        self.db.record_stat(
            request_type="analyze",
            provider_id=provider.provider_id,
            model_id=self.task_model("analyzer"),
            input_tokens=input_tokens or estimate_tokens(text),
            output_tokens=output_tokens or estimate_tokens(response.get("text", "")),
            latency_ms=int((time.time() - started_at) * 1000),
            used_vision=vision_used,
            status="ok",
        )
        return {
            "trace_id": trace_id,
            "context_key": context_key,
            "summary": str(analysis.get("summary", "")).strip(),
            "matched_persona": persona_config.get("name"),
            "matched_domain": " + ".join(item.get("domain_name", "") for item in active_sops if item.get("domain_name")) or "通用分析",
            "matched_skills": [item.get("domain_name", "") for item in active_sops if item.get("domain_name")],
            "matched_skill_ids": matched_skill_ids,
            "extracted_values": extracted_values,
            "extracted_fields": extracted_fields,
            "evidence_items": evidence_items,
            "text_advice": text_advice,
            "action_links": self.render_action_links(analysis, active_sops),
            "browser_actions": analysis.get("browser_actions", []),
            "quick_actions": quick_actions,
            "suggested_actions": quick_actions,
            "vision_requested": vision_requested,
            "vision_used": vision_used,
            "provider": provider.provider_id,
            "route_trace": route_trace,
            "memory_hits": memory_hits,
            "context_bar": context_bar,
            "debug_meta": {
                "primary_skill_id": matched_skill_ids[0] if matched_skill_ids else None,
                "gateway_personas": route_trace.get("gateway_personas", []),
                "candidate_skills": route_trace.get("candidate_skills", []),
                "preloaded_workflow_ids": [item.get("workflow_id") for item in pre_analysis_workflow_candidates if item.get("workflow_id")],
                "preloaded_memory_ids": [
                    item.get("workflow_id") or item.get("template_id") or item.get("document_id")
                    for item in preloaded_memory_hits
                    if item.get("workflow_id") or item.get("template_id") or item.get("document_id")
                ],
                "selected_memory_ids": [
                    item for item in selected_memory_ids if str(item).strip()
                ],
                "memory_selection_source": memory_selection_source,
                "memory_selection_reason": memory_selection_reason,
                "workflow_matches": workflow_trace,
                "workflow_selection_source": workflow_selection_source,
                "selected_workflow_ids": selected_workflow_ids,
                "workflow_selection_reason": workflow_selection_reason,
                "router_reason": route_trace.get("router_reason", ""),
                "selected_role_id": route_trace.get("selected_role_id", ""),
                "selected_sop_ids": route_trace.get("selected_sop_ids", []),
            },
            "page_meta": page_meta,
            "scope_meta": scope_meta,
            "browser_state": browser_state,
            "selection_excerpt": text[:500],
            "image_meta": payload.get("image_meta") or {},
        }

    def _build_chat_context_blocks(
        self,
        context_key: str,
        provider: ProviderConfig,
        supplied_images: list[str] | None = None,
        supplied_image_meta: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        snapshot = self.get_context_snapshot(context_key)
        blocks: list[dict[str, Any]] = []
        if snapshot is not None:
            page_title = str(snapshot.page_meta.get("title", "")).strip()
            page_url = str(snapshot.page_meta.get("url", "")).strip()
            scope_signature = str(snapshot.scope_meta.get("scope_signature", "")).strip()
            blocks.append({"type": "text", "text": f"当前网页上下文：title={page_title or '[unknown]'} url={page_url or '[unknown]'} scope={scope_signature or '[page]'}"})
            if snapshot.text:
                blocks.append({"type": "text", "text": f"当前区域文本摘要：\n{snapshot.text[:3000]}"})
            if snapshot.browser_state:
                blocks.append({"type": "text", "text": self._browser_state_prompt(snapshot.browser_state, snapshot.browser_state.get('dom_candidates') or [])})
        images = supplied_images if supplied_images is not None else (snapshot.images if snapshot else [])
        image_meta = supplied_image_meta if supplied_images is not None else (snapshot.image_meta if snapshot else {})
        visual_grounded = bool((image_meta or {}).get("visual_grounded"))
        if images:
            if provider.supports_vision and visual_grounded:
                for image in images[:4]:
                    blocks.append({"type": "image", "data_url": data_url_from_any_image(image)})
            elif provider.supports_vision:
                blocks.append(
                    {
                        "type": "text",
                        "text": f"系统说明：当前上下文附带了 {len(images)} 张前端生成的文本卡片或降级快照，不是原网页真实像素截图。绝对禁止声称看到了原图细节，只能基于文本内容作答。",
                    }
                )
            else:
                blocks.append({"type": "text", "text": f"系统说明：当前上下文包含 {len(images)} 张图片，但本轮 provider 不支持视觉输入。绝对禁止声称看到了图中内容。"})
        return blocks

    def _build_current_analysis_seed_blocks(self, current_seed: dict[str, Any] | None) -> list[dict[str, Any]]:
        if not isinstance(current_seed, dict) or not current_seed:
            return []
        blocks: list[dict[str, Any]] = []
        summary = str(current_seed.get("summary", "")).strip()
        matched_domain = str(current_seed.get("matched_domain", "")).strip()
        matched_persona = str(current_seed.get("matched_persona", "")).strip()
        page_meta = current_seed.get("page_meta") if isinstance(current_seed.get("page_meta"), dict) else {}
        page_title = str(page_meta.get("title", "")).strip()
        page_url = str(page_meta.get("url", "")).strip()
        selection_excerpt = str(current_seed.get("selection_excerpt", "")).strip()
        extracted_fields = current_seed.get("extracted_fields") if isinstance(current_seed.get("extracted_fields"), dict) else {}
        quick_actions = current_seed.get("quick_actions")
        if not isinstance(quick_actions, list):
            quick_actions = current_seed.get("suggested_actions")
        if not isinstance(quick_actions, list):
            quick_actions = []

        overview_lines = []
        if summary:
            overview_lines.append(f"summary={summary[:600]}")
        if matched_persona:
            overview_lines.append(f"persona={matched_persona[:120]}")
        if matched_domain:
            overview_lines.append(f"skill={matched_domain[:200]}")
        if page_title:
            overview_lines.append(f"title={page_title[:200]}")
        if page_url:
            overview_lines.append(f"url={page_url[:400]}")
        if overview_lines:
            blocks.append({"type": "text", "text": "当前分析承接：\n" + "\n".join(overview_lines)})

        if extracted_fields:
            blocks.append({"type": "text", "text": f"当前分析已抽取字段：\n{shorten_json_text(extracted_fields, 900)}"})

        if quick_actions:
            action_lines = []
            for index, action in enumerate(quick_actions[:3], start=1):
                if not isinstance(action, dict):
                    continue
                action_type = str(action.get("action_type", "")).strip() or "action"
                label = str(action.get("label", "") or action.get("workflow_id", "") or "未命名动作").strip()
                preview_steps = action.get("preview_steps") if isinstance(action.get("preview_steps"), list) else []
                preview = " / ".join(str(item).strip() for item in preview_steps[:2] if str(item).strip())
                suffix = f" | preview={preview[:240]}" if preview else ""
                action_lines.append(f"{index}. {action_type} | {label[:120]}{suffix}")
            if action_lines:
                blocks.append({"type": "text", "text": "当前推荐动作：\n" + "\n".join(action_lines)})

        if selection_excerpt:
            blocks.append({"type": "text", "text": f"当前分析区域摘要：\n{selection_excerpt[:1200]}"})
        return blocks

    def apply_tool_create_or_update_sop(self, payload: dict[str, Any]) -> dict[str, Any]:
        domain_name = str(payload.get("domain_name", "")).strip()
        if not domain_name:
            raise ApiError("INVALID_TOOL_PAYLOAD", "create_or_update_sop 缺少 domain_name", 400)
        result = self.db.upsert_skill(payload)
        return {"sop_id": result["skill_id"], "domain_name": domain_name, "updated": result["updated"]}

    def chat(self, payload: dict[str, Any]) -> dict[str, Any]:
        started_at = time.time()
        context_key = str(payload.get("context_key", "")).strip() or "standalone"
        normalized_messages = normalize_chat_messages(payload.get("messages") or [])
        if not normalized_messages:
            raise ApiError("EMPTY_MESSAGES", "messages 不能为空", 400)

        action_mode = str(payload.get("action_mode", "")).strip()
        provider = self.active_provider()
        supplied_images = [item for item in (payload.get("images") or []) if str(item).strip()]
        supplied_image_meta = payload.get("image_meta") or {}
        context_blocks = self._build_chat_context_blocks(context_key, provider, supplied_images or None, supplied_image_meta)
        payload_page_meta = payload.get("page_meta") or {}
        payload_scope_meta = payload.get("scope_meta") or {}
        payload_browser_state = payload.get("browser_state") or {}
        payload_dom_candidates = payload.get("dom_candidates") or []
        current_seed = payload.get("current_analysis_seed") or {}
        seed_context_blocks = self._build_current_analysis_seed_blocks(current_seed)
        selection_excerpt = ""
        if isinstance(current_seed, dict):
            selection_excerpt = str(current_seed.get("selection_excerpt", "")).strip()
        if not selection_excerpt:
            selection_excerpt = str(payload.get("text", "") or "").strip()

        if action_mode == "browser_control":
            action_context_blocks = list(context_blocks)
            latest_instruction = latest_user_message_text(normalized_messages)
            if payload_page_meta or payload_scope_meta:
                page_title = str(payload_page_meta.get("title", "")).strip()
                page_url = str(payload_page_meta.get("url", "")).strip()
                scope_signature = str(payload_scope_meta.get("scope_signature", "")).strip()
                action_context_blocks.insert(
                    0,
                    {
                        "type": "text",
                        "text": f"当前网页上下文：title={page_title or '[unknown]'} url={page_url or '[unknown]'} scope={scope_signature or '[page]'}",
                    },
                )
            if selection_excerpt:
                action_context_blocks.append({"type": "text", "text": f"当前区域文本摘要：\n{selection_excerpt[:3000]}"})
            browser_state_prompt = self._browser_state_prompt(payload_browser_state, payload_dom_candidates)
            if browser_state_prompt:
                action_context_blocks.append({"type": "text", "text": browser_state_prompt})
            action_messages = normalized_messages
            if action_context_blocks:
                action_messages = [{"role": "user", "content": action_context_blocks}, *normalized_messages]
            system_prompt = f"""你是 OmniAgent 的页面操作规划器。

目标：根据用户当前指令和页面状态，规划一组尽量稳健的浏览器动作。

规则：
1. 只允许输出这些动作类型：click、fill、select、press_key、fill_form、wait、ask_human、focus、highlight。
2. 优先使用 page_agent_index；如果不够稳定，再补 selector、selector_candidates、target_desc、semantic_anchors。
3. 最多返回 {MAX_CHAT_BROWSER_ACTIONS} 步动作；如果没有把握，就返回空数组并在 reply 里说明原因。
4. 遇到敏感、破坏性或高风险动作，先放一个 ask_human。
5. 如果本轮没有真正收到视觉输入，绝对禁止说你看到了截图细节。
6. reply 只能写一句简短计划或失败原因，绝对不要逐步直播“正在点击…/操作执行中…”。
7. 如果任务需要连续点“下一页”之类的按钮多次，直接在 browser_actions 里重复输出多个 click，不要把步骤写进 reply。
8. 对 click / fill / select / press_key 这类页面操作，优先输出稳定的 page_agent_index；如果当前页面状态不足以支撑稳定定位，宁可返回空数组，也不要靠自然语言描述让前端猜动作。
 9. 如果任务本质上是在提交一个表单，优先输出 1 个 fill_form，把多个字段放进 fields，而不是拆成很多零散 fill。
10. fill_form 的字段允许混合 fill / select，格式示例：
   {{"type": "fill_form", "target_desc": "搜索表单", "fields": [{{"field_name": "关键词", "type": "fill", "target_desc": "关键词输入框", "page_agent_index": 5, "value": "foo"}}, {{"field_name": "类型", "type": "select", "target_desc": "类型下拉框", "page_agent_index": 8, "value": "文章"}}], "submit_action": {{"type": "click", "target_desc": "搜索按钮", "page_agent_index": 12}}}}
11. 需要触发搜索、确认、关闭建议菜单等键盘动作时，优先使用 press_key，格式示例：
   {{"type": "press_key", "target_desc": "搜索框", "page_agent_index": 5, "key": "Enter"}}
11.5. ask_human 不要只写一句“是否继续”，尽量补充 question / reason / risk / suggested_action / confirm_label / cancel_label；如果当前暂停点存在清晰分支，还可以补 options 数组，并为某个 option 提供 branch_steps，让前端在用户确认后真正接续对应分支。
11.6. 如果某个分支还需要用户临时补一个值，可额外提供 input_fields 数组；前端会先采集这些值，再把 branch_steps 里的占位符 `{{field_name}}` 渲染后执行，例如：
   {{"type": "ask_human", "question": "是否按新负责人继续分派？", "reason": "当前页面缺少明确负责人。", "input_fields": [{{"name": "assignee", "label": "负责人", "placeholder": "请输入用户名"}}], "options": [{{"id": "assign", "label": "继续分派", "value": "continue", "branch_steps": [{{"type": "fill", "page_agent_index": 7, "target_desc": "负责人输入框", "value": "{{assignee}}"}}, {{"type": "click", "page_agent_index": 9, "target_desc": "提交按钮"}}]}}, {{"id": "cancel", "label": "先取消", "value": "cancel", "replace_remaining": true}}]}}
11.7. input_fields 目前支持 `text / textarea / select` 三种轻量类型；如需下拉选择，可提供 `options=[{{"label":"高","value":"high"}}]`，也可补 `help_text / default_value` 帮助用户更快填写。
11.8. 如果字段需要更明确约束，可补 `min_length / pattern / validation_message`，让前端在继续执行前先做轻量校验。
12. 必须返回闭合纯 JSON，格式如下：
{{
  "reply": "一句话说明准备怎么做，或为什么现在不能做",
  "browser_actions": [
    {{"type": "click", "page_agent_index": 12, "target_desc": "关闭按钮"}},
    {{"type": "fill", "selector": "input[name='q']", "target_desc": "搜索框", "value": "foo"}},
    {{"type": "press_key", "page_agent_index": 5, "target_desc": "搜索框", "key": "Enter"}}
  ]
}}"""
            action_response = self.call_task("chat", system_prompt, action_messages, max_tokens=2200, temperature=0.2)
            raw_reply = action_response.get("text", "").strip()
            browser_actions: list[dict[str, Any]] = []
            reply = raw_reply or "当前没有生成可执行动作。"
            parsed_structured_reply = False
            try:
                decision = extract_json_from_text(raw_reply)
                reply = str(decision.get("reply", "")).strip() or reply
                raw_actions = decision.get("browser_actions") or []
                if isinstance(raw_actions, list):
                    browser_actions = [item for item in raw_actions[:MAX_CHAT_BROWSER_ACTIONS] if workflow_step_looks_executable(item)]
                    parsed_structured_reply = True
            except Exception:
                browser_actions = []
            input_tokens, output_tokens = usage_from_raw(action_response.get("raw", {}))
            vision_in_context = bool(action_context_blocks and any(block.get("type") == "image" for block in action_context_blocks))
            self.db.record_stat(
                request_type="chat_action",
                provider_id=provider.provider_id,
                model_id=self.task_model("chat"),
                input_tokens=input_tokens or estimate_tokens(json.dumps(payload, ensure_ascii=False)),
                output_tokens=output_tokens or estimate_tokens(reply),
                latency_ms=int((time.time() - started_at) * 1000),
                used_vision=vision_in_context,
                status="ok",
            )
            return {
                "context_key": context_key,
                "reply": reply,
                "messages": [*payload.get("messages", []), {"role": "assistant", "content": reply}],
                "tool_calls": [],
                "tool_results": [],
                "browser_actions": browser_actions,
                "provider": provider.provider_id,
                "vision_in_context": vision_in_context,
                "action_mode": action_mode,
            }

        messages = normalized_messages
        combined_context_blocks = [*context_blocks, *seed_context_blocks]
        if combined_context_blocks:
            messages = [{"role": "user", "content": combined_context_blocks}, *normalized_messages]

        personas = self._persona_map()
        existing_roles = json.dumps({key: value.get("name", key) for key, value in personas.items()}, ensure_ascii=False)
        system_prompt = f"""你是 OmniAgent 的通用浏览器副驾。当前处于对话模式。

角色库: {existing_roles}

规则：
1. 正常对话时自然回答，不要机械复读。
2. 只有当用户明确要求“记住”“以后这样做”“建立规则”“生成 SOP/Skill”时，才允许调用 create_or_update_sop。
3. 如果本轮没有真正收到视觉输入，绝对禁止说你看到了图片内容。
4. 如果上下文里说明图片存在但本 provider 不支持视觉，必须明确说“本轮无法读取图片内容”，不能装作看到了。
5. 如果上下文里已经提供了页面文本摘要、当前分析结论、抽取字段或推荐动作，必须优先基于这些文字上下文回答，不能只重复视觉限制。"""

        response = self.call_task("chat", system_prompt, messages, max_tokens=2500, temperature=0.4, tools=AGENT_TOOLS)
        reply = response.get("text", "").strip()
        tool_results = []
        for tool_call in response.get("tool_calls", []):
            if tool_call.get("name") == "create_or_update_sop":
                tool_results.append(self.apply_tool_create_or_update_sop(tool_call.get("input", {})))
        input_tokens, output_tokens = usage_from_raw(response.get("raw", {}))
        self.db.record_stat(
            request_type="chat",
            provider_id=provider.provider_id,
            model_id=self.task_model("chat"),
            input_tokens=input_tokens or estimate_tokens(json.dumps(payload, ensure_ascii=False)),
            output_tokens=output_tokens or estimate_tokens(reply),
            latency_ms=int((time.time() - started_at) * 1000),
            used_vision=bool(context_blocks and any(block.get("type") == "image" for block in context_blocks)),
            status="ok",
        )
        return {
            "context_key": context_key,
            "reply": reply,
            "messages": [*payload.get("messages", []), {"role": "assistant", "content": reply}],
            "tool_calls": response.get("tool_calls", []),
            "tool_results": tool_results,
            "provider": provider.provider_id,
            "vision_in_context": bool(context_blocks and any(block.get("type") == "image" for block in context_blocks)),
        }

    def teach(self, payload: dict[str, Any]) -> dict[str, Any]:
        started_at = time.time()
        context_key = str(payload.get("context_key", "")).strip() or "standalone"
        normalized_messages = normalize_chat_messages(payload.get("messages") or [])
        if not normalized_messages:
            raise ApiError("EMPTY_MESSAGES", "messages 不能为空", 400)
        provider = self.active_provider()
        supplied_images = [item for item in (payload.get("images") or []) if str(item).strip()]
        supplied_image_meta = payload.get("image_meta") or {}
        context_blocks = self._build_chat_context_blocks(context_key, provider, supplied_images or None, supplied_image_meta)
        messages = normalized_messages
        if context_blocks:
            messages = [{"role": "user", "content": context_blocks}, *normalized_messages]

        personas = self._persona_map()
        skills = self._skill_records()
        current_seed = payload.get("current_analysis_seed") or {}
        recorded_steps = payload.get("recorded_steps") or (current_seed.get("recorder_steps") if isinstance(current_seed, dict) else []) or []
        if not isinstance(recorded_steps, list):
            recorded_steps = []
        recorded_step_preview: list[str] = []
        for index, step in enumerate(recorded_steps[:12], start=1):
            if not isinstance(step, dict):
                continue
            recorded_step_preview.append(f"{index}. {workflow_step_preview_text(step)}")
        current_seed_for_prompt = current_seed
        if isinstance(current_seed, dict):
            current_seed_for_prompt = dict(current_seed)
            if recorded_steps:
                current_seed_for_prompt["recorder_steps"] = recorded_step_preview
                current_seed_for_prompt["recorded_step_count"] = len(recorded_steps)
        skill_catalog = [
            {
                "skill_id": item.get("skill_id"),
                "title": item.get("title"),
                "role_id": item.get("role_id"),
                "activation_condition": item.get("activation_condition"),
            }
            for item in skills[:20]
        ]
        system_prompt = f"""你是 OmniAgent 的 Teach 决策器。

目标：只在用户明确提出“记住它”“以后这样做”“建立规则”“录制流程”时，才生成长期记忆草案；否则一律按正常聊天回复。

角色库: {json.dumps({key: value.get('name', key) for key, value in personas.items()}, ensure_ascii=False)}
已有技能（只展示最近 20 条供你参考）: {json.dumps(skill_catalog, ensure_ascii=False)}
当前分析种子: {json.dumps(current_seed_for_prompt, ensure_ascii=False)}
当前录制步骤摘要: {json.dumps(recorded_step_preview, ensure_ascii=False)}

必须返回闭合 JSON：
{{
  "teach_decision": "chat_only | update_skill | create_skill | create_workflow",
  "reply": "给用户看的自然语言回复",
  "target_persona_id": "角色ID或空字符串",
  "target_skill_id": "要更新的技能ID，没有则空字符串",
  "target_skill_title": "技能标题，没有则空字符串",
  "draft": {{
    "type": "skill | workflow | none",
    "data": {{
      "title": "技能标题",
      "activation_condition": "以后在哪些页面或场景里触发",
      "exact_match_signatures": ["召回关键词1", "召回关键词2"],
      "extraction_tasks": [{{"field_name": "judgement", "instruction": "需要重点判断什么"}}]
    }}
  }}
}}

硬规则：
1. 如果用户只是纠正当前理解、讨论页面内容、要求总结，返回 chat_only。
2. 如果用户说“以后这样做”“记住它”，优先 update_skill；只有明显不是同一技能时才 create_skill。
3. 如果用户提到“录制步骤”“按这个流程操作”“保存流程”，返回 create_workflow。
4. 如果当前 provider 不支持视觉，绝对不能声称看到了图片。"""
        response = self.call_task("teach", system_prompt, messages, max_tokens=2500, temperature=0.2)
        parsed = extract_json_from_text(response.get("text", ""))
        decision = str(parsed.get("teach_decision", "chat_only")).strip() or "chat_only"
        reply = str(parsed.get("reply", "")).strip()
        if decision not in {"chat_only", "update_skill", "create_skill", "create_workflow"}:
            raise ApiError("INVALID_TEACH_OUTPUT", f"teach_decision 非法: {decision}", 502)
        target_skill_id = str(parsed.get("target_skill_id", "")).strip()
        target_skill_title = str(parsed.get("target_skill_title", "")).strip()
        if decision == "update_skill" and not target_skill_id and isinstance(current_seed, dict):
            target_skill_id = str(current_seed.get("primary_skill_id", "")).strip()
        draft = parsed.get("draft", {"type": "none", "data": {}})
        if not isinstance(draft, dict):
            draft = {"type": "none", "data": {}}
        draft_data = draft.get("data", {}) if isinstance(draft.get("data"), dict) else {}
        if decision == "create_workflow":
            draft["type"] = "workflow"
            draft_data["steps"] = choose_preferred_workflow_steps(draft_data.get("steps"), recorded_steps)
            if draft_data.get("steps") and not draft_data.get("step_count"):
                draft_data["step_count"] = len(draft_data["steps"])
            site_host = str((current_seed.get("page_meta") or {}).get("host", "")).strip() if isinstance(current_seed, dict) else ""
            if site_host and not draft_data.get("site_scope"):
                draft_data["site_scope"] = [site_host]
            if not target_skill_id:
                target_skill_id = str((current_seed.get("primary_skill_id") or "")).strip() if isinstance(current_seed, dict) else ""
        elif decision in {"update_skill", "create_skill"}:
            draft["type"] = "skill"
            if not draft_data.get("skills"):
                derived_skills = build_skill_memory_actions_from_seed(current_seed)
                if derived_skills:
                    draft_data["skills"] = derived_skills
        draft["data"] = draft_data
        if not target_skill_title and target_skill_id:
            skill = self.db.get_skill(target_skill_id)
            if skill:
                target_skill_title = str(skill.get("title", "")).strip()
        input_tokens, output_tokens = usage_from_raw(response.get("raw", {}))
        self.db.record_stat(
            request_type="teach",
            provider_id=provider.provider_id,
            model_id=self.task_model("teach"),
            input_tokens=input_tokens or estimate_tokens(json.dumps(payload, ensure_ascii=False)),
            output_tokens=output_tokens or estimate_tokens(response.get("text", "")),
            latency_ms=int((time.time() - started_at) * 1000),
            used_vision=bool(context_blocks and any(block.get("type") == "image" for block in context_blocks)),
            status="ok",
        )
        returned_messages = [*payload.get("messages", []), {"role": "assistant", "content": reply}]
        return {
            "context_key": context_key,
            "teach_decision": decision,
            "reply": reply,
            "messages": returned_messages,
            "target_persona_id": str(parsed.get("target_persona_id", "")).strip(),
            "target_skill_id": target_skill_id,
            "target_skill_title": target_skill_title,
            "draft": draft,
            "provider": provider.provider_id,
        }

    def confirm_teach(self, payload: dict[str, Any]) -> dict[str, Any]:
        decision = str(payload.get("teach_decision", "")).strip()
        draft = payload.get("draft") or {}
        draft_data = draft.get("data", {}) if isinstance(draft, dict) else {}
        current_seed = payload.get("current_analysis_seed") or {}
        if decision in {"update_skill", "create_skill"}:
            existing_skill_id = str(payload.get("target_skill_id", "")).strip() or str(draft_data.get("skill_id", "")).strip()
            existing_skill = self.db.get_skill(existing_skill_id) if existing_skill_id else None
            domain_name = str(
                draft_data.get("domain_name")
                or draft_data.get("title")
                or draft_data.get("name")
                or (existing_skill or {}).get("title")
                or "新技能"
            ).strip()
            activation_condition = str(
                draft_data.get("activation_condition")
                or draft_data.get("instruction")
                or (existing_skill or {}).get("activation_condition")
                or "用户确认的规则"
            ).strip()
            context_text = " ".join(
                [
                    str((current_seed.get("selection_excerpt") or "") if isinstance(current_seed, dict) else "").strip(),
                    str(((current_seed.get("page_meta") or {}).get("title", "")) if isinstance(current_seed, dict) else "").strip(),
                ]
            ).strip()
            exact_match_signatures = draft_data.get(
                "exact_match_signatures",
                (existing_skill or {}).get("exact_match_signatures_json", []),
            )
            exact_match_signatures = exact_match_signatures or derive_skill_signatures(domain_name, activation_condition, context_text)
            extraction_tasks = build_default_skill_extraction_tasks(
                domain_name,
                activation_condition,
                draft_data.get("extraction_tasks", (existing_skill or {}).get("extraction_tasks_json", [])),
            )
            draft_skills = normalize_skill_memory_actions(draft_data.get("skills"))
            existing_skills = normalize_skill_memory_actions((existing_skill or {}).get("skills_json", []))
            derived_skills = build_skill_memory_actions_from_seed(current_seed)
            skill_payload = {
                "skill_id": existing_skill_id,
                "domain_name": domain_name,
                "role_id": str(payload.get("target_persona_id", "")).strip()
                or str(draft_data.get("role_id", "")).strip()
                or str((existing_skill or {}).get("role_id", "")).strip()
                or "role_base",
                "activation_condition": activation_condition,
                "exact_match_signatures": exact_match_signatures,
                "extraction_tasks": extraction_tasks,
                "skills": draft_skills or existing_skills or derived_skills,
                "site_scope": draft_data.get(
                    "site_scope",
                    (existing_skill or {}).get("site_scope_json", [str((current_seed.get("page_meta") or {}).get("host", "*"))]),
                ),
            }
            result = self.db.upsert_skill(skill_payload)
            return {"message": f"已写入技能：{skill_payload['domain_name']}", "skill_id": result["skill_id"], "updated": result["updated"]}

        if decision == "create_workflow":
            steps = choose_preferred_workflow_steps(
                payload.get("steps"),
                choose_preferred_workflow_steps(
                    draft_data.get("steps"),
                    current_seed.get("recorder_steps") if isinstance(current_seed, dict) else [],
                ),
            )
            if not isinstance(steps, list) or not steps:
                raise ApiError("INVALID_WORKFLOW_DRAFT", "流程草案缺少步骤，无法保存", 400)
            steps = build_parameterized_workflow_steps(
                steps,
                current_seed.get("extracted_fields") if isinstance(current_seed, dict) else {},
            )
            site_host = str((current_seed.get("page_meta") or {}).get("host", "")).strip()
            result = self.db.create_workflow(
                name=str(draft_data.get("name") or draft_data.get("title") or "录制流程").strip(),
                summary=str(draft_data.get("summary") or draft_data.get("instruction") or "由教导生成的流程").strip(),
                site_scope=draft_data.get("site_scope") or ([site_host] if site_host else ["*"]),
                steps=steps,
                require_human_confirm=True,
                bind_skill_id=str(payload.get("target_skill_id", "")).strip() or str((current_seed or {}).get("primary_skill_id", "")).strip() or None,
            )
            return {"message": f"已保存 workflow：{result['workflow_id']}", **result}

        return {"message": "本次为正常对话，没有需要写入的长期记忆。"}

    def reject_teach(self, payload: dict[str, Any]) -> dict[str, Any]:
        reason = str(payload.get("reason", "")).strip() or "user_rejected"
        return {"message": f"草案已放弃：{reason}"}

    def create_workflow(self, payload: dict[str, Any]) -> dict[str, Any]:
        steps = payload.get("steps") or []
        if not isinstance(steps, list) or not steps:
            raise ApiError("INVALID_WORKFLOW", "workflow 至少需要 1 个步骤", 400)
        steps = build_parameterized_workflow_steps(
            steps,
            payload.get("extracted_fields") if isinstance(payload, dict) else {},
        )
        return self.db.create_workflow(
            name=str(payload.get("name", "")).strip() or "未命名流程",
            summary=str(payload.get("summary", "")).strip() or "录制流程",
            site_scope=payload.get("site_scope") or ["*"],
            steps=steps,
            require_human_confirm=bool(payload.get("require_human_confirm", True)),
            bind_skill_id=str(payload.get("bind_skill_id", "")).strip() or None,
        )

    def heal_workflow(self, payload: dict[str, Any]) -> dict[str, Any]:
        workflow_id = str(payload.get("workflow_id", "")).strip()
        if not workflow_id:
            raise ApiError("INVALID_HEAL", "workflow_id 不能为空", 400)
        try:
            return self.db.heal_workflow(
                workflow_id=workflow_id,
                trace_id=str(payload.get("trace_id", "")).strip() or None,
                step_index=int(payload.get("step_index", 0)),
                replacement_step=payload.get("replacement_step") or {},
                reason=str(payload.get("reason", "")).strip() or None,
            )
        except KeyError as exc:
            raise ApiError("WORKFLOW_NOT_FOUND", f"找不到 workflow: {workflow_id}", 404) from exc
        except IndexError as exc:
            raise ApiError("WORKFLOW_STEP_NOT_FOUND", "step_index 越界", 400) from exc

    def update_trace(self, payload: dict[str, Any]) -> dict[str, Any]:
        trace_id = str(payload.get("trace_id", "")).strip()
        if not trace_id:
            raise ApiError("INVALID_TRACE", "trace_id 不能为空", 400)
        try:
            return self.db.update_trace(
                trace_id=trace_id,
                executed_steps=payload.get("executed_steps") or [],
                failed_step=payload.get("failed_step") or {},
                healing_detail=payload.get("healing_detail") or {},
                healing_state=payload.get("healing_state"),
                status=payload.get("status"),
            )
        except KeyError as exc:
            raise ApiError("TRACE_NOT_FOUND", f"找不到 trace: {trace_id}", 404) from exc

    def rag_upload(self, payload: dict[str, Any]) -> dict[str, Any]:
        source_type = str(payload.get("source_type", "")).strip()
        namespace = str(payload.get("namespace", "")).strip() or "general"
        tags = payload.get("tags") or []
        site_scope = payload.get("site_scope") or ["*"]
        rag_mode = str(payload.get("rag_mode", "semantic")).strip() or "semantic"
        if source_type == "text":
            text = str(payload.get("text", "")).strip()
            if not text:
                raise ApiError("EMPTY_DOCUMENT", "text 不能为空", 400)
            return self.db.add_document(
                name=str(payload.get("name", "")).strip() or stable_id("doc", text[:40]),
                doc_type="text",
                namespace=namespace,
                source_type="text",
                content_text=text,
                tags=tags,
                site_scope=site_scope,
                rag_mode=rag_mode,
            )
        if source_type == "file_base64":
            name = str(payload.get("name", "")).strip() or "upload.bin"
            content_base64 = str(payload.get("content_base64", "")).strip()
            if not content_base64:
                raise ApiError("EMPTY_DOCUMENT", "content_base64 不能为空", 400)
            try:
                raw_bytes = base64.b64decode(content_base64)
            except Exception as exc:
                raise ApiError("INVALID_BASE64", "文件内容不是合法 base64", 400) from exc
            content_text, doc_type = extract_text_from_upload(name, raw_bytes)
            return self.db.add_document(
                name=name,
                doc_type=doc_type,
                namespace=namespace,
                source_type="file_base64",
                content_text=content_text,
                tags=tags,
                site_scope=site_scope,
                rag_mode=rag_mode,
            )
        raise ApiError("UNSUPPORTED_SOURCE", f"不支持的 source_type: {source_type}", 400)

    def rag_search(self, query: str, namespace: str | None, top_k: int) -> dict[str, Any]:
        if not query.strip():
            raise ApiError("EMPTY_QUERY", "q 不能为空", 400)
        return self.db.search_documents(query=query, namespace=namespace or None, top_k=top_k)

    def audit_workflows(self) -> dict[str, Any]:
        workflows = [annotate_workflow_record(item) for item in self.db.list_workflows()]
        cleanup_candidates = [
            {
                "workflow_id": item.get("workflow_id"),
                "name": item.get("name", "执行流程"),
                "source_type": item.get("source_type"),
                "audit_flags": item.get("audit_flags", []),
                "summary": item.get("summary", ""),
                "site_scope": item.get("site_scope_json", []),
            }
            for item in workflows
            if item.get("name_generic") or not item.get("steps_executable")
        ]
        return {
            "summary": workflow_audit_summary(workflows),
            "cleanup_candidates": cleanup_candidates[:20],
        }

    def archive_workflows(self, payload: dict[str, Any]) -> dict[str, Any]:
        workflow_ids = [
            str(item or "").strip()
            for item in (payload.get("workflow_ids") or [])
            if str(item or "").strip()
        ]
        audit_flags = {
            str(item or "").strip().lower()
            for item in (payload.get("audit_flags") or [])
            if str(item or "").strip()
        }
        source_type_filter = normalize_workflow_source_type(payload.get("source_type"))
        dry_run = bool(payload.get("dry_run", False))
        if not workflow_ids and not audit_flags:
            raise ApiError("INVALID_ARCHIVE_REQUEST", "workflow_ids 或 audit_flags 至少需要一个", 400)

        workflows = [annotate_workflow_record(item) for item in self.db.list_workflows()]
        workflows_by_id = {str(item.get("workflow_id") or "").strip(): item for item in workflows if str(item.get("workflow_id") or "").strip()}
        matched: list[dict[str, Any]] = []
        seen_ids: set[str] = set()

        if workflow_ids:
            for workflow_id in workflow_ids:
                item = workflows_by_id.get(workflow_id)
                if not item or workflow_id in seen_ids:
                    continue
                seen_ids.add(workflow_id)
                matched.append(item)
        if audit_flags:
            for item in workflows:
                workflow_id = str(item.get("workflow_id") or "").strip()
                if not workflow_id or workflow_id in seen_ids:
                    continue
                if source_type_filter and str(item.get("source_type") or "").strip() != source_type_filter:
                    continue
                item_flags = {str(flag or "").strip().lower() for flag in (item.get("audit_flags") or []) if str(flag or "").strip()}
                if item_flags & audit_flags:
                    seen_ids.add(workflow_id)
                    matched.append(item)

        if not matched:
            return {
                "dry_run": dry_run,
                "matched_count": 0,
                "archived_count": 0,
                "matched_workflows": [],
                "summary_after": workflow_audit_summary(workflows),
            }

        archived_count = 0
        if not dry_run:
            archived_count = self.db.archive_workflows([item.get("workflow_id") for item in matched if item.get("workflow_id")])
            workflows = [annotate_workflow_record(item) for item in self.db.list_workflows()]

        matched_workflows = [
            {
                "workflow_id": item.get("workflow_id"),
                "name": item.get("name", "执行流程"),
                "source_type": item.get("source_type"),
                "audit_flags": item.get("audit_flags", []),
                "summary": item.get("summary", ""),
            }
            for item in matched
        ]
        return {
            "dry_run": dry_run,
            "matched_count": len(matched_workflows),
            "archived_count": archived_count,
            "matched_workflows": matched_workflows,
            "summary_after": workflow_audit_summary(workflows),
        }

    def audit_documents(self) -> dict[str, Any]:
        documents = [annotate_document_record(item) for item in self.db.list_documents()]
        cleanup_candidates = [
            {
                "document_id": item.get("document_id"),
                "name": item.get("name", "未命名文档"),
                "source_type": item.get("source_type"),
                "audit_flags": item.get("audit_flags", []),
                "namespace": item.get("namespace", ""),
                "chunk_count": item.get("chunk_count", 0),
            }
            for item in documents
            if item.get("name_generic") or "empty_chunks" in (item.get("audit_flags") or [])
        ]
        return {
            "summary": document_audit_summary(documents),
            "cleanup_candidates": cleanup_candidates[:20],
        }

    def audit_personas(self) -> dict[str, Any]:
        personas = self.db.list_personas()
        skills = self.db.list_skills()
        skill_counts: dict[str, int] = {}
        for item in skills:
            role_id = str(item.get("role_id") or "").strip()
            if not role_id:
                continue
            skill_counts[role_id] = skill_counts.get(role_id, 0) + 1
        annotated = [annotate_persona_record(item, skill_counts) for item in personas]
        review_candidates = [
            {
                "persona_id": item.get("persona_id"),
                "name": item.get("name", ""),
                "skill_count": item.get("skill_count", 0),
                "prompt_length": item.get("prompt_length", 0),
                "audit_flags": item.get("audit_flags", []),
            }
            for item in annotated
            if any(flag in {"generic_name", "empty_prompt", "short_prompt"} for flag in (item.get("audit_flags") or []))
        ]
        return {
            "summary": persona_audit_summary(annotated),
            "review_candidates": review_candidates[:20],
        }

    def audit_skills(self) -> dict[str, Any]:
        personas = self.db.list_personas()
        persona_ids = {str(item.get("persona_id") or "").strip() for item in personas if str(item.get("persona_id") or "").strip()}
        skills = [annotate_skill_record(item, persona_ids) for item in self.db.list_skills()]
        review_candidates = [
            {
                "skill_id": item.get("skill_id"),
                "title": item.get("title", ""),
                "role_id": item.get("role_id", ""),
                "signature_count": item.get("signature_count", 0),
                "extraction_task_count": item.get("extraction_task_count", 0),
                "action_count": item.get("action_count", 0),
                "scope_count": item.get("scope_count", 0),
                "audit_flags": item.get("audit_flags", []),
            }
            for item in skills
            if any(flag in {"generic_name", "missing_role", "empty_activation"} for flag in (item.get("audit_flags") or []))
        ]
        return {
            "summary": skill_audit_summary(skills),
            "review_candidates": review_candidates[:20],
        }

    def archive_documents(self, payload: dict[str, Any]) -> dict[str, Any]:
        document_ids = [
            str(item or "").strip()
            for item in (payload.get("document_ids") or [])
            if str(item or "").strip()
        ]
        audit_flags = {
            str(item or "").strip().lower()
            for item in (payload.get("audit_flags") or [])
            if str(item or "").strip()
        }
        source_type_filter = normalize_document_source_type(payload.get("source_type"))
        dry_run = bool(payload.get("dry_run", False))
        if not document_ids and not audit_flags:
            raise ApiError("INVALID_DOCUMENT_ARCHIVE_REQUEST", "document_ids 或 audit_flags 至少需要一个", 400)

        documents = [annotate_document_record(item) for item in self.db.list_documents()]
        documents_by_id = {str(item.get("document_id") or "").strip(): item for item in documents if str(item.get("document_id") or "").strip()}
        matched: list[dict[str, Any]] = []
        seen_ids: set[str] = set()

        if document_ids:
            for document_id in document_ids:
                item = documents_by_id.get(document_id)
                if not item or document_id in seen_ids:
                    continue
                seen_ids.add(document_id)
                matched.append(item)
        if audit_flags:
            for item in documents:
                document_id = str(item.get("document_id") or "").strip()
                if not document_id or document_id in seen_ids:
                    continue
                if source_type_filter and str(item.get("source_type") or "").strip() != source_type_filter:
                    continue
                item_flags = {str(flag or "").strip().lower() for flag in (item.get("audit_flags") or []) if str(flag or "").strip()}
                if item_flags & audit_flags:
                    seen_ids.add(document_id)
                    matched.append(item)

        if not matched:
            return {
                "dry_run": dry_run,
                "matched_count": 0,
                "archived_count": 0,
                "matched_documents": [],
                "summary_after": document_audit_summary(documents),
            }

        archived_count = 0
        if not dry_run:
            archived_count = self.db.archive_documents([item.get("document_id") for item in matched if item.get("document_id")])
            documents = [annotate_document_record(item) for item in self.db.list_documents()]

        matched_documents = [
            {
                "document_id": item.get("document_id"),
                "name": item.get("name", "未命名文档"),
                "source_type": item.get("source_type"),
                "audit_flags": item.get("audit_flags", []),
                "namespace": item.get("namespace", ""),
                "chunk_count": item.get("chunk_count", 0),
            }
            for item in matched
        ]
        return {
            "dry_run": dry_run,
            "matched_count": len(matched_documents),
            "archived_count": archived_count,
            "matched_documents": matched_documents,
            "summary_after": document_audit_summary(documents),
        }

    def capabilities(self) -> dict[str, Any]:
        provider = self.config.active_provider
        return {
            "provider": provider.provider_id if provider else None,
            "upstream_provider": describe_upstream_provider(provider),
            "provider_type": provider.provider_type if provider else None,
            "source_app_type": provider.source_app_type if provider else "",
            "source_label": provider.source_label if provider else "",
            "supports_vision": bool(provider and provider.supports_vision),
            "supports_tool_use": bool(provider and provider.supports_tool_use),
            "env_files": list(self.config.loaded_env_files),
            "ccswitch_endpoint": self.config.ccswitch_endpoint_url or "",
            "proxy": self.config.ccswitch_proxy_url or "",
            "system_proxy": self.config.system_proxy_url or "",
            "routing_mode": describe_routing_mode(self.config, provider),
            "endpoints": [
                "/api/health",
                "/api/capabilities",
                "/api/analyze",
                "/api/chat",
                "/api/teach",
                "/api/teach/confirm",
                "/api/teach/reject",
                "/api/workflows/record",
                "/api/workflows/heal",
                "/api/workflows/archive",
                "/api/workflows/audit",
                "/api/documents/archive",
                "/api/documents/audit",
                "/api/personas",
                "/api/skills",
                "/api/workflows",
                "/api/traces",
                "/api/traces/update",
                "/api/workflow-heal-events",
                "/api/query-templates",
                "/api/documents",
                "/api/stats",
                "/api/rag/upload",
                "/api/rag/search",
            ],
        }


CONFIG = load_runtime_config()
setup_logging(CONFIG.debug)
ensure_json_file(SOPS_FILE, default_sops_seed())
ensure_json_file(PERSONAS_FILE, default_personas_seed())
ensure_json_file(WORKFLOWS_FILE, default_workflows_seed())
ensure_json_file(QUERY_TEMPLATES_FILE, default_query_templates_seed())
ensure_json_file(DOCUMENTS_FILE, default_documents_seed())
DB = Database(CONFIG.db_path)
SEED_INFO = DB.initialize(
    personas_seed=load_json(PERSONAS_FILE) or default_personas_seed(),
    sops_seed=load_json(SOPS_FILE) or default_sops_seed(),
    workflow_seed=load_json(WORKFLOWS_FILE) or default_workflows_seed(),
    query_template_seed=load_json(QUERY_TEMPLATES_FILE) or default_query_templates_seed(),
    document_seed=load_json(DOCUMENTS_FILE) or default_documents_seed(),
)
RUNTIME = GeminiBaselineRuntime(CONFIG, DB)


@app.errorhandler(ApiError)
def handle_api_error(error: ApiError):
    return jsonify({"error": {"code": error.code, "message": error.message, "details": error.details}}), error.status_code


@app.errorhandler(Exception)
def handle_unexpected_error(error: Exception):
    LOGGER.exception("Unhandled error: %s", error)
    return jsonify({"error": {"code": "INTERNAL_ERROR", "message": str(error), "details": {}}}), 500


@app.route("/api/health", methods=["GET"])
def api_health():
    force = request.args.get("force", "").strip().lower() in {"1", "true", "yes"}
    return jsonify(RUNTIME.get_health(force=force))


@app.route("/api/capabilities", methods=["GET"])
def api_capabilities():
    return jsonify(RUNTIME.capabilities())


@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    payload = request.get_json(force=True, silent=False) or {}
    return jsonify(RUNTIME.analyze(payload))


@app.route("/api/chat", methods=["POST"])
def api_chat():
    payload = request.get_json(force=True, silent=False) or {}
    return jsonify(RUNTIME.chat(payload))


@app.route("/api/teach", methods=["POST"])
def api_teach():
    payload = request.get_json(force=True, silent=False) or {}
    return jsonify(RUNTIME.teach(payload))


@app.route("/api/teach/confirm", methods=["POST"])
def api_teach_confirm():
    payload = request.get_json(force=True, silent=False) or {}
    return jsonify(RUNTIME.confirm_teach(payload))


@app.route("/api/teach/reject", methods=["POST"])
def api_teach_reject():
    payload = request.get_json(force=True, silent=False) or {}
    return jsonify(RUNTIME.reject_teach(payload))


@app.route("/api/workflows/record", methods=["POST"])
def api_workflows_record():
    payload = request.get_json(force=True, silent=False) or {}
    return jsonify(RUNTIME.create_workflow(payload))


@app.route("/api/workflows/heal", methods=["POST"])
def api_workflows_heal():
    payload = request.get_json(force=True, silent=False) or {}
    return jsonify(RUNTIME.heal_workflow(payload))


@app.route("/api/workflows/archive", methods=["POST"])
def api_workflows_archive():
    payload = request.get_json(force=True, silent=False) or {}
    return jsonify(RUNTIME.archive_workflows(payload))


@app.route("/api/tools/create-or-update-sop", methods=["POST"])
def api_create_or_update_sop():
    payload = request.get_json(force=True, silent=False) or {}
    return jsonify(RUNTIME.apply_tool_create_or_update_sop(payload))


@app.route("/api/personas", methods=["GET"])
def api_personas():
    return jsonify(DB.list_personas())


@app.route("/api/personas/audit", methods=["GET"])
def api_personas_audit():
    return jsonify(RUNTIME.audit_personas())


@app.route("/api/skills", methods=["GET"])
def api_skills():
    return jsonify(DB.list_skills())


@app.route("/api/skills/audit", methods=["GET"])
def api_skills_audit():
    return jsonify(RUNTIME.audit_skills())


@app.route("/api/workflows", methods=["GET"])
def api_workflows():
    return jsonify([annotate_workflow_record(item) for item in DB.list_workflows()])


@app.route("/api/workflows/audit", methods=["GET"])
def api_workflows_audit():
    return jsonify(RUNTIME.audit_workflows())


@app.route("/api/documents/archive", methods=["POST"])
def api_documents_archive():
    payload = request.get_json(force=True, silent=False) or {}
    return jsonify(RUNTIME.archive_documents(payload))


@app.route("/api/documents/audit", methods=["GET"])
def api_documents_audit():
    return jsonify(RUNTIME.audit_documents())


@app.route("/api/traces", methods=["GET"])
def api_traces():
    limit = int(request.args.get("limit", "20"))
    context_key = request.args.get("context_key", "").strip() or None
    return jsonify(DB.list_traces(context_key=context_key, limit=limit))


@app.route("/api/traces/update", methods=["POST"])
def api_trace_update():
    payload = request.get_json(force=True, silent=False) or {}
    return jsonify(RUNTIME.update_trace(payload))


@app.route("/api/workflow-heal-events", methods=["GET"])
def api_workflow_heal_events():
    limit = int(request.args.get("limit", "20"))
    workflow_id = request.args.get("workflow_id", "").strip() or None
    return jsonify(DB.list_workflow_heal_events(workflow_id=workflow_id, limit=limit))


@app.route("/api/query-templates", methods=["GET"])
def api_query_templates():
    return jsonify(DB.list_query_templates())


@app.route("/api/documents", methods=["GET"])
def api_documents():
    namespace = request.args.get("namespace", "").strip() or None
    return jsonify([annotate_document_record(item) for item in DB.list_documents(namespace=namespace)])


@app.route("/api/stats", methods=["GET"])
def api_stats():
    recent_limit = int(request.args.get("recent_limit", "8"))
    return jsonify(DB.stats_summary(recent_limit=recent_limit))


@app.route("/api/rag/upload", methods=["POST"])
def api_rag_upload():
    payload = request.get_json(force=True, silent=False) or {}
    return jsonify(RUNTIME.rag_upload(payload))


@app.route("/api/rag/search", methods=["GET"])
def api_rag_search():
    query = request.args.get("q", "")
    namespace = request.args.get("namespace", "").strip() or None
    top_k = int(request.args.get("top_k", "5"))
    return jsonify(RUNTIME.rag_search(query=query, namespace=namespace, top_k=top_k))


@app.route("/frontend/page-agent.vendor.js", methods=["GET"])
def frontend_page_agent_vendor():
    target = FRONTEND_VENDOR_DIR / "page-agent.vendor.js"
    if not target.exists():
        raise ApiError("FRONTEND_ASSET_MISSING", "page-agent vendor 文件不存在", 404)
    return send_file(target, mimetype="application/javascript")


@app.route("/frontend/omniagent.user.js", methods=["GET"])
def frontend_userscript_asset():
    target = FRONTEND_DIR / "omniagent.user.js"
    if not target.exists():
        raise ApiError("FRONTEND_ASSET_MISSING", "userscript 文件不存在", 404)
    return send_file(target, mimetype="application/javascript")


@app.route("/frontend/omniagent.app.js", methods=["GET"])
def frontend_app_asset():
    target = FRONTEND_DIR / "omniagent.app.js"
    if not target.exists():
        raise ApiError("FRONTEND_ASSET_MISSING", "主前端脚本文件不存在", 404)
    return send_file(target, mimetype="application/javascript")


def _resolve_regression_asset(asset_path: str | None = None) -> Path:
    relative = Path(str(asset_path or "index.html").strip() or "index.html")
    if relative.is_absolute():
        raise ApiError("INVALID_FRONTEND_ASSET", "不允许访问绝对路径资源", 400)
    target = (FRONTEND_REGRESSION_DIR / relative).resolve()
    root = FRONTEND_REGRESSION_DIR.resolve()
    if root not in target.parents and target != root:
        raise ApiError("INVALID_FRONTEND_ASSET", "不允许访问回归目录外的资源", 400)
    if target.is_dir():
        target = target / "index.html"
    if not target.exists() or not target.is_file():
        raise ApiError("FRONTEND_ASSET_MISSING", "回归页面资源不存在", 404)
    return target


@app.route("/frontend/regression", methods=["GET"])
@app.route("/frontend/regression/<path:asset_path>", methods=["GET"])
def frontend_regression_asset(asset_path: str | None = None):
    return send_file(_resolve_regression_asset(asset_path))


if __name__ == "__main__":
    provider = CONFIG.active_provider
    LOGGER.info(
        "Starting Gemini Baseline host=%s port=%s provider=%s upstream=%s model=%s base_url=%s ccswitch_endpoint=%s proxy=%s routing=%s env_files=%s seed=%s",
        CONFIG.host,
        CONFIG.port,
        CONFIG.selected_provider_id,
        describe_upstream_provider(provider) or "<none>",
        provider.model_name if provider else "<none>",
        provider.base_url if provider else "<none>",
        CONFIG.ccswitch_endpoint_url or "<none>",
        CONFIG.ccswitch_proxy_url or "<none>",
        describe_routing_mode(CONFIG, provider),
        ",".join(CONFIG.loaded_env_files) if CONFIG.loaded_env_files else "<none>",
        SEED_INFO,
    )
    app.run(host=CONFIG.host, port=CONFIG.port, debug=CONFIG.debug, use_reloader=False)
