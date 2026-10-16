// 用户账号控制器 - 核心功能
// 条件导入telegram库（如果未安装则跳过）
let TelegramClient: any, StringSession: any, Api: any, telegram: any, Logger: any;
try {
  telegram = require('telegram');
  TelegramClient = telegram.TelegramClient;
  StringSession = telegram.sessions.StringSession;
  Api = telegram.Api;
  Logger = telegram.Logger; // 导入日志管理器
} catch (e) {
  console.warn('⚠️ telegram库未安装，账号控制功能不可用。运行: npm install telegram');
}

import { userAccountDb } from './database';
import { SendMessageTask } from './types';
import { database } from '../database';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// 后台任务接口
interface BackgroundTask {
  taskId: string;
  accountId: number;
  userId: number;
  keywords: string[];
  status: 'collecting' | 'scheduling' | 'sending' | 'completed' | 'failed';
  progress: number;
  total: number;
  startTime: number;
  collectedMessages: any[];
  scheduledGroups?: number; // 已调度的组数
  totalGroups?: number; // 总组数
  error?: string;
}

export class UserAccountController {
  private clients: Map<number, any> = new Map();
  private loginClients: Map<number, { client: any, phone?: string, phoneCodeHash?: string }> = new Map(); // 存储正在登录中的客户端
  private sessionsDir: string;
  private backgroundTasks: Map<string, BackgroundTask> = new Map(); // 后台任务队列

  constructor() {
    // 创建sessions目录
    this.sessionsDir = path.resolve(__dirname, '../../data/sessions');
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }

    // 🚀 核心优化：将 GramJS 内部日志级别设为 "error"
    // 这能彻底屏蔽掉由于网络抖动产生的无数 [TIMEOUT] 警告日志
    if (Logger) {
      Logger.setLevel("error");
    }
  }

  // ========== 原有逻辑的增强与修复 ==========

  // 验证Session字符串格式
  private validateSessionFormat(sessionString: string): { valid: boolean; error?: string } {
    const trimmed = sessionString.trim();
    if (!trimmed.startsWith('1')) return { valid: false, error: 'Session必须以"1"开头' };
    if (trimmed.length < 50) return { valid: false, error: 'Session长度至少需要50个字符' };
    return { valid: true };
  }

  // 使用Python脚本验证Session（真实验证）- 可选，用于预验证和获取用户信息
  private async verifySessionWithPython(
    sessionString: string,
    apiId: string,
    apiHash: string
  ): Promise<{ success: boolean; userInfo?: any; error?: string }> {
    try {
      // 检查Python是否可用
      let pythonCmd = '';
      try {
        execSync('python --version', { stdio: 'ignore' });
        pythonCmd = 'python';
      } catch {
        try {
          execSync('python3 --version', { stdio: 'ignore' });
          pythonCmd = 'python3';
        } catch {
          // 如果没有Python，返回null，后续使用Node.js验证
          return { success: true, userInfo: null };
        }
      }

      // 动态生成Python验证脚本
      const pythonScript = `
import sys
import json
from telethon import TelegramClient
from telethon.sessions import StringSession

try:
    api_id = ${parseInt(apiId)}
    api_hash = "${apiHash}"
    session_string = """${sessionString}"""
    
    client = TelegramClient(StringSession(session_string), api_id, api_hash)
    client.connect()
    
    if not client.is_user_authorized():
        print(json.dumps({"success": False, "error": "Session未授权"}))
        sys.exit(1)
    
    me = client.get_me()
    client.disconnect()
    
    result = {
        "success": True,
        "id": str(me.id),
        "first_name": me.first_name or "",
        "last_name": me.last_name or "",
        "username": me.username or "",
        "phone": me.phone or ""
    }
    print(json.dumps(result))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
`;

      // 执行Python脚本
      const output = execSync(pythonCmd, {
        input: pythonScript,
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const result = JSON.parse(output.trim());
      return result;
    } catch (error: any) {
      console.error('Python验证失败:', error);
      // Python验证失败不影响，后续使用Node.js验证
      return { success: true, userInfo: null };
    }
  }

  // 使用Node.js (gramjs) 验证Session并获取用户信息
  private async verifySessionWithNode(
    client: any
  ): Promise<{ success: boolean; userInfo?: any; error?: string }> {
    try {
      console.log(`      [验证] 检查授权状态...`);
      // 检查授权状态
      const isAuthorized = await client.checkAuthorization();
      console.log(`      [验证] 授权状态: ${isAuthorized ? '已授权' : '未授权'}`);
      
      if (!isAuthorized) {
        return { success: false, error: 'Session未授权' };
      }

      console.log(`      [验证] 获取用户信息...`);
      // 获取用户信息
      const me = await client.getMe();
      console.log(`      [验证] 用户信息获取成功: ID=${me.id}, Username=${me.username || '无'}`);
      
      return {
        success: true,
        userInfo: {
          id: me.id?.toString() || '',
          first_name: me.firstName || '',
          last_name: me.lastName || '',
          username: me.username || '',
          phone: me.phone || ''
        }
      };
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      console.error(`      [验证] 验证失败:`, errorMsg);
      console.error(`      [验证] 错误详情:`, error);
      return { success: false, error: errorMsg };
    }
  }

  // 启动时自动恢复所有已登录的账号（唯一登录方式）
  async autoRestoreAccounts(): Promise<void> {
    console.log('\n');
    console.log('========================================');
    console.log('🔄 [自动恢复] 开始自动恢复已登录的账号...');
    console.log('========================================');
    console.log('');
    
    try {
      console.log('[自动恢复] 正在从数据库加载账号列表...');
      const accounts = await userAccountDb.getAllAccounts();
      console.log(`[自动恢复] 数据库查询完成，找到 ${accounts.length} 个账号`);
      
      if (accounts.length === 0) {
        console.log('[自动恢复] 📭 没有找到已保存的账号');
        console.log('[自动恢复] 💡 提示：使用 /添加账号 命令添加第一个账号');
        console.log('');
        return;
      }

      console.log(`[自动恢复] 📋 找到 ${accounts.length} 个已保存的账号`);
      console.log('');

      let successCount = 0;
      let failCount = 0;

      // 按ID排序，确保激活账号优先处理
      const sortedAccounts = [...accounts].sort((a, b) => {
        if (a.is_active && !b.is_active) return -1;
        if (!a.is_active && b.is_active) return 1;
        return a.id - b.id;
      });

      for (const account of sortedAccounts) {
        try {
          // 跳过没有session的账号
          if (!account.session || !account.api_id || !account.api_hash) {
            console.log(`[自动恢复] ⚠️ 账号 ${account.id} (${account.nickname}) 缺少必要信息，跳过`);
            failCount++;
            continue;
          }

          // 检查是否已经连接（避免重复连接）
          if (this.clients.has(account.id)) {
            console.log(`[自动恢复] ✅ 账号 ${account.id} (${account.nickname}) 已连接，跳过`);
            successCount++;
            continue;
          }

          console.log(`[自动恢复] [${successCount + failCount + 1}/${accounts.length}] 🔄 正在恢复账号: ${account.nickname}...`);
          console.log(`[自动恢复]    账号ID: ${account.id}`);
          console.log(`[自动恢复]    API ID: ${account.api_id}`);
          console.log(`[自动恢复]    Session长度: ${account.session.length} 字符`);

          // 使用完整的登录方法（包含格式验证和Python验证，确保登录稳定）
          const result = await this.loginWithSession(
            account.id,
            account.api_id,
            account.api_hash,
            account.session,
            account.phone
          );

          if (result.success) {
            console.log(`[自动恢复]    ✅ 账号恢复成功`);
            successCount++;
            
            // 如果是激活账号，启动额外服务
            if (account.is_active) {
              // 1. 恢复自动回复
              const autoReplyConfig = await userAccountDb.getAutoReply(account.id);
              if (autoReplyConfig && autoReplyConfig.is_enabled) {
                await this.enableAutoReply(account.id);
              }

              // 2. 🚀 启动实时同步流监听 (如果配置了持久化群组)
              const config = require('../config').config;
              if (config.persistentGroupId) {
                this.startLiveIndexer(config.persistentGroupId);
              }
            }
          } else {
            console.log(`[自动恢复]    ❌ 恢复失败: ${result.error}`);
            failCount++;
            
            // 如果恢复失败且是激活账号，给出提示
            if (account.is_active) {
              console.log(`[自动恢复]    ⚠️ 激活账号恢复失败，但保持激活状态`);
              console.log(`[自动恢复]    💡 建议：检查Session是否过期，或使用 /添加账号 重新登录`);
            }
          }
          console.log(''); // 空行分隔
        } catch (error: any) {
          console.error(`[自动恢复]    ❌ 恢复时出错:`, error?.message || error);
          failCount++;
          console.log(''); // 空行分隔
        }
      }

      console.log('[自动恢复] ========================================');
      console.log(`[自动恢复] ✅ 账号恢复完成`);
      console.log(`[自动恢复]    成功: ${successCount} 个`);
      console.log(`[自动恢复]    失败: ${failCount} 个`);
      console.log('[自动恢复] ========================================');
      console.log('');

      // 检查激活账号状态
      console.log('[自动恢复] 检查激活账号状态...');
      const activeAccount = await userAccountDb.getActiveAccount();
      if (activeAccount) {
        console.log(`[自动恢复] 找到激活账号: ${activeAccount.nickname} (ID: ${activeAccount.id})`);
        const isConnected = this.clients.has(activeAccount.id);
        console.log(`[自动恢复] 连接状态: ${isConnected ? '已连接' : '未连接'}`);
        
        if (isConnected) {
          console.log(`[自动恢复] ✅ 当前激活账号: ${activeAccount.nickname} (ID: ${activeAccount.id}) - 已连接`);
          
          // 确保自动回复已启用
          const autoReplyConfig = await userAccountDb.getAutoReply(activeAccount.id);
          if (autoReplyConfig && autoReplyConfig.is_enabled) {
            console.log('[自动恢复] 恢复自动回复功能...');
            await this.enableAutoReply(activeAccount.id);
            console.log(`[自动恢复] ✅ 账号${activeAccount.id} 自动回复监听已启用 (仅私信)`);
            console.log(`[自动恢复] ✅ 激活账号的自动回复已恢复`);
          } else {
            console.log('[自动恢复] ⚠️ 自动回复未配置或未启用');
          }
          console.log('');
        } else {
          console.log(`[自动恢复] ⚠️ 警告：当前激活账号: ${activeAccount.nickname} (ID: ${activeAccount.id}) - 未连接！`);
          console.log(`[自动恢复]    请检查Session是否有效，或使用 /添加账号 重新登录此账号`);
          console.log('');
        }
      } else {
        console.log(`[自动恢复] ⚠️ 没有激活的账号`);
        console.log('');
      }
      
      console.log('[自动恢复] 自动恢复流程完成!');
      console.log('');
    } catch (error: any) {
      console.error('[自动恢复] ❌ 自动恢复账号失败:', error?.message || error);
      console.error('[自动恢复] 详细错误:', error);
      if (error?.stack) {
        console.error('[自动恢复] 错误堆栈:', error.stack);
      }
    }
  }

  // 保存Session到文件
  private saveSessionToFile(phoneNumber: string, sessionString: string): string | null {
    try {
    // 清理手机号（去掉特殊字符）
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    const sessionFile = path.join(this.sessionsDir, `${cleanPhone}.session`);
    
    // 写入文件（UTF-8编码）
      fs.writeFileSync(sessionFile, sessionString, { encoding: 'utf-8', mode: 0o600 }); // 设置 600 权限增加安全性
    console.log(`✅ Session已保存到: ${sessionFile}`);
    
    return sessionFile;
    } catch (error: any) {
      console.error(`❌ 保存Session文件失败:`, error.message);
      return null;
    }
  }

  // 从文件加载Session
  private loadSessionFromFile(sessionPath: string): string | null {
    try {
      if (fs.existsSync(sessionPath)) {
        return fs.readFileSync(sessionPath, 'utf-8');
      }
    } catch (error) {
      console.error('读取Session文件失败:', error);
    }
    return null;
  }

  // 使用session字符串登录账号（按照文档的完整流程）
  async loginWithSession(
    accountId: number,
    apiId: string,
    apiHash: string,
    sessionString: string,
    phoneNumber?: string
  ): Promise<{ success: boolean; error?: string; userInfo?: any }> {
    try {
      // 步骤1: 验证Session格式
      const formatCheck = this.validateSessionFormat(sessionString);
      if (!formatCheck.valid) {
        return { success: false, error: formatCheck.error };
      }

      // 步骤2: 获取最有效的Session字符串
      let effectiveSession = sessionString.trim();
      
      // 如果提供了手机号，优先尝试从本地文件加载最新的Session（文件通常比数据库更新）
      if (phoneNumber) {
        const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
        const sessionFile = path.join(this.sessionsDir, `${cleanPhone}.session`);
        const fileSession = this.loadSessionFromFile(sessionFile);
        if (fileSession) {
          console.log(`      [登录] 发现本地Session文件，优先使用文件登录 (Phone: ${cleanPhone})`);
          effectiveSession = fileSession;
        }
      }

      const apiIdNum = parseInt(apiId);
      if (isNaN(apiIdNum) || apiIdNum <= 0) {
        return { success: false, error: 'API ID格式不正确（必须是数字）' };
      }

      const session = new StringSession(effectiveSession);
      const client = new TelegramClient(session, apiIdNum, apiHash.trim(), {
        connectionRetries: 5,
        retryDelay: 1000,
        autoReconnect: true,
        maxConcurrentDownloads: 1,
        timeout: 60000, // 增加到60秒
      });

      // 步骤3: 连接到Telegram
      await client.connect();

      // 🚀 增加底层错误拦截：静默无害的 TIMEOUT 错误
      client.setLogLevel("none"); // 减少底层库自带的日志输出
      client.addEventHandler((event: any) => {
        // 这里可以处理全局事件，但暂时留空，主要通过下面的错误捕获
      });
      
      // 捕获并过滤掉烦人的 TIMEOUT 报错
      const originalErrorHandler = client._log.error;
      client._log.error = (...args: any[]) => {
        const msg = args.join(' ');
        if (msg.includes('TIMEOUT') || msg.includes('Timeout')) return;
        originalErrorHandler.apply(client._log, args);
      };

      // 步骤4: 使用Node.js验证Session并获取用户信息（真实登录验证）
      const nodeVerify = await this.verifySessionWithNode(client);
      if (!nodeVerify.success) {
        await client.disconnect();
        return { success: false, error: nodeVerify.error || 'Session验证失败' };
      }

      const userInfo = nodeVerify.userInfo;
      const phone = phoneNumber || userInfo?.phone || '';

      // 🚀 重要：获取连接后最新的Session字符串（GramJS 可能会更新它）
      const latestSession = client.session.save() as string;

      // 步骤5: 保存最新的Session到文件
      if (phone) {
        this.saveSessionToFile(phone, latestSession);
      }

      // 步骤6: （可选）Python预验证（用于双重验证和更准确的用户信息）
      // 如果Python可用，进行额外验证，但主要验证已经通过Node.js完成
      const pythonVerify = await this.verifySessionWithPython(latestSession, apiId, apiHash);
      if (pythonVerify.success && pythonVerify.userInfo) {
        // 使用Python验证获取的更准确信息（特别是手机号）
        if (pythonVerify.userInfo.phone && !phone) {
          // 如果Node.js没有获取到手机号，使用Python的结果
          this.saveSessionToFile(pythonVerify.userInfo.phone, latestSession);
        }
        // 优先使用Python验证的用户信息（更准确）
        Object.assign(userInfo, pythonVerify.userInfo);
      }

      // 步骤7: 保存客户端
      this.clients.set(accountId, client);
      
      // 步骤8: 同步更新数据库中的session为最新值
      await userAccountDb.updateAccountSession(accountId, latestSession);
      
      console.log(`✅ 账号 ${accountId} 登录成功并同步了最新Session`);
      if (userInfo?.phone) {
        console.log(`📱 手机号: ${userInfo.phone}`);
      }
      if (userInfo?.username) {
        console.log(`👤 用户名: @${userInfo.username}`);
      }
      
      return { success: true, userInfo };
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      console.error(`❌ 账号 ${accountId} 登录失败:`, errorMsg);
      
      // 解析常见错误
      let friendlyError = errorMsg;
      if (errorMsg.includes('AUTH_KEY_INVALID') || errorMsg.includes('SESSION_REVOKED')) {
        friendlyError = 'Session已过期或无效，请重新获取Session';
      } else if (errorMsg.includes('API_ID_INVALID')) {
        friendlyError = 'API ID不正确';
      } else if (errorMsg.includes('API_HASH_INVALID')) {
        friendlyError = 'API Hash不正确';
      } else if (errorMsg.includes('PHONE_NUMBER_INVALID')) {
        friendlyError = '手机号无效';
      } else if (errorMsg.includes('timeout') || errorMsg.includes('TIMEOUT')) {
        friendlyError = '连接超时，请检查网络';
      } else if (errorMsg.includes('FLOOD')) {
        friendlyError = '请求过于频繁，请稍后再试';
      }
      
      return { success: false, error: friendlyError };
    }
  }

  // 激活并连接账号
  async activateAccount(accountId: number): Promise<boolean> {
    try {
      console.log(`[切换账号] 🔄 开始激活账号 ${accountId}`);
      
      const account = await userAccountDb.getAccount(accountId);
      if (!account) {
        console.error('[切换账号] ❌ 账号不存在');
        return false;
      }

      // 如果已经连接，直接激活
      if (this.clients.has(accountId)) {
        console.log(`[切换账号] ✅ 账号已连接，直接激活`);
        await userAccountDb.setActiveAccount(accountId);
        
        // 启用自动回复（如果已配置）
        const autoReplyConfig = await userAccountDb.getAutoReply(accountId);
        if (autoReplyConfig && autoReplyConfig.is_enabled) {
          console.log(`[切换账号] 🤖 启用自动回复...`);
          await this.enableAutoReply(accountId);
        }
        
        return true;
      }

      // 否则重新连接
      console.log(`[切换账号] 🔌 账号未连接，尝试重新登录...`);
      const result = await this.loginWithSession(
        accountId,
        account.api_id,
        account.api_hash,
        account.session
      );

      if (result.success) {
        console.log(`[切换账号] ✅ 登录成功，设置为激活账号`);
        await userAccountDb.setActiveAccount(accountId);
        
        // 启用自动回复（如果已配置）
        const autoReplyConfig = await userAccountDb.getAutoReply(accountId);
        if (autoReplyConfig && autoReplyConfig.is_enabled) {
          console.log(`[切换账号] 🤖 启用自动回复...`);
          await this.enableAutoReply(accountId);
        }
      } else {
        console.error(`[切换账号] ❌ 登录失败: ${result.error}`);
      }

      return result.success;
    } catch (error: any) {
      console.error('[切换账号] ❌ 激活失败:', error?.message || error);
      return false;
    }
  }

  // 删除账号
  async deleteAccount(accountId: number): Promise<boolean> {
    try {
      console.log(`[删除账号] 🗑️ 开始删除账号 ${accountId}`);
      
      const account = await userAccountDb.getAccount(accountId);
      if (!account) {
        console.error('[删除账号] ❌ 账号不存在');
        return false;
      }

      // 如果是激活账号，需要先断开连接
      if (account.is_active) {
        console.log(`[删除账号] ⚠️ 这是当前激活账号，先断开连接...`);
        
        // 断开客户端连接
        const client = this.clients.get(accountId);
        if (client) {
          try {
            await client.disconnect();
            console.log(`[删除账号] ✅ 客户端已断开`);
          } catch (e) {
            console.warn(`[删除账号] ⚠️ 断开连接失败:`, e);
          }
          this.clients.delete(accountId);
        }
      }

      // 从数据库删除
      await userAccountDb.deleteAccount(accountId);
      
      // 删除session文件（如果存在）
      if (account.phone) {
        const sessionPath = path.join(this.sessionsDir, `${account.phone}.session`);
        if (fs.existsSync(sessionPath)) {
          try {
            fs.unlinkSync(sessionPath);
            console.log(`[删除账号] 🗑️ Session文件已删除: ${account.phone}.session`);
          } catch (e) {
            console.warn(`[删除账号] ⚠️ 删除session文件失败:`, e);
          }
        }
      }

      console.log(`[删除账号] ✅ 账号 ${accountId} (${account.nickname}) 已删除`);
      return true;
    } catch (error: any) {
      console.error('[删除账号] ❌ 删除失败:', error?.message || error);
      return false;
    }
  }

  // 获取当前激活的客户端
  private async getActiveClient(): Promise<any | null> {
    const account = await userAccountDb.getActiveAccount();
    if (!account) return null;
    return this.clients.get(account.id) || null;
  }

  // 发送私信
  async sendPrivateMessage(
    targetUsername: string,
    message: string
  ): Promise<boolean> {
    try {
      const client = await this.getActiveClient();
      if (!client) {
        console.error('[发送私信] 没有激活的账号');
        return false;
      }

      // 解析用户名（移除@符号）
      const username = targetUsername.replace('@', '');

      await client.sendMessage(username, { message });
      console.log(`✅ 发送消息成功: ${username}`);
      return true;
    } catch (error) {
      console.error('发送私信失败:', error);
      return false;
    }
  }

  // 搜索并收集多个关键词的结果（新方法）
  async searchAndCollectKeywords(
    keywords: string[],
    pending: any // PendingGroupSend类型
  ): Promise<boolean> {
    try {
      console.log(`[搜索收集] ========== 开始收集流程 ==========`);
      console.log(`[搜索收集] 关键词列表: ${keywords.join(', ')}`);
      
      const client = await this.getActiveClient();
      if (!client) {
        console.error('[搜索收集] ❌ 错误：没有激活的账号');
        console.error('[搜索收集] 💡 提示：请先在"账号控制"中激活一个账号');
        return false;
      }
      console.log(`[搜索收集] ✅ 账号客户端已就绪`);

      // 获取机器人bot的信息
      let botUsername: string;
      let botId: number;
      
      try {
        const config = require('../config').config;
        const botToken = config.botToken;
        console.log(`[搜索收集] 🔍 Bot Token: ${botToken.substring(0, 10)}...`);
        
        const { Telegraf } = require('telegraf');
        const bot = new Telegraf(botToken);
        const botInfo = await bot.telegram.getMe();
        botUsername = botInfo.username;
        botId = botInfo.id;
        
        console.log(`[搜索收集] ✅ Bot信息获取成功`);
        console.log(`[搜索收集] 📱 Bot用户名: @${botUsername}`);
        console.log(`[搜索收集] 🆔 Bot ID: ${botId}`);
      } catch (botError: any) {
        console.error('[搜索收集] ❌ 获取Bot信息失败:', botError?.message);
        console.error('[搜索收集] 💡 请检查bot token配置是否正确');
        return false;
      }

      // 获取bot的peer对象
      let botPeer: any;
      try {
        botPeer = await client.getInputEntity(botUsername);
        console.log(`[搜索收集] ✅ Bot实体获取成功`);
      } catch (peerError: any) {
        console.error('[搜索收集] ❌ 获取Bot实体失败:', peerError?.message);
        console.error('[搜索收集] 💡 请确保已经和机器人 @' + botUsername + ' 发起过对话');
        return false;
      }

      // 收集所有消息
      const allCollectedMessages: any[] = [];
      let messageHandler: any = null;

      const cleanup = () => {
        if (messageHandler) {
          try {
            client.removeEventHandler(messageHandler);
            console.log(`[搜索收集] 🧹 监听器已清理`);
          } catch (e) {
            console.error(`[搜索收集] ⚠️ 清理监听器失败:`, e);
          }
          messageHandler = null;
        }
      };

      // 设置监听器（监听所有机器人消息）
      const { NewMessage } = require('telegram/events');
      
      // 生成唯一的事件ID
      const eventId = `search_collect_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      console.log(`[搜索收集] 🔧 设置消息监听器 (事件ID: ${eventId})...`);
      
      messageHandler = client.addEventHandler(async (event: any) => {
        try {
          console.log(`[搜索收集] 🔔 收到消息事件 (事件ID: ${eventId})`);
          
          const message = event.message;
          if (!message) {
            console.log(`[搜索收集] ⚠️ 收到事件但消息为空`);
            return;
          }

          const peerId = message.peerId;
          if (!peerId) {
            console.log(`[搜索收集] ⚠️ 消息无peerId`);
            return;
          }

          console.log(`[搜索收集] 🔍 消息peerId类型: ${peerId?.className}`);

          // 检查是否是用户私聊（PeerUser）
          if (peerId?.className !== 'PeerUser') {
            console.log(`[搜索收集] ⚠️ 消息不是PeerUser类型: ${peerId?.className}`);
            return;
          }

          // 获取发送者ID（多种方式尝试）
          let actualSenderId: number | null = null;
          
          // 方式1: 从peerId.userId获取
          if (peerId.userId) {
            actualSenderId = typeof peerId.userId === 'object' && peerId.userId.toJSNumber 
              ? peerId.userId.toJSNumber() 
              : Number(peerId.userId);
            console.log(`[搜索收集] 🔍 方式1获取发送者ID: ${actualSenderId}`);
          }
          
          // 方式2: 从message.fromId获取（如果peerId获取失败）
          if (!actualSenderId && message.fromId) {
            try {
              const fromId = message.fromId;
              console.log(`[搜索收集] 🔍 fromId类型: ${fromId?.className}`);
              if (fromId?.className === 'PeerUser' && fromId.userId) {
                actualSenderId = typeof fromId.userId === 'object' && fromId.userId.toJSNumber
                  ? fromId.userId.toJSNumber()
                  : Number(fromId.userId);
                console.log(`[搜索收集] 🔍 方式2获取发送者ID: ${actualSenderId}`);
              }
            } catch (e: any) {
              console.log(`[搜索收集] ⚠️ 方式2获取失败: ${e?.message}`);
            }
          }

          // 方式3: 直接从message.senderId获取
          if (!actualSenderId && (message as any).senderId) {
            try {
              const senderIdObj = (message as any).senderId;
              if (senderIdObj?.className === 'PeerUser' && senderIdObj.userId) {
                actualSenderId = typeof senderIdObj.userId === 'object' && senderIdObj.userId.toJSNumber
                  ? senderIdObj.userId.toJSNumber()
                  : Number(senderIdObj.userId);
                console.log(`[搜索收集] 🔍 方式3获取发送者ID: ${actualSenderId}`);
              }
            } catch (e: any) {
              console.log(`[搜索收集] ⚠️ 方式3获取失败: ${e?.message}`);
            }
          }

          // 调试日志
          console.log(`[搜索收集] 🔍 消息检查结果: actualSenderId=${actualSenderId}, botId=${botId}, match=${actualSenderId === botId}`);

          if (!actualSenderId || actualSenderId !== botId) {
            console.log(`[搜索收集] ⚠️ 消息发送者不匹配: ${actualSenderId} !== ${botId}，跳过`);
            return;
          }

          // 确认是私聊（PeerUser类型）
          if (peerId?.className !== 'PeerUser') {
            console.log(`[搜索收集] ⚠️ 跳过非私聊消息 (类型: ${peerId?.className})`);
            return;
          }

          console.log(`[搜索收集] ✅ 确认是机器人私聊消息！`);

          // 检查是否已收集过这条消息（避免重复）
          const messageId = message.id;
          const alreadyCollected = allCollectedMessages.some(m => {
            let id = m.id;
            if (typeof id === 'object' && id.toJSNumber) id = id.toJSNumber();
            return Number(id) === Number(messageId);
          });

          if (alreadyCollected) {
            console.log(`[搜索收集] ⚠️ 消息已收集过: ${messageId}`);
            return;
          }

          // 收集消息
          allCollectedMessages.push(message);
          console.log(`[搜索收集] ✅ 收集到消息 #${allCollectedMessages.length} (ID: ${message.id}, 发送者: ${actualSenderId})`);
        } catch (error: any) {
          console.error(`[搜索收集] ❌ 监听器错误:`, error?.message);
          console.error(`[搜索收集] 错误堆栈:`, error?.stack);
        }
      }, new NewMessage({
        incoming: true,
        outgoing: false,
      }), { id: eventId });

      console.log(`[搜索收集] ✅ 监听器已设置 (事件ID: ${eventId})`);
      
      // 等待监听器完全就绪
      console.log(`[搜索收集] ⏳ 等待2秒确保监听器就绪...`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 快速连续发送所有关键词（不等待回复）
      console.log(`[搜索收集] 📤 开始批量发送 ${keywords.length} 个关键词...`);
      for (let i = 0; i < keywords.length; i++) {
        const keyword = keywords[i];
        console.log(`[搜索收集] [${i + 1}/${keywords.length}] 发送关键词: "${keyword}"`);

        try {
          // 发送关键词
          await client.sendMessage(botUsername, {
            message: keyword,
          });

          console.log(`[搜索收集] ✅ 关键词 "${keyword}" 已发送`);

          // 关键词间短暂延迟（避免发送过快）
          if (i < keywords.length - 1) {
            await this.sleep(500); // 500ms延迟
          }
        } catch (sendError: any) {
          console.error(`[搜索收集] ❌ 发送关键词 "${keyword}" 失败:`, sendError?.message);
        }
      }

      console.log(`[搜索收集] 📤 所有关键词已发送完成，开始等待机器人回复...`);

      // 等待机器人处理并发送所有消息（修复时序问题）
      let lastMessageCount = 0;
      let stableCount = 0;
      const maxWaitTime = 90000; // 最大等待90秒（增加等待时间）
      const stableThreshold = 15000; // 15秒无新消息认为完成（增加稳定阈值）
      const checkInterval = 1000; // 每1秒检查一次
      const startTime = Date.now();
      let hasReceivedAnyMessage = false;

      console.log(`[搜索收集] ⏳ 开始收集消息（最长等待90秒，15秒无新消息即完成）...`);
      console.log(`[搜索收集] 💡 注意：机器人可能需要一些时间处理关键词，请耐心等待...`);

      while (Date.now() - startTime < maxWaitTime) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        
        const currentCount = allCollectedMessages.length;
        const elapsedTime = Math.floor((Date.now() - startTime) / 1000);
        
        if (currentCount > lastMessageCount) {
          // 有新消息，重置稳定计数
          stableCount = 0;
          lastMessageCount = currentCount;
          hasReceivedAnyMessage = true;
          console.log(`[搜索收集] 📨 收到新消息，当前共 ${currentCount} 条 (已等待 ${elapsedTime} 秒)`);
        } else {
          // 没有新消息，增加稳定计数
          stableCount += checkInterval;
          
          // 每10秒显示一次等待状态
          if (stableCount % 10000 === 0) {
            console.log(`[搜索收集] ⏳ 等待中... 当前 ${currentCount} 条消息，${stableCount/1000}秒无新消息 (已等待 ${elapsedTime} 秒)`);
          }
          
          // 只有收到过消息后，才允许因为稳定而结束
          if (hasReceivedAnyMessage && stableCount >= stableThreshold) {
            console.log(`[搜索收集] ✅ 消息收集稳定（${stableThreshold/1000}秒无新消息），完成收集`);
            break;
          }
          
          // 如果30秒内没有收到任何消息，给出提示
          if (!hasReceivedAnyMessage && elapsedTime === 30) {
            console.log(`[搜索收集] ⚠️ 30秒内未收到任何消息，可能机器人响应较慢或关键词无效`);
          }
        }
      }

      const totalWaitTime = Math.floor((Date.now() - startTime) / 1000);
      console.log(`[搜索收集] 📊 收集完成！共收集到 ${allCollectedMessages.length} 条消息 (总等待时间: ${totalWaitTime} 秒)`);

      cleanup();

      // 更新pending中的消息列表
      pending.collectedMessages = allCollectedMessages;

      console.log(`[搜索收集] ✅ 搜索完成，共收集 ${allCollectedMessages.length} 条消息`);
      return allCollectedMessages.length > 0;
    } catch (error: any) {
      console.error('[搜索收集] ❌ 搜索失败:', error?.message || error);
      return false;
    }
  }

  // ========== 优化版：异步并行收集（生产级） ==========

  /**
   * 并行收集多个关键词（优化版 - 生产级）
   * 
   * 优化点：
   * 1. Promise.allSettled 防止单个失败影响整体
   * 2. FloodWait 自动重试
   * 3. 清理逻辑严谨
   * 4. 日志结构化
   * 5. 防止重复resolve
   */
  async searchAndCollectKeywordsParallel(
    keywords: string[],
    pending: any
  ): Promise<boolean> {
    try {
      console.log(`[并行收集] 🚀 开始并行搜索 ${keywords.length} 个关键词`);
      console.log(`[并行收集] 关键词列表: ${keywords.join(', ')}`);
      
      // 检查客户端
      const client = await this.getActiveClient();
      if (!client) {
        console.error('[并行收集] ❌ 没有激活的账号或账号未登录');
        return false;
      }
      console.log(`[并行收集] ✅ 账号客户端已就绪`);
      
      const tasks = keywords.map((keyword, index) => {
        // 每个任务延迟 index * 1000ms 启动（防止FloodWait）
        return this.delay(index * 1000)
          .then(() => this.collectSingleKeyword(keyword));
      });
      
      // 使用 allSettled 防止单个失败影响整体
      console.log(`[并行收集] ⏳ 等待所有任务完成...`);
      const results = await Promise.allSettled(tasks);
      
      // 统计结果
      const succeeded = results.filter(r => r.status === 'fulfilled');
      const failed = results.filter(r => r.status === 'rejected');
      
      console.log(`[并行收集] 📊 任务完成统计: ${succeeded.length} 成功, ${failed.length} 失败`);
      
      // 合并所有成功的结果（按关键词顺序，不按消息ID）
      const allMessages = succeeded
        .map(r => (r as PromiseFulfilledResult<any[]>).value)
        .flat();
      
      console.log(`[并行收集] ✅ 并行收集完成！共 ${allMessages.length} 条消息`);
      
      // ⚠️ 不按消息ID排序！保持关键词顺序
      // 因为并行收集后，消息已经按关键词分组了（456的→321的→白漂亮的→123的）
      // 按ID排序会打乱这个顺序
      console.log(`[并行收集] 💡 保持关键词顺序，不按消息ID重新排序`);
      
      // 输出每个关键词收集的数量（调试用）
      let startIdx = 0;
      for (let i = 0; i < succeeded.length; i++) {
        const keywordMessages = (succeeded[i] as PromiseFulfilledResult<any[]>).value;
        console.log(`[并行收集] 📊 关键词${i + 1} [${keywords[i]}]: ${keywordMessages.length} 条消息`);
        startIdx += keywordMessages.length;
      }
      
      // 更新pending
      pending.collectedMessages = allMessages;
      
      return allMessages.length > 0;
    } catch (error: any) {
      console.error('[并行收集] ❌ 并行收集失败:', error?.message);
      return false;
    }
  }

  /**
   * 收集单个关键词的消息（优化版）
   * 
   * @param keyword 关键词
   * @param retryCount 重试次数（用于FloodWait重试）
   */
  private async collectSingleKeyword(
    keyword: string, 
    retryCount: number = 0
  ): Promise<any[]> {
    return new Promise(async (resolve) => {
      const messages: any[] = [];
      let handler: any = null;
      let timeoutId: NodeJS.Timeout | null = null;
      let checkInterval: NodeJS.Timeout | null = null;
      let isResolved = false; // 防止重复resolve
      
      // 清理函数（顺序很重要！）
      const cleanup = () => {
        if (isResolved) return; // 已经清理过了
        
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (checkInterval) {
          clearInterval(checkInterval);
          checkInterval = null;
        }
        if (handler) {
          try {
            this.getActiveClient().then(client => {
              if (client) client.removeEventHandler(handler);
            }).catch(() => {});
          } catch (e) {}
          handler = null;
        }
      };
      
      // 安全的resolve（防止重复）
      const safeResolve = (result: any[]) => {
        if (isResolved) return;
        isResolved = true;
        cleanup();
        resolve(result);
      };
      
      try {
        const client = await this.getActiveClient();
        if (!client) {
          console.error(`[Collect][${keyword}] ❌ 没有激活的账号`);
          safeResolve([]);
          return;
        }
        
        // 获取机器人信息
        const config = require('../config').config;
        const botToken = config.botToken;
        const { Telegraf } = require('telegraf');
        const bot = new Telegraf(botToken);
        const botInfo = await bot.telegram.getMe();
        const botUsername = botInfo.username;
        const botId = botInfo.id;
        
        console.log(`[Collect][${keyword}] 🔄 开始收集... (尝试 ${retryCount + 1})`);
        
        // 常量配置
        const STABLE_GAP = 5000;    // 5秒无新消息认为完成
        const MIN_COUNT = 1;         // 至少收集1条
        const MAX_WAIT = 30000;      // 单个关键词最多等30秒
        const CHECK_INTERVAL = 1000; // 每秒检查一次
        
        // 设置专属监听器
        const { NewMessage } = require('telegram/events');
        let lastMessageTime = Date.now();
        
        handler = client.addEventHandler(async (event: any) => {
          try {
            const msg = event.message;
            if (!msg) return;
            
            // 检查是否是机器人的私聊消息
            const peerId = msg.peerId;
            if (peerId?.className !== 'PeerUser') return;
            
            // 获取发送者ID
            let senderId: number | null = null;
            if (peerId.userId) {
              senderId = typeof peerId.userId === 'object' && peerId.userId.toJSNumber
                ? peerId.userId.toJSNumber()
                : Number(peerId.userId);
            }
            
            // 确认是机器人发的
            if (senderId !== botId) return;
            
            // 避免重复收集
            const msgId = msg.id;
            const exists = messages.some(m => {
              let id = m.id;
              if (typeof id === 'object' && id.toJSNumber) id = id.toJSNumber();
              return Number(id) === Number(msgId);
            });
            
            if (!exists) {
              messages.push(msg);
              lastMessageTime = Date.now();
              console.log(`[Collect][${keyword}] ✅ 收到消息 #${messages.length}`);
            }
          } catch (err: any) {
            console.error(`[Collect][${keyword}] ❌ 监听器错误:`, err?.message);
          }
        }, new NewMessage({ incoming: true, outgoing: false }), { id: `collect_${keyword}_${Date.now()}` });
        
        // 发送关键词（带FloodWait重试）
        try {
          await client.sendMessage(botUsername, { message: keyword });
          console.log(`[Collect][${keyword}] 📤 已发送，等待回复...`);
        } catch (sendError: any) {
          const errorMsg = sendError?.message || String(sendError);
          
          // 检查是否是FloodWait错误
          if (errorMsg.includes('FLOOD_WAIT') || errorMsg.includes('FloodWait')) {
            const waitMatch = errorMsg.match(/(\d+)/);
            const waitSeconds = waitMatch ? parseInt(waitMatch[1]) : 5;
            
            console.warn(`[Collect][${keyword}] ⚠️ FloodWait ${waitSeconds}秒，等待后重试...`);
            
            cleanup();
            
            // 等待后递归重试（最多重试3次）
            if (retryCount < 3) {
              await this.delay(waitSeconds * 1000);
              return resolve(await this.collectSingleKeyword(keyword, retryCount + 1));
            } else {
              console.error(`[Collect][${keyword}] ❌ FloodWait重试次数已用完`);
              safeResolve([]);
              return;
            }
          }
          
          // 其他错误
          console.error(`[Collect][${keyword}] ❌ 发送失败:`, errorMsg);
          safeResolve([]);
          return;
        }
        
        // 超时保护
        timeoutId = setTimeout(() => {
          console.log(`[Collect][${keyword}] ⏱️ 超时(${MAX_WAIT/1000}秒)，收到 ${messages.length} 条消息`);
          safeResolve(messages);
        }, MAX_WAIT);
        
        // 稳定检查：STABLE_GAP 秒无新消息即完成
        checkInterval = setInterval(() => {
          const timeSinceLastMessage = Date.now() - lastMessageTime;
          
          // 收集到至少MIN_COUNT条，且STABLE_GAP秒无新消息
          if (messages.length >= MIN_COUNT && timeSinceLastMessage > STABLE_GAP) {
            console.log(`[Collect][${keyword}] ✅ 收集完成，共 ${messages.length} 条消息`);
            safeResolve(messages);
          }
        }, CHECK_INTERVAL);
        
      } catch (error: any) {
        console.error(`[Collect][${keyword}] ❌ 收集失败:`, error?.message);
        cleanup();
        safeResolve([]);
      }
    });
  }

  /**
   * 延迟工具函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 批量转发收集到的消息（保持媒体组格式）
  async forwardCollectedMessages(
    groupUsername: string,
    messages: any[]
  ): Promise<boolean> {
    try {
      const client = await this.getActiveClient();
      if (!client) {
        console.error('[批量转发] 没有激活的账号');
        return false;
      }

      if (!messages || messages.length === 0) {
        console.error('[批量转发] 没有要转发的消息');
        return false;
      }

      console.log(`[批量转发] 🔄 开始转发 ${messages.length} 条消息到群组 "${groupUsername}"`);

      // 解析群组用户名
      const group = groupUsername.replace('@', '').trim();

      // 获取目标群组实体
      let targetGroupEntity;
      try {
        targetGroupEntity = await client.getInputEntity(group);
      } catch (e) {
        if (/^\d+$/.test(group)) {
          const groupIdNum = parseInt(group);
          try {
            targetGroupEntity = await client.getInputEntity(groupIdNum);
          } catch (e2) {
            const negativeId = -1000000000000 - Math.abs(groupIdNum);
            targetGroupEntity = await client.getInputEntity(negativeId);
          }
        } else {
          throw e;
        }
      }

      // 获取消息来源（机器人私聊）
      const config = require('../config').config;
      const botToken = config.botToken;
      const { Telegraf } = require('telegraf');
      const bot = new Telegraf(botToken);
      const botInfo = await bot.telegram.getMe();
      const botUsername = botInfo.username;
      const fromChat = await client.getInputEntity(botUsername);

      // ⚠️ 不按ID排序！保持收集时的顺序（机器人返回的顺序）
      // 按ID排序会打乱关键词的分组，导致文字和媒体分散
      const sortedMessages = [...messages]; // 保持原始顺序
      
      console.log(`[批量转发] 📊 开始转发 ${sortedMessages.length} 条消息（保持收集顺序）`);
      console.log(`[批量转发] 💡 消息ID范围: ${messages[0]?.id} - ${messages[messages.length-1]?.id}`);

      // 尝试一次性转发所有消息（保持媒体组格式）
      const allMessageIds = sortedMessages.map(msg => {
        let id = msg.id;
        if (typeof id === 'object' && id.toJSNumber) {
          id = id.toJSNumber();
        }
        return Number(id);
      });

      let successCount = 0;
      let totalForwarded = 0;

      // 判断是否为频道
      const isChannel = targetGroupEntity.className === 'InputPeerChannel';
      
      // ========== 最终方案：媒体组 + 定时发送（确保顺序） ==========
      console.log(`[批量转发] 🎯 使用媒体组+定时发送策略（保证顺序和完整性）`);
      console.log(`[批量转发] 📊 目标类型: ${isChannel ? '频道' : '群组'}`);
      
      // 1. 智能分组策略：按时间间隔识别关键词边界
      // 同一关键词的消息时间戳接近，不同关键词之间有明显的时间间隔
      const groupedMessages: any[][] = [];
      const TIME_GAP_THRESHOLD = 5000; // 5秒时间间隔，超过则认为是不同关键词
      const MAX_GROUP_SIZE = 10; // Telegram限制

      console.log(`[批量转发] 📋 使用智能分组策略：按时间间隔识别关键词边界`);
      console.log(`[批量转发] 💡 同一关键词的媒体保持在一起，不会被拆散`);

      let currentKeywordGroup: any[] = [];
      let lastMessageTime = 0;

      for (let i = 0; i < sortedMessages.length; i++) {
        const msg = sortedMessages[i];
        const msgDate = msg.date || 0;
        const timestamp = typeof msgDate === 'object' && msgDate.getTime 
          ? msgDate.getTime() 
          : Number(msgDate) * 1000;

        // 如果时间间隔超过阈值，认为是新关键词
        const isNewKeyword = currentKeywordGroup.length > 0 && 
                            Math.abs(timestamp - lastMessageTime) > TIME_GAP_THRESHOLD;

        if (isNewKeyword) {
          // 当前关键词结束，处理并添加到结果
          if (currentKeywordGroup.length <= MAX_GROUP_SIZE) {
            // 关键词媒体数≤10，作为一个完整组
            groupedMessages.push([...currentKeywordGroup]);
          } else {
            // 关键词媒体数>10，按10个切分
            for (let j = 0; j < currentKeywordGroup.length; j += MAX_GROUP_SIZE) {
              groupedMessages.push(currentKeywordGroup.slice(j, j + MAX_GROUP_SIZE));
            }
          }
          currentKeywordGroup = [];
        }

        currentKeywordGroup.push(msg);
        lastMessageTime = timestamp;
      }

      // 处理最后一个关键词组
      if (currentKeywordGroup.length > 0) {
        if (currentKeywordGroup.length <= MAX_GROUP_SIZE) {
          groupedMessages.push([...currentKeywordGroup]);
        } else {
          for (let j = 0; j < currentKeywordGroup.length; j += MAX_GROUP_SIZE) {
            groupedMessages.push(currentKeywordGroup.slice(j, j + MAX_GROUP_SIZE));
          }
        }
      }

      console.log(`[批量转发] 📦 识别出 ${groupedMessages.length} 个媒体组`);
      for (let i = 0; i < groupedMessages.length; i++) {
        console.log(`[批量转发]    组${i + 1}: ${groupedMessages[i].length} 条消息`);
      }

      // 2. 使用定时发送（schedule_date），确保严格顺序
      const now = Math.floor(Date.now() / 1000); // 当前Unix时间戳（秒）
      let scheduleTime = now + 8; // 从8秒后开始发送（给服务器充足准备时间）

      console.log(`[批量转发] ⏰ 开始调度发送计划...`);
      console.log(`[批量转发] ⏰ 当前时间: ${new Date().toLocaleTimeString()}`);

      // 分组定时发送
      for (let i = 0; i < groupedMessages.length; i++) {
        const group = groupedMessages[i];
        const messageIds = group.map(msg => {
          let id = msg.id;
          if (typeof id === 'object' && id.toJSNumber) {
            id = id.toJSNumber();
          }
          return Number(id);
        });

        try {
          const scheduleDate = new Date(scheduleTime * 1000);
          console.log(`[批量转发] 📤 调度消息组 ${i + 1}/${groupedMessages.length} (${group.length} 条)`);
          console.log(`[批量转发] ⏰ 定时发送: ${scheduleDate.toLocaleTimeString()}`);

          // 转发选项（带定时发送）
          const forwardOptions: any = {
            messages: messageIds,
            fromPeer: fromChat,
            scheduleDate: scheduleTime, // ⭐ 关键：定时发送，确保顺序
          };
          
          if (isChannel) {
            forwardOptions.dropAuthor = true;  // 取消转发来源
            forwardOptions.silent = true;      // 静默发送
          }

          await client.forwardMessages(targetGroupEntity, forwardOptions);

          successCount++;
          totalForwarded += group.length;
          console.log(`[批量转发] ✅ 消息组 ${i + 1} 已调度成功`);

          // 下一组延迟：频道10秒，群组8秒（增加间隔，确保顺序）
          scheduleTime += isChannel ? 10 : 8;

        } catch (groupError: any) {
          console.error(`[批量转发] ❌ 消息组 ${i + 1} 调度失败:`, groupError?.message);
          
          // 降级：逐条定时发送
          console.log(`[批量转发] 🔄 降级为单条定时发送...`);
          for (let j = 0; j < group.length; j++) {
            const msg = group[j];
            try {
              let msgId = msg.id;
              if (typeof msgId === 'object' && msgId.toJSNumber) {
                msgId = msgId.toJSNumber();
              }
              
              const singleOptions: any = {
                messages: [Number(msgId)],
                fromPeer: fromChat,
                scheduleDate: scheduleTime, // 定时发送
              };
              
              if (isChannel) {
                singleOptions.dropAuthor = true;
                singleOptions.silent = true;
              }
              
              await client.forwardMessages(targetGroupEntity, singleOptions);
              totalForwarded++;
              console.log(`[批量转发] ✅ 单条消息 ${j + 1}/${group.length} 已调度`);
              
              // 单条消息间隔
              scheduleTime += 3;
            } catch (singleError: any) {
              console.error(`[批量转发] ❌ 单条消息调度失败:`, singleError?.message);
            }
          }
        }
      }

      const finalTime = new Date(scheduleTime * 1000);
      console.log(`[批量转发] 📊 调度完成: 共调度 ${totalForwarded}/${messages.length} 条消息`);
      console.log(`[批量转发] ⏰ 预计全部发送完成时间: ${finalTime.toLocaleTimeString()}`);
      console.log(`[批量转发] 💡 提示: 消息将按定时自动发送，保证顺序和完整性`)

      console.log(`[批量转发] 📊 转发完成: 共转发 ${totalForwarded}/${messages.length} 条消息`);
      
      // 只要转发了超过一半的消息就算成功
      const successRate = totalForwarded / messages.length;
      return successRate > 0.5;
    } catch (error: any) {
      console.error('[批量转发] ❌ 转发失败:', error?.message || error);
      return false;
    }
  }

  // 发送媒体库到群组（使用转发模式：控制账号触发机器人搜索，然后转发结果）
  async sendMediaLibraryToGroup(
    groupUsername: string,
    keyword: string
  ): Promise<boolean> {
    try {
      const client = await this.getActiveClient();
      if (!client) {
        console.error('[发送媒体库] 没有激活的账号');
        return false;
      }

      // 获取机器人bot的信息
      const config = require('../config').config;
      const botToken = config.botToken;
      
      // 获取bot用户名
      const { Telegraf } = require('telegraf');
      const bot = new Telegraf(botToken);
      const botInfo = await bot.telegram.getMe();
      const botUsername = botInfo.username;

      console.log(`[发送媒体库] 🔄 使用转发模式发送`);
      console.log(`[发送媒体库] 关键词: "${keyword}"`);
      console.log(`[发送媒体库] 目标群组: "${groupUsername}"`);
      console.log(`[发送媒体库] Bot用户名: @${botUsername}`);

      // 解析群组用户名（移除@符号）
      const group = groupUsername.replace('@', '').trim();

      // 创建临时消息监听器，用于捕获机器人返回的搜索结果
      let forwardedMessages: any[] = [];
      let messageHandler: any = null;
      let timeoutId: NodeJS.Timeout | null = null;
      let botPeer: any = null;
      
      // 清理函数
      const cleanup = () => {
        if (messageHandler) {
          try {
            client.removeEventHandler(messageHandler);
          } catch (e) {
            // 忽略清理错误
          }
          messageHandler = null;
        }
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      // 获取bot的peer对象和ID（用于后续验证）
      try {
        botPeer = await client.getInputEntity(botUsername);
        console.log(`[发送媒体库] ✅ 已获取Bot实体`);
        
        // 验证botInfo.id是否正确
        console.log(`[发送媒体库] 📋 Bot信息 - 用户名: @${botUsername}, ID: ${botInfo.id}`);
      } catch (peerError: any) {
        console.error(`[发送媒体库] ⚠️ 无法获取Bot实体: ${peerError?.message}，将继续尝试`);
        // 不直接返回false，让后续逻辑尝试获取
      }
      
      // 验证目标群组是否可访问
      try {
        const targetGroupEntity = await client.getInputEntity(group);
        console.log(`[发送媒体库] ✅ 目标群组可访问: ${group}`);
      } catch (groupError: any) {
        console.error(`[发送媒体库] ❌ 无法访问目标群组 "${group}": ${groupError?.message}`);
        console.error(`[发送媒体库] 💡 请确保：1) 群组用户名正确 2) 账号已加入该群组 3) 账号有转发权限`);
        return false;
      }

      // 设置超时（30秒内必须完成）
      const sendPromise = new Promise<boolean>((resolve, reject) => {
        timeoutId = setTimeout(() => {
          cleanup();
          if (forwardedMessages.length > 0) {
            console.log(`[发送媒体库] ⏰ 超时，但已转发 ${forwardedMessages.length} 条消息`);
            resolve(true);
          } else {
            console.log(`[发送媒体库] ⏰ 超时，未收到任何消息`);
            reject(new Error('转发超时（60秒）'));
          }
        }, 45000); // 45秒超时（平衡速度和稳定性）

        // 监听来自机器人的消息（初始监听器，后续会被增强版替换）
        const { NewMessage } = require('telegram/events');
        
        // 先创建一个占位监听器，后续会被增强版替换
        messageHandler = client.addEventHandler(async (event: any) => {
          console.log(`[发送媒体库] 🔍 初始监听器收到事件（将被替换）`);
        }, new NewMessage({
          incoming: true,
          outgoing: false,
        }));
        
        console.log(`[发送媒体库] ✅ 初始监听器已设置`);

        // 延迟发送关键词给机器人（确保监听器已设置）
        setTimeout(async () => {
          try {
            console.log(`[发送媒体库] 📤 发送关键词给机器人: "${keyword}"`);
            await client.sendMessage(botUsername, {
              message: keyword,
            });
            console.log(`[发送媒体库] ✅ 关键词已发送`);

            // 等待确认收到第一条机器人回复（延迟更长，确保消息已收到）
            let hasReceivedFirstMessage = false;
            const firstMessageTimer = setTimeout(() => {
              if (!hasReceivedFirstMessage) {
                console.log(`[发送媒体库] ⚠️ 10秒内未收到机器人回复，但将继续等待...`);
              }
            }, 10000);

            // 收集所有收到的机器人消息（用于媒体组识别）
            const receivedBotMessages: any[] = [];
            let messageCount = 0;
            let lastMessageTime = Date.now();
            
            // 等待机器人处理和返回消息
            // 🚀 优化：大幅增加静默等待时间，防止网络波动导致采集不全
            const checkComplete = () => {
              const timeSinceLastMessage = Date.now() - lastMessageTime;
              
              // 1. 如果已经收到消息，需要等待更长的静默期 (从2s增加到8s)
              // 2. 因为机器人发送大媒体组或多个分段时，API 延迟可能超过2-3秒
              if (receivedBotMessages.length > 0 && timeSinceLastMessage > 8000) {
                clearTimeout(firstMessageTimer);
                console.log(`[发送媒体库] ⏰ 8秒内无新消息，确认采集完成，开始处理 ${receivedBotMessages.length} 条消息...`);
                
                // 现在批量转发媒体组
                processAndForwardMessages(receivedBotMessages)
                  .then((success) => {
                    cleanup();
                    if (success) {
                      console.log(`[发送媒体库] ✅ 转发完成，共处理 ${receivedBotMessages.length} 条消息`);
                      resolve(true);
                    } else {
                      console.log(`[发送媒体库] ⚠️ 转发部分失败，但已处理 ${forwardedMessages.length} 条消息`);
                      resolve(forwardedMessages.length > 0); // 只要有部分成功就返回true
                    }
                  })
                  .catch((err) => {
                    cleanup();
                    console.error(`[发送媒体库] ❌ 转发处理失败:`, err);
                    // 如果已经有部分消息转发成功，也返回true
                    resolve(forwardedMessages.length > 0);
                  });
              } else if (receivedBotMessages.length === 0 && timeSinceLastMessage > 30000) {
                // 如果30秒还没收到任何消息，认为失败
                clearTimeout(firstMessageTimer);
                cleanup();
                console.log(`[发送媒体库] ⚠️ 30秒内未收到机器人的回复`);
                resolve(false);
              } else {
                // 继续等待（缩短检查间隔到500ms提高响应速度）
                setTimeout(checkComplete, 500);
              }
            };

            // 处理并转发消息的函数（识别媒体组）
            const processAndForwardMessages = async (messages: any[]): Promise<boolean> => {
              if (messages.length === 0) return false;

              console.log(`[发送媒体库] 📦 开始处理 ${messages.length} 条消息...`);

              // 获取目标群组实体（只获取一次，复用）
              let targetGroupEntity;
              try {
                targetGroupEntity = await client.getInputEntity(group);
              } catch (e) {
                if (/^\d+$/.test(group)) {
                  const groupIdNum = parseInt(group);
                  try {
                    targetGroupEntity = await client.getInputEntity(groupIdNum);
                  } catch (e2) {
                    const negativeId = -1000000000000 - Math.abs(groupIdNum);
                    targetGroupEntity = await client.getInputEntity(negativeId);
                  }
                } else {
                  throw e;
                }
              }

              // 获取消息来源聊天（机器人私聊）- 只获取一次，复用
              const fromChat = await client.getInputEntity(botPeer);

              // 识别媒体组：同一时间戳附近的连续消息（间隔<3秒）可能是媒体组
              const groupedMessages: any[][] = [];
              let currentGroup: any[] = [];
              let lastTimestamp = 0;

              // 按消息ID排序（确保顺序正确）
              const sortedMessages = [...messages].sort((a, b) => {
                let idA = a.id;
                let idB = b.id;
                if (typeof idA === 'object' && idA.toJSNumber) idA = idA.toJSNumber();
                if (typeof idB === 'object' && idB.toJSNumber) idB = idB.toJSNumber();
                return Number(idA) - Number(idB);
              });

              for (const msg of sortedMessages) {
                const msgDate = msg.date || 0;
                const timestamp = typeof msgDate === 'object' && msgDate.getTime ? msgDate.getTime() : Number(msgDate) * 1000;

                // 如果时间间隔小于3秒，认为是同一组（放宽时间窗口）
                if (currentGroup.length > 0 && Math.abs(timestamp - lastTimestamp) < 3000) {
                  currentGroup.push(msg);
                } else {
                  if (currentGroup.length > 0) {
                    groupedMessages.push(currentGroup);
                  }
                  currentGroup = [msg];
                }
                lastTimestamp = timestamp;
              }
              if (currentGroup.length > 0) {
                groupedMessages.push(currentGroup);
              }

              console.log(`[发送媒体库] 📊 识别出 ${groupedMessages.length} 个消息组`);

              let successCount = 0;
              let failCount = 0;

              // 批量转发每个组（并行处理，提高速度）
              const forwardPromises = groupedMessages.map(async (group, i) => {
                const messageIds = group.map(msg => {
                  let id = msg.id;
                  if (typeof id === 'object' && id.toJSNumber) {
                    id = id.toJSNumber();
                  }
                  return Number(id);
                });

                try {
                  console.log(`[发送媒体库] 📤 转发消息组 ${i + 1}/${groupedMessages.length} (${group.length} 条消息)...`);
                  
                  // 一起转发媒体组中的所有消息
                  await client.forwardMessages(targetGroupEntity, {
                    messages: messageIds,
                    fromPeer: fromChat,
                  });
                  
                  forwardedMessages.push(...group);
                  successCount++;
                  console.log(`[发送媒体库] ✅ 消息组 ${i + 1} 转发成功`);
                  return true;
                } catch (forwardError: any) {
                  console.error(`[发送媒体库] ❌ 消息组 ${i + 1} 转发失败:`, forwardError?.message);
                  failCount++;
                  
                  // 如果组转发失败，尝试单个转发
                  for (const msg of group) {
                    try {
                      let msgId = msg.id;
                      if (typeof msgId === 'object' && msgId.toJSNumber) {
                        msgId = msgId.toJSNumber();
                      }
                      await client.forwardMessages(targetGroupEntity, {
                        messages: [Number(msgId)],
                        fromPeer: fromChat,
                      });
                      forwardedMessages.push(msg);
                      successCount++;
                      await this.sleep(200); // 缩短延迟
                    } catch (singleError: any) {
                      console.error(`[发送媒体库] ❌ 单个消息转发也失败:`, singleError?.message);
                    }
                  }
                  return false;
                }
              });

              // 等待所有转发完成（串行执行，避免频率限制，但优化顺序）
              // 不使用Promise.all并行，改为串行但快速执行
              for (const promise of forwardPromises) {
                await promise;
                // 组间短暂延迟（100ms），避免频率限制
                await this.sleep(100);
              }

              console.log(`[发送媒体库] 📊 转发统计: 成功 ${successCount} 组，失败 ${failCount} 组，共转发 ${forwardedMessages.length} 条消息`);
              return successCount > 0 || forwardedMessages.length > 0;
            };

            // 修改监听器，添加消息计数和时间戳更新
            // 注意：需要使用一个ID来管理这个监听器，避免重复添加
            const forwardEventId = `forward_media_${Date.now()}`;
            const enhancedHandler = client.addEventHandler(async (event: any) => {
              try {
                const message = event.message;
                if (!message) {
                  console.log(`[发送媒体库] 🔍 监听器收到事件，但没有message对象`);
                  return;
                }

                console.log(`[发送媒体库] 🔍 收到消息事件 - 消息ID: ${message.id}, 聊天类型: ${message.peerId?.className || '未知'}`);

                // 检查消息是否来自机器人的私聊
                // 方法1: 检查fromId（如果存在）
                let senderId: number | null = null;
                const fromId = message.fromId;
                if (fromId && fromId.userId) {
                  senderId = typeof fromId.userId === 'object' && fromId.userId.toJSNumber 
                    ? fromId.userId.toJSNumber() 
                    : Number(fromId.userId);
                }

                // 方法2: 检查peerId（对于私聊，peerId就是发送者）
                const peerId = message.peerId;
                let peerUserId: number | null = null;
                if (peerId && (peerId.className === 'PeerUser' || peerId.userId)) {
                  const uId = peerId.userId;
                  peerUserId = uId?.toJSNumber ? uId.toJSNumber() : Number(uId);
                }

                // 获取bot的ID
                const botId = botInfo.id;
                
                // 确定消息的发送者ID（优先使用fromId，如果没有则使用peerId）
                const actualSenderId = senderId || peerUserId;
                
                // 只处理来自机器人的消息（私聊且ID匹配）
                if (!actualSenderId || String(actualSenderId) !== String(botId)) {
                  return; // 静默跳过
                }

                // 确认是私聊
                const peerType = peerId?.className || '';
                if (peerType !== 'PeerUser' && !peerId.userId) {
                  return;
                }

                console.log(`[发送媒体库] ✅ 确认是机器人私聊消息！`);

                // 标记已收到第一条消息
                if (!hasReceivedFirstMessage) {
                  hasReceivedFirstMessage = true;
                  clearTimeout(firstMessageTimer);
                  console.log(`[发送媒体库] ✅ 已收到机器人第一条回复，等待收集所有消息...`);
                }

                messageCount++;
                lastMessageTime = Date.now();
                
                // 收集消息，不立即转发（等待收集完成后批量转发）
                receivedBotMessages.push(message);
                console.log(`[发送媒体库] 📨 收到机器人消息 #${messageCount} (ID: ${message.id})，已收集`);
                
                // 不在这里转发，而是等待收集完成后统一处理
              } catch (error: any) {
                console.error(`[发送媒体库] 监听器错误:`, error?.message);
              }
            }, new NewMessage({
              incoming: true,
              outgoing: false,
            }), { id: forwardEventId });

            // 移除旧的监听器，使用增强版
            if (messageHandler) {
              try {
                console.log(`[发送媒体库] 🔄 移除旧监听器...`);
                client.removeEventHandler(messageHandler);
                console.log(`[发送媒体库] ✅ 旧监听器已移除`);
              } catch (e: any) {
                console.log(`[发送媒体库] ⚠️ 移除旧监听器失败: ${e?.message}，继续使用新监听器`);
              }
            }
            messageHandler = enhancedHandler;
            console.log(`[发送媒体库] ✅ 增强版监听器已设置`);

            // 开始检查完成状态
            setTimeout(checkComplete, 2000); // 2秒后开始检查
          } catch (sendError: any) {
            cleanup();
            console.error(`[发送媒体库] ❌ 发送关键词失败:`, sendError?.message);
            reject(sendError);
          }
        }, 3000); // 延迟3秒确保监听器已设置好
      });

      const success = await sendPromise;
      return success;
    } catch (error: any) {
      console.error('[发送媒体库] ❌ 发送失败:', error?.message || error);
      if (error?.stack) {
        console.error('[发送媒体库] 错误堆栈:', error.stack);
      }
      return false;
    }
  }

  // 启用自动回复监听
  async enableAutoReply(accountId: number): Promise<void> {
    const client = this.clients.get(accountId);
    if (!client) {
      console.error(`⚠️ 账号 ${accountId} 未连接，无法启用自动回复`);
      return;
    }

    const config = await userAccountDb.getAutoReply(accountId);
    if (!config || !config.is_enabled) {
      console.log(`⚠️ 账号 ${accountId} 自动回复未启用或未配置`);
      return;
    }

    // 使用固定事件ID管理监听器
    const eventId = `auto_reply_${accountId}`;
    
    try {
      // 先移除旧的监听器（确保不重复）
      try {
        client.removeEventHandler(eventId);
      } catch (e) {
        // 忽略移除失败（可能不存在）
      }
      
      const { NewMessage } = require('telegram/events');
      
      client.addEventHandler(async (event: any) => {
        try {
          const message = event.message;
          if (!message) return;
          
          const peer = message.peerId;
          if (!peer || peer.className !== 'PeerUser') return; // 严格限制为私信用户
          
          // 获取发送者ID
          const senderId = peer.userId?.toJSNumber ? peer.userId.toJSNumber() : Number(peer.userId);
          if (!senderId) return;
          
          // 排除自己
          const me = await client.getMe();
          const myId = me?.id?.toJSNumber ? me.id.toJSNumber() : Number(me?.id);
          if (myId === senderId) return;
          
          // 再次检查配置（确保最新且已启用）
          const replyConfig = await userAccountDb.getAutoReply(accountId);
          if (replyConfig && replyConfig.is_enabled && replyConfig.reply_message) {
            console.log(`[自动回复] 📤 账号${accountId} -> 用户${senderId}: ${replyConfig.reply_message}`);
            await client.sendMessage(peer, { message: replyConfig.reply_message });
          }
        } catch (error: any) {
          console.error(`[自动回复] ❌ 账号${accountId} 处理失败:`, error.message);
        }
      }, new NewMessage({ incoming: true, outgoing: false }), { id: eventId });

      console.log(`✅ 账号 ${accountId} 自动回复监听已启用 (仅限私信)`);
    } catch (error: any) {
      console.error(`❌ 启用自动回复监听失败:`, error.message);
    }
  }

  // 禁用自动回复监听
  async disableAutoReply(accountId: number): Promise<void> {
    const client = this.clients.get(accountId);
    if (!client) return;

    const eventId = `auto_reply_${accountId}`;
    try {
      client.removeEventHandler(eventId);
      console.log(`✅ 账号 ${accountId} 自动回复监听已禁用`);
    } catch (error: any) {
      console.error(`❌ 禁用自动回复监听失败:`, error.message);
    }
  }

  // 断开账号连接
  async disconnectAccount(accountId: number): Promise<void> {
    const client = this.clients.get(accountId);
    if (client) {
      await client.disconnect();
      this.clients.delete(accountId);
      console.log(`账号 ${accountId} 已断开连接`);
    }
  }

  // 断开所有连接
  async disconnectAll(): Promise<void> {
    for (const [accountId, client] of this.clients) {
      await client.disconnect();
      console.log(`账号 ${accountId} 已断开连接`);
    }
    this.clients.clear();
  }

  // 工具方法：延迟
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 获取账号信息
  async getAccountInfo(accountId: number): Promise<any> {
    try {
      const client = this.clients.get(accountId);
      if (!client) {
        return null;
      }

      const me = await client.getMe();
      return {
        id: me.id,
        firstName: me.firstName,
        lastName: me.lastName,
        username: me.username,
        phone: me.phone,
      };
    } catch (error) {
      console.error('获取账号信息失败:', error);
      return null;
    }
  }

  // ========== 后台任务系统 ==========

  // 启动并通知
  async startBackgroundCollectionTask(
    userId: number,
    keywords: string[],
    targetChannel: string,
    options: {
      spreadHours: number;
      startDelay: number;
    },
    onComplete: (result: any) => Promise<void>
  ): Promise<{ taskId: string; message: string }> {
    try {
      const activeAccount = await userAccountDb.getActiveAccount();
      if (!activeAccount) {
        throw new Error('没有激活的账号');
      }

      const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      const task: BackgroundTask = {
        taskId,
        accountId: activeAccount.id,
        userId,
        keywords,
        status: 'collecting',
        progress: 0,
        total: keywords.length,
        startTime: Date.now(),
        collectedMessages: [],
      };
      
      this.backgroundTasks.set(taskId, task);
      
      // 后台执行（不阻塞）
      this.runCollectionTaskInBackground(taskId, targetChannel, options, onComplete);
      
      const modeText = options.spreadHours > 0 ? `📅 定时分布模式 (${options.spreadHours}小时)` : `🚀 极速连发模式`;

      return {
        taskId,
        message: `✅ **严格串行任务已启动**\n\n` +
                 `📊 关键词: ${keywords.length}个\n` +
                 `🛠️ 模式: ${modeText}\n` +
                 `💡 策略: 搜一组 -> 发一组 -> 搜下一组\n\n` +
                 `任务执行中，完成后我会立即通知您。`
      };
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * 启动后台收集任务（自定义时间段模式）
   */
  async startBackgroundTimeRangeTask(
    userId: number,
    keywords: string[],
    targetChannel: string,
    startTimeStr: string,
    endTimeStr: string,
    onComplete: (result: any) => Promise<void>
  ): Promise<{ taskId: string; message: string }> {
    try {
      const activeAccount = await userAccountDb.getActiveAccount();
      if (!activeAccount) {
        throw new Error('没有激活的账号');
      }

      const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      const task: BackgroundTask = {
        taskId,
        accountId: activeAccount.id,
        userId,
        keywords,
        status: 'collecting',
        progress: 0,
        total: keywords.length,
        startTime: Date.now(),
        collectedMessages: [],
      };
      
      this.backgroundTasks.set(taskId, task);
      
      // 后台执行（不阻塞）
      this.runTimeRangeTaskInBackground(taskId, targetChannel, startTimeStr, endTimeStr, onComplete);
      
      return {
        taskId,
        message: `✅ **自定义时间段任务已启动**\n\n` +
                 `📊 关键词: ${keywords.length}个\n` +
                 `🕒 时间段: ${startTimeStr} 至 ${endTimeStr}\n` +
                 `💡 策略: 到点启动，在此期间内均匀更新完所有内容\n\n` +
                 `任务已加入计划，您可以继续进行其他操作。`
      };
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * 🚀 升级：支持批量坐标转发，并能定向发送给 Bot 进行“洗白”
   */
  async forwardByPermanentIds(
    targetChatId: number | string,
    sourceChatId: string,
    sourceMsgIds: number[]
  ): Promise<{ success: boolean; messageIds?: number[] }> {
    try {
      const client = await this.getActiveClient();
      if (!client) throw new Error('没有激活的账号');

      console.log(`[自愈系统] 正在批量同步永久仓库 (数量: ${sourceMsgIds.length}): ${sourceChatId}`);

      // 一次性转发整个数组，确保相册不散架
      const sent = await client.forwardMessages(targetChatId, {
        messages: sourceMsgIds,
        fromPeer: sourceChatId
      });

      return { success: true, messageIds: (Array.isArray(sent) ? sent : [sent]).map(message => message.id) };
    } catch (error: any) {
      console.error(`[自愈系统] 批量转发失败:`, error.message);
      return { success: false };
    }
  }

  // 辅助方法：将消息按媒体组 (groupedId) 拆分为原子单元
  private splitByAlbum(messages: any[]): any[][] {
    const result: any[][] = [];
    let buffer: any[] = [];

    for (const msg of messages) {
      const groupedId = msg.groupedId ? msg.groupedId.toString() : null;
      
      if (groupedId) {
        if (!buffer.length || (buffer[0].groupedId && buffer[0].groupedId.toString() === groupedId)) {
          buffer.push(msg);
        } else {
          result.push(buffer);
          buffer = [msg];
        }
      } else {
        if (buffer.length) {
          result.push(buffer);
          buffer = [];
        }
        result.push([msg]);
      }
    }

    if (buffer.length) result.push(buffer);
    return result;
  }

  // 辅助方法：分发单个关键词下的所有原子组，带自愈能力
  private async dispatchAtomicGroupsWithSelfHealing(
    client: any,
    target: any,
    fromPeer: any,
    atomicGroups: any[][],
    isChannel: boolean,
    isBasicGroup: boolean = false
  ): Promise<boolean> {
    for (let i = 0; i < atomicGroups.length; i++) {
      const group = atomicGroups[i];
      let success = false;
      let retryCount = 0;
      const MAX_HARD_RETRIES = 3; // 最大的硬重试次数（消耗配额）
      const MAX_TOTAL_ATTEMPTS = 5; // 包含免责重试在内的总尝试上限

      let totalAttempts = 0;
      while (!success && retryCount < MAX_HARD_RETRIES && totalAttempts < MAX_TOTAL_ATTEMPTS) {
        totalAttempts++;
        const forwardOptions: any = {
          messages: group.map((m: any) => Number(m.id)),
          fromPeer: fromPeer,
        };

        if (isChannel) {
          forwardOptions.dropAuthor = true;
          forwardOptions.silent = true;
        }

        // 调用升级后的微观执行层
        const result = await this.safeForwardWithRetry(client, target, forwardOptions, isBasicGroup);
        
        if (result.status === 'SUCCESS') {
          success = true;
          console.log(`[发送成功] 原子组 ${i + 1}/${atomicGroups.length} 已送达`);
        } else if (result.status === 'FATAL_ERROR') {
          console.error(`[致命中断] 遇到不可恢复错误 (${result.reason})，任务强行终止`);
          return false; // 立即跳出，止损
        } else {
          // PARTIAL_CLEANED 或其他需要重试的情况
          retryCount++;
          console.warn(`[自愈触发] 原子组 ${i + 1} 第 ${retryCount} 次重试 (原因: ${result.reason})`);
          await this.sleep(15000); 
        }
      }

      if (!success) return false;
      
      // 原子组之间微小延迟，防止触发 Telegram 频率限制
      await this.sleep(2000);
    }
    return true;
  }

  /**
   * 后台运行收集任务 (严格串行版 - 标准答案实现)
   */
  private async runCollectionTaskInBackground(
    taskId: string,
    targetChannel: string,
    options: { spreadHours: number; startDelay: number },
    onComplete: (result: any) => Promise<void>
  ) {
    const task = this.backgroundTasks.get(taskId);
    if (!task) return;

    try {
      console.log(`\n[任务指挥官][${taskId}] 🚀 启动严格串行流程`);
      
      const client = await this.getActiveClient();
      if (!client) throw new Error('没有激活的账号');

      // 获取机器人信息
      const config = require('../config').config;
      const { Telegraf } = require('telegraf');
      const bot = new Telegraf(config.botToken);
      const botInfo = await bot.telegram.getMe();
      const fromPeer = await client.getInputEntity(botInfo.username);

      // 获取目标实体
      const group = targetChannel.replace('@', '').trim();
      let targetEntity;
      try {
        targetEntity = await client.getInputEntity(group);
      } catch (e) {
        if (/^\d+$/.test(group)) {
          targetEntity = await client.getInputEntity(parseInt(group));
        } else throw e;
      }
      const isChannel = targetEntity.className === 'InputPeerChannel';
      const isBasicGroup = targetEntity.className === 'InputPeerChat';

      // 计算模式二的间隔时间
      const totalKeywords = task.keywords.length;
      const intervalMs = options.spreadHours > 0 
        ? Math.floor((options.spreadHours * 3600000) / totalKeywords) 
        : 0;

      console.log(`[任务指挥官] 模式: ${intervalMs > 0 ? '定时分布' : '极速连发'}`);
      if (intervalMs > 0) console.log(`[任务指挥官] 预设每组间隔: ${Math.floor(intervalMs/60000)}分${Math.floor((intervalMs%60000)/1000)}秒`);

      for (let i = 0; i < totalKeywords; i++) {
        const keyword = task.keywords[i];
        const keywordStartTime = Date.now();
        
        console.log(`\n[串行步骤][${i+1}/${totalKeywords}] 🟢 开始处理关键词: "${keyword}"`);
        task.status = 'collecting';
        task.progress = i + 1;

        // 1. 采集 (直到稳定)
        const rawMessages = await this.collectSingleKeywordSync(client, botInfo.username, botInfo.id, keyword);
        if (rawMessages.length === 0) {
          console.warn(`[串行步骤] ⚠️ 关键词 "${keyword}" 未采集到内容，跳过`);
          continue;
        }

        // 记录到任务状态中
        task.collectedMessages.push(...rawMessages);

        // 2. 拆分原子组
        const atomicGroups = this.splitByAlbum(rawMessages);
        console.log(`[串行步骤] 📦 识别出 ${atomicGroups.length} 个原子单元 (消息/媒体组)`);

        // 3. 发送并自愈 (严格串行)
        task.status = 'sending';
        const sendSuccess = await this.dispatchAtomicGroupsWithSelfHealing(client, targetEntity, fromPeer, atomicGroups, isChannel, isBasicGroup);

        if (!sendSuccess) {
          console.error(`[串行步骤] ❌ 关键词 "${keyword}" 发送最终失败`);
          // 可根据需求决定是否中断整个队列，这里选择记录错误并继续
        }

        console.log(`[串行步骤] ✅ 关键词 "${keyword}" 处理完成`);

        // 4. 节奏控制 (如果是模式二)
        if (intervalMs > 0 && i < totalKeywords - 1) {
          const elapsed = Date.now() - keywordStartTime;
          const remainingWait = intervalMs - elapsed;
          if (remainingWait > 0) {
            console.log(`[节奏大师] 💤 等待预定时间轴: 还需休息 ${Math.floor(remainingWait/1000)} 秒...`);
            await this.sleep(remainingWait);
          }
        }
      }

      task.status = 'completed';
      console.log(`\n[任务指挥官][${taskId}] 🎉 全部任务严格执行完毕！`);

      await onComplete({
        success: true,
        taskId,
        messageCount: task.collectedMessages.length,
      });

    } catch (error: any) {
      console.error(`[任务指挥官][${taskId}] ❌ 崩溃:`, error.message);
      task.status = 'failed';
      task.error = error.message;
      await onComplete({ success: false, taskId, error: error.message });
    }
  }

  /**
   * 后台运行收集任务（自定义时间段模式）
   */
  private async runTimeRangeTaskInBackground(
    taskId: string,
    targetChannel: string,
    startTimeStr: string,
    endTimeStr: string,
    onComplete: (result: any) => Promise<void>
  ) {
    const task = this.backgroundTasks.get(taskId);
    if (!task) return;

    try {
      console.log(`\n[任务指挥官][${taskId}] 📅 启动自定义时间段任务: ${startTimeStr} - ${endTimeStr}`);
      
      const client = await this.getActiveClient();
      if (!client) throw new Error('没有激活的账号');

      // 1. 计算时间
      const [startH, startM] = startTimeStr.split(':').map(Number);
      const [endH, endM] = endTimeStr.split(':').map(Number);
      
      const now = new Date();
      let start = new Date();
      start.setHours(startH, startM, 0, 0);
      
      let end = new Date();
      end.setHours(endH, endM, 0, 0);

      // 如果结束时间早于开始时间，说明跨天
      if (end < start) {
        end.setDate(end.getDate() + 1);
      }

      // 如果当前时间已经过了结束时间，说明是计划明天的
      if (now > end) {
        start.setDate(start.getDate() + 1);
        end.setDate(end.getDate() + 1);
      }

      let waitMs = start.getTime() - now.getTime();
      
      // 如果已在时间段内，waitMs 将为负或零，将其设为 0
      if (waitMs < 0) waitMs = 0;

      // 剩余任务时长
      let taskDurationMs = end.getTime() - Math.max(now.getTime(), start.getTime());
      
      if (waitMs > 0) {
        console.log(`[任务指挥官] 🕒 未到开始时间，进入等待模式: ${Math.floor(waitMs/60000)} 分钟后启动`);
        task.status = 'scheduling';
        await this.sleep(waitMs);
      }

      console.log(`[任务指挥官] 🚀 任务正式开始，预计总时长: ${Math.floor(taskDurationMs/60000)} 分钟`);

      // 获取机器人信息
      const config = require('../config').config;
      const { Telegraf } = require('telegraf');
      const bot = new Telegraf(config.botToken);
      const botInfo = await bot.telegram.getMe();
      const fromPeer = await client.getInputEntity(botInfo.username);

      // 获取目标实体
      const group = targetChannel.replace('@', '').trim();
      let targetEntity;
      try {
        targetEntity = await client.getInputEntity(group);
      } catch (e) {
        if (/^\d+$/.test(group)) {
          targetEntity = await client.getInputEntity(parseInt(group));
        } else throw e;
      }
      const isChannel = targetEntity.className === 'InputPeerChannel';
      const isBasicGroup = targetEntity.className === 'InputPeerChat';

      // 计算间隔 (总时长除以关键词数)
      const totalKeywords = task.keywords.length;
      const intervalMs = Math.floor(taskDurationMs / totalKeywords);

      console.log(`[任务指挥官] 均匀分布间隔: ${Math.floor(intervalMs/60000)}分${Math.floor((intervalMs%60000)/1000)}秒`);

      for (let i = 0; i < totalKeywords; i++) {
        const keyword = task.keywords[i];
        const keywordStartTime = Date.now();
        
        console.log(`\n[串行步骤][${i+1}/${totalKeywords}] 🟢 开始处理关键词: "${keyword}"`);
        task.status = 'collecting';
        task.progress = i + 1;

        // 1. 采集
        const rawMessages = await this.collectSingleKeywordSync(client, botInfo.username, botInfo.id, keyword);
        if (rawMessages.length === 0) {
          console.warn(`[串行步骤] ⚠️ 关键词 "${keyword}" 未采集到内容，跳过`);
        } else {
          // 记录到任务状态中
          task.collectedMessages.push(...rawMessages);

          // 2. 拆分原子组
          const atomicGroups = this.splitByAlbum(rawMessages);
          console.log(`[串行步骤] 📦 识别出 ${atomicGroups.length} 个原子单元`);

          // 3. 发送并自愈 (严格串行)
          task.status = 'sending';
          const sendSuccess = await this.dispatchAtomicGroupsWithSelfHealing(client, targetEntity, fromPeer, atomicGroups, isChannel, isBasicGroup);
          if (!sendSuccess) {
            console.error(`[串行步骤] ❌ 关键词 "${keyword}" 发送最终失败`);
          }
          console.log(`[串行步骤] ✅ 关键词 "${keyword}" 处理完成`);
        }

        // 4. 节奏控制 (如果是模式二)
        if (i < totalKeywords - 1) {
          const elapsed = Date.now() - keywordStartTime;
          const remainingWait = intervalMs - elapsed;
          if (remainingWait > 0) {
            console.log(`[节奏大师] 💤 等待时间轴: 还需休息 ${Math.floor(remainingWait/1000)} 秒...`);
            await this.sleep(remainingWait);
          }
        }
      }

      task.status = 'completed';
      console.log(`\n[任务指挥官][${taskId}] 🎉 全部任务按自定义时间段执行完毕！`);

      await onComplete({
        success: true,
        taskId,
        messageCount: task.collectedMessages.length,
      });

    } catch (error: any) {
      console.error(`[任务指挥官][${taskId}] ❌ 崩溃:`, error.message);
      task.status = 'failed';
      task.error = error.message;
      await onComplete({ success: false, taskId, error: error.message });
    }
  }

  /**
   * 同步收集单个关键词（等待完全收集后才返回）
   */
  private async collectSingleKeywordSync(
    client: any,
    botUsername: string,
    botId: number,
    keyword: string
  ): Promise<any[]> {
    return new Promise(async (resolve) => {
      const messages: any[] = [];
      let handler: any = null;
      let timeoutId: NodeJS.Timeout | null = null;
      let stableCheckId: NodeJS.Timeout | null = null;
      let isResolved = false;
      
      const safeResolve = (msgs: any[]) => {
        if (isResolved) return;
        cleanup(); // 先清理再设标志
        isResolved = true;
        resolve(msgs);
      };
        
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (stableCheckId) {
          clearTimeout(stableCheckId);
          stableCheckId = null;
        }
        if (handler) {
          try {
            client.removeEventHandler(handler);
            console.log(`[${keyword}] 🧹 监听器已清理`);
          } catch (e) {}
          handler = null;
        }
      };
      
      try {
        const { NewMessage } = require('telegram/events');
        let lastMessageTime = Date.now();
        
        console.log(`[${keyword}] 🔧 设置专属监听器...`);
        
        handler = client.addEventHandler(async (event: any) => {
          try {
            const msg = event.message;
            if (!msg) return;
            
            // 🚀 核心修复：增加来源校验，只收集来自指定对话的消息
            // 这样即便同时有多个采集任务，也不会互相干扰
            const peerId = msg.peerId;
            if (!peerId) return;
            
            // 获取当前消息的来源 ID
            let currentChatId: number | null = null;
            if (peerId.userId) {
              currentChatId = typeof peerId.userId === 'object' && peerId.userId.toJSNumber ? peerId.userId.toJSNumber() : Number(peerId.userId);
            } else if (peerId.channelId) {
              currentChatId = typeof peerId.channelId === 'object' && peerId.channelId.toJSNumber ? peerId.channelId.toJSNumber() : Number(peerId.channelId);
            } else if (peerId.chatId) {
              currentChatId = typeof peerId.chatId === 'object' && peerId.chatId.toJSNumber ? peerId.chatId.toJSNumber() : Number(peerId.chatId);
            }

            // 只接受来自机器人对话的消息
            if (currentChatId !== botId) return;
            
            const msgId = msg.id;
            const exists = messages.some(m => {
              let id = m.id;
              if (typeof id === 'object' && id.toJSNumber) id = id.toJSNumber();
              return Number(id) === Number(msgId);
            });
            
            if (!exists) {
              messages.push(msg);
              lastMessageTime = Date.now();
              console.log(`[${keyword}] ✅ 收到 #${messages.length}`);
            }
          } catch (err: any) {
            console.error(`[${keyword}] ❌ 监听器错误:`, err?.message);
          }
        }, new NewMessage({ incoming: true, outgoing: false }), { id: `collect_sync_${keyword}_${Date.now()}` });
        
        console.log(`[${keyword}] ✅ 监听器已设置`);
        
        // 等待3秒确保监听器就绪
        await this.sleep(3000);
        
        // 发送关键词
        console.log(`[${keyword}] 📤 发送关键词...`);
        await client.sendMessage(botUsername, { message: keyword });
        console.log(`[${keyword}] ✅ 已发送，等待回复...`);
        
        // 超时保护（60秒）
        timeoutId = setTimeout(() => {
          console.log(`[${keyword}] ⏱️ 超时，收到 ${messages.length} 条`);
          safeResolve(messages);
        }, 60000);
        
        // 稳定性检查（10秒无新消息即完成）
        const checkStable = () => {
          const timeSince = Date.now() - lastMessageTime;
          
          if (messages.length > 0 && timeSince > 10000) {
            console.log(`[${keyword}] ✅ 收集稳定（10秒无新消息），共 ${messages.length} 条`);
            safeResolve(messages);
          } else {
            stableCheckId = setTimeout(checkStable, 1000);
          }
        };
        
        stableCheckId = setTimeout(checkStable, 1000);
        
      } catch (error: any) {
        console.error(`[${keyword}] ❌ 收集失败:`, error?.message);
        safeResolve([]);
      }
    });
  }

  private async safeForwardWithRetry(
    client: any, 
    target: any, 
    options: any, 
    isBasicGroup: boolean = false
  ): Promise<{ status: 'SUCCESS' | 'PARTIAL_CLEANED' | 'FATAL_ERROR', reason?: string }> {
      try {
      // 1. 执行转发动作
        const results = await client.forwardMessages(target, options);
      
      // 🚀 核心修复：从 GramJS 各种可能的返回类型中提取消息列表
      let sentMessages: any[] = [];
      if (Array.isArray(results)) {
        sentMessages = results;
      } else if (results && typeof results === 'object') {
        if (results.updates && Array.isArray(results.updates)) {
          sentMessages = results.updates
            .map((u: any) => u.message || (u.update && u.update.message))
            .filter((m: any) => m && (m.id || m.className === 'Message'));
        } else if (results.messages && Array.isArray(results.messages)) {
          sentMessages = results.messages;
        } else if (results.id || results.className === 'Message') {
          sentMessages = [results];
        }
      }

        const expectedCount = options.messages.length;
        const actualCount = sentMessages.length;

      // 2. 判定成功（根据群组类型执行不同的完整性校验）
      let isSuccess = false;
      if (isBasicGroup && expectedCount > 1) {
        // 【普通群 + 相册】: 尝试执行 100% 匹配。
        // 但如果 GramJS 返回了成功的 Updates 对象但实际提取数量不符，
        // 考虑到普通群的非原子性，我们增加一个兜底判断，防止因为提取失败导致的无限重复发送。
        if (actualCount === expectedCount) {
          isSuccess = true;
        } else if (results && (results.className === 'Updates' || results.className === 'UpdatesCombined')) {
          console.log(`[自愈系统] 普通群相册转发返回了成功对象，虽然提取数量(${actualCount})不匹配预期(${expectedCount})，为防止重复发送，判定为成功。`);
          isSuccess = true;
        }
      } else {
        // 【频道/超级群】或【单条消息】: 
        // 维持实用主义策略：只要有返回 ID 且不是 0，通常认为 Telegram 已接管。
        isSuccess = (actualCount === expectedCount || (expectedCount > 1 && actualCount > 0));
        
        // 兜底：如果是成功的 Updates 对象，也认为成功
        if (!isSuccess && results && (results.className === 'Updates' || results.className === 'UpdatesCombined')) {
          isSuccess = true;
        }
      }

      if (isSuccess) {
        return { status: 'SUCCESS' };
        }
        
      // 3. 判定为碎片：执行撤回自愈
      console.warn(`⚠️ [自愈系统] ${isBasicGroup ? '普通群' : '频道/超级群'}发送不完整 (${actualCount}/${expectedCount})，启动撤回...`);
        const msgIdsToDelete = sentMessages.map((m: any) => m.id).filter((id: any) => id);
      
        if (msgIdsToDelete.length > 0) {
          try {
            await client.deleteMessages(target, msgIdsToDelete, { revoke: true });
          console.log(`✅ [自愈系统] 已成功撤回碎片消息，确保了频道整洁`);
          } catch (delError: any) {
          // 如果撤回都失败了，这才是真正的风险点
          console.error(`🚨 [严重风险] 碎片撤回失败！频道可能残留脏数据: ${delError.message}`);
          }
        }
      
      return { status: 'PARTIAL_CLEANED', reason: isBasicGroup && expectedCount > 1 ? '普通群相册发送不完整' : '发送不完整且已尝试清理' };

      } catch (error: any) {
      // 4. 致命错误精准识别
      const isFatal = 
        error.code === 403 || 
        error.code === 401 ||
        error.errorMessage === 'CHAT_ADMIN_REQUIRED' ||
        error.errorMessage === 'USER_BANNED_IN_CHANNEL' ||
        error.message.includes('AUTH_KEY_DUPLICATED');

      if (isFatal) {
        return { status: 'FATAL_ERROR', reason: error.errorMessage || error.message };
        }

      // 🚀 核心优化：针对 Telegram 500 错误 (如 WORKER_BUSY) 的特殊处理
      // 这种错误通常意味着消息已经到达服务器，但服务器太忙没给回执。
      // 如果重试，极大概率会导致重复发送。
      if (error.code === 500 || error.message.includes('WORKER_BUSY')) {
        console.warn(`[自愈系统] 捕获到 Telegram 500 错误: ${error.message}。判定为 SUCCESS 以防止重复发送。`);
        return { status: 'SUCCESS' };
      }

      return { status: 'PARTIAL_CLEANED', reason: `捕获异常: ${error.message}` };
    }
  }

  /**
   * 🚀 启动“瞬时同步流”监听器
   * 监听关联群组的消息镜像，实现秒级自动索引
   */
  async startLiveIndexer(groupId: string): Promise<void> {
    try {
      const client = await this.getActiveClient();
      if (!client) return;

      const { NewMessage } = require('telegram/events');
      console.log(`📡 [实时索引] 正在监听同步群组: ${groupId}`);

      client.addEventHandler(async (event: any) => {
        const msg = event.message;
        if (!msg || !msg.peerId) return;

        // 验证来源群组
        let currentChatId: string;
        if (msg.peerId.channelId) {
          currentChatId = `-100${msg.peerId.channelId.toString()}`;
        } else if (msg.peerId.chatId) {
          currentChatId = msg.peerId.chatId.toString();
        } else return;

        if (currentChatId !== groupId) return;

        // 如果是媒体消息，记录到数据库
        if (msg.media) {
          console.log(`✨ [实时索引] 捕捉到同步镜像消息: ${msg.id}`);
          // 这里可以进一步实现：根据 caption 中的隐藏标签自动关联关键词
          // 或者仅仅作为存证记录
        }
      }, new NewMessage({ incoming: true }));

    } catch (error: any) {
      console.error(`[实时索引] 启动失败:`, error.message);
    }
  }

  /**
   * 使用程序定时器控制发送（替代scheduleDate）
   */
  private async scheduleMessagesWithTimers(
    messages: any[],
    targetChannel: string,
    options: {
      spreadHours: number;
      startDelay: number;
    },
    taskId: string,
    keywordBoundaries?: Array<{ keyword: string; start: number; end: number; count: number }>
  ): Promise<any> {
    try {
      const client = await this.getActiveClient();
      if (!client) {
        throw new Error('没有激活的账号');
      }

      console.log(`[定时器调度] 📅 开始设置定时发送`);
      console.log(`[定时器调度] 📊 总消息: ${messages.length} 条`);
      console.log(`[定时器调度] ⏰ 分散时长: ${options.spreadHours} 小时`);
      console.log(`[定时器调度] 🕐 延迟开始: ${options.startDelay} 小时`);

      // 获取目标实体
      const group = targetChannel.replace('@', '').trim();
      let targetEntity;
      
      try {
        targetEntity = await client.getInputEntity(group);
      } catch (e) {
        if (/^\d+$/.test(group)) {
          const groupIdNum = parseInt(group);
          try {
            targetEntity = await client.getInputEntity(groupIdNum);
          } catch (e2) {
            const negativeId = -1000000000000 - Math.abs(groupIdNum);
            targetEntity = await client.getInputEntity(negativeId);
          }
        } else {
          throw e;
        }
      }

      const isChannel = targetEntity.className === 'InputPeerChannel';
      const isBasicGroup = targetEntity.className === 'InputPeerChat';
      console.log(`[定时器调度] 📺 目标类型: ${isChannel ? '频道/超级群' : isBasicGroup ? '普通群' : '私聊'}`);

      // 获取消息来源
      const config = require('../config').config;
      const { Telegraf } = require('telegraf');
      const bot = new Telegraf(config.botToken);
      const botInfo = await bot.telegram.getMe();
      const fromChat = await client.getInputEntity(botInfo.username);

      // 分组策略：按关键词边界分组（保持完整性）
      const groups: any[][] = [];
      
      if (keywordBoundaries && keywordBoundaries.length > 0) {
        // 按关键词分组（每个关键词作为一个完整的组）
        console.log(`[定时器调度] 📋 使用关键词边界分组（保证每个关键词完整）`);
        
        for (const boundary of keywordBoundaries) {
          const keywordMessages = messages.slice(boundary.start, boundary.end + 1);
          
          // 如果单个关键词超过10条，按10条切分
          if (keywordMessages.length <= 10) {
            groups.push(keywordMessages);
          } else {
            for (let i = 0; i < keywordMessages.length; i += 10) {
              groups.push(keywordMessages.slice(i, i + 10));
            }
          }
        }
      } else {
        // 降级：按固定10条分组
        console.log(`[定时器调度] 📋 使用固定分组（每10条一组）`);
        for (let i = 0; i < messages.length; i += 10) {
          groups.push(messages.slice(i, i + 10));
        }
      }

      console.log(`[定时器调度] 📦 分为 ${groups.length} 组`);

      // 计算时间分布
      const startDelayMs = Math.max(60000, options.startDelay * 3600000); // 至少1分钟
      const totalMs = options.spreadHours * 3600000; // 总时长（毫秒）
      const intervalPerGroup = groups.length > 1 
        ? Math.floor(totalMs / groups.length)
        : 60000;

      const startTime = Date.now() + startDelayMs;
      const endTime = startTime + (groups.length - 1) * intervalPerGroup;

      console.log(`[定时器调度] ⏰ 时间规划:`);
      console.log(`[定时器调度]    总组数: ${groups.length} 组`);
      console.log(`[定时器调度]    开始: ${new Date(startTime).toLocaleString('zh-CN')}`);
      console.log(`[定时器调度]    结束: ${new Date(endTime).toLocaleString('zh-CN')}`);
      console.log(`[定时器调度]    每组间隔: ${Math.floor(intervalPerGroup / 60000)} 分钟`);

      // 设置定时器逐组发送
      let scheduleTime = startTime;
      let successCount = 0;

      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const groupIndex = i; // 闭包捕获
        const totalGroups = groups.length; // 闭包捕获
        const delay = scheduleTime - Date.now();
        
        console.log(`[定时器调度] ⏰ 组${i + 1}将在 ${new Date(scheduleTime).toLocaleTimeString('zh-CN')} 发送 (${Math.floor(delay / 60000)}分${Math.floor((delay % 60000) / 1000)}秒后)`);

        // 预先提取消息ID
        const messageIds = group.map(msg => {
          let id = msg.id;
          if (typeof id === 'object' && id.toJSNumber) id = id.toJSNumber();
          return Number(id);
        });

        // 设置定时器（闭包捕获所有必要变量）
        ((msgIds, idx, total, isChan, isBasic, from, target, tId) => {
          setTimeout(async () => {
            try {
              console.log(`[定时器调度] 📤 [${new Date().toLocaleTimeString('zh-CN')}] 开始发送组${idx + 1}/${total} (${msgIds.length}条)`);

              const forwardOptions: any = {
                messages: msgIds,
                fromPeer: from,
              };

              if (isChan) {
                forwardOptions.dropAuthor = true;
                forwardOptions.silent = true;
              }

              // 获取最新的client（防止断线）
              const currentClient = await this.getActiveClient();
              if (currentClient) {
                // 🚀 优化：使用带自愈能力的发送函数
                const forwardResult = await this.safeForwardWithRetry(currentClient, target, forwardOptions, isBasic);
                
                if (forwardResult.status === 'SUCCESS') {
                  console.log(`[定时器调度] ✅ 组${idx + 1}发送成功 (已通过完整性校验)`);
                } else {
                  console.error(`[定时器调度] ❌ 组${idx + 1}发送失败 (原因: ${forwardResult.reason})`);
                }
              } else {
                console.error(`[定时器调度] ❌ 组${idx + 1}发送失败：账号未连接`);
              }

              // 如果是最后一组，标记任务为完成
              if (idx + 1 === total) {
                const task = this.backgroundTasks.get(tId);
                if (task) {
                  task.status = 'completed';
                  console.log(`[定时器调度] 🎉 任务 ${tId} 所有消息发送完成！`);
                  
                  // 1小时后自动清理已完成的任务
                  setTimeout(() => {
                    this.backgroundTasks.delete(tId);
                    console.log(`[任务清理] 🧹 已清理完成的任务 ${tId}`);
                  }, 3600000); // 1小时后清理
                }
              }
            } catch (error: any) {
              console.error(`[定时器调度] ❌ 组${idx + 1}发送失败:`, error?.message);
            }
          }, delay);
        })(messageIds, groupIndex, totalGroups, isChannel, isBasicGroup, fromChat, targetEntity, taskId);

        successCount++;
        scheduleTime += intervalPerGroup;
      }

      const finalDate = new Date(endTime);

      console.log(`[定时器调度] ✅ 定时器设置完成！`);
      console.log(`[定时器调度] 📊 已设置 ${successCount} 个定时器`);
      console.log(`[定时器调度] ⏰ 最后发送: ${finalDate.toLocaleString('zh-CN')}`);
      console.log(`[定时器调度] 💡 程序需要保持运行才能发送！`);

      return {
        success: true,
        scheduledGroups: successCount,
        totalGroups: groups.length,
        startTime: new Date(startTime),
        endTime: finalDate,
      };
    } catch (error: any) {
      console.error('[定时器调度] ❌ 调度失败:', error?.message);
      throw error;
    }
  }

  /**
   * 设置定时发送（时间分散）- 旧方法，使用Telegram的scheduleDate
   */
  private async scheduleMessagesWithSpread(
    messages: any[],
    targetChannel: string,
    options: {
      spreadHours: number;
      startDelay: number;
    }
  ): Promise<any> {
    try {
      const client = await this.getActiveClient();
      if (!client) {
        throw new Error('没有激活的账号');
      }

      console.log(`[定时调度] 📅 开始设置定时发送`);
      console.log(`[定时调度] 📊 总消息: ${messages.length} 条`);
      console.log(`[定时调度] ⏰ 分散时长: ${options.spreadHours} 小时`);
      console.log(`[定时调度] 🕐 延迟开始: ${options.startDelay} 小时`);

      // 获取目标实体
      const group = targetChannel.replace('@', '').trim();
      let targetEntity;
      
      try {
        targetEntity = await client.getInputEntity(group);
      } catch (e) {
        if (/^\d+$/.test(group)) {
          const groupIdNum = parseInt(group);
          try {
            targetEntity = await client.getInputEntity(groupIdNum);
          } catch (e2) {
            const negativeId = -1000000000000 - Math.abs(groupIdNum);
            targetEntity = await client.getInputEntity(negativeId);
          }
        } else {
          throw e;
        }
      }

      const isChannel = targetEntity.className === 'InputPeerChannel';
      console.log(`[定时调度] 📺 目标类型: ${isChannel ? '频道' : '群组'}`);

      // 获取消息来源
      const config = require('../config').config;
      const { Telegraf } = require('telegraf');
      const bot = new Telegraf(config.botToken);
      const botInfo = await bot.telegram.getMe();
      const fromChat = await client.getInputEntity(botInfo.username);

      // 分组（每10条一组）
      const GROUP_SIZE = 10;
      const groups: any[][] = [];
      
      for (let i = 0; i < messages.length; i += GROUP_SIZE) {
        groups.push(messages.slice(i, i + GROUP_SIZE));
      }

      console.log(`[定时调度] 📦 分为 ${groups.length} 组`);

      // 计算时间分布（修复）
      const now = Math.floor(Date.now() / 1000);
      const startTime = now + Math.max(60, options.startDelay * 3600); // 至少延迟60秒
      const totalSeconds = options.spreadHours * 3600;
      
      // 修复：间隔应该是总时间除以组数
      const intervalPerGroup = groups.length > 1 
        ? Math.floor(totalSeconds / groups.length)
        : 60; // 单组时至少60秒间隔

      const startDate = new Date(startTime * 1000);
      const endTime = startTime + (groups.length - 1) * intervalPerGroup;
      const endDate = new Date(endTime * 1000);

      console.log(`[定时调度] ⏰ 时间规划:`);
      console.log(`[定时调度]    总组数: ${groups.length} 组`);
      console.log(`[定时调度]    开始: ${startDate.toLocaleString('zh-CN')}`);
      console.log(`[定时调度]    结束: ${endDate.toLocaleString('zh-CN')}`);
      console.log(`[定时调度]    每组间隔: ${Math.floor(intervalPerGroup / 60)} 分钟 ${intervalPerGroup % 60} 秒`);
      console.log(`[定时调度]    分散时长: ${options.spreadHours} 小时`);

      // 调度所有组
      let scheduleTime = startTime;
      let successCount = 0;

      console.log(`[定时调度] 📤 开始调度各组...`);

      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const messageIds = group.map(msg => {
          let id = msg.id;
          if (typeof id === 'object' && id.toJSNumber) id = id.toJSNumber();
          return Number(id);
        });

        try {
          const schedTime = new Date(scheduleTime * 1000);
          
          // 详细日志：每组都显示
          console.log(`[定时调度] 📤 调度组${i + 1}/${groups.length}:`);
          console.log(`[定时调度]    消息数: ${group.length} 条`);
          console.log(`[定时调度]    消息ID: ${messageIds[0]} - ${messageIds[messageIds.length - 1]}`);
          console.log(`[定时调度]    定时时间: ${schedTime.toLocaleString('zh-CN')}`);
          console.log(`[定时调度]    Unix时间戳: ${scheduleTime}`);

          const forwardOptions: any = {
            messages: messageIds,
            fromPeer: fromChat,
            scheduleDate: scheduleTime, // 定时发送
          };

          if (isChannel) {
            forwardOptions.dropAuthor = true;  // 取消转发来源
            forwardOptions.silent = true;       // 静默发送
          }

          await client.forwardMessages(targetEntity, forwardOptions);

          successCount++;
          console.log(`[定时调度] ✅ 组${i + 1}调度成功`);

          // 下一组时间
          scheduleTime += intervalPerGroup;

        } catch (error: any) {
          console.error(`[定时调度] ❌ 组${i + 1}调度失败:`, error?.message);
          console.error(`[定时调度] 错误详情:`, error);
        }
      }

      const finalDate = new Date((scheduleTime - intervalPerGroup) * 1000);

      console.log(`[定时调度] ✅ 调度完成！`);
      console.log(`[定时调度] 📊 成功: ${successCount}/${groups.length} 组`);
      console.log(`[定时调度] ⏰ 最后发送: ${finalDate.toLocaleString('zh-CN')}`);

      return {
        success: true,
        scheduledGroups: successCount,
        totalGroups: groups.length,
        startTime: startDate,
        endTime: finalDate,
      };
    } catch (error: any) {
      console.error('[定时调度] ❌ 调度失败:', error?.message);
      throw error;
    }
  }

  /**
   * 停止指定的后台任务
   */
  stopTask(taskId: string): boolean {
    const task = this.backgroundTasks.get(taskId);
    if (!task) return false;
    
    // 标记为已失败（被手动终止）
    task.status = 'failed';
    task.error = '任务被管理员手动终止';
    
    // 从活动任务中移除
    this.backgroundTasks.delete(taskId);
    console.log(`[任务指挥官] 🛑 任务 ${taskId} 已被管理员手动终止`);
    return true;
  }

  /**
   * 查询任务状态
   */
  getTaskStatus(taskId: string): any {
    const task = this.backgroundTasks.get(taskId);
    if (!task) {
      return null;
    }

    const elapsed = Math.floor((Date.now() - task.startTime) / 1000);
    const elapsedMin = Math.floor(elapsed / 60);
    const elapsedSec = elapsed % 60;

    return {
      taskId: task.taskId,
      status: task.status,
      progress: `${task.progress}/${task.total}`,
      elapsed: `${elapsedMin}分${elapsedSec}秒`,
      collectedCount: task.collectedMessages.length,
      scheduledGroups: task.scheduledGroups,
      totalGroups: task.totalGroups,
      statusText: this.getStatusText(task.status),
    };
  }

  /**
   * 获取所有运行中的任务
   */
  getRunningTasks(): any[] {
    return Array.from(this.backgroundTasks.values()).map(task => ({
      taskId: task.taskId,
      status: task.status,
      progress: `${task.progress}/${task.total}`,
      currentKeyword: task.keywords[task.progress - 1] || '等待中',
      totalKeywords: task.total,
      processedKeywords: task.progress,
      keywordsList: task.keywords,
      startTime: task.startTime,
      collectedCount: task.collectedMessages.length
    }));
  }

  private getStatusText(status: string): string {
    switch (status) {
      case 'collecting': return '🔄 收集中';
      case 'scheduling': return '📅 调度中';
      case 'sending': return '📤 发送中（定时器运行）';
      case 'completed': return '✅ 已完成';
      case 'failed': return '❌ 失败';
      default: return '❓ 未知';
    }
  }
}

export const accountController = new UserAccountController();
