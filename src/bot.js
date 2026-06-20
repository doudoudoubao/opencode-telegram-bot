import TelegramBot from 'node-telegram-bot-api';
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENCODE_SERVER_URL = process.env.OPENCODE_SERVER_URL || 'http://localhost:4096';
const OPENCODE_SERVER_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || '';
const OPENCODE_SERVER_USERNAME = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'opencode/mimo-v2.5-free';
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS ? process.env.ALLOWED_USER_IDS.split(',').map(Number) : [];
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

if (!TELEGRAM_BOT_TOKEN) {
  console.error('错误: 请设置 TELEGRAM_BOT_TOKEN 环境变量');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

let client;
let opencodeServer;

function getAuthHeaders() {
  if (OPENCODE_SERVER_PASSWORD) {
    const auth = Buffer.from(`${OPENCODE_SERVER_USERNAME}:${OPENCODE_SERVER_PASSWORD}`).toString('base64');
    return { 'Authorization': `Basic ${auth}` };
  }
  return {};
}

const userSessions = new Map();
const userCurrentSession = new Map();
const userCurrentModel = new Map();
const userSessionHistory = new Map();

const log = {
  debug: (...args) => LOG_LEVEL === 'debug' && console.log('[DEBUG]', ...args),
  info: (...args) => ['debug', 'info'].includes(LOG_LEVEL) && console.log('[INFO]', ...args),
  warn: (...args) => ['debug', 'info', 'warn'].includes(LOG_LEVEL) && console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};

function checkAccess(userId) {
  if (ALLOWED_USER_IDS.length === 0) return true;
  return ALLOWED_USER_IDS.includes(userId);
}

function formatSession(session) {
  const title = session.title || '未命名会话';
  const id = session.id ? session.id.substring(0, 8) : 'unknown';
  return `${title} (${id})`;
}

function formatMessage(message, parts) {
  let text = '';
  
  if (parts && parts.length > 0) {
    for (const part of parts) {
      if (part.type === 'text') {
        text += part.text;
      } else if (part.type === 'tool-invocation') {
        text += `\n🔧 调用工具: ${part.toolInvocation?.toolName || '未知'}`;
      } else if (part.type === 'reasoning') {
        text += `\n💭 思考: ${part.text}`;
      }
    }
  }
  
  return text || message?.content || '';
}

function getMainMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📝 新建会话', callback_data: 'cmd_new' },
          { text: '📋 会话列表', callback_data: 'cmd_list' }
        ],
        [
          { text: '📌 当前会话', callback_data: 'cmd_current' },
          { text: '🤖 选择模型', callback_data: 'cmd_model' }
        ],
        [
          { text: '🔍 搜索文件', callback_data: 'cmd_search' },
          { text: '📖 读取文件', callback_data: 'cmd_read' }
        ],
        [
          { text: '❓ 帮助', callback_data: 'cmd_help' },
          { text: '🔄 刷新', callback_data: 'cmd_refresh' }
        ]
      ]
    }
  };
}

function getBackKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔙 返回主菜单', callback_data: 'cmd_menu' }]
      ]
    }
  };
}

function getSessionKeyboard(sessionId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '💬 开始对话', callback_data: 'cmd_chat' },
          { text: '📊 会话详情', callback_data: `session_info_${sessionId}` }
        ],
        [
          { text: '🗑️ 删除会话', callback_data: `delete_${sessionId}` },
          { text: '📤 分享会话', callback_data: `share_${sessionId}` }
        ],
        [
          { text: '🔙 返回会话列表', callback_data: 'cmd_list' },
          { text: '🏠 主菜单', callback_data: 'cmd_menu' }
        ]
      ]
    }
  };
}

function getChatKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📝 新建会话', callback_data: 'cmd_new' },
          { text: '📋 会话列表', callback_data: 'cmd_list' }
        ],
        [
          { text: '📌 当前会话', callback_data: 'cmd_current' },
          { text: '🤖 切换模型', callback_data: 'cmd_model' }
        ],
        [
          { text: '🔄 重新生成', callback_data: 'cmd_regenerate' },
          { text: '🗑️ 清空上下文', callback_data: 'cmd_clear' }
        ],
        [
          { text: '🏠 主菜单', callback_data: 'cmd_menu' }
        ]
      ]
    }
  };
}

async function handleStart(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!checkAccess(userId)) {
    await bot.sendMessage(chatId, '⛔ 您没有权限使用此机器人');
    return;
  }
  
  const welcomeMessage = `🤖 *OpenCode AI 助手*

欢迎使用 OpenCode Telegram Bot！

我可以帮助您：
• 💬 与 AI 进行智能对话
• 📝 管理多个会话
• 🤖 切换不同的 AI 模型
• 🔍 搜索和读取项目文件
• 🛠️ 执行各种开发任务

点击下方按钮开始使用：`;
  
  await bot.sendMessage(chatId, welcomeMessage, { 
    parse_mode: 'Markdown',
    ...getMainMenuKeyboard() 
  });
}

async function handleHelp(msg) {
  const chatId = msg.chat.id;
  
  const helpMessage = `📖 *使用指南*

*会话管理:*
• /new - 创建新的对话会话
• /new <名称> - 创建指定名称的会话
• /list - 显示所有会话列表
• /current - 显示当前活动会话
• /switch <编号> - 切换到指定会话
• /delete <编号> - 删除指定会话

*模型选择:*
• /model - 显示模型选择菜单
• /models - 列出所有可用模型
• /model <provider/model> - 切换模型

*文件操作:*
• /search <关键词> - 搜索文件
• /read <文件路径> - 读取文件内容

*快捷操作:*
• 直接发送消息与 AI 对话
• 点击按钮快速操作
• 支持图片和文件上传

*提示:*
• 使用 /new 创建新会话后才能开始对话
• 可以用 /model 切换不同的 AI 模型
• 支持多种 AI 模型，包括免费模型`;
  
  await bot.sendMessage(chatId, helpMessage, { 
    parse_mode: 'Markdown',
    ...getBackKeyboard() 
  });
}

async function handleNewSession(msg, match) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!checkAccess(userId)) {
    await bot.sendMessage(chatId, '⛔ 您没有权限使用此机器人');
    return;
  }
  
  const customName = match && match[1] ? match[1].trim() : null;
  
  try {
    const title = customName || `会话 ${new Date().toLocaleString('zh-CN', { 
      month: 'short', 
      day: 'numeric', 
      hour: '2-digit', 
      minute: '2-digit' 
    })}`;
    
    const result = await client.session.create({
      body: { title }
    });
    
    if (result.data) {
      const session = result.data;
      userCurrentSession.set(userId, session.id);
      
      if (!userSessions.has(userId)) {
        userSessions.set(userId, []);
      }
      userSessions.get(userId).push(session);
      
      const message = `✅ *新会话已创建*

📋 *会话信息:*
• 名称: ${session.title}
• ID: ${session.id.substring(0, 12)}...
• 模型: ${userCurrentModel.get(userId) || DEFAULT_MODEL}

现在您可以直接发送消息与 AI 对话了！`;
      
      await bot.sendMessage(chatId, message, { 
        parse_mode: 'Markdown',
        ...getSessionKeyboard(session.id) 
      });
    } else {
      await bot.sendMessage(chatId, '❌ 创建会话失败');
    }
  } catch (error) {
    log.error('创建会话失败:', error);
    await bot.sendMessage(chatId, `❌ 创建会话失败: ${error.message}`);
  }
}

async function handleListSessions(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!checkAccess(userId)) {
    await bot.sendMessage(chatId, '⛔ 您没有权限使用此机器人');
    return;
  }
  
  try {
    const result = await client.session.list();
    
    if (result.data && result.data.length > 0) {
      let message = '📋 *会话列表*\n\n';
      
      const keyboardButtons = [];
      
      result.data.forEach((session, index) => {
        const currentId = userCurrentSession.get(userId);
        const isCurrent = currentId === session.id;
        const marker = isCurrent ? '➡️' : '•';
        const model = session.model ? `${session.model.providerID}/${session.model.id}` : '未知';
        
        message += `${marker} *${index + 1}.* ${session.title || '未命名'}\n`;
        message += `   📊 模型: ${model}\n`;
        message += `   🆔 ${session.id.substring(0, 12)}...\n\n`;
        
        keyboardButtons.push([
          { text: `${isCurrent ? '➡️' : '📌'} ${index + 1}. ${session.title || '未命名'}`, callback_data: `switch_${index}` },
          { text: '🗑️', callback_data: `delete_confirm_${index}` }
        ]);
      });
      
      message += `📊 *统计:* 共 ${result.data.length} 个会话`;
      
      keyboardButtons.push([
        { text: '📝 新建会话', callback_data: 'cmd_new' },
        { text: '🔄 刷新列表', callback_data: 'cmd_list' }
      ]);
      keyboardButtons.push([{ text: '🏠 主菜单', callback_data: 'cmd_menu' }]);
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: keyboardButtons
        }
      };
      
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📝 创建第一个会话', callback_data: 'cmd_new' }],
            [{ text: '🏠 主菜单', callback_data: 'cmd_menu' }]
          ]
        }
      };
      
      await bot.sendMessage(chatId, '📭 *暂无会话*\n\n点击下方按钮创建您的第一个会话！', { 
        parse_mode: 'Markdown', 
        ...keyboard 
      });
    }
  } catch (error) {
    log.error('获取会话列表失败:', error);
    await bot.sendMessage(chatId, `❌ 获取会话列表失败: ${error.message}`);
  }
}

async function handleCurrentSession(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  const currentSessionId = userCurrentSession.get(userId);
  
  if (!currentSessionId) {
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📝 创建新会话', callback_data: 'cmd_new' }],
          [{ text: '📋 查看会话列表', callback_data: 'cmd_list' }],
          [{ text: '🏠 主菜单', callback_data: 'cmd_menu' }]
        ]
      }
    };
    
    await bot.sendMessage(chatId, '📌 *当前没有活动会话*\n\n请先创建或选择一个会话', { 
      parse_mode: 'Markdown', 
      ...keyboard 
    });
    return;
  }
  
  try {
    const result = await client.session.get({ path: { id: currentSessionId } });
    
    if (result.data) {
      const session = result.data;
      const model = userCurrentModel.get(userId) || DEFAULT_MODEL;
      const messages = session.tokens ? session.tokens.total : 0;
      const cost = session.cost ? session.cost.toFixed(4) : '0.0000';
      
      const message = `📌 *当前会话详情*

📋 *基本信息:*
• 名称: ${session.title || '未命名'}
• ID: ${session.id}
• 模型: ${model}

📊 *使用统计:*
• 消息数: ${messages}
• 费用: $${cost}
• 创建时间: ${new Date(session.time?.created).toLocaleString('zh-CN')}

💡 *提示:* 直接发送消息即可与 AI 对话`;
      
      await bot.sendMessage(chatId, message, { 
        parse_mode: 'Markdown',
        ...getSessionKeyboard(session.id) 
      });
    }
  } catch (error) {
    log.error('获取当前会话失败:', error);
    await bot.sendMessage(chatId, `❌ 获取会话失败: ${error.message}`);
  }
}

async function handleSwitchSession(chatId, userId, index) {
  try {
    const result = await client.session.list();
    
    if (result.data && result.data[index]) {
      const session = result.data[index];
      userCurrentSession.set(userId, session.id);
      
      const message = `✅ *已切换会话*

📋 *会话信息:*
• 名称: ${session.title || '未命名'}
• ID: ${session.id.substring(0, 12)}...
• 模型: ${session.model ? `${session.model.providerID}/${session.model.id}` : '未知'}

现在您可以直接发送消息与 AI 对话了！`;
      
      await bot.sendMessage(chatId, message, { 
        parse_mode: 'Markdown',
        ...getSessionKeyboard(session.id) 
      });
    } else {
      await bot.sendMessage(chatId, '❌ 无效的会话编号');
    }
  } catch (error) {
    log.error('切换会话失败:', error);
    await bot.sendMessage(chatId, `❌ 切换会话失败: ${error.message}`);
  }
}

async function handleDeleteSession(chatId, userId, sessionId) {
  try {
    await client.session.delete({ path: { id: sessionId } });
    
    const currentSessionId = userCurrentSession.get(userId);
    if (currentSessionId === sessionId) {
      userCurrentSession.delete(userId);
    }
    
    const message = `✅ *会话已删除*

会话已成功删除。您可以：
• 创建新会话
• 选择其他会话继续对话`;
    
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 新建会话', callback_data: 'cmd_new' },
            { text: '📋 会话列表', callback_data: 'cmd_list' }
          ],
          [{ text: '🏠 主菜单', callback_data: 'cmd_menu' }]
        ]
      }
    };
    
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...keyboard });
  } catch (error) {
    log.error('删除会话失败:', error);
    await bot.sendMessage(chatId, `❌ 删除会话失败: ${error.message}`);
  }
}

async function handleModelSelection(chatId, userId) {
  if (!checkAccess(userId)) {
    await bot.sendMessage(chatId, '⛔ 您没有权限使用此机器人');
    return;
  }
  
  try {
    const result = await client.config.providers();
    
    if (result.data && result.data.providers) {
      const providers = result.data.providers;
      const currentModel = userCurrentModel.get(userId) || DEFAULT_MODEL;
      
      let message = '🤖 *可用模型列表*\n\n';
      
      const keyboardButtons = [];
      
      providers.forEach(provider => {
        message += `*${provider.name || provider.id}:*\n`;
        if (provider.models) {
          const modelsArray = Object.values(provider.models);
          modelsArray.forEach(model => {
            const fullModelId = `${provider.id}/${model.id}`;
            const isCurrent = fullModelId === currentModel;
            const marker = isCurrent ? '✅' : '•';
            const capabilities = [];
            
            if (model.capabilities?.reasoning) capabilities.push('🧠');
            if (model.capabilities?.toolcall) capabilities.push('🛠️');
            if (model.capabilities?.attachment) capabilities.push('📎');
            
            message += `${marker} ${model.name || model.id} ${capabilities.join('')}\n`;
            
            keyboardButtons.push([
              { 
                text: `${isCurrent ? '✅' : '🤖'} ${model.name || model.id}`, 
                callback_data: `setmodel_${fullModelId}` 
              }
            ]);
          });
        }
        message += '\n';
      });
      
      message += `📌 *当前模型:* ${currentModel}\n\n`;
      message += '💡 *提示:* 点击模型名称即可切换';
      
      keyboardButtons.push([{ text: '🔙 返回主菜单', callback_data: 'cmd_menu' }]);
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: keyboardButtons
        }
      };
      
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await bot.sendMessage(chatId, '❌ 获取模型列表失败');
    }
  } catch (error) {
    log.error('获取模型列表失败:', error);
    await bot.sendMessage(chatId, `❌ 获取模型列表失败: ${error.message}`);
  }
}

async function handleSearchFiles(msg, match) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!checkAccess(userId)) {
    await bot.sendMessage(chatId, '⛔ 您没有权限使用此机器人');
    return;
  }
  
  const query = match[1];
  
  if (!query) {
    await bot.sendMessage(chatId, '🔍 *搜索文件*\n\n请指定搜索关键词\n\n例如: /search function', { parse_mode: 'Markdown' });
    return;
  }
  
  try {
    const result = await client.find.files({ query: { query } });
    
    if (result.data && result.data.length > 0) {
      let message = `🔍 *搜索结果*\n\n📋 *关键词:* ${query}\n📊 *找到:* ${result.data.length} 个文件\n\n`;
      
      const keyboardButtons = [];
      
      result.data.slice(0, 10).forEach((file, index) => {
        const fileName = file.split('/').pop();
        message += `${index + 1}. 📄 ${fileName}\n   📍 ${file}\n\n`;
        
        keyboardButtons.push([
          { text: `📖 读取 ${fileName}`, callback_data: `read_${Buffer.from(file).toString('base64')}` }
        ]);
      });
      
      if (result.data.length > 10) {
        message += `\n... 还有 ${result.data.length - 10} 个结果`;
      }
      
      keyboardButtons.push([{ text: '🔙 返回主菜单', callback_data: 'cmd_menu' }]);
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: keyboardButtons
        }
      };
      
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await bot.sendMessage(chatId, `📭 *未找到结果*\n\n未找到匹配 "${query}" 的文件`, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    log.error('搜索文件失败:', error);
    await bot.sendMessage(chatId, `❌ 搜索文件失败: ${error.message}`);
  }
}

async function handleReadFile(msg, match) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!checkAccess(userId)) {
    await bot.sendMessage(chatId, '⛔ 您没有权限使用此机器人');
    return;
  }
  
  const filePath = match[1];
  
  if (!filePath) {
    await bot.sendMessage(chatId, '📖 *读取文件*\n\n请指定文件路径\n\n例如: /read src/index.ts', { parse_mode: 'Markdown' });
    return;
  }
  
  try {
    const result = await client.file.read({ query: { path: filePath } });
    
    if (result.data && result.data.content) {
      const content = result.data.content;
      const fileName = filePath.split('/').pop();
      const lines = content.split('\n').length;
      const size = content.length;
      
      let message = `📖 *文件内容*\n\n`;
      message += `📄 *文件:* ${fileName}\n`;
      message += `📍 *路径:* ${filePath}\n`;
      message += `📊 *统计:* ${lines} 行, ${size} 字符\n\n`;
      message += `---\n\n`;
      
      if (content.length > 3500) {
        const truncated = content.substring(0, 3500);
        message += `\`\`\`\n${truncated}\n\`\`\`\n\n⚠️ *文件内容过长，已截断显示*`;
      } else {
        message += `\`\`\`\n${content}\n\`\`\``;
      }
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔍 搜索文件', callback_data: 'cmd_search' },
              { text: '📖 读取其他文件', callback_data: 'cmd_read' }
            ],
            [{ text: '🔙 返回主菜单', callback_data: 'cmd_menu' }]
          ]
        }
      };
      
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await bot.sendMessage(chatId, `❌ *无法读取文件*\n\n文件不存在或无法访问: ${filePath}`, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    log.error('读取文件失败:', error);
    await bot.sendMessage(chatId, `❌ 读取文件失败: ${error.message}`);
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;
  
  if (!checkAccess(userId)) {
    await bot.sendMessage(chatId, '⛔ 您没有权限使用此机器人');
    return;
  }
  
  const currentSessionId = userCurrentSession.get(userId);
  
  if (!currentSessionId) {
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📝 创建新会话', callback_data: 'cmd_new' }],
          [{ text: '📋 查看会话列表', callback_data: 'cmd_list' }],
          [{ text: '🏠 主菜单', callback_data: 'cmd_menu' }]
        ]
      }
    };
    
    await bot.sendMessage(chatId, '📌 *请先创建会话*\n\n您需要先创建一个会话才能与 AI 对话', { 
      parse_mode: 'Markdown', 
      ...keyboard 
    });
    return;
  }
  
  const model = userCurrentModel.get(userId) || DEFAULT_MODEL;
  
  try {
    await bot.sendChatAction(chatId, 'typing');
    
    log.info('发送消息到会话:', currentSessionId);
    log.info('模型:', model);
    log.info('消息内容:', text);
    
    const result = await client.session.prompt({
      path: { id: currentSessionId },
      body: {
        model: { 
          providerID: model.split('/')[0], 
          modelID: model.split('/').slice(1).join('/') 
        },
        parts: [{ type: 'text', text: text }],
      },
    });
    
    log.info('API响应成功:', !!result.data);
    
    if (result.data) {
      const response = formatMessage(result.data.info, result.data.parts);
      
      const responseText = response || '(空响应)';
      
      if (responseText.length > 4000) {
        const truncated = responseText.substring(0, 4000);
        await bot.sendMessage(chatId, `${truncated}\n\n⚠️ *响应过长，已截断显示*`, { 
          parse_mode: 'Markdown',
          ...getChatKeyboard() 
        });
      } else {
        await bot.sendMessage(chatId, responseText, { 
          parse_mode: 'Markdown',
          ...getChatKeyboard() 
        });
      }
    } else {
      log.error('API返回空数据:', result);
      await bot.sendMessage(chatId, '❌ *获取响应失败*\n\n请重试或检查服务器状态', { 
        parse_mode: 'Markdown',
        ...getChatKeyboard() 
      });
    }
  } catch (error) {
    log.error('发送消息失败:', error);
    await bot.sendMessage(chatId, `❌ *发送消息失败*\n\n${error.message}`, { 
      parse_mode: 'Markdown',
      ...getChatKeyboard() 
    });
  }
}

async function handleShareSession(chatId, userId, sessionId) {
  try {
    const result = await client.session.share({ path: { id: sessionId } });
    
    if (result.data) {
      const session = result.data;
      const shareUrl = `https://opencode.ai/s/${session.slug}`;
      
      const message = `📤 *会话已分享*

🔗 *分享链接:*
${shareUrl}

📋 *会话信息:*
• 名称: ${session.title}
• ID: ${session.id.substring(0, 12)}...

⚠️ *注意:* 分享的会话将公开可见`;
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔗 打开链接', url: shareUrl }],
            [{ text: '🔙 返回会话', callback_data: `session_info_${sessionId}` }],
            [{ text: '🏠 主菜单', callback_data: 'cmd_menu' }]
          ]
        }
      };
      
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (error) {
    log.error('分享会话失败:', error);
    await bot.sendMessage(chatId, `❌ 分享会话失败: ${error.message}`);
  }
}

async function handleSessionInfo(chatId, userId, sessionId) {
  try {
    const result = await client.session.get({ path: { id: sessionId } });
    
    if (result.data) {
      const session = result.data;
      const model = session.model ? `${session.model.providerID}/${session.model.id}` : '未知';
      const tokens = session.tokens || {};
      const cost = session.cost ? session.cost.toFixed(4) : '0.0000';
      
      const message = `📊 *会话详情*

📋 *基本信息:*
• 名称: ${session.title || '未命名'}
• ID: ${session.id}
• 模型: ${model}
• 状态: ${session.status || '活跃'}

📊 *使用统计:*
• 输入 Tokens: ${tokens.input || 0}
• 输出 Tokens: ${tokens.output || 0}
• 总 Tokens: ${tokens.total || 0}
• 费用: $${cost}

⏰ *时间信息:*
• 创建时间: ${new Date(session.time?.created).toLocaleString('zh-CN')}
• 更新时间: ${new Date(session.time?.updated).toLocaleString('zh-CN')}

📁 *项目信息:*
• 目录: ${session.directory || '未知'}
• 路径: ${session.path || '未知'}`;
      
      await bot.sendMessage(chatId, message, { 
        parse_mode: 'Markdown',
        ...getSessionKeyboard(sessionId) 
      });
    }
  } catch (error) {
    log.error('获取会话详情失败:', error);
    await bot.sendMessage(chatId, `❌ 获取会话详情失败: ${error.message}`);
  }
}

async function handleDeleteConfirm(chatId, userId, index) {
  try {
    const result = await client.session.list();
    
    if (result.data && result.data[index]) {
      const session = result.data[index];
      
      const message = `⚠️ *确认删除*

您确定要删除以下会话吗？

📋 *会话信息:*
• 名称: ${session.title || '未命名'}
• ID: ${session.id.substring(0, 12)}...

⚠️ *警告:* 此操作不可恢复！`;
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ 确认删除', callback_data: `delete_${session.id}` },
              { text: '❌ 取消', callback_data: 'cmd_list' }
            ],
            [{ text: '🏠 主菜单', callback_data: 'cmd_menu' }]
          ]
        }
      };
      
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (error) {
    log.error('获取会话信息失败:', error);
    await bot.sendMessage(chatId, `❌ 获取会话信息失败: ${error.message}`);
  }
}

bot.onText(/\/start/, handleStart);
bot.onText(/\/help/, handleHelp);
bot.onText(/\/new\s*(.*)/, handleNewSession);
bot.onText(/\/list/, handleListSessions);
bot.onText(/\/current/, handleCurrentSession);
bot.onText(/\/switch (\d+)/, (msg, match) => {
  handleSwitchSession(msg.chat.id, msg.from.id, parseInt(match[1]) - 1);
});
bot.onText(/\/delete (\d+)/, (msg, match) => {
  handleDeleteConfirm(msg.chat.id, msg.from.id, parseInt(match[1]) - 1);
});
bot.onText(/\/models/, (msg) => {
  handleModelSelection(msg.chat.id, msg.from.id);
});
bot.onText(/\/model (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const modelId = match[1];
  
  if (modelId) {
    userCurrentModel.set(userId, modelId);
    bot.sendMessage(chatId, `✅ *已切换模型*\n\n📌 *当前模型:* ${modelId}`, { 
      parse_mode: 'Markdown',
      ...getBackKeyboard() 
    });
  }
});
bot.onText(/\/model$/, (msg) => {
  handleModelSelection(msg.chat.id, msg.from.id);
});
bot.onText(/\/search (.+)/, handleSearchFiles);
bot.onText(/\/read (.+)/, handleReadFile);

bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  
  await bot.answerCallbackQuery(callbackQuery.id);
  
  if (data === 'cmd_menu') {
    const welcomeMessage = `🤖 *OpenCode AI 助手*

点击下方按钮开始使用：`;
    
    await bot.sendMessage(chatId, welcomeMessage, { 
      parse_mode: 'Markdown',
      ...getMainMenuKeyboard() 
    });
  } else if (data === 'cmd_new') {
    await handleNewSession({ chat: { id: chatId }, from: { id: userId } }, [null, null]);
  } else if (data === 'cmd_list') {
    await handleListSessions({ chat: { id: chatId }, from: { id: userId } });
  } else if (data === 'cmd_current') {
    await handleCurrentSession({ chat: { id: chatId }, from: { id: userId } });
  } else if (data === 'cmd_model') {
    await handleModelSelection(chatId, userId);
  } else if (data === 'cmd_models') {
    await handleModelSelection(chatId, userId);
  } else if (data === 'cmd_help') {
    await handleHelp({ chat: { id: chatId } });
  } else if (data === 'cmd_chat') {
    await bot.sendMessage(chatId, '💬 *开始对话*\n\n请直接发送消息与 AI 对话', { 
      parse_mode: 'Markdown',
      ...getChatKeyboard() 
    });
  } else if (data === 'cmd_refresh') {
    await bot.sendMessage(chatId, '🔄 *已刷新*\n\n界面已更新', { 
      parse_mode: 'Markdown',
      ...getMainMenuKeyboard() 
    });
  } else if (data === 'cmd_search') {
    await bot.sendMessage(chatId, '🔍 *搜索文件*\n\n请发送搜索关键词\n\n例如: function, index.ts, config', { parse_mode: 'Markdown' });
  } else if (data === 'cmd_read') {
    await bot.sendMessage(chatId, '📖 *读取文件*\n\n请发送文件路径\n\n例如: src/index.ts, package.json', { parse_mode: 'Markdown' });
  } else if (data === 'cmd_regenerate') {
    await bot.sendMessage(chatId, '🔄 *重新生成*\n\n请重新发送您的问题', { 
      parse_mode: 'Markdown',
      ...getChatKeyboard() 
    });
  } else if (data === 'cmd_clear') {
    await bot.sendMessage(chatId, '🗑️ *上下文已清空*\n\n请重新开始对话', { 
      parse_mode: 'Markdown',
      ...getChatKeyboard() 
    });
  } else if (data.startsWith('switch_')) {
    const index = parseInt(data.replace('switch_', ''));
    await handleSwitchSession(chatId, userId, index);
  } else if (data.startsWith('delete_confirm_')) {
    const index = parseInt(data.replace('delete_confirm_', ''));
    await handleDeleteConfirm(chatId, userId, index);
  } else if (data.startsWith('delete_')) {
    const sessionId = data.replace('delete_', '');
    await handleDeleteSession(chatId, userId, sessionId);
  } else if (data.startsWith('setmodel_')) {
    const modelId = data.replace('setmodel_', '');
    userCurrentModel.set(userId, modelId);
    await bot.sendMessage(chatId, `✅ *已切换模型*\n\n📌 *当前模型:* ${modelId}`, { 
      parse_mode: 'Markdown',
      ...getBackKeyboard() 
    });
  } else if (data.startsWith('session_info_')) {
    const sessionId = data.replace('session_info_', '');
    await handleSessionInfo(chatId, userId, sessionId);
  } else if (data.startsWith('share_')) {
    const sessionId = data.replace('share_', '');
    await handleShareSession(chatId, userId, sessionId);
  } else if (data.startsWith('read_')) {
    const filePath = Buffer.from(data.replace('read_', ''), 'base64').toString();
    await handleReadFile({ chat: { id: chatId }, from: { id: userId } }, [null, filePath]);
  }
});

bot.on('message', (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  handleMessage(msg).catch(error => {
    log.error('处理消息失败:', error);
    bot.sendMessage(msg.chat.id, `❌ 处理消息失败: ${error.message}`);
  });
});

bot.on('polling_error', (error) => {
  log.error('轮询错误:', error);
});

async function main() {
  try {
    console.log('正在启动 OpenCode 服务器...');
    
    const opencode = await createOpencode({
      hostname: '127.0.0.1',
      port: 4096,
    });
    
    opencodeServer = opencode.server;
    client = opencode.client;
    
    console.log(`OpenCode 服务器已启动: ${opencodeServer.url}`);
    
    log.info('Telegram Bot 已启动');
    console.log('Bot 已启动，等待消息...');
  } catch (error) {
    log.error('启动 OpenCode 服务器失败:', error);
    console.error('启动失败:', error.message);
    
    console.log('尝试连接到现有服务器...');
    try {
      const headers = getAuthHeaders();
      client = createOpencodeClient({
        baseUrl: OPENCODE_SERVER_URL,
        fetch: async (url, options = {}) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 300000);
          
          try {
            const response = await globalThis.fetch(url, {
              ...options,
              headers: {
                ...options.headers,
                ...headers,
              },
              signal: controller.signal,
            });
            return response;
          } finally {
            clearTimeout(timeout);
          }
        },
      });
      console.log('已连接到现有服务器');
      console.log('Bot 已启动，等待消息...');
    } catch (connError) {
      console.error('无法连接到服务器:', connError.message);
      process.exit(1);
    }
  }
}

process.on('SIGINT', async () => {
  console.log('\n正在关闭...');
  if (opencodeServer) {
    await opencodeServer.close();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n正在关闭...');
  if (opencodeServer) {
    await opencodeServer.close();
  }
  process.exit(0);
});

main().catch(console.error);
