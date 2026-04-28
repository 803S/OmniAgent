> - 日常在浏览器大量重复操作，处理工单，页面内容很多，有些格式都不对，经常看漏了，于是它有了重要内容高亮功能；</br>
> - 有些工单有大量代码，所以直接接入ai让ai大人直接分析。防止有些非主要内容干扰和拖慢速度有了区域选择功能；</br>
> - ai太笨？不会处理？我教它啊，有了教导和沉淀落地功能；</br>
> - 一些没啥问题的东西懒得接单选内容提交工单，于是接入阿里的page agent直接执行(为了保证准确性你先教它操作一遍)；</br>
> - 用不太聪明的便宜或者公司内部笨ai就行，不过也简单加了token消耗的面板（虽然不太好用，不过问题不大）；</br>
> - rag感觉没啥用，暂时没咋搞，也没测
> - 它没法代替人，而是辅助人
> - 你会什么它就会什么，不局限于某一个领域
>
> - 存在问题：会被csp拦，但写插件又通用性不太好，快捷键也存在问题
---
# OmniAgent

一个“浏览器内助手 + 本地后端服务”的轻量实现：在任意网页上用 Userscript 注入侧边面板，把当前页面的选区/摘要/页面状态发给本地后端，由后端完成 **路由（Persona/Skill）→ 结构化分析 → 推荐动作/工作流 → 可选的教导写入长期记忆**。

> 后端默认监听 `http://127.0.0.1:8765`，前端脚本从该地址按需加载 UI 与能力。

## 快速使用（3 分钟）

### 1) 准备环境

- Python 3.9+（建议 3.11+）
- 浏览器装 Tampermonkey / Violentmonkey（用于安装 Userscript）

### 2) 配置模型与启动后端

1. 编辑 `.env`，至少填一组可用的 Provider（如 `OPENAI_*` / `DEEPSEEK_*` / `ANTHROPIC_*` / `INTERNAL_*` 等）。
2. 启动：

```bash
./start.sh
```

Windows：

```bat
start.bat
```

首次启动会创建 `.venv/` 并安装 `backend/requirements.txt`。

### 3) 安装前端 Userscript 并开始使用

后端启动后，在暴力猴等安装插件：

- /frontend/omniagent.user.js`

安装完成后刷新任意网页，右下角会出现一个悬浮入口；点击即可打开 OmniAgent 面板，进行：

- “分析当前选区/页面摘要”
- “继续对话（chat）”
- “教导（teach）：当你明确说‘记住/以后这样做/录制流程’时写入长期记忆或工作流”

### 4）截图


## 多层架构（从浏览器到模型到存储）

项目按“前端注入层 → 后端 API 层 → 核心运行时层 → 存储与记忆层 → Provider 适配层”组织，每一层都尽量保持职责单一。

### L0：浏览器注入层（Userscript + 面板脚本）

- `frontend/omniagent.user.js`：轻量加载器  
  - 在任意网页（`@match http(s)://*/*`）注入一个悬浮入口
  - 从本地后端拉取并加载主面板脚本 `frontend/omniagent.app.js`
  - 支持通过 `localStorage` 配置后端地址（默认回退 `127.0.0.1:8765` / `localhost:8765`）
- `frontend/omniagent.app.js`：主面板与交互逻辑  
  - 采集选区文本/页面摘要、可交互元素候选（DOM candidates）、必要时生成“文本卡片/降级快照”
  - 调用后端 `/api/analyze`、`/api/chat`、`/api/teach` 等接口，并展示结果/动作/记忆
- `frontend/vendor/page-agent.vendor.js`：前端页面代理依赖（用于 DOM 候选与页面状态结构化）
- `frontend/regression/*`：回归/演示页面，用于验证页面动作规划与选择器鲁棒性

### L1：后端 API 层（Flask）

- `backend/server.py`：Flask 服务与所有 API 路由，兼任前端静态资源分发
  - 核心入口：`/api/analyze`、`/api/chat`、`/api/teach`
  - 数据与审计：`/api/personas`、`/api/skills`、`/api/workflows`、`/api/traces`、`/api/stats`
  - RAG：`/api/rag/upload`、`/api/rag/search`
  - 前端资源：`/frontend/omniagent.user.js`、`/frontend/omniagent.app.js`、`/frontend/regression/*`

### L2：核心运行时层（路由 / Prompt 组装 / 结构化输出）

核心运行时封装在 `backend/server.py` 的 `GeminiBaselineRuntime`：

1. **路由（Router）**：`route_text()`  
   - 先做本地关键词召回（基于 Skill 的 `exact_match_signatures`、以及从标题/激活条件里提取的 recall term）
   - 再用模型（router 任务）在候选 Persona/Skill 列表中选择更合适的组合；失败时回退到纯本地排序
2. **Prompt 组装（System Prompt）**：`assemble_system_prompt()`  
   - 将 Persona 的 `system_prompt` + 当前激活 Skill 的提取任务融合成一个“必须返回 JSON”的约束式提示
   - 明确视觉输入边界：支持视觉但非真实截图时，只允许读取卡片文字，禁止编造“看到了截图细节”
3. **结构化分析（Analyzer）**：`/api/analyze`  
   - 通过 `call_task("analyzer", ...)` 调用上游模型
   - 解析模型返回的 JSON（`summary / extracted_values / evidence_items / text_advice ...`）
   - 结合抽取字段与工作流库，生成 `quick_actions`（可执行的页面动作/外链/工作流）
4. **对话与页面动作规划（Chat）**：`/api/chat`  
   - 普通 chat：将最近上下文（选区摘要、页面元信息等）拼进消息，调用 `chat` 任务模型
   - `action_mode=browser_control`：进入“页面操作规划器”模式，要求输出可执行的 `browser_actions`（click/fill/select/press_key/...）
5. **教导（Teach）**：`/api/teach` + `/api/teach/confirm`  
   - 只在用户明确表达“记住/以后这样做/录制流程”时，生成 Skill/Workflow 草案
   - 由用户确认后写入 DB，成为长期记忆（Skill）或可复用流程（Workflow）

### L3：存储与记忆层（SQLite + Seed JSON）

- `backend/db.py`：统一的数据读写与 schema 管理（SQLite）
- `backend/memory/omniagent.db`：运行时持久化数据库
- `backend/memory/*.json`：种子数据（首次启动会确保存在）
  - `personas.json`：角色库（Persona）
  - `sops.json`：技能/SOP（Skill）
  - `workflows.json`：可复用流程（Workflow）
  - `query_templates.json`：查询模板（用于给出“下一步查询”的快捷动作）
  - `documents.json`：RAG 文档（片段/语义检索用）

数据表重点包括：

- `personas / skills / workflows`：长期可配置能力
- `traces`：每次分析的路由、记忆选择、工作流选择、动作执行结果等审计记录
- `documents / query_templates`：RAG 与查询模板
- `stats_calls`：按请求类型统计 token/耗时（用于成本与性能观测）

### L4：Provider 适配层（多模型后端接入）

后端内置多种 Provider 选择逻辑（按环境变量推断或显式指定），并支持代理/网关：

- `ccswitch`：本地/企业网关探测与代理转发（可选）
- `deepseek / openai / anthropic / internal / local`：以 OpenAI-compatible 或 Anthropic Messages API 的方式调用
- 关键点：同一套 `call_task(task_name, ...)` 对外暴露 router/analyzer/chat/teach 四类任务，底层按 Provider 类型分发

## 端到端流程（从“点一下”到“记住它”）

### 流程 1：分析（Analyze）

1. 前端采集：选区文本/页面摘要 + `page_meta/scope_meta/browser_state/dom_candidates`（必要时附带文本卡片/降级快照）
2. 调用后端：`POST /api/analyze`
3. 后端路由：`route_text()` 选 Persona + 激活 Skill（可模型路由，也可纯本地回退）
4. 记忆预加载：从 Workflow/Document/Template 中挑选少量候选，构造 memory prompt
5. 调用 analyzer 模型：要求输出闭合 JSON（summary/证据/抽取字段/建议等）
6. 二次处理：
   - 把抽取字段 materialize 到 Skill/Workflow 的占位符里
   - 生成 `quick_actions`（打开链接 / 执行页面动作 / 执行工作流）
7. 落库审计：写入 `traces` 与 `stats_calls`，把结果返回前端展示

### 流程 2：对话（Chat）与页面动作规划

1. 前端把消息数组 `messages` 发给：`POST /api/chat`
2. 后端读取 `context_key` 对应的上下文快照（选区摘要、页面元信息、页面状态）
3. 普通聊天：调用 `chat` 任务模型输出文本回复
4. 页面控制模式（`action_mode=browser_control`）：
   - system prompt 强约束只输出有限动作类型（click/fill/select/press_key/fill_form/…）
   - 输出 `browser_actions` 由前端执行，并可把执行结果回写到 `traces`

### 流程 3：教导（Teach）→ 写入长期记忆（Skill / Workflow）

1. 用户在面板里明确提出“记住/以后这样做/录制流程”
2. 前端调用：`POST /api/teach`（携带当前聊天、当前分析种子、可选录制步骤）
3. teach 模型只做决策：`chat_only | update_skill | create_skill | create_workflow`
4. 需要写入时，前端让用户确认，再调用：
   - `POST /api/teach/confirm`：写入 Skill 或 Workflow
   - `POST /api/teach/reject`：放弃草案
5. 写入后的 Skill/Workflow 会在后续 `route_text()` 与 `build_quick_actions()` 中参与召回与动作生成

### 流程 4：RAG（上传与检索）

- 上传文档：`POST /api/rag/upload`
  - `source_type=text`：直接写入文本
  - `source_type=file_base64`：上传文件内容（后端会抽取文本并入库）
- 检索：`GET /api/rag/search?q=...&namespace=...&top_k=...`
  - 返回的命中可被 analyze/chat 用作参考记忆（memory hits）

## 常用配置（环境变量）

后端启动时默认读取 `REBUILD_ROOT/.env`（即仓库根目录的 `.env`），并支持：

- `HOST` / `PORT`：监听地址与端口（默认 `127.0.0.1:8765`）
- 注意：`FLASK_HOST` / `FLASK_PORT` 在当前实现里不会生效，请使用 `HOST` / `PORT`（或 `OMNIAGENT_HOST` / `OMNIAGENT_PORT`）。
- `DEBUG`：是否启用 debug（默认 true）
- `MODEL_PROVIDER`：`ccswitch|deepseek|openai|anthropic|internal|local`（不填则按已配置的 key/base_url 推断）
- `ROUTER_MODEL / ANALYZER_MODEL / CHAT_MODEL / TEACH_MODEL`：分别指定四类任务使用的模型名
- `OMNIAGENT_TRUST_SYSTEM_PROXY=1`：允许自动探测并使用系统代理（仅对非本地 base_url 生效）

## 目录速览

```text
.
├── backend/
│   ├── server.py              # Flask + Runtime（路由/分析/对话/教导/工作流/RAG）
│   ├── db.py                  # SQLite schema + DAO
│   ├── requirements.txt
│   └── memory/                # 种子 JSON + omniagent.db
├── frontend/
│   ├── omniagent.user.js      # Userscript 加载器
│   ├── omniagent.app.js       # 主面板脚本（UI + API 调用）
│   ├── vendor/
│   └── regression/
├── scripts/                   # 清理/审计脚本（可选）
├── start.sh / start.bat       # 一键启动后端（创建 venv + 安装依赖 + 启动）
└── .env                       # 运行时配置（Provider / 端口等）
```
