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
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'anthropic/claude-3-5-sonnet-20241022';
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
        text += `\n调用工具: ${part.toolInvocation?.toolName || '未知'}`;
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
          { text: '新建会话', callback_data: 'cmd_new' },
          { text: '会话列表', callback_data: 'cmd_list' }
        ],
        [
          { text: '当前会话', callback_data: 'cmd_current' },
          { text: '选择模型', callback_data: 'cmd_model' }
        ],
        [
          { text: '可用模型', callback_data: 'cmd_models' },
          { text: '帮助', callback_data: 'cmd_help' }
        ]
      ]
    }
  };
}

async function handleStart(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!checkAccess(userId)) {
    await bot.sendMessage(chatId, '您没有权限使用此机器人');
    return;
  }
  
  const welcomeMessage = `OpenCode Telegram Bot

欢迎使用 OpenCode Telegram Bot！

点击下方按钮或直接发送消息与 AI 对话：`;
  
  await bot.sendMessage(chatId, welcomeMessage, getMainMenuKeyboard());
}

async function handleHelp(msg) {
  const chatId = msg.chat.id;
  
  const helpMessage = `命令详解

会话管理:
/new - 创建新的对话会话
/new <名称> - 创建指定名称的会话
/list - 显示所有会话列表
/current - 显示当前活动会话
/switch <编号> - 切换到指定会话
/delete <编号> - 删除指定会话

模型选择:
/model - 显示模型选择菜单
/models - 列出所有可用模型

文件操作:
/search <关键词> - 搜索文件
/read <文件路径> - 读取文件内容

提示:
- 直接发送消息即可与 AI 对话
- 点击按钮快速操作`;
  
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '返回主菜单', callback_data: 'cmd_menu' }]
      ]
    }
  };
  
  await bot.sendMessage(chatId, helpMessage, keyboard);
}

async function handleNewSession(msg, match) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!checkAccess(userId)) {
    await bot.sendMessage(chatId, '您没有权限使用此机器人');
    return;
  }
  
  const customName = match && match[1] ? match[1].trim() : null;
  
  try {
    const title = customName || `Telegram会话 ${new Date().toLocaleString('zh-CN')}`;
    
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
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '开始对话', callback_data: 'cmd_chat' },
              { text: '会话列表', callback_data: 'cmd_list' }
            ],
            [{ text: '返回主菜单', callback_data: 'cmd_menu' }]
          ]
        }
      };
      
      await bot.sendMessage(chatId, `新会话已创建: ${formatSession(session)}`, keyboard);
    } else {
      await bot.sendMessage(chatId, '创建会话失败');
    }
  } catch (error) {
    log.error('创建会话失败:', error);
    await bot.sendMessage(chatId, `创建会话失败: ${error.message}`);
  }
}

async function handleListSessions(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!checkAccess(userId)) {
    await bot.sendMessage(chatId, '您没有权限使用此机器人');
    return;
  }
  
  try {
    const result = await client.session.list();
    
    if (result.data && result.data.length > 0) {
      let message = '会话列表:\n\n';
      
      const keyboardButtons = [];
      
      result.data.forEach((session, index) => {
        const currentId = userCurrentSession.get(userId);
        const isCurrent = currentId === session.id;
        const marker = isCurrent ? '>> ' : '';
        message += `${marker}${index + 1}. ${formatSession(session)}\n`;
        
        keyboardButtons.push([
          { text: `${index + 1}. ${session.title || '未命名'}`, callback_data: `switch_${index}` }
        ]);
      });
      
      message += '\n点击按钮切换会话';
      
      keyboardButtons.push([{ text: '返回主菜单', callback_data: 'cmd_menu' }]);
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: keyboardButtons
        }
      };
      
      await bot.sendMessage(chatId, message, keyboard);
    } else {
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '新建会话', callback_data: 'cmd_new' }],
            [{ text: '返回主菜单', callback_data: 'cmd_menu' }]
          ]
        }
      };
      
      await bot.sendMessage(chatId, '暂无会话，点击下方按钮创建', keyboard);
    }
  } catch (error) {
    log.error('获取会话列表失败:', error);
    await bot.sendMessage(chatId, `获取会话列表失败: ${error.message}`);
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
          [{ text: '新建会话', callback_data: 'cmd_new' }],
          [{ text: '返回主菜单', callback_data: 'cmd_menu' }]
        ]
      }
    };
    
    await bot.sendMessage(chatId, '当前没有活动会话', keyboard);
    return;
  }
  
  try {
    const result = await client.session.get({ path: { id: currentSessionId } });
    
    if (result.data) {
      const session = result.data;
      const model = userCurrentModel.get(userId) || DEFAULT_MODEL;
      
      const message = `当前会话:

名称: ${session.title || '未命名'}
ID: ${session.id}
模型: ${model}`;
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '切换模型', callback_data: 'cmd_model' },
              { text: '会话列表', callback_data: 'cmd_list' }
            ],
            [{ text: '返回主菜单', callback_data: 'cmd_menu' }]
          ]
        }
      };
      
      await bot.sendMessage(chatId, message, keyboard);
    }
  } catch (error) {
    log.error('获取当前会话失败:', error);
    await bot.sendMessage(chatId, `获取会话失败: ${error.message}`);
  }
}

async function handleSwitchSession(chatId, userId, index) {
  try {
    const result = await client.session.list();
    
    if (result.data && result.data[index]) {
      const session = result.data[index];
      userCurrentSession.set(userId, session.id);
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '开始对话', callback_data: 'cmd_chat' }],
            [{ text: '返回主菜单', callback_data: 'cmd_menu' }]
          ]
        }
      };
      
      await bot.sendMessage(chatId, `已切换到会话: ${formatSession(session)}`, keyboard);
    } else {
      await bot.sendMessage(chatId, '无效的会话编号');
    }
  } catch (error) {
    log.error('切换会话失败:', error);
    await bot.sendMessage(chatId, `切换会话失败: ${error.message}`);
  }
}

async function handleDeleteSession(chatId, userId, index) {
  try {
    const result = await client.session.list();
    
    if (result.data && result.data[index]) {
      const session = result.data[index];
      
      await client.session.delete({ path: { id: session.id } });
      
      const currentSessionId = userCurrentSession.get(userId);
      if (currentSessionId === session.id) {
        userCurrentSession.delete(userId);
      }
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '会话列表', callback_data: 'cmd_list' }],
            [{ text: '返回主菜单', callback_data: 'cmd_menu' }]
          ]
        }
      };
      
      await bot.sendMessage(chatId, `已删除会话: ${formatSession(session)}`, keyboard);
    } else {
      await bot.sendMessage(chatId, '无效的会话编号');
    }
  } catch (error) {
    log.error('删除会话失败:', error);
    await bot.sendMessage(chatId, `删除会话失败: ${error.message}`);
  }
}

async function handleModelSelection(chatId, userId) {
  if (!checkAccess(userId)) {
    await bot.sendMessage(chatId, '您没有权限使用此机器人');
    return;
  }
  
  try {
    const result = await client.config.providers();
    
    if (result.data && result.data.providers) {
      const providers = result.data.providers;
      const currentModel = userCurrentModel.get(userId) || DEFAULT_MODEL;
      
      let message = '可用模型:\n\n';
      
      const keyboardButtons = [];
      
      providers.forEach(provider => {
        message += `${provider.name || provider.id}:\n`;
        if (provider.models) {
          const modelsArray = Object.values(provider.models);
          modelsArray.forEach(model => {
            const isCurrent = `${provider.id}/${model.id}` === currentModel;
            const marker = isCurrent ? '>> ' : '';
            message += `${marker}  ${model.name || model.id}\n`;
            
            keyboardButtons.push([
              { text: `${isCurrent ? '>> ' : ''}${model.name || model.id}`, callback_data: `setmodel_${provider.id}/${model.id}` }
            ]);
          });
        }
        message += '\n';
      });
      
      message += `当前模型: ${currentModel}`;
      
      keyboardButtons.push([{ text: '返回主菜单', callback_data: 'cmd_menu' }]);
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: keyboardButtons
        }
      };
      
      await bot.sendMessage(chatId, message, keyboard);
    } else {
      await bot.sendMessage(chatId, '获取模型列表失败');
    }
  } catch (error) {
    log.error('获取模型列表失败:', error);
    await bot.sendMessage(chatId, `获取模型列表失败: ${error.message}`);
  }
}

async function handleSearchFiles(msg, match) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!checkAccess(userId)) {
    await bot.sendMessage(chatId, '您没有权限使用此机器人');
    return;
  }
  
  const query = match[1];
  
  if (!query) {
    await bot.sendMessage(chatId, '请指定搜索关键词，例如: /search function');
    return;
  }
  
  try {
    const result = await client.find.files({ query: { query } });
    
    if (result.data && result.data.length > 0) {
      let message = `搜索结果 (关键词: ${query}):\n\n`;
      
      result.data.slice(0, 20).forEach((file, index) => {
        message += `${index + 1}. ${file}\n`;
      });
      
      if (result.data.length > 20) {
        message += `\n... 还有 ${result.data.length - 20} 个结果`;
      }
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '返回主菜单', callback_data: 'cmd_menu' }]
          ]
        }
      };
      
      await bot.sendMessage(chatId, message, keyboard);
    } else {
      await bot.sendMessage(chatId, `未找到匹配 "${query}" 的文件`);
    }
  } catch (error) {
    log.error('搜索文件失败:', error);
    await bot.sendMessage(chatId, `搜索文件失败: ${error.message}`);
  }
}

async function handleReadFile(msg, match) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!checkAccess(userId)) {
    await bot.sendMessage(chatId, '您没有权限使用此机器人');
    return;
  }
  
  const filePath = match[1];
  
  if (!filePath) {
    await bot.sendMessage(chatId, '请指定文件路径，例如: /read src/index.ts');
    return;
  }
  
  try {
    const result = await client.file.read({ query: { path: filePath } });
    
    if (result.data && result.data.content) {
      const content = result.data.content;
      
      if (content.length > 4000) {
        const truncated = content.substring(0, 4000);
        await bot.sendMessage(chatId, 
          `文件: ${filePath}\n\n${truncated}\n\n文件内容过长，已截断显示`
        );
      } else {
        await bot.sendMessage(chatId, 
          `文件: ${filePath}\n\n${content}`
        );
      }
    } else {
      await bot.sendMessage(chatId, `无法读取文件: ${filePath}`);
    }
  } catch (error) {
    log.error('读取文件失败:', error);
    await bot.sendMessage(chatId, `读取文件失败: ${error.message}`);
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;
  
  if (!checkAccess(userId)) {
    await bot.sendMessage(chatId, '您没有权限使用此机器人');
    return;
  }
  
  const currentSessionId = userCurrentSession.get(userId);
  
  if (!currentSessionId) {
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '新建会话', callback_data: 'cmd_new' }],
          [{ text: '返回主菜单', callback_data: 'cmd_menu' }]
        ]
      }
    };
    
    await bot.sendMessage(chatId, '请先创建会话', keyboard);
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
      
      log.debug('API响应:', JSON.stringify(result.data, null, 2));
      log.debug('格式化后的响应:', response);
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '新建会话', callback_data: 'cmd_new' },
              { text: '会话列表', callback_data: 'cmd_list' }
            ],
            [
              { text: '当前会话', callback_data: 'cmd_current' },
              { text: '选择模型', callback_data: 'cmd_model' }
            ]
          ]
        }
      };
      
      const responseText = response || '(空响应)';
      
      if (responseText.length > 4000) {
        const truncated = responseText.substring(0, 4000);
        await bot.sendMessage(chatId, `${truncated}\n\n响应过长，已截断显示`, keyboard);
      } else {
        await bot.sendMessage(chatId, responseText, keyboard);
      }
    } else {
      log.error('API返回空数据:', result);
      await bot.sendMessage(chatId, '获取响应失败，请重试');
    }
  } catch (error) {
    log.error('发送消息失败:', error);
    await bot.sendMessage(chatId, `发送消息失败: ${error.message}`);
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
  handleDeleteSession(msg.chat.id, msg.from.id, parseInt(match[1]) - 1);
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
    bot.sendMessage(chatId, `已切换模型: ${modelId}`);
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
    const welcomeMessage = `OpenCode Telegram Bot

点击下方按钮或直接发送消息与 AI 对话：`;
    
    await bot.sendMessage(chatId, welcomeMessage, getMainMenuKeyboard());
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
    await bot.sendMessage(chatId, '请直接发送消息与 AI 对话');
  } else if (data.startsWith('switch_')) {
    const index = parseInt(data.replace('switch_', ''));
    await handleSwitchSession(chatId, userId, index);
  } else if (data.startsWith('delete_')) {
    const index = parseInt(data.replace('delete_', ''));
    await handleDeleteSession(chatId, userId, index);
  } else if (data.startsWith('setmodel_')) {
    const modelId = data.replace('setmodel_', '');
    userCurrentModel.set(userId, modelId);
    await bot.sendMessage(chatId, `已切换模型: ${modelId}`);
  }
});

bot.on('message', (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  handleMessage(msg).catch(error => {
    log.error('处理消息失败:', error);
    bot.sendMessage(msg.chat.id, `处理消息失败: ${error.message}`);
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
          const timeout = setTimeout(() => controller.abort(), 300000); // 5分钟超时
          
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
