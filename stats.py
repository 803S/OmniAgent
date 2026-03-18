"""
OmniAgent 统计监控模块
功能：记录 SOP 调用次数、Token 消耗、响应时间、成本分析
"""

import json
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any
from functools import wraps
import threading

# ============================================================================
# 配置
# ============================================================================
STATS_DIR = Path(__file__).parent / "memory"
STATS_FILE = STATS_DIR / "stats.json"

# Claude API 定价 (2024年)
CLAUDE_PRICING = {
    "claude-opus-4-6": {"input": 15.0, "output": 75.0},  # $ per 1M tokens
    "claude-sonnet-4-5": {"input": 3.0, "output": 15.0},
    "claude-haiku-4-3": {"input": 0.25, "output": 1.25},
}

# ============================================================================
# 数据结构
# ============================================================================

def _get_default_stats() -> Dict[str, Any]:
    """获取默认统计数据结构"""
    return {
        "version": "1.0",
        "created_at": datetime.now().isoformat(),
        "last_updated": datetime.now().isoformat(),
        "total_requests": 0,
        "total_tokens_input": 0,
        "total_tokens_output": 0,
        "total_tokens": 0,
        "total_cost_usd": 0.0,
        "models_used": {},  # {"model_name": {"requests": n, "tokens": m, "cost": x}}
        "sop_usage": {},    # {"sop_id": {"name": "xxx", "count": n, "success": m}}
        "persona_usage": {}, # {"persona_id": {"name": "xxx", "count": n}}
        "operation_usage": {}, # {"operation_name": {"count": n, "success": m}}
        "daily_stats": {},  # {"2026-03-12": {...}}
        "hourly_stats": {}, # {"2026-03-12-14": {...}}
        "error_stats": {
            "total": 0,
            "by_type": {},  # {"error_type": count}
        },
        "response_times": {
            "avg_ms": 0,
            "p50_ms": 0,
            "p95_ms": 0,
            "p99_ms": 0,
            "samples": []
        }
    }

# ============================================================================
# 核心函数
# ============================================================================

def _load_stats() -> Dict[str, Any]:
    """加载统计数据"""
    STATS_DIR.mkdir(exist_ok=True)
    if STATS_FILE.exists():
        try:
            data = json.loads(STATS_FILE.read_text(encoding="utf-8"))
            return data
        except (json.JSONDecodeError, Exception) as e:
            print(f"[STATS] Load error: {e}, using default")
    return _get_default_stats()

def _save_stats(data: Dict[str, Any]):
    """保存统计数据"""
    data["last_updated"] = datetime.now().isoformat()
    STATS_DIR.mkdir(exist_ok=True)
    STATS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

def _get_today_key() -> str:
    """获取今天的日期键"""
    return datetime.now().strftime("%Y-%m-%d")

def _get_hourly_key() -> str:
    """获取当前小时键"""
    return datetime.now().strftime("%Y-%m-%d-%H")

def _calculate_cost(model_name: str, input_tokens: int, output_tokens: int) -> float:
    """计算 API 成本 (USD)"""
    pricing = CLAUDE_PRICING.get(model_name, CLAUDE_PRICING["claude-opus-4-6"])
    cost = (input_tokens / 1_000_000 * pricing["input"] + 
            output_tokens / 1_000_000 * pricing["output"])
    return round(cost, 6)

def _update_response_times(stats: Dict, response_time_ms: int):
    """更新响应时间统计"""
    samples = stats.get("response_times", {}).get("samples", [])
    samples.append(response_time_ms)
    # 保留最近 1000 个样本
    samples = samples[-1000:]
    
    if samples:
        samples.sort()
        n = len(samples)
        stats["response_times"]["avg_ms"] = int(sum(samples) / n)
        stats["response_times"]["p50_ms"] = samples[int(n * 0.5)]
        stats["response_times"]["p95_ms"] = samples[int(n * 0.95)] if n >= 20 else samples[-1]
        stats["response_times"]["p99_ms"] = samples[int(n * 0.99)] if n >= 100 else samples[-1]
        stats["response_times"]["samples"] = samples

# ============================================================================
# 公共 API
# ============================================================================

def track_request(
    model_name: str,
    input_tokens: int,
    output_tokens: int,
    sop_ids: List[str] = None,
    sop_names: Dict[str, str] = None,
    persona_id: str = None,
    persona_name: str = None,
    operation_name: str = None,
    response_time_ms: int = 0,
    error_type: str = None,
    success: bool = True
):
    """
    记录一次请求的统计数据
    
    Args:
        model_name: 使用的模型名称
        input_tokens: 输入 token 数
        output_tokens: 输出 token 数
        sop_ids: 触发的 SOP ID 列表
        sop_names: SOP ID -> 名称 的映射
        persona_id: 使用的角色 ID
        persona_name: 角色名称
        operation_name: 执行的浏览器操作名称
        response_time_ms: 响应时间（毫秒）
        error_type: 错误类型（如果有）
        success: 是否成功
    """
    stats = _load_stats()
    today = _get_today_key()
    hourly = _get_hourly_key()
    
    # 更新总量
    total_tokens = input_tokens + output_tokens
    cost = _calculate_cost(model_name, input_tokens, output_tokens)
    
    stats["total_requests"] += 1
    stats["total_tokens_input"] += input_tokens
    stats["total_tokens_output"] += output_tokens
    stats["total_tokens"] += total_tokens
    stats["total_cost_usd"] = round(stats["total_cost_usd"] + cost, 6)
    
    # 模型统计
    if model_name not in stats["models_used"]:
        stats["models_used"][model_name] = {"requests": 0, "tokens": 0, "cost": 0.0}
    stats["models_used"][model_name]["requests"] += 1
    stats["models_used"][model_name]["tokens"] += total_tokens
    stats["models_used"][model_name]["cost"] = round(
        stats["models_used"][model_name]["cost"] + cost, 6
    )
    
    # SOP 统计
    sop_names = sop_names or {}
    for sop_id in (sop_ids or []):
        if sop_id not in stats["sop_usage"]:
            stats["sop_usage"][sop_id] = {
                "name": sop_names.get(sop_id, sop_id),
                "count": 0,
                "success": 0,
                "first_used": datetime.now().isoformat()
            }
        stats["sop_usage"][sop_id]["count"] += 1
        if success:
            stats["sop_usage"][sop_id]["success"] += 1
    
    # Persona 统计
    if persona_id:
        if persona_id not in stats["persona_usage"]:
            stats["persona_usage"][persona_id] = {
                "name": persona_name or persona_id,
                "count": 0,
                "first_used": datetime.now().isoformat()
            }
        stats["persona_usage"][persona_id]["count"] += 1
    
    # 操作统计
    if operation_name:
        if operation_name not in stats["operation_usage"]:
            stats["operation_usage"][operation_name] = {
                "count": 0,
                "success": 0,
                "first_used": datetime.now().isoformat()
            }
        stats["operation_usage"][operation_name]["count"] += 1
        if success:
            stats["operation_usage"][operation_name]["success"] += 1
    
    # 每日统计
    if today not in stats["daily_stats"]:
        stats["daily_stats"][today] = {
            "requests": 0, "tokens": 0, "cost": 0.0, 
            "sops": {}, "errors": 0
        }
    stats["daily_stats"][today]["requests"] += 1
    stats["daily_stats"][today]["tokens"] += total_tokens
    stats["daily_stats"][today]["cost"] = round(
        stats["daily_stats"][today]["cost"] + cost, 6
    )
    
    # 每小时统计
    if hourly not in stats["hourly_stats"]:
        stats["hourly_stats"][hourly] = {"requests": 0, "tokens": 0}
    stats["hourly_stats"][hourly]["requests"] += 1
    stats["hourly_stats"][hourly]["tokens"] += total_tokens
    
    # 错误统计
    if error_type:
        stats["error_stats"]["total"] += 1
        stats["error_stats"]["by_type"][error_type] = \
            stats["error_stats"]["by_type"].get(error_type, 0) + 1
        stats["daily_stats"][today]["errors"] = \
            stats["daily_stats"][today].get("errors", 0) + 1
    
    # 响应时间
    if response_time_ms > 0:
        _update_response_times(stats, response_time_ms)
    
    _save_stats(stats)
    print(f"[STATS] Tracked: {model_name}, {total_tokens} tokens, ${cost:.4f}")


def get_stats_summary(days: int = 7) -> Dict[str, Any]:
    """
    获取统计摘要
    
    Args:
        days: 统计最近多少天
    """
    stats = _load_stats()
    today = _get_today_key()
    
    # 计算平均
    avg_tokens = stats["total_tokens"] / max(stats["total_requests"], 1)
    avg_cost = stats["total_cost_usd"] / max(stats["total_requests"], 1)
    
    # 最近 N 天的统计
    recent_days = []
    for i in range(days):
        d = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        d = d - timedelta(days=i)
        d_str = d.strftime("%Y-%m-%d")
        if d_str in stats["daily_stats"]:
            recent_days.append({
                "date": d_str,
                **stats["daily_stats"][d_str]
            })
    recent_days.reverse()
    
    # Top SOP
    top_sops = sorted(
        stats["sop_usage"].items(), 
        key=lambda x: x[1].get("count", 0), 
        reverse=True
    )[:10]
    
    # Top Persona
    top_personas = sorted(
        stats["persona_usage"].items(), 
        key=lambda x: x[1].get("count", 0), 
        reverse=True
    )[:5]
    
    # Top Operations
    top_ops = sorted(
        stats["operation_usage"].items(),
        key=lambda x: x[1].get("count", 0),
        reverse=True
    )[:5]
    
    # 今日统计
    today_stats = stats["daily_stats"].get(today, {
        "requests": 0, "tokens": 0, "cost": 0.0
    })
    
    return {
        "overall": {
            "total_requests": stats["total_requests"],
            "total_tokens": stats["total_tokens"],
            "total_cost_usd": round(stats["total_cost_usd"], 4),
            "avg_tokens_per_request": int(avg_tokens),
            "avg_cost_per_request": round(avg_cost, 4),
            "uptime_days": (datetime.now() - datetime.strptime(
                (stats.get("created_at") or datetime.now().isoformat())[:10],
                "%Y-%m-%d"
            )).days
        },
        "today": today_stats,
        "recent_days": recent_days,
        "top_sops": [
            {"id": k, "name": v.get("name", k), "count": v.get("count", 0),
             "success_rate": round(v.get("success", 0) / max(v.get("count", 1), 1) * 100, 1)}
            for k, v in top_sops
        ],
        "top_personas": [
            {"id": k, "name": v.get("name", k), "count": v.get("count", 0)}
            for k, v in top_personas
        ],
        "top_operations": [
            {"name": k, "count": v.get("count", 0),
             "success_rate": round(v.get("success", 0) / max(v.get("count", 1), 1) * 100, 1)}
            for k, v in top_ops
        ],
        "response_times": stats.get("response_times", {}),
        "models": [
            {"name": k, "requests": v.get("requests", 0), 
             "tokens": v.get("tokens", 0), "cost": round(v.get("cost", 0), 4)}
            for k, v in stats.get("models_used", {}).items()
        ],
        "errors": stats.get("error_stats", {})
    }


def get_sop_stats(sop_id: str = None) -> Dict[str, Any]:
    """获取指定 SOP 或所有 SOP 的详细统计"""
    stats = _load_stats()
    if sop_id:
        return stats["sop_usage"].get(sop_id, {})
    return stats["sop_usage"]


def reset_stats(confirm: bool = False) -> Dict[str, str]:
    """重置统计数据（需确认）"""
    if not confirm:
        return {"status": "error", "message": "请传入 confirm=True 确认重置"}
    _save_stats(_get_default_stats())
    return {"status": "ok", "message": "统计数据已重置"}


# 导出常用函数
__all__ = [
    "track_request",
    "get_stats_summary", 
    "get_sop_stats",
    "reset_stats"
]

if __name__ == "__main__":
    # 测试
    print("=== Stats Module Test ===")
    
    # 模拟记录
    track_request(
        model_name="claude-opus-4-6",
        input_tokens=1000,
        output_tokens=500,
        sop_ids=["sop_hash_xxx"],
        sop_names={"sop_hash_xxx": "测试SOP"},
        persona_id="role_cybersecurity_expert",
        persona_name="网络安全专家",
        response_time_ms=2500,
        success=True
    )
    
    # 获取摘要
    summary = get_stats_summary()
    print(json.dumps(summary, ensure_ascii=False, indent=2))