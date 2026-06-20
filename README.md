# OpenCode Telegram Bot

通过 Telegram 与 OpenCode AI 进行对话，支持会话管理、模型选择、文件操作等功能。

## 功能特性

- AI 对话: 直接在 Telegram 中与 AI 对话
- 会话管理: 创建、列出、切换、删除会话
- 自定义会话名称: 创建会话时可自定义名称
- 模型选择: 支持多种 AI 模型切换
- 文件操作: 搜索和读取项目文件
- 访问控制: 支持用户白名单

## 前置要求

1. Node.js: 版本 18 或更高
2. OpenCode: 已安装并运行
3. Telegram Bot Token: 从 @BotFather 获取

## 安装

```bash
cd opencode-telegram-bot
npm install
cp .env.example .env
```

## 配置

编辑 `.env` 文件：

```env
# Telegram Bot Token (从 @BotFather 获取)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

# OpenCode Server URL (默认本地)
OPENCODE_SERVER_URL=http://localhost:4096

# OpenCode Server Password (如果设置了密码)
OPENCODE_SERVER_PASSWORD=your_password_here

# 可选：默认模型
DEFAULT_MODEL=anthropic/claude-3-5-sonnet-20241022

# 可选：允许使用的用户ID (逗号分隔，留空则允许所有用户)
ALLOWED_USER_IDS=123456789,987654321

# 日志级别 (debug, info, warn, error)
LOG_LEVEL=info
```

## 启动

### 1. 启动 OpenCode 服务器

```bash
opencode web --port 4096
```

### 2. 启动 Telegram Bot

```bash
# 使用 PM2 启动 (推荐)
pm2 start src/bot.js --name opencode-telegram-bot

# 或直接启动
npm start
```

## 使用命令

### 会话管理

| 命令 | 说明 |
|------|------|
| `/new` | 创建新会话（自动生成名称） |
| `/new <名称>` | 创建指定名称的会话 |
| `/list` | 列出所有会话 |
| `/current` | 查看当前会话 |
| `/switch <编号>` | 切换到指定会话 |
| `/delete <编号>` | 删除指定会话 |

### 模型选择

| 命令 | 说明 |
|------|------|
| `/model` | 显示模型选择菜单 |
| `/model <provider/model>` | 切换到指定模型 |
| `/models` | 列出所有可用模型 |

### 文件操作

| 命令 | 说明 |
|------|------|
| `/search <关键词>` | 搜索文件 |
| `/read <文件路径>` | 读取文件内容 |

### 其他

| 命令 | 说明 |
|------|------|
| `/start` | 显示欢迎信息 |
| `/help` | 显示帮助信息 |

## 使用示例

```
# 创建新会话
/new

# 创建指定名称的会话
/new 我的项目会话

# 发送消息给 AI
你好，请帮我解释一下这段代码

# 切换模型
/model anthropic/claude-3-5-sonnet-20241022

# 搜索文件
/search function

# 读取文件
/read src/index.ts
```

## 获取 Telegram Bot Token

1. 在 Telegram 中搜索 @BotFather
2. 发送 `/newbot` 命令
3. 按提示输入机器人名称和用户名
4. 获取生成的 Token

## 获取用户 ID

1. 在 Telegram 中搜索 @userinfobot
2. 发送任意消息
3. 机器人会回复你的用户 ID

## PM2 管理命令

```bash
# 查看状态
pm2 status

# 查看日志
pm2 logs opencode-telegram-bot

# 重启
pm2 restart opencode-telegram-bot

# 停止
pm2 stop opencode-telegram-bot

# 删除
pm2 delete opencode-telegram-bot
```

## 故障排除

### 无法连接到 OpenCode 服务器

确保 OpenCode 服务器已启动：

```bash
opencode web --port 4096
```

### Bot 无响应

1. 检查 Telegram Bot Token 是否正确
2. 检查网络连接
3. 查看日志输出: `pm2 logs opencode-telegram-bot`

### 权限错误

检查 `.env` 文件中的 `ALLOWED_USER_IDS` 配置是否正确。

## 项目结构

```
opencode-telegram-bot/
├── src/
│   └── bot.js          # 主程序
├── .env.example        # 配置示例
├── .gitignore          # Git忽略文件
├── package.json        # 项目配置
├── start.sh            # 启动脚本
└── README.md           # 说明文档
```

## 许可证

ISC
