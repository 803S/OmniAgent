"""
OmniAgent - main 基线重构版
核心设计：混合路由（Local Recall + LLM Rerank）、SOP Skills 引擎、角色冻结、动作与文本生成分离。
在保留可选 Stats / Browser / RAG 接口的同时，回归 main 分支的稳定核心。
"""

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS

load_dotenv(Path(__file__).parent / ".env")

app = Flask(__name__)
CORS(app)

BASE_DIR = Path(__file__).parent
MEMORY_DIR = BASE_DIR / "memory"
MEMORY_DIR.mkdir(exist_ok=True)

SOPS_FILE = MEMORY_DIR / "sops.json"
PERSONAS_FILE = MEMORY_DIR / "personas.json"

MODEL_PROVIDER = os.getenv("MODEL_PROVIDER", "deepseek")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-1.5-pro")
XIAOMI_API_KEY = os.getenv("XIAOMI_API_KEY", "")
XIAOMI_BASE_URL = os.getenv("XIAOMI_BASE_URL", "https://api.xiaomi.com/v1")
XIAOMI_MODEL = os.getenv("XIAOMI_MODEL", "mi-abab6.5-chat")
LOCAL_MODEL_URL = os.getenv("LOCAL_MODEL_URL", "")
LOCAL_MODEL_NAME = os.getenv("LOCAL_MODEL_NAME", "llama3")
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "")
INTERNAL_BASE_URL = os.getenv("INTERNAL_BASE_URL", "")
INTERNAL_MODEL = os.getenv("INTERNAL_MODEL", "claude-opus-4-6")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-4-1")

print(f"[MODEL] Provider: {MODEL_PROVIDER}")


# ============================================================================
# 基础工具：记忆库管理
# ============================================================================

def load_json(filepath: Path) -> Dict[str, Any]:
    if filepath.exists():
        if os.path.getsize(filepath) == 0:
            return {}
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, dict) else {}
        except json.JSONDecodeError as exc:
            print(f"[MEMORY] {filepath.name} damaged, fallback to empty: {exc}")
            return {}
    return {}


def save_json(filepath: Path, data: Dict[str, Any]) -> None:
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_sops() -> Dict[str, Any]:
    return load_json(SOPS_FILE)


def save_sops(data: Dict[str, Any]) -> None:
    save_json(SOPS_FILE, data)


def load_personas() -> Dict[str, Any]:
    personas = load_json(PERSONAS_FILE)
    if "role_base" not in personas:
        personas["role_base"] = {
            "name": "客观总结助手",
            "system_prompt": "你是一个严谨、客观的通用文本分析助手。你的任务是提炼核心信息，保持中立语气。",
        }
    return personas


def save_personas(data: Dict[str, Any]) -> None:
    save_json(PERSONAS_FILE, data)


def extract_json_from_text(text: str) -> Dict[str, Any]:
    if not text or not isinstance(text, str):
        raise ValueError("AI returned empty text")
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except Exception:
        pass

    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if not match:
        match = re.search(r"(\{.*\})", text, re.DOTALL)
    if match:
        return json.loads(match.group(1))
    raise ValueError(f"AI did not return valid JSON: {text[:120]}...")


def parse_image_base64(b64_str: str) -> Dict[str, Any]:
    match = re.match(r"data:(image/[a-zA-Z0-9.+-]+);base64,(.*)", b64_str)
    if match:
        media_type, data = match.group(1), match.group(2)
    else:
        media_type, data = "image/png", b64_str
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": media_type, "data": data},
    }


# ============================================================================
# 统一模型调用
# ============================================================================

def _anthropic_client():
    if not ANTHROPIC_API_KEY:
        return None
    try:
        import anthropic  # type: ignore

        return anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    except ImportError:
        return None


ANTHROPIC_CLIENT = _anthropic_client()


def chat_completion(
    messages: List[Dict[str, Any]],
    *,
    max_tokens: int = 1000,
    temperature: float = 0.3,
    system: Optional[str] = None,
) -> str:
    if MODEL_PROVIDER == "anthropic" and ANTHROPIC_CLIENT:
        resp = ANTHROPIC_CLIENT.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=max_tokens,
            temperature=temperature,
            system=system,
            messages=messages,
        )
        chunks: List[str] = []
        for block in resp.content:
            if getattr(block, "type", None) == "text":
                chunks.append(block.text)
        return "".join(chunks)

    if MODEL_PROVIDER == "local" and LOCAL_MODEL_URL:
        payload = {
            "model": LOCAL_MODEL_NAME,
            "messages": ([{"role": "system", "content": system}] if system else []) + messages,
            "options": {"temperature": temperature},
            "stream": False,
        }
        resp = requests.post(f"{LOCAL_MODEL_URL}/api/chat", json=payload, timeout=120)
        resp.raise_for_status()
        return resp.json()["message"]["content"]

    if MODEL_PROVIDER == "openai" and OPENAI_API_KEY:
        headers = {"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"}
        payload = {
            "model": OPENAI_MODEL,
            "messages": ([{"role": "system", "content": system}] if system else []) + messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        resp = requests.post(f"{OPENAI_BASE_URL}/chat/completions", headers=headers, json=payload, timeout=120)
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]

    if MODEL_PROVIDER == "gemini" and GEMINI_API_KEY:
        headers = {"Content-Type": "application/json"}
        contents = []
        if system:
            contents.append({"role": "user", "parts": [{"text": system}]})
        for message in messages:
            content = message["content"]
            if isinstance(content, str):
                parts = [{"text": content}]
            else:
                parts = []
                for item in content:
                    if item.get("type") == "text":
                        parts.append({"text": item.get("text", "")})
            contents.append({"role": message["role"], "parts": parts})
        payload = {"contents": contents, "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens}}
        resp = requests.post(
            f"https://generativelanguage.googleapis.com/v1/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}",
            headers=headers,
            json=payload,
            timeout=120,
        )
        resp.raise_for_status()
        return resp.json()["candidates"][0]["content"]["parts"][0]["text"]

    if MODEL_PROVIDER == "xiaomi" and XIAOMI_API_KEY:
        headers = {"Authorization": f"Bearer {XIAOMI_API_KEY}", "Content-Type": "application/json"}
        payload = {
            "model": XIAOMI_MODEL,
            "messages": ([{"role": "system", "content": system}] if system else []) + messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        resp = requests.post(f"{XIAOMI_BASE_URL}/chat/completions", headers=headers, json=payload, timeout=120)
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]

    if MODEL_PROVIDER == "internal" and INTERNAL_API_KEY and INTERNAL_BASE_URL:
        headers = {"Authorization": f"Bearer {INTERNAL_API_KEY}", "Content-Type": "application/json"}
        payload = {
            "model": INTERNAL_MODEL,
            "messages": ([{"role": "system", "content": system}] if system else []) + messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        resp = requests.post(f"{INTERNAL_BASE_URL}/chat/completions", headers=headers, json=payload, timeout=120)
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]

    if MODEL_PROVIDER == "deepseek" and DEEPSEEK_API_KEY:
        headers = {"Authorization": f"Bearer {DEEPSEEK_API_KEY}", "Content-Type": "application/json"}
        payload = {
            "model": DEEPSEEK_MODEL,
            "messages": ([{"role": "system", "content": system}] if system else []) + messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        resp = requests.post(f"{DEEPSEEK_BASE_URL}/v1/chat/completions", headers=headers, json=payload, timeout=120)
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]

    raise RuntimeError(f"Model provider '{MODEL_PROVIDER}' is not configured correctly")


# ============================================================================
# 核心逻辑 1：混合路由
# ============================================================================

def local_keyword_recall(text: str, sops: Dict[str, Any]) -> Dict[str, Any]:
    candidates: Dict[str, Any] = {}
    text_lower = text.lower()
    for sop_id, sop_config in sops.items():
        if not isinstance(sop_config, dict):
            continue
        signatures = sop_config.get("exact_match_signatures", sop_config.get("trigger_keywords", []))
        if not isinstance(signatures, list):
            continue
        for sig in signatures:
            sig = str(sig).strip()
            if sig and sig.lower() in text_lower:
                candidates[sop_id] = sop_config
                print(f"[ROUTER] local recall hit '{sig}' -> {sop_config.get('domain_name', sop_id)}")
                break
    return candidates


def smart_llm_router(text: str) -> Tuple[Optional[Dict[str, Any]], Dict[str, Any]]:
    sops = load_sops()
    personas = load_personas()
    candidate_sops = local_keyword_recall(text, sops)
    persona_catalog = {k: v.get("name") for k, v in personas.items()}

    if not candidate_sops:
        sop_context = "当前没有业务规则匹配。请仅根据文本内容选择合适的专家角色。"
    else:
        sop_catalog = {
            k: f"业务领域: {v.get('domain_name')} | 适用条件: {v.get('activation_condition', '无说明')}"
            for k, v in candidate_sops.items()
        }
        sop_context = f"本地召回到以下候选规则，请判断哪个真正符合：\n{json.dumps(sop_catalog, ensure_ascii=False, indent=2)}"

    router_prompt = f"""你是一个智能请求路由器（API Gateway）。
从【角色库】中挑选合适专家，并判断是否需要应用【候选技能】。
角色库: {json.dumps(persona_catalog, ensure_ascii=False)}
候选技能: {sop_context}

请返回纯 JSON：
{{
    "thought_process": "极简理由，20字内",
    "role_id": "选出的角色ID",
    "sop_id": "选出的技能ID，如无则为null"
}}"""

    try:
        route_text = chat_completion(
            messages=[{"role": "user", "content": f"提取文本前1500字：\n{text[:1500]}"}],
            max_tokens=800,
            temperature=0.1,
            system=router_prompt,
        )
        route_decision = extract_json_from_text(route_text)
        role_id = route_decision.get("role_id", "role_base")
        sop_id = route_decision.get("sop_id")
        persona_config = personas.get(role_id, personas["role_base"])
        sop_config = sops.get(sop_id) if sop_id in sops else None
        print(f"[ROUTER] persona={persona_config.get('name')} sop={sop_config.get('domain_name') if sop_config else 'None'}")
        return sop_config, persona_config
    except Exception as exc:
        print(f"[ROUTER] fallback: {exc}")
        return None, personas["role_base"]


# ============================================================================
# 核心逻辑 2：执行与解析
# ============================================================================

def assemble_system_prompt(sop_config: Optional[Dict[str, Any]], persona_config: Dict[str, Any]) -> str:
    prompt = f"【你的角色设定】\n{persona_config.get('system_prompt', '')}\n\n"
    if sop_config:
        domain = sop_config.get("domain_name", "特定领域")
        prompt += f"【当前触发业务技能：{domain}】\n你必须准确提取以下真实存在的值：\n"
        for task in sop_config.get("extraction_tasks", []):
            prompt += f"- {task.get('field_name')}: {task.get('instruction')}\n"
        text_constraints = [s for s in sop_config.get("skills", []) if s.get("action_type") == "text_constraint"]
        if text_constraints:
            prompt += "\n【强制回复话术规范】：\n"
            for tc in text_constraints:
                label = tc.get("description") or tc.get("skill_name") or "规则"
                prompt += f"- {label}: {tc.get('template', '')}\n"
    else:
        prompt += "【自由发挥模式】未触发特定 SOP，请直接精准研判。\n"

    prompt += """
【操作系统绝对红线】：
1. summary 必须直接给结论（50字内）；text_advice 必须是极简动作指令，如无需排查则返回 []。
2. 绝对禁止在分析中编造或输出任何 http/https 链接。
3. 提取值必须是原文或截图中真实存在的字符。
"""
    return prompt


def call_model_analyze(text: str, images_base64: List[str], system_prompt: str) -> str:
    if images_base64 and MODEL_PROVIDER == "anthropic" and ANTHROPIC_CLIENT:
        content: List[Dict[str, Any]] = [parse_image_base64(img) for img in images_base64]
        content.append({
            "type": "text",
            "text": f"""分析以下文本并结合截图：
```text
{text}
```
严格返回闭合纯 JSON：
{{
  "summary": "极度精炼定性结论",
  "extracted_values": [{{"field": "字段名", "exact_match_text": "原文值", "color": "red/orange/blue"}}],
  "text_advice": ["短句动作指令1"]
}}""",
        })
        return chat_completion(messages=[{"role": "user", "content": content}], max_tokens=3000, temperature=0.1, system=system_prompt)

    user_message = f"""分析以下文本：
```text
{text}
```
严格返回闭合纯 JSON：
{{
  "summary": "极度精炼定性结论",
  "extracted_values": [{{"field": "字段名", "exact_match_text": "原文值", "color": "red/orange/blue"}}],
  "text_advice": ["短句动作指令1"]
}}"""
    return chat_completion(messages=[{"role": "user", "content": user_message}], max_tokens=3000, temperature=0.1, system=system_prompt)


def parse_and_enrich_analysis(model_response: str, sop_config: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    try:
        result = extract_json_from_text(model_response)
    except ValueError:
        clean_text = re.sub(r"json\n?|\n?", "", model_response).strip()
        result = {
            "summary": f"⚠️ 截断兜底显示：{clean_text[:300]}...",
            "extracted_values": [],
            "text_advice": [],
            "action_links": [],
        }
        return result

    action_links = []
    if sop_config:
        value_dict = {str(v.get("field", "")): str(v.get("exact_match_text", "")) for v in result.get("extracted_values", [])}
        for skill in sop_config.get("skills", []):
            if skill.get("action_type") == "url_render":
                url = skill.get("template", "")
                for field, value in value_dict.items():
                    if value:
                        url = url.replace(f"{{{field}}}", value)
                if "{" not in url and url.startswith("http"):
                    action_links.append({"title": skill.get("skill_name", "动作链接"), "url": url})
        for legacy in sop_config.get("verified_urls", []):
            url = legacy.get("url_template", "")
            for field, value in value_dict.items():
                if value:
                    url = url.replace(f"{{{field}}}", value)
            if "{" not in url and url.startswith("http"):
                action_links.append({"title": legacy.get("title", "相关链接"), "url": url})
    result["action_links"] = action_links
    return result


# ============================================================================
# 可选模块集成
# ============================================================================
stats_module = None
browser_module = None
rag_module = None


def _init_modules() -> None:
    global stats_module, browser_module, rag_module
    try:
        from functools import partial
        from stats import get_stats_summary, reset_stats, track_request

        stats_module = type(
            "StatsModule",
            (),
            {
                "get_stats_summary": staticmethod(get_stats_summary),
                "reset_stats": staticmethod(partial(reset_stats, confirm=True)),
                "track_request": staticmethod(track_request),
            },
        )()
        print("[MODULE] Stats loaded")
    except Exception as exc:
        print(f"[MODULE] Stats unavailable: {exc}")

    try:
        import browser

        browser_module = browser if browser.is_available() else None
        print("[MODULE] Browser loaded" if browser_module else "[MODULE] Browser unavailable")
    except Exception as exc:
        print(f"[MODULE] Browser unavailable: {exc}")

    try:
        import rag

        rag.get_knowledge_base()
        rag_module = rag
        print("[MODULE] RAG loaded")
    except Exception as exc:
        err_msg = str(exc)
        print(f"[MODULE] RAG unavailable: {err_msg}")
        rag_module = type(
            "RAGStub",
            (),
            {
                "available": False,
                "error": err_msg,
                "add_knowledge": staticmethod(lambda *args, **kwargs: {"error": f"RAG not available: {err_msg}"}),
                "search_knowledge": staticmethod(lambda *args, **kwargs: []),
                "get_knowledge_stats": staticmethod(lambda *args, **kwargs: {"error": f"RAG not available: {err_msg}"}),
                "list_documents": staticmethod(lambda *args, **kwargs: []),
                "delete_document": staticmethod(lambda *args, **kwargs: {"error": f"RAG not available: {err_msg}"}),
            },
        )()


_init_modules()


# ============================================================================
# API
# ============================================================================
@app.route("/api/analyze", methods=["POST"])
def analyze():
    data = request.json or {}
    text = data.get("text", "").strip()
    images = data.get("images", []) or []
    if not text and not images:
        return jsonify({"error": "text and images cannot both be empty"}), 400

    started = datetime.now()
    try:
        sop_config, persona_config = smart_llm_router(text)
        system_prompt = assemble_system_prompt(sop_config, persona_config)
        model_response = call_model_analyze(text, images, system_prompt)
        result = parse_and_enrich_analysis(model_response, sop_config)
        result["matched_domain"] = sop_config.get("domain_name") if sop_config else "无 (专家自由研判)"
        result["matched_persona"] = persona_config.get("name")

        if stats_module:
            elapsed = int((datetime.now() - started).total_seconds() * 1000)
            stats_module.track_request(
                model_name=MODEL_PROVIDER,
                input_tokens=max(len(text) // 4, 1) if text else 0,
                output_tokens=max(len(json.dumps(result, ensure_ascii=False)) // 4, 1),
                sop_ids=[next((sid for sid, sop in load_sops().items() if sop is sop_config), "")] if sop_config else [],
                sop_names={},
                persona_name=persona_config.get("name"),
                persona_id=next((pid for pid, p in load_personas().items() if p.get("name") == persona_config.get("name")), None),
                response_time_ms=elapsed,
            )
        return jsonify(result), 200
    except Exception as exc:
        import traceback

        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.json or {}
    messages = data.get("messages", [])
    if not messages and data.get("message"):
        messages = [{"role": "user", "content": data.get("message")}]
    current_domain = data.get("current_domain", "未知领域")

    personas = load_personas()
    existing_roles = json.dumps({k: v.get("name") for k, v in personas.items()}, ensure_ascii=False)
    coaching_prompt = f"""你是一个高级 AI 系统架构师。用户正在教你处理告警规则或添加动作。

当前上下文：【{current_domain}】
现有角色库：{existing_roles}

【最高架构指令 1 - 角色冻结令】：
只有当领域发生巨大跨界时才允许新建角色。安全相关细分场景必须优先复用现有安全角色。

【最高架构指令 2 - 动作隔离引擎】：
如果用户教你生成某个查询链接，绝对不要写进文本规则里；必须将其转化为 skills 数组中的 url_render 动作。

请返回纯 JSON：
{{
  "thought_process": "简述思路",
  "reply": "你对用户的自然语言回复",
  "new_persona": {{"role_id": "role_xxx", "name": "中文名", "system_prompt": "..."}} 或 null,
  "sop_draft": {{
    "domain_name": "规则名",
    "role_id": "必须填写角色ID",
    "activation_condition": "一句话触发条件",
    "exact_match_signatures": ["2-4个英文/数字特征"],
    "extraction_tasks": [{{"field_name": "file_md5", "instruction": "提取说明"}}],
    "skills": [{{"skill_name": "查询链接", "action_type": "url_render", "template": "https://example.com/{{file_md5}}"}}]
  }} 或 null
}}"""

    try:
        raw = chat_completion(messages=messages, max_tokens=2500, temperature=0.1, system=coaching_prompt)
        parsed = extract_json_from_text(raw)
        reply = parsed.get("reply", "已更新系统认知。")
        new_persona = parsed.get("new_persona")
        sop_draft = parsed.get("sop_draft")
        response_data: Dict[str, Any] = {
            "reply": reply,
            "persona_created": False,
            "persona_name": "",
            "sop_created": False,
            "sop_domain": "",
            "is_update": False,
        }

        if isinstance(new_persona, dict) and new_persona.get("role_id"):
            role_id = new_persona["role_id"]
            if role_id not in personas:
                personas[role_id] = {
                    "name": new_persona.get("name", "新角色"),
                    "system_prompt": new_persona.get("system_prompt", ""),
                    "created_at": datetime.now().isoformat(),
                }
                save_personas(personas)
                response_data["persona_created"] = True
                response_data["persona_name"] = personas[role_id]["name"]

        if isinstance(sop_draft, dict) and sop_draft.get("domain_name"):
            sops = load_sops()
            domain_name = sop_draft["domain_name"]
            sop_id = f"sop_hash_{hash(domain_name)}"
            response_data["is_update"] = sop_id in sops
            sop_draft["created_at"] = datetime.now().isoformat()
            sops[sop_id] = sop_draft
            save_sops(sops)
            response_data["sop_created"] = True
            response_data["sop_domain"] = domain_name
            response_data["sop_config"] = sop_draft

        return jsonify(response_data), 200
    except Exception as exc:
        import traceback

        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


@app.route("/api/patterns/record", methods=["POST"])
def record_pattern():
    data = request.json or {}
    pattern_name = data.get("pattern_name") or data.get("action_title")
    trigger = data.get("trigger") or data.get("sop_id") or "manual_trigger"
    if not pattern_name:
        return jsonify({"error": "pattern_name or action_title required"}), 400

    sops = load_sops()
    sop_id = f"pattern_{re.sub(r'[^a-zA-Z0-9_]+', '_', pattern_name).strip('_').lower() or 'unnamed'}"
    sops[sop_id] = {
        "domain_name": pattern_name,
        "role_id": "role_base",
        "activation_condition": trigger,
        "exact_match_signatures": [trigger],
        "skills": [],
        "created_at": datetime.now().isoformat(),
    }
    save_sops(sops)
    return jsonify({"status": "ok", "sop_id": sop_id}), 200


@app.route("/api/stats", methods=["GET"])
def get_stats():
    if not stats_module:
        return jsonify({"error": "Stats module not available"}), 500
    days = request.args.get("days", 7, type=int)
    return jsonify(stats_module.get_stats_summary(days)), 200


@app.route("/api/stats/reset", methods=["POST"])
def reset_stats_api():
    if not stats_module:
        return jsonify({"error": "Stats module not available"}), 500
    return jsonify(stats_module.reset_stats()), 200


@app.route("/api/browser/create", methods=["POST"])
def browser_create():
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    data = request.json or {}
    result = browser_module.create_browser(data.get("browser_type", "chrome"), data.get("headless", True))
    if result.get("browser_id"):
        result["page_id"] = result["browser_id"]
    if result.get("status") == "success":
        result["success"] = True
    return jsonify(result), 200


@app.route("/api/browser/<browser_id>/close", methods=["POST"])
def browser_close(browser_id: str):
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    result = browser_module.close_browser(browser_id)
    if result.get("status") == "success":
        result["success"] = True
    return jsonify(result), 200


@app.route("/api/browser/<browser_id>/navigate", methods=["POST"])
def browser_navigate(browser_id: str):
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    url = (request.json or {}).get("url")
    if not url:
        return jsonify({"error": "url is required"}), 400
    result = browser_module.navigate(browser_id, url)
    if result.get("status") == "success":
        result["success"] = True
    return jsonify(result), 200


@app.route("/api/browser/<browser_id>/action", methods=["POST"])
def browser_action(browser_id: str):
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    data = request.json or {}
    action = data.get("action")
    if not action:
        return jsonify({"error": "action is required"}), 400
    result = browser_module.execute_action(browser_id, action, selector=data.get("selector"), value=data.get("value"), index=data.get("index", 0))
    if result.get("status") == "success":
        result["success"] = True
    return jsonify(result), 200


@app.route("/api/browser/<browser_id>/content", methods=["GET"])
def browser_content(browser_id: str):
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    return jsonify(browser_module.get_content(browser_id)), 200


@app.route("/api/browser/<browser_id>/info", methods=["GET"])
def browser_info(browser_id: str):
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    return jsonify(browser_module.get_info(browser_id)), 200


@app.route("/api/browser/operations", methods=["GET"])
def browser_operations_list():
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    return jsonify({"operations": browser_module.list_operations()}), 200


@app.route("/api/browser/operations", methods=["POST"])
def browser_operations_save():
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    data = request.json or {}
    name = data.get("name")
    if not name:
        return jsonify({"error": "name is required"}), 400
    return jsonify(browser_module.save_operations(name, data.get("steps", []))), 200


@app.route("/api/browser/<browser_id>/play", methods=["POST"])
def browser_operations_play(browser_id: str):
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    name = (request.json or {}).get("name")
    if not name:
        return jsonify({"error": "name is required"}), 400
    return jsonify(browser_module.play_operations(browser_id, name)), 200


@app.route("/api/rag/add", methods=["POST"])
def rag_add():
    if not rag_module:
        return jsonify({"error": "RAG module not available"}), 500
    data = request.json or {}
    source = data.get("source")
    if not source and data.get("text"):
        tmp_dir = MEMORY_DIR / "ad_hoc_docs"
        tmp_dir.mkdir(exist_ok=True)
        doc_path = tmp_dir / f"adhoc_{datetime.now().strftime('%Y%m%d%H%M%S%f')}.txt"
        doc_path.write_text(data["text"], encoding="utf-8")
        source = str(doc_path)
    if not source:
        return jsonify({"error": "source is required (file path / URL / text)"}), 400
    return jsonify(rag_module.add_knowledge(source, data.get("metadata", {}))), 200


@app.route("/api/rag/search", methods=["GET"])
def rag_search():
    if not rag_module:
        return jsonify({"error": "RAG module not available"}), 500
    query = request.args.get("q", "")
    if not query:
        return jsonify({"error": "query parameter 'q' is required"}), 400
    results = rag_module.search_knowledge(query, request.args.get("top_k", 5, type=int))
    return jsonify({"query": query, "results": results}), 200


@app.route("/api/rag/stats", methods=["GET"])
def rag_stats():
    if not rag_module:
        return jsonify({"error": "RAG module not available"}), 500
    return jsonify(rag_module.get_knowledge_stats()), 200


@app.route("/api/rag/documents", methods=["GET"])
def rag_documents():
    if not rag_module:
        return jsonify({"error": "RAG module not available"}), 500
    return jsonify({"documents": rag_module.list_documents()}), 200


@app.route("/api/rag/documents/<doc_id>", methods=["DELETE"])
def rag_delete(doc_id: str):
    if not rag_module:
        return jsonify({"error": "RAG module not available"}), 500
    return jsonify(rag_module.delete_document(doc_id)), 200


@app.route("/health", methods=["GET"])
def health():
    rag_available = bool(rag_module and getattr(rag_module, "available", True) is not False and not getattr(rag_module, "error", None))
    return jsonify(
        {
            "status": "ok",
            "timestamp": datetime.now().isoformat(),
            "storage": "json",
            "model_provider": MODEL_PROVIDER,
            "modules": {
                "stats": stats_module is not None,
                "browser": browser_module is not None,
                "rag": rag_available,
            },
        }
    ), 200


if __name__ == "__main__":
    print("=" * 60)
    print("OmniAgent Server (main-baseline refactor)")
    print("=" * 60)
    print(f"Stats module: {'✓' if stats_module else '✗'}")
    print(f"Browser module: {'✓' if browser_module else '✗'}")
    print(f"RAG module: {'✓' if rag_module and getattr(rag_module, 'available', True) is not False else '✗'}")
    print("=" * 60)
    app.run(host="127.0.0.1", port=5000, debug=False)
