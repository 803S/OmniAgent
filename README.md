# OmniAgent - 浏览器增强式工作助手

> 人在回路的 AI 辅助工具，通过自然语言教导让 AI 自动学习 SOP 和角色

## 核心定位

**增强式工作助手** - 而非全自动化工具
- 人在回路（Human in the Loop）：AI 辅助，人类决策
- 自然语言教导：通过对话教 AI 学习业务知识
- AI 自动生成：SOP 和角色提示词由 AI 自动生成

## 功能特性

| 功能 | 说明 |
|------|------|
| **智能分析** | 图像+文本分析，基于 Claude API |
| **教导模式** | 人用自然语言教 AI，AI 自动生成 SOP/角色 |
| **对话引擎** | 自然语言交互，支持多 Persona |
| **浏览器控制** | 辅助操作（人在浏览器中，AI 提供建议） |
| **RAG 知识库** | Chroma 向量数据库，文档吞噬与检索 |
| **统计监控** | Token 消耗、成本统计 |

## 快速开始

### 安装

```bash
# 克隆后进入目录
cd omniagent

# 创建虚拟环境（Python 3.12+）
python3 -m venv venv
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt
```

### 启动后端

```bash
# Linux (需要 xvfb-run)
xvfb-run -a python server.py

# Windows
python server.py
```

### 安装浏览器端（Tampermonkey）

1. 安装 Tampermonkey 扩展
2. 新建脚本，粘贴 `user.js` 内容
3. 访问任意页面，图标会出现

## 用户界面

### 五个标签页

1. **【分析】** - 页面内容智能分析
2. **【教导】** - 自然语言教导 AI（核心功能）
3. **【统计】** - 查看消耗统计
4. **【浏览器】** - 浏览器操作控制
5. **【知识库】** - RAG 文档管理

### 教导模式使用流程

1. 点击【教导】标签
2. 用自然语言描述任务规则，例如：
   - "遇到登录页面时，自动填写用户名 admin"
   - "当看到红色错误提示时，截图并通知我"
3. AI 自动理解并生成 SOP/角色
4. 后续遇到类似场景，AI 会按学习的规则辅助你

## API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/analyze` | POST | 智能分析（图像+文本） |
| `/api/chat` | POST | 自然语言对话 |
| `/api/stats` | GET | 获取统计数据 |
| `/api/stats/reset` | POST | 重置统计 |
| `/api/browser/create` | POST | 创建浏览器页面 |
| `/api/rag/add` | POST | 添加文档 |
| `/api/rag/search` | GET | 向量搜索 |
| `/health` | GET | 健康检查 |

## 项目结构

```
omniagent/
├── server.py          # 后端服务入口
├── stats.py           # 统计模块
├── user.js            # 浏览器端脚本（Tampermonkey）
├── requirements.txt   # Python 依赖
├── start.sh           # Linux 启动脚本
├── start.bat          # Windows 启动脚本
├── browser/           # 浏览器自动化模块
├── rag/               # RAG 向量知识库模块
└── memory/            # SOP/Persona 存储
```

## 环境配置

`.env` 文件：

```bash
# Claude API（必需）
ANTHROPIC_API_KEY=sk-xxx

# 可选配置
PORT=5000
```

## 技术栈

- **后端**：Flask + Playwright + LangChain + ChromaDB
- **前端**：Tampermonkey 用户脚本
- **AI**：Claude API