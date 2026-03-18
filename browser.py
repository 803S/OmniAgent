"""
OmniAgent Browser 模块
功能：浏览器自动化控制（基于 Selenium）
"""

import os
import json
import time
import uuid
import threading
from typing import Dict, List, Optional, Any
from pathlib import Path

# Selenium 相关
SeleniumAvailable = False
try:
    from selenium import webdriver
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.chrome.options import Options as ChromeOptions
    from selenium.webdriver.firefox.options import Options as FirefoxOptions
    SeleniumAvailable = True
except ImportError as e:
    print(f"[WARN] Selenium not available: {e}")

# 全局浏览器实例管理
_browsers: Dict[str, 'BrowserInstance'] = {}
_browsers_lock = threading.Lock()

# 操作序列存储
OPERATIONS_DIR = Path(__file__).parent / "memory" / "browser_operations"
OPERATIONS_DIR.mkdir(parents=True, exist_ok=True)


class BrowserInstance:
    """浏览器实例"""
    
    def __init__(self, browser_type: str = "chrome", headless: bool = True):
        self.id = str(uuid.uuid4())
        self.browser_type = browser_type
        self.driver = None
        self._init_driver(headless)
    
    def _init_driver(self, headless: bool = True):
        """初始化 WebDriver"""
        if not SeleniumAvailable:
            raise RuntimeError("Selenium not available")
        
        if self.browser_type == "chrome":
            options = ChromeOptions()
            if headless:
                options.add_argument("--headless")
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
    
    def navigate(self, url: str) -> Dict[str, Any]:
        """导航到 URL"""
        self.driver.get(url)
        return {
            "status": "success",
            "url": self.driver.current_url,
            "title": self.driver.title
        }
    
    def close(self):
        """关闭浏览器"""
        if self.driver:
            self.driver.quit()
            self.driver = None
    
    def get_content(self) -> str:
        """获取页面内容"""
        return self.driver.page_source
    
    def get_info(self) -> Dict[str, Any]:
        """获取页面信息"""
        return {
            "url": self.driver.current_url,
            "title": self.driver.title,
            "window_handles": len(self.driver.window_handles)
        }
    
    def execute_action(self, action: str, selector: str = None, value: str = None, 
                       index: int = 0) -> Dict[str, Any]:
        """执行浏览器操作
        
        Args:
            action: 操作类型 (click, input, select, scroll, screenshot, wait)
            selector: CSS 选择器
            value: 输入值或选项
            index: 元素索引
        """
        if action == "click":
            if selector:
                elem = self.driver.find_elements(By.CSS_SELECTOR, selector)
                if elem and index < len(elem):
                    elem[index].click()
            return {"status": "success", "action": "click"}
        
        elif action == "input":
            if selector and value is not None:
                elem = self.driver.find_elements(By.CSS_SELECTOR, selector)
                if elem and index < len(elem):
                    elem[index].clear()
                    elem[index].send_keys(value)
            return {"status": "success", "action": "input", "value": value}
        
        elif action == "select":
            # <select> 元素处理
            if selector and value is not None:
                from selenium.webdriver.support.ui import Select
                elem = self.driver.find_elements(By.CSS_SELECTOR, selector)
                if elem and index < len(elem):
                    Select(elem[index]).select_by_value(value)
            return {"status": "success", "action": "select"}
        
        elif action == "scroll":
            if selector:
                elem = self.driver.find_elements(By.CSS_SELECTOR, selector)
                if elem and index < len(elem):
                    self.driver.execute_script("arguments[0].scrollIntoView();", elem[index])
            else:
                self.driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
            return {"status": "success", "action": "scroll"}
        
        elif action == "screenshot":
            # 返回 base64 编码的截图
            screenshot = self.driver.get_screenshot_as_base64()
            return {"status": "success", "action": "screenshot", "data": screenshot}
        
        elif action == "wait":
            time.sleep(float(value or 1))
            return {"status": "success", "action": "wait", "duration": value}
        
        elif action == "goto":
            return self.navigate(value)
        
        elif action == "refresh":
            self.driver.refresh()
            return {"status": "success", "action": "refresh"}
        
        elif action == "back":
            self.driver.back()
            return {"status": "success", "action": "back"}
        
        elif action == "forward":
            self.driver.forward()
            return {"status": "success", "action": "forward"}
        
        else:
            return {"status": "error", "message": f"Unknown action: {action}"}


def create_browser(browser_type: str = "chrome", headless: bool = True) -> Dict[str, Any]:
    """创建浏览器实例"""
    if not SeleniumAvailable:
        return {"status": "error", "message": "Selenium not available"}
    
    try:
        instance = BrowserInstance(browser_type, headless)
        with _browsers_lock:
            _browsers[instance.id] = instance
        return {
            "status": "success",
            "browser_id": instance.id,
            "browser_type": browser_type,
            "headless": headless
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


def close_browser(browser_id: str) -> Dict[str, Any]:
    """关闭浏览器实例"""
    with _browsers_lock:
        if browser_id in _browsers:
            instance = _browsers[browser_id]
            instance.close()
            del _browsers[browser_id]
            return {"status": "success"}
    return {"status": "error", "message": "Browser not found"}


def navigate(browser_id: str, url: str) -> Dict[str, Any]:
    """导航到 URL"""
    with _browsers_lock:
        instance = _browsers.get(browser_id)
    if not instance:
        return {"status": "error", "message": "Browser not found"}
    return instance.navigate(url)


def execute_action(browser_id: str, action: str, selector: str = None, 
                   value: str = None, index: int = 0) -> Dict[str, Any]:
    """执行浏览器操作"""
    with _browsers_lock:
        instance = _browsers.get(browser_id)
    if not instance:
        return {"status": "error", "message": "Browser not found"}
    return instance.execute_action(action, selector, value, index)


def get_content(browser_id: str) -> Dict[str, Any]:
    """获取页面内容"""
    with _browsers_lock:
        instance = _browsers.get(browser_id)
    if not instance:
        return {"status": "error", "message": "Browser not found"}
    return {"status": "success", "content": instance.get_content()}


def get_info(browser_id: str) -> Dict[str, Any]:
    """获取页面信息"""
    with _browsers_lock:
        instance = _browsers.get(browser_id)
    if not instance:
        return {"status": "error", "message": "Browser not found"}
    return instance.get_info()


def list_operations() -> List[Dict[str, Any]]:
    """列出所有保存的操作序列"""
    operations = []
    for f in OPERATIONS_DIR.glob("*.json"):
        try:
            with open(f, 'r', encoding='utf-8') as fp:
                data = json.load(fp)
                operations.append({
                    "name": f.stem,
                    "steps": len(data.get("steps", [])),
                    "created": data.get("created")
                })
        except Exception:
            pass
    return operations


def save_operations(name: str, steps: List[Dict]) -> Dict[str, Any]:
    """保存操作序列"""
    filepath = OPERATIONS_DIR / f"{name}.json"
    data = {
        "name": name,
        "steps": steps,
        "created": time.strftime("%Y-%m-%d %H:%M:%S")
    }
    with open(filepath, 'w', encoding='utf-8') as fp:
        json.dump(data, fp, ensure_ascii=False, indent=2)
    return {"status": "success", "filepath": str(filepath)}


def play_operations(browser_id: str, name: str) -> Dict[str, Any]:
    """回放操作序列"""
    filepath = OPERATIONS_DIR / f"{name}.json"
    if not filepath.exists():
        return {"status": "error", "message": f"Operation '{name}' not found"}
    
    with open(filepath, 'r', encoding='utf-8') as fp:
        data = json.load(fp)
    
    steps = data.get("steps", [])
    results = []
    
    with _browsers_lock:
        instance = _browsers.get(browser_id)
    if not instance:
        return {"status": "error", "message": "Browser not found"}
    
    for i, step in enumerate(steps):
        try:
            action = step.get("action")
            selector = step.get("selector")
            value = step.get("value")
            index = step.get("index", 0)
            
            result = instance.execute_action(action, selector, value, index)
            results.append({"step": i + 1, "result": result})
            
            # 每个操作后等待一小段时间
            time.sleep(0.5)
        except Exception as e:
            results.append({"step": i + 1, "error": str(e)})
    
    return {"status": "success", "results": results}


def is_available() -> bool:
    """检查模块是否可用"""
    return SeleniumAvailable