"""
OmniAgent Browser 模块
功能：浏览器自动化控制。
- 优先使用 Selenium 真浏览器
- 若未安装 Selenium，则退化为 requests 驱动的轻量浏览模式，至少保证 create / navigate / content / info 可用于用户测试
"""

import json
import re
import time
import uuid
import threading
from html import unescape
from pathlib import Path
from typing import Any, Dict, List

import requests

SeleniumAvailable = False
try:
    from selenium import webdriver
    from selenium.webdriver.common.by import By
    from selenium.webdriver.chrome.options import Options as ChromeOptions
    from selenium.webdriver.firefox.options import Options as FirefoxOptions
    SeleniumAvailable = True
except ImportError as e:
    print(f"[WARN] Selenium not available, using lightweight browser fallback: {e}")

_browsers: Dict[str, 'BrowserInstance'] = {}
_browsers_lock = threading.Lock()
OPERATIONS_DIR = Path(__file__).parent / "memory" / "browser_operations"
OPERATIONS_DIR.mkdir(parents=True, exist_ok=True)


def _extract_title(html: str) -> str:
    match = re.search(r'<title[^>]*>(.*?)</title>', html, re.IGNORECASE | re.DOTALL)
    return unescape(match.group(1).strip()) if match else ""


class BrowserInstance:
    def __init__(self, browser_type: str = "chrome", headless: bool = True):
        self.id = str(uuid.uuid4())
        self.browser_type = browser_type
        self.headless = headless
        self.driver = None
        self.mode = "selenium" if SeleniumAvailable else "http"
        self.session = requests.Session()
        self.current_url = ""
        self.current_title = ""
        self.page_source = ""
        self.history: List[str] = []
        self.history_index = -1
        if SeleniumAvailable:
            self._init_driver(headless)

    def _init_driver(self, headless: bool = True):
        if self.browser_type == "chrome":
            options = ChromeOptions()
            if headless:
                options.add_argument("--headless=new")
            options.add_argument("--no-sandbox")
            options.add_argument("--disable-dev-shm-usage")
            options.add_argument("--disable-gpu")
            options.add_argument("--window-size=1920,1080")
            self.driver = webdriver.Chrome(options=options)
        elif self.browser_type == "firefox":
            options = FirefoxOptions()
            if headless:
                options.add_argument("--headless")
            self.driver = webdriver.Firefox(options=options)
        else:
            raise ValueError(f"Unsupported browser type: {self.browser_type}")
        self.driver.implicitly_wait(10)

    def _push_history(self, url: str):
        if self.history_index < len(self.history) - 1:
            self.history = self.history[: self.history_index + 1]
        self.history.append(url)
        self.history_index = len(self.history) - 1

    def navigate(self, url: str) -> Dict[str, Any]:
        if self.driver:
            self.driver.get(url)
            self.current_url = self.driver.current_url
            self.current_title = self.driver.title
            self.page_source = self.driver.page_source
            self._push_history(self.current_url)
            return {"status": "success", "url": self.current_url, "title": self.current_title, "mode": self.mode}

        resp = self.session.get(url, timeout=30)
        resp.raise_for_status()
        resp.encoding = resp.encoding or resp.apparent_encoding or 'utf-8'
        self.current_url = resp.url
        self.page_source = resp.text
        self.current_title = _extract_title(self.page_source)
        self._push_history(self.current_url)
        return {"status": "success", "url": self.current_url, "title": self.current_title, "mode": self.mode}

    def close(self):
        if self.driver:
            self.driver.quit()
            self.driver = None
        self.session.close()

    def get_content(self) -> str:
        return self.driver.page_source if self.driver else self.page_source

    def get_info(self) -> Dict[str, Any]:
        if self.driver:
            return {
                "url": self.driver.current_url,
                "title": self.driver.title,
                "window_handles": len(self.driver.window_handles),
                "mode": self.mode,
            }
        return {
            "url": self.current_url,
            "title": self.current_title,
            "window_handles": 1,
            "mode": self.mode,
        }

    def _navigate_history(self, step: int) -> Dict[str, Any]:
        if not self.history:
            return {"status": "error", "message": "No history"}
        next_index = self.history_index + step
        if next_index < 0 or next_index >= len(self.history):
            return {"status": "error", "message": "History boundary reached"}
        self.history_index = next_index
        return self.navigate(self.history[self.history_index])

    def execute_action(self, action: str, selector: str = None, value: str = None, index: int = 0) -> Dict[str, Any]:
        if self.driver:
            if action == "click":
                elems = self.driver.find_elements(By.CSS_SELECTOR, selector) if selector else []
                if elems and index < len(elems):
                    elems[index].click()
                    return {"status": "success", "action": "click"}
                return {"status": "error", "message": "Element not found"}
            if action == "input":
                elems = self.driver.find_elements(By.CSS_SELECTOR, selector) if selector else []
                if elems and index < len(elems):
                    elems[index].clear()
                    elems[index].send_keys(value or "")
                    return {"status": "success", "action": "input", "value": value}
                return {"status": "error", "message": "Element not found"}
            if action == "scroll":
                if selector:
                    elems = self.driver.find_elements(By.CSS_SELECTOR, selector)
                    if elems and index < len(elems):
                        self.driver.execute_script("arguments[0].scrollIntoView();", elems[index])
                else:
                    self.driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
                return {"status": "success", "action": "scroll"}
            if action == "screenshot":
                return {"status": "success", "action": "screenshot", "data": self.driver.get_screenshot_as_base64()}
            if action == "refresh":
                self.driver.refresh()
                return {"status": "success", "action": "refresh"}

        if action == "goto":
            return self.navigate(value)
        if action == "refresh":
            if not self.current_url:
                return {"status": "error", "message": "No page loaded"}
            return self.navigate(self.current_url)
        if action == "back":
            return self._navigate_history(-1)
        if action == "forward":
            return self._navigate_history(1)
        if action == "wait":
            time.sleep(float(value or 1))
            return {"status": "success", "action": "wait", "duration": value}
        if action == "screenshot":
            return {"status": "error", "message": "Screenshot requires Selenium browser mode"}
        if action in {"click", "input", "select", "scroll"}:
            return {"status": "error", "message": f"Action '{action}' requires Selenium browser mode"}
        return {"status": "error", "message": f"Unknown action: {action}"}


def create_browser(browser_type: str = "chrome", headless: bool = True) -> Dict[str, Any]:
    try:
        instance = BrowserInstance(browser_type, headless)
        with _browsers_lock:
            _browsers[instance.id] = instance
        return {
            "status": "success",
            "browser_id": instance.id,
            "browser_type": browser_type,
            "headless": headless,
            "mode": instance.mode,
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


def close_browser(browser_id: str) -> Dict[str, Any]:
    with _browsers_lock:
        instance = _browsers.pop(browser_id, None)
    if not instance:
        return {"status": "error", "message": "Browser not found"}
    instance.close()
    return {"status": "success"}


def navigate(browser_id: str, url: str) -> Dict[str, Any]:
    with _browsers_lock:
        instance = _browsers.get(browser_id)
    if not instance:
        return {"status": "error", "message": "Browser not found"}
    return instance.navigate(url)


def execute_action(browser_id: str, action: str, selector: str = None, value: str = None, index: int = 0) -> Dict[str, Any]:
    with _browsers_lock:
        instance = _browsers.get(browser_id)
    if not instance:
        return {"status": "error", "message": "Browser not found"}
    return instance.execute_action(action, selector, value, index)


def get_content(browser_id: str) -> Dict[str, Any]:
    with _browsers_lock:
        instance = _browsers.get(browser_id)
    if not instance:
        return {"status": "error", "message": "Browser not found"}
    return {"status": "success", "content": instance.get_content(), "mode": instance.mode}


def get_info(browser_id: str) -> Dict[str, Any]:
    with _browsers_lock:
        instance = _browsers.get(browser_id)
    if not instance:
        return {"status": "error", "message": "Browser not found"}
    return instance.get_info()


def list_operations() -> List[Dict[str, Any]]:
    operations = []
    for f in OPERATIONS_DIR.glob("*.json"):
        try:
            with open(f, 'r', encoding='utf-8') as fp:
                data = json.load(fp)
            operations.append({"name": f.stem, "steps": len(data.get("steps", [])), "created": data.get("created")})
        except Exception:
            pass
    return operations


def save_operations(name: str, steps: List[Dict]) -> Dict[str, Any]:
    filepath = OPERATIONS_DIR / f"{name}.json"
    with open(filepath, 'w', encoding='utf-8') as fp:
        json.dump({"name": name, "steps": steps, "created": time.strftime("%Y-%m-%d %H:%M:%S")}, fp, ensure_ascii=False, indent=2)
    return {"status": "success", "filepath": str(filepath)}


def play_operations(browser_id: str, name: str) -> Dict[str, Any]:
    filepath = OPERATIONS_DIR / f"{name}.json"
    if not filepath.exists():
        return {"status": "error", "message": f"Operation '{name}' not found"}
    with open(filepath, 'r', encoding='utf-8') as fp:
        data = json.load(fp)
    results = []
    for i, step in enumerate(data.get("steps", [])):
        result = execute_action(browser_id, step.get("action"), step.get("selector"), step.get("value"), step.get("index", 0))
        results.append({"step": i + 1, "result": result})
        time.sleep(0.2)
    return {"status": "success", "results": results}


def is_available() -> bool:
    return True
