#!/bin/bash

echo "🤖 OpenCode Telegram Bot 启动脚本"
echo "================================"
echo ""

# 检查 .env 文件
if [ ! -f .env ]; then
    echo "⚠️  未找到 .env 文件"
    echo "   正在从 .env.example 复制..."
    cp .env.example .env
    echo "   请编辑 .env 文件配置 Telegram Bot Token"
    echo ""
fi

# 检查 node_modules
if [ ! -d "node_modules" ]; then
    echo "📦 正在安装依赖..."
    npm install
    echo ""
fi

# 检查 OpenCode 服务器
echo "🔍 检查 OpenCode 服务器..."
if curl -s http://localhost:4096/health > /dev/null 2>&1; then
    echo "✅ OpenCode 服务器已运行"
else
    echo "⚠️  OpenCode 服务器未运行"
    echo "   请在另一个终端运行: opencode web --port 4096"
    echo ""
fi

echo "🚀 正在启动 Bot..."
echo "   按 Ctrl+C 停止"
echo ""

npm start
