#!/bin/bash
# git.sh — 一键提交并推送代码到 GitHub

set -e

cd "$(dirname "$0")"

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${YELLOW}=== Git Push 工具 ===${NC}"
echo ""

# 检查是否有远程仓库
if ! git remote get-url origin > /dev/null 2>&1; then
    echo -e "${RED}错误: 未配置远程仓库 origin${NC}"
    exit 1
fi

# 显示当前状态
echo -e "${GREEN}当前分支:${NC} $(git branch --show-current)"
echo -e "${GREEN}远程仓库:${NC} $(git remote get-url origin)"
echo ""

# 检查是否有更改
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    echo -e "${GREEN}没有新的更改需要提交${NC}"
    echo ""
    read -p "是否直接 push 到远程? (y/N): " choice
    if [[ "$choice" =~ ^[Yy]$ ]]; then
        git push origin "$(git branch --show-current)"
        echo -e "${GREEN}推送完成!${NC}"
    fi
    exit 0
fi

# 显示更改摘要
echo -e "${YELLOW}更改摘要:${NC}"
echo "--- 已修改的文件 ---"
git diff --name-only
echo "--- 已暂存的文件 ---"
git diff --cached --name-only
echo "--- 未跟踪的文件 ---"
git ls-files --others --exclude-standard
echo ""

# 询问 commit message
if [ -n "$1" ]; then
    COMMIT_MSG="$1"
else
    read -p "输入 commit message (留空则自动生成): " COMMIT_MSG
fi

if [ -z "$COMMIT_MSG" ]; then
    # 自动生成 commit message
    TIMESTAMP=$(date "+%Y-%m-%d %H:%M")
    CHANGED_FILES=$(git diff --name-only | head -3 | tr '\n' ', ' | sed 's/,$//')
    if [ -z "$CHANGED_FILES" ]; then
        CHANGED_FILES=$(git ls-files --others --exclude-standard | head -3 | tr '\n' ', ' | sed 's/,$//')
    fi
    COMMIT_MSG="update: ${CHANGED_FILES} [${TIMESTAMP}]"
    echo -e "${GREEN}自动生成 commit message:${NC} $COMMIT_MSG"
fi

# 添加所有文件并提交
git add -A
git commit -m "$COMMIT_MSG"

# 推送到远程
echo ""
echo -e "${YELLOW}正在推送到远程...${NC}"
git push origin "$(git branch --show-current)"

echo ""
echo -e "${GREEN}✓ 完成! 代码已推送到 GitHub${NC}"
echo -e "${GREEN}  仓库: $(git remote get-url origin)${NC}"
