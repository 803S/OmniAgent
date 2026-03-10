"""
OmniAgent - 混合路由架构 (Local Recall + LLM Rerank)
核心设计：SOP 内嵌 Skills 引擎、强力角色冻结、动作与文本生成彻底分离
"""

import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple

from flask import Flask, request, jsonify
from flask_cors import CORS
import anthropic

# ============================================================================
# 全局配置
# ============================================================================
app = Flask(__name__)
CORS(app)

MEMORY_DIR = Path(__file__).parent / "memory"
MEMORY_DIR.mkdir(exist_ok=True)

SOPS_FILE = MEMORY_DIR / "sops.json"
PERSONAS_FILE = MEMORY_DIR / "personas.json"

client = anthropic.Anthropic()
INTERNAL_MODEL_NAME = "claude-opus-4-6" 

# ============================================================================
# 工具函数：记忆库管理 (极强容错)
# ============================================================================

def load_json(filepath: Path) -> Dict[str, Any]:
    if filepath.exists():
        if os.path.getsize(filepath) == 0: return {}
        try:
            with open(filepath, "r", encoding="utf-8") as f: return json.load(f)
        except json.JSONDecodeError as e:
            print(f"⚠️ [系统修复] {filepath.name} 损坏，按空库处理 ({e})")
            return {}
    return {}

def save_json(filepath: Path, data: Dict[str, Any]) -> None:
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"❌ [严重错误] 无法写入文件 {filepath.name}: {e}")

def load_sops() -> Dict[str, Any]: return load_json(SOPS_FILE)
def save_sops(data: Dict[str, Any]) -> None: save_json(SOPS_FILE, data)

def load_personas() -> Dict[str, Any]:
    personas = load_json(PERSONAS_FILE)
    if not isinstance(personas, dict): personas = {}
    if "role_base" not in personas:
        personas["role_base"] = {
            "name": "客观总结助手",
            "system_prompt": "你是一个严谨、客观的通用文本分析助手。你的任务是提炼核心信息，保持中立的语气。"
        }
    return personas
def save_personas(data: Dict[str, Any]) -> None: save_json(PERSONAS_FILE, data)

def extract_json_from_text(text: str) -> dict:
    if not text or not isinstance(text, str): raise ValueError("AI 返回空文本")
    try: return json.loads(text)
    except Exception:
        match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', text, re.DOTALL)
        if not match: match = re.search(r'(\{.*\})', text, re.DOTALL)
        if match:
            try: return json.loads(match.group(1))
            except json.JSONDecodeError: pass
    raise ValueError(f"AI没有返回合法JSON。片段: {text[:100]}...")

# ============================================================================
# 核心逻辑 1：混合路由 (只发描述，省 Token)
# ============================================================================

def local_keyword_recall(text: str, sops: Dict[str, Any]) -> Dict[str, Any]:
    candidates = {}
    text_lower = text.lower()
    for sop_id, sop_config in sops.items():
        # 兼容新老特征字段
        signatures = sop_config.get("exact_match_signatures", sop_config.get("trigger_keywords", []))
        for sig in signatures:
            if not sig.strip(): continue
            if sig.lower() in text_lower:
                candidates[sop_id] = sop_config
                print(f"🎯 [本地初筛] 命中特征: '{sig}' -> {sop_config.get('domain_name')}")
                break
    return candidates

def smart_llm_router(text: str) -> Tuple[Optional[Dict], Dict]:
    sops = load_sops()
    personas = load_personas()
    candidate_sops = local_keyword_recall(text, sops)
    
    # ⚠️ 这里已经实现了你的优化思路：只传角色名字和SOP的描述条件
    persona_catalog = {k: v.get("name") for k, v in personas.items()}
    
    if not candidate_sops:
        sop_context = "当前没有业务规则匹配。请仅根据文本内容选择合适的专家角色。"
    else:
        sop_catalog = {
            k: f"业务领域: {v.get('domain_name')} | 适用条件: {v.get('activation_condition', '无说明')}" 
            for k, v in candidate_sops.items()
        }
        sop_context = f"本地拦截到以下疑似规则，请判断哪个【真正符合】：\n{json.dumps(sop_catalog, ensure_ascii=False, indent=2)}"

    router_prompt = f"""你是一个智能请求路由器（API Gateway）。
从【角色库】中挑选合适的专家，并判断是否需要应用【候选技能】。
角色库: {json.dumps(persona_catalog, ensure_ascii=False)}
候选技能: {sop_context}

请返回纯 JSON：
{{
    "thought_process": "路由理由(极简，限20字)",
    "role_id": "选出角色ID",
    "sop_id": "选出技能ID(如不符填null)"
}}"""

    try:
        message = client.messages.create(
            model=INTERNAL_MODEL_NAME, max_tokens=800, temperature=0.1,  
            system=router_prompt, messages=[{"role": "user", "content": f"提取文本前1500字：\n{text[:1500]}"}] 
        )
        route_decision = extract_json_from_text(message.content[0].text)
        role_id = route_decision.get("role_id", "role_base")
        sop_id = route_decision.get("sop_id")
        
        persona_config = personas.get(role_id, personas["role_base"])
        sop_config = sops.get(sop_id) if sop_id in sops else None
        print(f"🚥 [LLM确诊] Persona: {persona_config.get('name')} | SOP: {sop_config.get('domain_name') if sop_config else 'None'}")
        return (sop_config, persona_config)
    except Exception as e:
        print(f"⚠️ [路由降级] 调用失败: {e}")
        return (None, personas["role_base"])

# ============================================================================
# 核心逻辑 2：组装执行 (隔离动作，保护大模型)
# ============================================================================

def assemble_system_prompt(sop_config: Optional[Dict], persona_config: Dict) -> str:
    prompt = f"【你的角色设定】\n{persona_config.get('system_prompt', '')}\n\n"

    if sop_config:
        domain = sop_config.get("domain_name", "特定领域")
        extraction_tasks = sop_config.get("extraction_tasks", [])
        
        prompt += f"【当前触发业务技能：{domain}】\n你必须准确提取以下真实存在的值：\n"
        for task in extraction_tasks:
            prompt += f"- {task.get('field_name')}: {task.get('instruction')}\n"
            
        # ⚠️ 架构升级：只向大模型暴露文本相关的规则，隐蔽 URL 生成规则，防止它产生幻觉困扰
        skills = sop_config.get("skills", [])
        text_constraints = [s for s in skills if s.get("action_type") == "text_constraint"]
        if text_constraints:
            prompt += "\n【强制回复话术规范】：\n"
            for tc in text_constraints:
                prompt += f"- {tc.get('description')}: {tc.get('template')}\n"
    else:
        prompt += "【自由发挥模式】未触发特定SOP，请直接精准研判。\n"

    prompt += """
            【操作系统绝对红线】：
            1. 你的 summary 必须直接说结论（50字内）；text_advice 必须是极简动作指令，如果规则要求无需排查，必须强制返回 []！
            2. 绝对禁止在分析中编造或输出任何 http/https 链接！(如果用户配置了链接，后端程序会自动渲染，你不要越俎代庖！)
            3. 提取的值必须是原文中原原本本存在的字符。
            """
    return prompt

def call_claude_analyze(text: str, system_prompt: str) -> str:
    user_message = f"""分析以下文本：
        ```text
        {text}
        ```
        严格返回闭合纯 JSON：
        {{
        "summary": "极度精炼定性结论",
        "extracted_values": [ {{"field": "字段名", "exact_match_text": "原文值", "color": "red/orange/blue"}} ],
        "text_advice": ["短句动作指令1"] // 可为空 []
        }}"""
    message = client.messages.create(
        model=INTERNAL_MODEL_NAME, max_tokens=3000, temperature=0.1,
        system=system_prompt, messages=[{"role": "user", "content": user_message}]
    )
    return message.content[0].text

def parse_and_enrich_analysis(claude_response: str, sop_config: Optional[Dict]) -> Dict:
    try:
        result = extract_json_from_text(claude_response)
    except ValueError:
        clean_text = re.sub(r'json\n?|\n?', '', claude_response).strip()
        result = {"summary": f"⚠️ 截断兜底显示：\n{clean_text[:300]}...", "extracted_values": [], "text_advice": [], "action_links": []}
    # ⚠️ 架构升级：由纯净的 Python 执行环境来处理 url_render 动作，与大模型的文本生成彻底剥离！
    action_links = []
    if sop_config:
        value_dict = {str(v.get("field", "")): str(v.get("exact_match_text", "")) for v in result.get("extracted_values", [])}
        
        # 兼容旧版的 verified_urls，并处理新版 skills
        skills = sop_config.get("skills", [])
        legacy_urls = sop_config.get("verified_urls", [])
        
        # 处理新版 Skills 引擎的 URL
        for skill in skills:
            if skill.get("action_type") == "url_render":
                url = skill.get("template", "")
                for field, val in value_dict.items():
                    if val: url = url.replace(f"{{{field}}}", val)
                if "{" not in url and url.startswith("http"):
                    action_links.append({"title": skill.get("skill_name", "动作链接"), "url": url})
                    
        # 兼容处理老版
        for u in legacy_urls:
            url = u.get("url_template", "")
            for field, val in value_dict.items():
                if val: url = url.replace(f"{{{field}}}", val)
            if "{" not in url and url.startswith("http"):
                action_links.append({"title": u.get("title", "相关链接"), "url": url})
                
    result["action_links"] = action_links
    return result

# ============================================================================
# API 端点
# ============================================================================
@app.route("/api/analyze", methods=["POST"])
def analyze():
    text = request.json.get("text", "").strip()
    if not text: return jsonify({"error": "文本为空"}), 400
    try:
        sop_config, persona_config = smart_llm_router(text)
        system_prompt = assemble_system_prompt(sop_config, persona_config)
        claude_response = call_claude_analyze(text, system_prompt)
        result = parse_and_enrich_analysis(claude_response, sop_config)
        result["matched_domain"] = sop_config.get("domain_name") if sop_config else "无 (专家自由研判)"
        result["matched_persona"] = persona_config.get("name")
        return jsonify(result), 200
    except Exception as e:
        import traceback
        traceback.print_exc()
    return jsonify({"error": str(e)}), 500

@app.route("/api/chat", methods=["POST"])
def chat():
    """⚠️ 架构升级：重构教导接口 (引入角色冻结令 + Skills构造引擎)"""
    data = request.json
    messages = data.get("messages", [])
    current_domain = data.get("current_domain", "未知领域")

    personas = load_personas()
    existing_roles = json.dumps({k: v["name"] for k, v in personas.items()}, ensure_ascii=False)

    coaching_prompt = f"""你是一个高级 AI 系统架构师。用户正在教你处理告警规则或添加动作。

        当前上下文：【{current_domain}】
        现有角色库：{existing_roles}

        【最高架构指令 1 - 角色冻结令】：
        大模型有滥建角色的恶习。我在此下达死命令：只有当领域发生巨大的跨界（比如从安全跨越到法律/烹饪）时，才允许新建角色！
        像“沙箱分析师”、“外连分析师”统统都属于现有的【网络安全专家】！你必须强制复用现有角色，极力避免把 new_persona 设为非 null！

        【最高架构指令 2 - 动作隔离引擎】：
        如果用户教你生成某个查询链接（如沙箱/SIEM），绝对不要写进让大模型回答的文本规则里！
        你必须将其转化为 skills 数组中的 url_render 动作。后端程序会通过 Python 物理拼接 URL 给用户！

        请返回纯 JSON：
            {{
            "thought_process": "1. 角色是否可以复用现有库？ 2. 有没有需要抽离为 url_render 动作的链接？",
            "reply": "你对用户的自然语言回复",
            "new_persona": {{ // 警告：99% 的情况必须为 null！除非跨界！
            "role_id": "role_xxx", "name": "中文名", "system_prompt": "..."
            }},
            "sop_draft": {{ // 若未教导业务逻辑则为 null
            "domain_name": "规则名",
            "role_id": "【必须填写】现有库中的角色ID（如网络安全相关直接填对应的安全专家ID）",
            "activation_condition": "一句话触发条件",
            "exact_match_signatures": ["2-4个直接存在于告警原文的【纯英文/数字】特征！绝对不要用中文总结！"],
            "extraction_tasks": [ {{"field_name": "提取目标(如 file_md5)", "instruction": "提取说明"}} ],
            "skills": [ // ⚠️ 取代了原本的 action_rules
            {{
            "skill_name": "查询沙箱",
            "action_type": "url_render", // 可选: url_render(生成链接) 或 text_constraint(强制话术)
            "template": "https://siem.example.com/search?q={{file_md5}}" // 变量名必须与 extraction_tasks 中的 field_name 对应
            }}
            ]
            }}
            }}"""

    try:
        message = client.messages.create(
            model=INTERNAL_MODEL_NAME, max_tokens=2500, temperature=0.1, 
            system=coaching_prompt, messages=messages
        )
        parsed_data = extract_json_from_text(message.content[0].text)
        
        print(f"🧠 [架构思考]: {parsed_data.get('thought_process', '')}")
        
        reply = parsed_data.get("reply", "已更新系统认知。")
        new_persona = parsed_data.get("new_persona")
        sop_draft = parsed_data.get("sop_draft")
        response_data = {"reply": reply, "persona_created": False, "sop_created": False, "is_update": False}

        if new_persona and isinstance(new_persona, dict) and "role_id" in new_persona:
            r_id = new_persona["role_id"]
            if r_id not in personas:
                personas[r_id] = {"name": new_persona.get("name", "新角色"), "system_prompt": new_persona.get("system_prompt", "")}
                save_personas(personas)
                response_data["persona_created"] = True

        if sop_draft and isinstance(sop_draft, dict) and "domain_name" in sop_draft:
            sops = load_sops()
            domain_name = sop_draft["domain_name"]
            sop_id = f"sop_hash_{hash(domain_name)}"
            
            response_data["is_update"] = sop_id in sops
            sop_draft["created_at"] = datetime.now().isoformat()
            
            sops[sop_id] = sop_draft
            save_sops(sops)
            response_data["sop_created"] = True

        return jsonify(response_data), 200
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    
if __name__ == "__main__":
    print("🚀 OmniAgent (Skills 架构版) 已启动")
    app.run(host="127.0.0.1", port=5000, debug=True)
