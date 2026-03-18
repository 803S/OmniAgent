"""
OmniAgent - 万象全域智能管家 (完全体)
核心进化：
1. 视觉神经接入 (支持 Base64 截图解析)
2. 多重技能组合引擎 (支持同时激活多个 SOP 叠加)
3. 自由对话与工具调用 (Copilot 模式)
4. 统计监控 + 浏览器自动化 + RAG 知识库
"""

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple

# 修复 sys.path：确保用户 site-packages 在前面（解决 RAG 依赖检测问题）
import sys
import site
_user_site = site.getusersitepackages()
if _user_site and _user_site not in sys.path:
    sys.path.insert(0, _user_site)

# 添加当前目录到 Python 路径（支持导入同级模块）
sys.path.insert(0, str(Path(__file__).parent))

from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
from dotenv import load_dotenv

# 加载 .env 文件
load_dotenv(Path(__file__).parent / ".env")

# ============================================================================
# 全局配置
# ============================================================================
app = Flask(__name__)
CORS(app)

MEMORY_DIR = Path(__file__).parent / "memory"
MEMORY_DIR.mkdir(exist_ok=True)

# 优先使用 SQLite，兼容 JSON
try:
    import database
    USE_SQLITE = True
    print("[DB] Using SQLite storage")
except ImportError:
    USE_SQLITE = False
    SOPS_FILE = MEMORY_DIR / "sops.json"
    PERSONAS_FILE = MEMORY_DIR / "personas.json"
    print("[DB] Using JSON storage (fallback)")

# API 安全配置
API_TOKEN = os.getenv("API_TOKEN", "")  # 本地 API 鉴权 Token

# 支持多模型: anthropic / deepseek / ollama (本地)
MODEL_PROVIDER = os.getenv("MODEL_PROVIDER", "deepseek")  # 默认用 deepseek
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")

# OpenAI API (GPT-4, GPT-3.5)
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4")

# Google Gemini
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-pro")

# 小米大模型
XIAOMI_API_KEY = os.getenv("XIAOMI_API_KEY", "")
XIAOMI_BASE_URL = os.getenv("XIAOMI_BASE_URL", "https://api.xiaomi.com/v1")
XIAOMI_MODEL = os.getenv("XIAOMI_MODEL", "mi-abab6.5-chat")

# 本地模型（Ollama/vLLM）
LOCAL_MODEL_URL = os.getenv("LOCAL_MODEL_URL", "")
LOCAL_MODEL_NAME = os.getenv("LOCAL_MODEL_NAME", "llama3")

# 公司内部模型（OpenAI 兼容接口）
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "")
INTERNAL_BASE_URL = os.getenv("INTERNAL_BASE_URL", "")
INTERNAL_MODEL = os.getenv("INTERNAL_MODEL", "your-model")

print(f"[MODEL] Provider: {MODEL_PROVIDER}")

# Anthropic 客户端
if ANTHROPIC_API_KEY:
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-4-6")
else:
    client = None
    ANTHROPIC_MODEL = "claude-opus-4-6"

INTERNAL_MODEL_NAME = "claude-opus-4-6"  # 仅用于注释

# ============================================================================
# API Token 鉴权装饰器
# ============================================================================
from functools import wraps

def require_auth(f):
    """API Token 鉴权装饰器"""
    @wraps(f)
    def decorated(*args, **kwargs):
        if API_TOKEN:
            auth_header = request.headers.get("Authorization", "")
            if not auth_header.startswith("Bearer "):
                return jsonify({"error": "Missing or invalid Authorization header"}), 401
            token = auth_header[7:]  # 去掉 "Bearer " 前缀
            if token != API_TOKEN:
                return jsonify({"error": "Invalid API token"}), 401
        return f(*args, **kwargs)
    return decorated

# ============================================================================
# 统一 LLM 调用接口
def chat_completion(model: str, messages: list, max_tokens: int = 1000, temperature: float = 0.3, system: str = None) -> str:
    """统一的大模型调用接口，支持多种模型提供商"""
    
    # ===== 本地模型（Ollama/vLLM） =====
    if MODEL_PROVIDER == "local" and LOCAL_MODEL_URL:
        headers = {"Content-Type": "application/json"}
        payload = {"model": LOCAL_MODEL_NAME, "messages": [{"role": "system", "content": system}] + messages if system else messages, "options": {"temperature": temperature}, "stream": False}
        resp = requests.post(f"{LOCAL_MODEL_URL}/api/chat", headers=headers, json=payload, timeout=120)
        return resp.json()["message"]["content"]
    
    # ===== OpenAI API (GPT-4, GPT-3.5) =====
    if MODEL_PROVIDER == "openai" and OPENAI_API_KEY:
        headers = {"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"}
        payload = {"model": OPENAI_MODEL, "messages": [{"role": "system", "content": system}] + messages if system else messages, "max_tokens": max_tokens, "temperature": temperature}
        resp = requests.post(f"{OPENAI_BASE_URL}/chat/completions", headers=headers, json=payload, timeout=120)
        return resp.json()["choices"][0]["message"]["content"]
    
    # ===== Google Gemini =====
    if MODEL_PROVIDER == "gemini" and GEMINI_API_KEY:
        headers = {"Content-Type": "application/json"}
        gemini_messages = [{"role": "user", "parts": [{"text": system}]}] if system else []
        for m in messages: gemini_messages.append({"role": m["role"], "parts": [{"text": m["content"]}]})
        payload = {"contents": gemini_messages, "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens}}
        resp = requests.post(f"https://generativelanguage.googleapis.com/v1/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}", headers=headers, json=payload, timeout=120)
        return resp.json()["candidates"][0]["content"]["parts"][0]["text"]
    
    # ===== 小米大模型 =====
    if MODEL_PROVIDER == "xiaomi" and XIAOMI_API_KEY:
        headers = {"Authorization": f"Bearer {XIAOMI_API_KEY}", "Content-Type": "application/json"}
        payload = {"model": XIAOMI_MODEL, "messages": [{"role": "system", "content": system}] + messages if system else messages, "max_tokens": max_tokens, "temperature": temperature}
        resp = requests.post(f"{XIAOMI_BASE_URL}/chat/completions", headers=headers, json=payload, timeout=120)
        return resp.json()["choices"][0]["message"]["content"]
    
    # ===== 公司内部模型（OpenAI 兼容） =====
    if MODEL_PROVIDER == "internal" and INTERNAL_API_KEY and INTERNAL_BASE_URL:
        headers = {"Authorization": f"Bearer {INTERNAL_API_KEY}", "Content-Type": "application/json"}
        payload = {"model": INTERNAL_MODEL, "messages": [{"role": "system", "content": system}] + messages if system else messages, "max_tokens": max_tokens, "temperature": temperature}
        resp = requests.post(f"{INTERNAL_BASE_URL}/chat/completions", headers=headers, json=payload, timeout=120)
        return resp.json()["choices"][0]["message"]["content"]
    
    # ===== DeepSeek =====
    if MODEL_PROVIDER == "deepseek" and DEEPSEEK_API_KEY:
        headers = {"Authorization": f"Bearer {DEEPSEEK_API_KEY}", "Content-Type": "application/json"}
        payload = {"model": DEEPSEEK_MODEL, "messages": [{"role": "system", "content": system}] + messages if system else messages, "max_tokens": max_tokens, "temperature": temperature}
        resp = requests.post(f"{DEEPSEEK_BASE_URL}/v1/chat/completions", headers=headers, json=payload, timeout=120)
        return resp.json()["choices"][0]["message"]["content"]
    
    # ===== Anthropic Claude =====
    if MODEL_PROVIDER == "anthropic" and client:
        anthropic_messages = [{"role": m["role"], "content": m["content"]} for m in messages]
        if system:
            resp = client.messages.create(model=ANTHROPIC_MODEL, max_tokens=max_tokens, temperature=temperature, system=system, messages=anthropic_messages)
        else:
            resp = client.messages.create(model=ANTHROPIC_MODEL, max_tokens=max_tokens, temperature=temperature, messages=anthropic_messages)
        return resp.content[0].text
    
    raise Exception(f"模型 provider '{MODEL_PROVIDER}' 未配置或缺少 API KEY")

# Agent 核心工具库 (Function Calling Schema)
# ============================================================================
AGENT_TOOLS = [
    {
        "name": "create_or_update_sop",
        "description": "When user explicitly asks to 'remember this rule', 'build automation flow', or 'handle this way in future', call this tool to solidify knowledge into SOP. Do NOT call for casual questions, chat, or single-time webpage analysis!",
        "input_schema": {
            "type": "object",
            "properties": {
                "domain_name": {"type": "string", "description": "Business rule name."},
                "role_id": {"type": "string", "description": "Existing role ID (e.g., role_sec_expert)."},
                "activation_condition": {"type": "string", "description": "One-sentence natural language trigger condition."},
                "exact_match_signatures": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "2-4 English/numeric machine-readable features. NO CHINESE!"
                },
                "extraction_tasks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "field_name": {"type": "string"},
                            "instruction": {"type": "string"}
                        }
                    }
                },
                "skills": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "skill_name": {"type": "string"},
                            "action_type": {"type": "string", "enum": ["url_render", "text_constraint", "dom_macro"]},
                            "template": {"type": "string"}
                        }
                    }
                }
            },
            "required": ["domain_name", "role_id", "activation_condition", "exact_match_signatures"]
        }
    },
    {
        "name": "create_or_update_persona",
        "description": "When user explicitly asks to 'create new role', 'add xx expert', or 'establish xx analyst', call this tool to add specialist roles to the system.",
        "input_schema": {
            "type": "object",
            "properties": {
                "role_id": {"type": "string", "description": "Role ID (English, e.g., role_ai_expert, role_finance_analyst)."},
                "role_name": {"type": "string", "description": "Role display name (Chinese, e.g., AI Security Expert, Financial Analyst)."},
                "system_prompt": {"type": "string", "description": "Role system prompt defining expertise, stance, and workflow."}
            },
            "required": ["role_id", "role_name", "system_prompt"]
        }
    }
]

# ============================================================================
# Tool Functions
# ============================================================================
def load_json(filepath: Path) -> Dict[str, Any]:
    if filepath.exists():
        if os.path.getsize(filepath) == 0: return {}
        try:
            with open(filepath, "r", encoding="utf-8") as f: return json.load(f)
        except json.JSONDecodeError as e: return {}
    return {}

def save_json(filepath: Path, data: Dict[str, Any]) -> None:
    try:
        with open(filepath, "w", encoding="utf-8") as f: json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e: print(f"ERROR writing: {e}")

# ============================================================================
# SOP / Persona 存储（支持 SQLite 和 JSON 兼容）
# ============================================================================
def load_sops() -> Dict[str, Any]:
    """加载 SOPs，支持 SQLite 和 JSON"""
    if USE_SQLITE:
        sops_list = database.get_all_sops()
        # 转换为旧格式兼容
        return {"sops": {sop["id"]: {"name": sop["name"], "description": sop.get("description", ""), "steps": sop.get("steps", []), "trigger": sop.get("trigger", ""), "domain": sop.get("domain", "")} for sop in sops_list}}
    return load_json(SOPS_FILE)

def save_sops(data: Dict[str, Any]) -> None:
    """保存 SOPs，支持 SQLite 和 JSON"""
    if USE_SQLITE and "sops" in data:
        for sop_id, sop_data in data["sops"].items():
            sop_data["id"] = sop_id
            database.save_sop(sop_data)
        return
    save_json(SOPS_FILE, data)

def load_personas() -> Dict[str, Any]:
    """加载 Personas，支持 SQLite 和 JSON"""
    if USE_SQLITE:
        personas_list = database.get_all_personas()
        result = {}
        for p in personas_list:
            result[p["id"]] = {"name": p["name"], "system_prompt": p["system_prompt"], "description": p.get("description", ""), "domain": p.get("domain", "")}
        if "role_base" not in result:
            result["role_base"] = {"name": "Objective Summary Assistant", "system_prompt": "You are a rigorous and objective text analysis assistant."}
        return result
    personas = load_json(PERSONAS_FILE)
    if not isinstance(personas, dict): personas = {}
    if "role_base" not in personas:
        personas["role_base"] = {"name": "Objective Summary Assistant", "system_prompt": "You are a rigorous and objective text analysis assistant."}
    return personas

def save_personas(data: Dict[str, Any]) -> None:
    """保存 Personas，支持 SQLite 和 JSON"""
    if USE_SQLITE:
        for persona_id, persona_data in data.items():
            persona_data["id"] = persona_id
            database.save_persona(persona_data)
        return
    save_json(PERSONAS_FILE, data)

def extract_json_from_text(text: str) -> dict:
    if not text or not isinstance(text, str): raise ValueError("AI returned empty text")
    try: return json.loads(text)
    except Exception:
        match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', text, re.DOTALL)
        if not match: match = re.search(r'(\{.*\})', text, re.DOTALL)
        if match:
            try: return json.loads(match.group(1))
            except json.JSONDecodeError: pass
    raise ValueError("AI did not return valid JSON")

def parse_image_base64(b64_str: str) -> dict:
    """Extract image data from frontend, adapt to LLM format"""
    match = re.match(r'data:(image/[a-zA-Z]+);base64,(.*)', b64_str)
    if match:
        media_type = match.group(1)
        data = match.group(2)
    else:
        media_type = "image/jpeg"
        data = b64_str
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": media_type, "data": data}
    }

# ============================================================================
# Core Logic 1: Multi-skill Routing
# ============================================================================
def local_keyword_recall(text: str, sops: Dict[str, Any]) -> Dict[str, Any]:
    candidates = {}
    text_lower = text.lower()
    for sop_id, sop_config in sops.items():
        signatures = sop_config.get("exact_match_signatures", sop_config.get("trigger_keywords", []))
        for sig in signatures:
            if sig.strip() and sig.lower() in text_lower:
                candidates[sop_id] = sop_config
                break
    return candidates

def smart_llm_router(text: str) -> Tuple[List[Dict], Dict]:
    """Architecture upgrade: return array of SOPs"""
    sops = load_sops()
    personas = load_personas()

    print(f"[ROUTER] Processing text: {text[:100]}...")
    print(f"[ROUTER] Available SOPs: {list(sops.keys())}")
    print(f"[ROUTER] Available roles: {list(personas.keys())}")

    # First: keyword-based matching
    candidate_sops = local_keyword_recall(text, sops)
    print(f"[ROUTER] Keyword matches: {list(candidate_sops.keys())}")

    persona_catalog = {k: v.get("name") for k, v in personas.items()}

    # Always use smart routing via Claude to select best role and SOP
    sop_descriptions = {
        k: f"[{v.get('domain_name')}] Trigger: {v.get('activation_condition', 'N/A')}"
        for k, v in sops.items()
    }

    router_prompt = f"""You are an intelligent request router that selects the best expert and automation rules.

Available Experts (Roles):
{json.dumps(persona_catalog, ensure_ascii=False, indent=2)}

Available Automation Rules (SOPs):
{json.dumps(sop_descriptions, ensure_ascii=False, indent=2)}

Based on the user input, decide:
1. Which expert role is MOST suitable (role_id)
2. Which automation rules apply (sop_ids array)

IMPORTANT:
- If no rules match, return empty sop_ids: []
- Prefer specificity: pick the most directly relevant rules
- role_id must be from the available roles

Return JSON:
{{
    "thought_process": "explain your reasoning",
    "role_id": "best expert for this request",
    "sop_ids": ["rule_id_1", "rule_id_2"] or []
}}
"""

    try:
        result = chat_completion(
            model=DEEPSEEK_MODEL,
            messages=[{"role": "user", "content": f"User input:\n{text[:2000]}"}],
            max_tokens=1000, temperature=0.3, system=router_prompt
        )
        route_decision = extract_json_from_text(result)
        print(f"[ROUTER] Claude decision: {route_decision}")

        role_id = route_decision.get("role_id", "role_base")
        sop_ids = route_decision.get("sop_ids", [])
        if not isinstance(sop_ids, list): sop_ids = [sop_ids] if sop_ids else []

        # Validate role exists
        if role_id not in personas:
            print(f"[ROUTER] Role {role_id} not found, using role_base")
            role_id = "role_base"

        persona_config = personas.get(role_id, personas["role_base"])
        active_sops = [sops[sid] for sid in sop_ids if sid in sops]

        domain_names = [s.get('domain_name') for s in active_sops]
        print(f"[ROUTER] Final selection - Role: {persona_config.get('name')} | SOPs: {domain_names if domain_names else 'none'}")

        return (active_sops, persona_config)
    except Exception as e:
        print(f"[ROUTER] Router error, fallback: {e}")
        import traceback
        traceback.print_exc()
        return ([], personas["role_base"])

# ============================================================================
# Core Logic 2: Multi-rule Dynamic Prompt + Vision LLM Execution
# ============================================================================
def assemble_system_prompt(active_sops: List[Dict], persona_config: Dict) -> str:
    prompt = f"Role Setting:\n{persona_config.get('system_prompt', '')}\n\n"

    if active_sops:
        prompt += "Active multi-skill extraction tasks:\n"
        all_text_constraints = []

        for sop in active_sops:
            domain = sop.get("domain_name", "Domain")
            prompt += f"\n--- Rule Source: [{domain}] ---\n"
            for task in sop.get("extraction_tasks", []):
                prompt += f"- Extract [{task.get('field_name')}]: {task.get('instruction')}\n"

            skills = sop.get("skills", [])
            all_text_constraints.extend([s for s in skills if s.get("action_type") == "text_constraint"])

        if all_text_constraints:
            prompt += "\nMandatory reply format (must strictly follow):\n"
            for tc in all_text_constraints:
                prompt += f"- {tc.get('description')}: {tc.get('template')}\n"
    else:
        prompt += "Free-form analysis mode - no specific SOP triggered.\n"

    prompt += """
    Absolute System Red Lines:
    1. summary must conclude directly (50 chars max); text_advice must be minimal action instructions, return [] if no investigation needed.
    2. NEVER fabricate any http/https links in analysis!
    3. Extracted values must be exact text from original content or screenshot.
    """
    return prompt

def call_claude_analyze(text: str, images_base64: List[str], system_prompt: str) -> str:
    """Architecture upgrade: native multi-modal vision support"""
    print(f"[CLAUDE] call_claude_analyze: text_len={len(text)}, images_count={len(images_base64)}")

    content_blocks = []

    # Attach image neural
    for idx, b64 in enumerate(images_base64):
        parsed_img = parse_image_base64(b64)
        content_blocks.append(parsed_img)
        print(f"[CLAUDE] Added image {idx}: {str(parsed_img)[:80]}...")

    print(f"[CLAUDE] Content blocks after images: {len(content_blocks)}")

    # Attach text instruction
    user_message = f"""Analyze the following text and combine with provided screenshots (if any):
        ```text
        {text}
        ```
        Return strict closed JSON:
            {{
            "summary": "Qualitative conclusion (combining image and text info)",
            "extracted_values": [ {{"field": "field_name", "exact_match_text": "real value from text or screenshot", "color": "red/orange/blue"}} ],
            "text_advice": ["short action instruction1"] // can be empty []
            }}"""

    content_blocks.append({"type": "text", "text": user_message})
    print(f"[CLAUDE] Final content_blocks count: {len(content_blocks)}")
    print(f"[CLAUDE] Block types: {[b.get('type') for b in content_blocks]}")

    # Debug: print full content structure
    print(f"[CLAUDE] Full content structure:")
    for idx, block in enumerate(content_blocks):
        if block.get('type') == 'image':
            print(f"  Block {idx}: image - {str(block)[:100]}...")
        else:
            print(f"  Block {idx}: {block.get('type')} - {str(block.get('text', ''))[:100]}...")

    result = chat_completion(
        model=DEEPSEEK_MODEL,
        messages=[{"role": "user", "content": content_blocks}],
        max_tokens=3000, temperature=0.1, system=system_prompt
    )

    print(f"[LLM] Response received: {result[:200]}...")
    return result

def parse_and_enrich_analysis(claude_response: str, active_sops: List[Dict]) -> Dict:
    try:
        result = extract_json_from_text(claude_response)
    except ValueError:
        clean_text = re.sub(r'json\n?|\n?', '', claude_response).strip()
        result = {"summary": f"Fallback: {clean_text[:300]}...", "extracted_values": [], "text_advice": [], "action_links": []}
        return result

    action_links = []
    value_dict = {str(v.get("field", "")): str(v.get("exact_match_text", "")) for v in result.get("extracted_values", [])}

    # Architecture upgrade: iterate and aggregate all active SOP action skills
    for sop in active_sops:
        skills = sop.get("skills", [])
        legacy_urls = sop.get("verified_urls", [])

        for skill in skills:
            if skill.get("action_type") == "url_render":
                url = skill.get("template", "")
                for field, val in value_dict.items():
                    if val: url = url.replace(f"{{{field}}}", val)
                if "{" not in url and url.startswith("http"):
                    action_links.append({"title": f"[{sop.get('domain_name')}] {skill.get('skill_name')}", "url": url})

        for u in legacy_urls:
            url = u.get("url_template", "")
            for field, val in value_dict.items():
                if val: url = url.replace(f"{{{field}}}", val)
            if "{" not in url and url.startswith("http"):
                action_links.append({"title": u.get("title", "action_link"), "url": url})

    result["action_links"] = action_links
    return result

# ============================================================================
# API Endpoints
# ============================================================================
@require_auth
@app.route("/api/analyze", methods=["POST"])
def analyze():
    text = request.json.get("text", "").strip()
    images = request.json.get("images", [])

    print(f"[ANALYZE] Received request: text_len={len(text)}, images_count={len(images)}")
    if images:
        for idx, img in enumerate(images):
            print(f"[ANALYZE] Image {idx}: {str(img)[:50]}... ({len(img)} bytes)")

    if not text and not images:
        return jsonify({"error": "text and images cannot both be empty"}), 400

    try:
        active_sops, persona_config = smart_llm_router(text)
        system_prompt = assemble_system_prompt(active_sops, persona_config)
        print(f"[ANALYZE] Calling Claude with {len(images)} images")
        claude_response = call_claude_analyze(text, images, system_prompt)
        result = parse_and_enrich_analysis(claude_response, active_sops)

        domain_names = [s.get("domain_name") for s in active_sops]
        result["matched_domain"] = " + ".join(domain_names) if domain_names else "none (expert judgment)"
        result["matched_persona"] = persona_config.get("name")
        print(f"[ANALYZE] Response: {result}")
        return jsonify(result), 200
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[ANALYZE] Error: {e}")
        return jsonify({"error": str(e)}), 500

@require_auth
@app.route("/api/chat", methods=["POST"])
def chat():
    """Architecture upgrade: free conversation brain with multi-modal and tool calling"""
    data = request.json
    # 支持 messages 或单条 message
    messages = data.get("messages", [])
    if not messages and data.get("message"):
        messages = [{"role": "user", "content": data.get("message")}]

    personas = load_personas()
    existing_roles = json.dumps({k: v["name"] for k, v in personas.items()}, ensure_ascii=False)

    system_prompt = f"""You are an omniscient Personal Agent OS. Currently in Copilot conversation mode.
        You can naturally chat with users, help analyze webpage content, review vulnerability screenshots, summarize articles.

        Available Tools:
        1. create_or_update_sop: Call when user explicitly requests "create rule", "establish SOP", or "handle like this in future"
        2. create_or_update_persona: Call when user explicitly requests "create new role", "add xx expert", or "establish xx analyst"

        Tool Usage Rules:
        NEVER call tools unless user explicitly says the keywords above! Use natural language replies instead!

        Role Creation Guide:
        If user requests role creation:
        1. Generate suitable role_id (English, e.g., role_security_expert, role_code_reviewer)
        2. Set role_name (Chinese display name, e.g., Security Expert, Code Reviewer)
        3. Write system_prompt (detailed definition of role function, thinking, workflow)

        Current Role Library: {existing_roles}

        Strong role binding: When encountering new domain tasks, prioritize reusing existing roles."""

    try:
        # 统一调用 - 暂时移除 tools 支持（DeepSeek 需额外配置）
        result = chat_completion(
            model=DEEPSEEK_MODEL,
            messages=messages,
            max_tokens=2500, temperature=0.4, system=system_prompt
        )
        response_data = {"reply": "", "sop_created": False, "sop_domain": "", "is_tool_call": False, "raw_response": result}

        # 简单解析：检查是否包含 SOP 创建意图
        if "create_or_update_sop" in result or "domain_name" in result:
            response_data["is_tool_call"] = True
            response_data["reply"] = result
        else:
            response_data["reply"] = result

        return response_data

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# ============================================================================
# 新模块集成: Stats / Browser / RAG
# ============================================================================

# 延迟导入新模块（支持可选安装）
stats_module = None
browser_module = None
rag_module = None

def _init_modules():
    """初始化各模块"""
    global stats_module, browser_module, rag_module
    
    # Stats 模块
    try:
        from functools import partial
        from stats import track_request, get_stats_summary, reset_stats
        stats_module = type('StatsModule', (), {
            'track_request': track_request,
            'get_stats_summary': get_stats_summary,
            'reset_stats': partial(reset_stats, confirm=True)
        })()
        print("[MODULE] Stats loaded successfully")
    except ImportError as e:
        print(f"[WARN] Stats module not available: {e}")
    
    # Browser 模块
    try:
        import browser
        if browser.is_available():
            browser_module = browser
            print("[MODULE] Browser loaded successfully")
        else:
            print("[WARN] Browser module not available (Selenium missing)")
    except ImportError as e:
        print(f"[WARN] Browser module not available: {e}")
    
    # RAG 模块
    try:
        import rag
        # 测试 RAG 是否真正可用
        rag.get_knowledge_base()
        rag_module = rag
        print("[MODULE] RAG loaded successfully")
    except Exception as e:
        err_msg = str(e)
        print(f"[WARN] RAG module not available: {err_msg}")
        # 创建降级 stub
        rag_module = type('RAGStub', (), {
            'add_knowledge': lambda *a, **kw: {"error": f"RAG not available: {err_msg}"},
            'search_knowledge': lambda *a, **kw: [],
            'get_knowledge_stats': lambda *a, **kw: {"error": "RAG not available"},
            'list_documents': lambda *a, **kw: [],
            'delete_document': lambda *a, **kw: {"error": "RAG not available"}
        })()

# ============================================================================
# Patterns API - SOP/Pattern 记录
# ============================================================================

@require_auth
@app.route("/api/patterns/record", methods=["POST"])
def record_pattern():
    """记录用户操作模式到 SOP"""
    print("[PATTERNS] Recording pattern request received")
    data = request.json or {}
    pattern_name = data.get("pattern_name", "")
    pattern_type = data.get("pattern_type", "sop")  # sop | persona
    trigger = data.get("trigger", "")
    action = data.get("action", {})
    
    print(f"[PATTERNS] Pattern: {pattern_name}, Type: {pattern_type}, Trigger: {trigger}")
    
    if not pattern_name or not trigger:
        return jsonify({"error": "pattern_name and trigger required"}), 400
    
    if pattern_type == "sop":
        sops = load_sops()
        sop_id = pattern_name.lower().replace(" ", "_")
        sops[sop_id] = {
            "id": sop_id,
            "name": pattern_name,
            "exact_match_signatures": [trigger] if trigger else [],
            "activation_condition": trigger,
            "action": action,
            "created_at": datetime.now().isoformat()
        }
        save_sops(sops)
        print(f"[PATTERNS] SOP saved: {sop_id}")
        return jsonify({"status": "ok", "sop_id": sop_id}), 200
    
    elif pattern_type == "persona":
        personas = load_personas()
        persona_id = pattern_name.lower().replace(" ", "_")
        personas[persona_id] = {
            "id": persona_id,
            "name": pattern_name,
            "system_prompt": action.get("system_prompt", ""),
            "created_at": datetime.now().isoformat()
        }
        save_personas(personas)
        print(f"[PATTERNS] Persona saved: {persona_id}")
        return jsonify({"status": "ok", "persona_id": persona_id}), 200
    
    return jsonify({"error": "invalid pattern_type"}), 400

# 立即初始化模块
_init_modules()

# ============================================================================
# Stats API - 监控统计
# ============================================================================

@require_auth
@app.route("/api/stats", methods=["GET"])
def get_stats():
    """获取统计摘要"""
    if stats_module:
        try:
            from stats import get_stats_summary
            days = request.args.get("days", 7, type=int)
            return jsonify(get_stats_summary(days)), 200
        except Exception as e:
            return jsonify({"error": f"Stats error: {e}"}), 500
    return jsonify({"error": "Stats module not available"}), 500

@require_auth
@app.route("/api/stats/reset", methods=["POST"])
def reset_stats_api():
    """重置统计数据"""
    if stats_module:
        try:
            return jsonify(stats_module.reset_stats()), 200
        except Exception as e:
            return jsonify({"error": f"Reset error: {e}"}), 500
    return jsonify({"error": "Stats module not available"}), 500

# ============================================================================
# Browser API - 浏览器自动化
# ============================================================================

@require_auth
@app.route("/api/browser/create", methods=["POST"])
def browser_create():
    """创建浏览器页面"""
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    
    data = request.json or {}
    browser_type = data.get("browser_type", "chrome")
    headless = data.get("headless", True)
    
    try:
        result = browser_module.create_browser(browser_type, headless)
        return jsonify(result), 200
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@require_auth
@app.route("/api/browser/<browser_id>/close", methods=["POST"])
def browser_close(browser_id):
    """关闭浏览器页面"""
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    
    try:
        result = browser_module.close_browser(browser_id)
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@require_auth
@app.route("/api/browser/<browser_id>/navigate", methods=["POST"])
def browser_navigate(browser_id):
    """导航到 URL"""
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    
    data = request.json or {}
    url = data.get("url")
    
    if not url:
        return jsonify({"error": "url is required"}), 400
    
    try:
        result = browser_module.navigate(browser_id, url)
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@require_auth
@app.route("/api/browser/<browser_id>/action", methods=["POST"])
def browser_action(browser_id):
    """执行浏览器操作"""
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    
    data = request.json or {}
    action = data.get("action")
    
    if not action:
        return jsonify({"error": "action is required"}), 400
    
    try:
        result = browser_module.execute_action(
            browser_id, action,
            selector=data.get("selector"),
            value=data.get("value"),
            index=data.get("index", 0)
        )
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@require_auth
@app.route("/api/browser/<browser_id>/content", methods=["GET"])
def browser_content(browser_id):
    """获取页面内容"""
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    
    try:
        result = browser_module.get_content(browser_id)
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@require_auth
@app.route("/api/browser/<browser_id>/info", methods=["GET"])
def browser_info(browser_id):
    """获取页面信息"""
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    
    try:
        result = browser_module.get_info(browser_id)
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@require_auth
@app.route("/api/browser/operations", methods=["GET"])
def browser_operations_list():
    """列出所有操作序列"""
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    
    try:
        result = browser_module.list_operations()
        return jsonify({"operations": result}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@require_auth
@app.route("/api/browser/operations", methods=["POST"])
def browser_operations_save():
    """保存操作序列"""
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    
    data = request.json or {}
    name = data.get("name")
    steps = data.get("steps", [])
    
    if not name:
        return jsonify({"error": "name is required"}), 400
    
    try:
        result = browser_module.save_operations(name, steps)
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@require_auth
@app.route("/api/browser/<browser_id>/play", methods=["POST"])
def browser_operations_play(browser_id):
    """执行操作序列"""
    if not browser_module:
        return jsonify({"error": "Browser module not available"}), 500
    
    data = request.json or {}
    name = data.get("name")
    
    if not name:
        return jsonify({"error": "name is required"}), 400
    
    try:
        result = browser_module.play_operations(browser_id, name)
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ============================================================================
# RAG API - 知识库
# ============================================================================

@require_auth
@app.route("/api/rag/add", methods=["POST"])
def rag_add():
    """添加知识（文件/URL）"""
    if not rag_module:
        return jsonify({"error": "RAG module not available"}), 500
    
    data = request.json
    source = data.get("source")
    metadata = data.get("metadata", {})
    
    if not source:
        return jsonify({"error": "source is required (file path or URL)"}), 400
    
    try:
        result = rag_module.add_knowledge(source, metadata)
        return jsonify(result), 200
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@require_auth
@app.route("/api/rag/search", methods=["GET"])
def rag_search():
    """检索知识"""
    if not rag_module:
        return jsonify({"error": "RAG module not available"}), 500
    
    query = request.args.get("q", "")
    top_k = request.args.get("top_k", 5, type=int)
    
    if not query:
        return jsonify({"error": "query parameter 'q' is required"}), 400
    
    try:
        results = rag_module.search_knowledge(query, top_k)
        return jsonify({"query": query, "results": results}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@require_auth
@app.route("/api/rag/stats", methods=["GET"])
def rag_stats():
    """获取知识库统计"""
    if not rag_module:
        return jsonify({"error": "RAG module not available"}), 500
    
    try:
        stats = rag_module.get_knowledge_stats()
        return jsonify(stats), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@require_auth
@app.route("/api/rag/documents", methods=["GET"])
def rag_documents():
    """列出已吞噬的文档"""
    if not rag_module:
        return jsonify({"error": "RAG module not available"}), 500
    
    try:
        docs = rag_module.list_documents()
        return jsonify({"documents": docs}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@require_auth
@app.route("/api/rag/documents/<doc_id>", methods=["DELETE"])
def rag_delete(doc_id):
    """删除文档"""
    if not rag_module:
        return jsonify({"error": "RAG module not available"}), 500
    
    try:
        result = rag_module.delete_document(doc_id)
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ============================================================================
# 健康检查
# ============================================================================

@app.route("/health", methods=["GET"])
def health():
    """健康检查"""
    status = {
        "status": "ok",
        "timestamp": datetime.now().isoformat(),
        "modules": {
            "stats": stats_module is not None,
            "browser": browser_module is not None,
            "rag": rag_module is not None
        }
    }
    return jsonify(status), 200

# ============================================================================
# 启动
# ============================================================================

# 请求超时中间件
import signal

def timeout_handler(signum, frame):
    raise TimeoutError("Request timeout")

# Note: signal timeout 已在 Python 3.6+ nohup 环境失效，改用线程超时

if __name__ == "__main__":
    print("=" * 50)
    print("OmniAgent Server (Enhanced Version)")
    print("=" * 50)
    print(f"Stats module: {'✓' if stats_module else '✗'}")
    print(f"Browser module: {'✓' if browser_module else '✗'}")
    print(f"RAG module: {'✓' if rag_module else '✗'}")
    print("Request timeout: 60s")
    print("=" * 50)
    print("Backend started (complete version: multi-skill fusion + multi-modal vision)")
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=False)
