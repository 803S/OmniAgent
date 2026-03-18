"""
OmniAgent SQLite 数据库模块
替换 JSON 文件存储，确保并发安全
"""

import sqlite3
import json
import threading
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, List, Optional

DB_FILE = Path(__file__).parent / "memory" / "omniagent.db"

# 线程锁，确保并发安全
_db_lock = threading.Lock()

def _get_conn():
    """获取数据库连接"""
    DB_FILE.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(str(DB_FILE), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """初始化数据库表"""
    with _db_lock:
        conn = _get_conn()
        cursor = conn.cursor()
        
        # SOPs 表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS sops (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                steps TEXT NOT NULL,  -- JSON 存储步骤
                trigger TEXT,         -- 触发条件
                domain TEXT,          -- 适用域名
                created_at TEXT,
                updated_at TEXT
            )
        """)
        
        # Personas 表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS personas (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                system_prompt TEXT NOT NULL,
                description TEXT,
                domain TEXT,
                created_at TEXT,
                updated_at TEXT
            )
        """)
        
        conn.commit()
        conn.close()

def get_all_sops() -> List[Dict[str, Any]]:
    """获取所有 SOP"""
    with _db_lock:
        conn = _get_conn()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM sops ORDER BY updated_at DESC")
        rows = cursor.fetchall()
        conn.close()
        
        result = []
        for row in rows:
            item = dict(row)
            item["steps"] = json.loads(item["steps"])
            result.append(item)
        return result

def get_sop(sop_id: str) -> Optional[Dict[str, Any]]:
    """获取单个 SOP"""
    with _db_lock:
        conn = _get_conn()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM sops WHERE id = ?", (sop_id,))
        row = cursor.fetchone()
        conn.close()
        
        if row:
            item = dict(row)
            item["steps"] = json.loads(item["steps"])
            return item
        return None

def save_sop(sop: Dict[str, Any]) -> None:
    """保存 SOP"""
    with _db_lock:
        conn = _get_conn()
        cursor = conn.cursor()
        now = datetime.now().isoformat()
        
        cursor.execute("""
            INSERT OR REPLACE INTO sops (id, name, description, steps, trigger, domain, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM sops WHERE id = ?), ?), ?)
        """, (
            sop.get("id"),
            sop.get("name"),
            sop.get("description", ""),
            json.dumps(sop.get("steps", []), ensure_ascii=False),
            sop.get("trigger", ""),
            sop.get("domain", ""),
            sop.get("id"),
            now,
            now
        ))
        
        conn.commit()
        conn.close()

def delete_sop(sop_id: str) -> None:
    """删除 SOP"""
    with _db_lock:
        conn = _get_conn()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM sops WHERE id = ?", (sop_id,))
        conn.commit()
        conn.close()

def get_all_personas() -> List[Dict[str, Any]]:
    """获取所有 Persona"""
    with _db_lock:
        conn = _get_conn()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM personas ORDER BY updated_at DESC")
        rows = cursor.fetchall()
        conn.close()
        return [dict(row) for row in rows]

def get_persona(persona_id: str) -> Optional[Dict[str, Any]]:
    """获取单个 Persona"""
    with _db_lock:
        conn = _get_conn()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM personas WHERE id = ?", (persona_id,))
        row = cursor.fetchone()
        conn.close()
        return dict(row) if row else None

def save_persona(persona: Dict[str, Any]) -> None:
    """保存 Persona"""
    with _db_lock:
        conn = _get_conn()
        cursor = conn.cursor()
        now = datetime.now().isoformat()
        
        cursor.execute("""
            INSERT OR REPLACE INTO personas (id, name, system_prompt, description, domain, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM personas WHERE id = ?), ?), ?)
        """, (
            persona.get("id"),
            persona.get("name"),
            persona.get("system_prompt"),
            persona.get("description", ""),
            persona.get("domain", ""),
            persona.get("id"),
            now,
            now
        ))
        
        conn.commit()
        conn.close()

def delete_persona(persona_id: str) -> None:
    """删除 Persona"""
    with _db_lock:
        conn = _get_conn()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM personas WHERE id = ?", (persona_id,))
        conn.commit()
        conn.close()

# 初始化数据库
init_db()