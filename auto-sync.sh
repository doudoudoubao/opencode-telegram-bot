#!/bin/bash
# 自动监控文件变化并提交推送到GitHub

REPO_DIR="/root/关联TG/opencode-telegram-bot"
cd "$REPO_DIR"

echo "开始监控文件变化..."
echo "按 Ctrl+C 停止监控"

while true; do
    # 监控文件变化（排除.git目录和node_modules）
    inotifywait -r -e modify,create,delete,move \
        --exclude '(\.git|node_modules)' \
        --format '%w%f' \
        . 2>/dev/null
    
    # 等待2秒，避免频繁提交
    sleep 2
    
    # 检查是否有变化
    if [ -n "$(git status --porcelain)" ]; then
        echo "检测到文件变化，正在提交..."
        git add .
        timestamp=$(date '+%Y-%m-%d %H:%M:%S')
        git commit -m "自动提交: $timestamp"
        echo "已自动提交并推送到GitHub"
    fi
done