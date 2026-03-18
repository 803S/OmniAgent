#!/bin/bash

# OmniAgent 启动脚本
# 用法: ./start.sh [dev|prod|docker]

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${GREEN}===== OmniAgent 启动 =====${NC}"

# 检查 Python 版本
PYTHON_VERSION=$(python3 --version 2>&1 | awk '{print $2}')
echo -e "${YELLOW}Python 版本: $PYTHON_VERSION${NC}"

# 检查环境变量
if [ ! -f ".env" ]; then
    if [ -f "docker/.env.example" ]; then
        echo -e "${YELLOW}未找到 .env 文件，从示例创建...${NC}"
        cp docker/.env.example .env
        echo -e "${RED}请编辑 .env 文件填入 API 密钥！${NC}"
        exit 1
    fi
fi

# 加载环境变量
source .env 2>/dev/null || true

# 检查 API 密钥
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo -e "${RED}错误: ANTHROPIC_API_KEY 未设置${NC}"
    echo -e "${YELLOW}请在 .env 文件中设置 ANTHROPIC_API_KEY${NC}"
    exit 1
fi

# 安装依赖
echo -e "${GREEN}检查依赖...${NC}"
if [ ! -d "venv" ]; then
    echo -e "${YELLOW}创建虚拟环境...${NC}"
    python3 -m venv venv
fi

source venv/bin/activate
pip install -q -r requirements.txt 2>/dev/null || pip install -r requirements.txt

# 创建必要目录
mkdir -p memory/operations memory/vector_db memory/documents logs

# 判断启动模式
MODE=${1:-dev}

if [ "$MODE" = "docker" ]; then
    echo -e "${GREEN}启动 Docker 模式...${NC}"
    cd docker
    docker-compose up -d --build
    echo -e "${GREEN}服务已启动:${NC}"
    echo "  - OmniAgent: http://localhost:5000"
    echo "  - (可选) Qdrant: http://localhost:6333"
    echo "  - (可选) Redis: localhost:6379"
elif [ "$MODE" = "prod" ]; then
    echo -e "${GREEN}启动生产模式...${NC}"
    export FLASK_ENV=production
    export LOG_LEVEL=INFO
    nohup python server.py > logs/omniagent.log 2>&1 &
    echo -e "${GREEN}服务已启动: http://localhost:5000${NC}"
    echo -e "${YELLOW}日志: logs/omniagent.log${NC}"
else
    echo -e "${GREEN}启动开发模式...${NC}"
    export FLASK_ENV=development
    export LOG_LEVEL=DEBUG
    python server.py
fi