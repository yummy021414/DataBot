import { ButtonMakerHandler } from './handlers/ButtonMakerHandler';
import { Telegraf, Markup, Context } from 'telegraf';
import { config, BUTTONS, authorizedUsers, getAdminChannelIds, hasAdminChannelMap, isAdminUser, isSuperAdmin } from '../config';
import { BotMode, UserSession } from '../types';
import { database } from '../database';
import { SearchHandler } from './handlers/SearchHandler';
import { ReplaceGroupHandler } from './handlers/ReplaceGroupHandler';
import { RecentSearchHandler } from './handlers/RecentSearchHandler';
import { RecommendationHandler } from './handlers/RecommendationHandler';
import { recommendations } from '../services/recommendations';
import { publicationQueue } from '../services/publicationQueue';
import { UploadHandler } from './handlers/UploadHandler';
import { PublishHandler } from './handlers/PublishHandler';
import { scheduledPublish } from '../services/scheduledPublish';
import { JoinWelcomeHandler } from './handlers/JoinWelcomeHandler';
import { DirectSendHandler } from './handlers/DirectSendHandler';
import { AlbumHandler } from './handlers/AlbumHandler';
import { userAccountCommands, accountController } from '../userAccount';
import { TagFilterHandler } from './handlers/TagFilterHandler';
import { ForwardingService } from '../forwarding';
import { BroadcastDataHandler } from './handlers/BroadcastDataHandler';
import { ReviewHandler } from './handlers/ReviewHandler';
import { WatermarkHandler } from './handlers/WatermarkHandler';
import { getVaultCoverageStats, checkVaultAccess } from '../services/vault';

export class TelegramBot {
  private bot: Telegraf;
  private forwardingService: ForwardingService;
    private userSessions: Map<number, UserSession>;
    private adminMessageToUserMap: Map<number, number>;
    private broadcastContent: any;

    private getUserDisplay(ctx: Context): string {
        const user = ctx.from;
        if (!user) return '未知用户';
        const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || '未设置昵称';
        const userTag = user.username ? ` (@${user.username})` : '';
        return `${fullName}${userTag} (ID: ${user.id})`;
    }

    private isAdmin(userId: number): boolean {
      return isAdminUser(userId);
    }

    private isRootAdmin(userId: number): boolean {
      return isSuperAdmin(userId);
    }

    private getDataScopeUserId(userId: number, _hasPermission: boolean = false): number | undefined {
      if (this.isRootAdmin(userId)) return undefined;
      // 子管理员看自己的库；普通用户与搜索一致，看超管公共库
      if (this.isAdmin(userId)) return userId;
      return config.superAdminId;
    }

    withAuthorization(handler: (ctx: Context) => Promise<void>) {
    return async (ctx: Context) => {
        const userId = ctx.from?.id;
        if (!userId) {
            await ctx.reply('You are not authorized to use this bot.');
            return;
        }
            
            const userDisplay = this.getUserDisplay(ctx);

            // 追踪所有用户活动
            try {
                await database.trackUser(
                    userId,
                    ctx.from?.first_name,
                    ctx.from?.last_name,
                    ctx.from?.username
                );
            } catch (error) {
                console.error('追踪用户失败:', error);
            }

            // 📝 记录具体行为
            if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
                console.log(`👤 [交互] ${userDisplay} -> 🖱️ 点击按钮: ${ctx.callbackQuery.data}`);
            } else if (ctx.message && 'text' in ctx.message) {
                // 如果是命令不单独记，在后续逻辑处理
                if (!ctx.message.text.startsWith('/')) {
                    console.log(`👤 [消息] ${userDisplay} -> 💬 发送文本: "${ctx.message.text}"`);
                }
            } else if (ctx.message) {
                const message = ctx.message as any;
                const type = message.photo ? '照片' : message.video ? '视频' : message.document ? '文档' : message.audio ? '音频' : message.voice ? '语音' : '媒体';
                console.log(`👤 [媒体] ${userDisplay} -> 📂 发送${type}`);
        }
        
        // 允许所有用户使用机器人（包括普通用户）
        // 普通用户可以查看公共资料库
        await handler.call(this, ctx);
    };
  }
  // 严格权限检查：只允许超级管理员
    withStrictAuthorization(handler: (ctx: Context) => Promise<void>) {
    return async (ctx: Context) => {
        const userId = ctx.from?.id;
        if (!userId) {
            await ctx.reply('You are not authorized to use this bot.');
            return;
        }
            
            const userDisplay = this.getUserDisplay(ctx);

            // 追踪所有用户活动（包括管理员）
            try {
                await database.trackUser(
                    userId,
                    ctx.from?.first_name,
                    ctx.from?.last_name,
                    ctx.from?.username
                );
            } catch (error) {
                console.error('追踪用户失败:', error);
            }

            // 📝 管理员行为日志
            if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
                console.log(`👑 [管理] ${userDisplay} -> 🖱️ 点击按钮: ${ctx.callbackQuery.data}`);
            } else if (ctx.message && 'text' in ctx.message) {
                if (!ctx.message.text.startsWith('/')) {
                    console.log(`👑 [管理] ${userDisplay} -> 💬 发送文本: "${ctx.message.text}"`);
                }
        }
        
        // 允许超级管理员与额外管理员
        const isAdmin = this.isAdmin(userId);
        if (!isAdmin) {
                console.warn(`⚠️ [越权警告] ${userDisplay} 尝试访问管理员功能`);
            await ctx.reply('You are not authorized to use this bot.');
            return;
        }
        await handler.call(this, ctx);
    };
  }
  constructor(bot: Telegraf, forwardingService: ForwardingService) {
        this.userSessions = new Map<number, UserSession>();
        this.adminMessageToUserMap = new Map<number, number>(); // 消息ID -> 用户ID 映射
        this.broadcastContent = null;
    this.bot = bot;
    this.forwardingService = forwardingService;
    // Preserve the production guard: only admins may interact in group chats.
    this.bot.use(async (ctx, next) => {
      const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
      if (isGroup && (ctx.message || ctx.callbackQuery)) {
        const uid = ctx.from?.id;
        let allowed = Boolean(uid && this.isAdmin(uid));
        if (!allowed && uid && ctx.chat) {
          try {
            const member = await ctx.telegram.getChatMember(ctx.chat.id, uid);
            allowed = ['creator', 'administrator'].includes(member.status);
          } catch { allowed = false; }
        }
        if (!allowed) return;
      }
      return next();
    });
    this.setupHandlers();
  }
    getBot() {
    return this.bot;
  }
    setupHandlers() {
    // Navigation must precede every mode-specific input consumer.
    this.bot.use(async (ctx, next) => {
      const text = ctx.message && 'text' in ctx.message ? ctx.message.text.trim() : '';
      const action = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
      if ((action && !action.startsWith('replace_group:')) ||
          ['⬅️ 返回主菜单', '🏠 返回主菜单', '返回主菜单', '主菜单', '/start', '❌ 取消', '取消', '/cancel'].includes(text)) {
        if (!await ReplaceGroupHandler.cancelForNavigation(ctx)) return;
      }
      if (action === 'back_to_main' || ['⬅️ 返回主菜单', '🏠 返回主菜单', '返回主菜单', '主菜单', '/start'].includes(text)) {
        await this.handleBackToMain(ctx); return;
      }
      if (action === 'cancel' || ['❌ 取消', '取消', '/cancel'].includes(text)) {
        await this.handleCancel(ctx); return;
      }
      return next();
    });
    // While this uploader's background save is active, preserve its frozen session.
    // Other users continue normally; the handler itself returns immediately.
    this.bot.use(async (ctx, next) => {
      if (ctx.from && UploadHandler.isProcessing(ctx.from.id)) {
        if (ctx.callbackQuery) await ctx.answerCbQuery('当前上传正在处理，请完成后再操作').catch(() => {});
        else await ctx.reply('当前上传正在后台处理，请完成后再发送新资料或切换模式。').catch(() => {});
        return;
      }
      return next();
    });
    // 基础命令
    this.bot.use(async (ctx, next) => {
      const action = (ctx.callbackQuery as any)?.data;
      const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
      if (ctx.from && ((action && !action.startsWith('rec:') && !action.startsWith('recommend_')) ||
          (text && (text.startsWith('/') || (Object.values(BUTTONS) as string[]).includes(text))))) recommendations.clearInput(ctx.from.id);
      return next();
    });
    this.bot.action(/^recommend_(menu|new|link)$|^rec:/, this.withStrictAuthorization(ctx => RecommendationHandler.action(ctx, this.userSessions)));
    this.bot.command('recommend_bind', this.withStrictAuthorization(ctx => RecommendationHandler.bind(ctx)));
    this.bot.start(this.withAuthorization(this.handleStart.bind(this)));
    this.bot.help(this.withAuthorization(this.handleHelp.bind(this)));
    this.bot.command('admin', this.withAuthorization(this.handleAdmin.bind(this)));
    this.bot.command('reply', this.withAuthorization(this.handleReplyCommand.bind(this)));
    this.bot.command('exit', this.withAuthorization(this.handleExitCommand.bind(this)));
    this.bot.command('forward', this.withAuthorization(this.handleForwardCommand.bind(this)));
    // 简化的关键词管理命令
    this.bot.command('keywords', this.withAuthorization(this.handleKeywordsCommand.bind(this)));
    this.bot.command('setforwarddelay', this.withAuthorization(this.handleSetForwardDelay.bind(this)));
    this.bot.command('showforwarddelay', this.withAuthorization(this.handleShowForwardDelay.bind(this)));
    this.bot.command('vaultstatus', this.withStrictAuthorization(this.handleVaultStatus.bind(this)));
    this.bot.command('publish_resume', this.withStrictAuthorization(async ctx => {
      const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
      const channel = text.trim().split(/\s+/)[1];
      if (!channel) { await ctx.reply('请先核对频道最后一组，再发送 /publish_resume 频道ID。恢复只解除暂停，不会重发旧任务。'); return; }
      if (!isSuperAdmin(ctx.from!.id)) {
        const allowed = hasAdminChannelMap(ctx.from!.id) ? getAdminChannelIds(ctx.from!.id) : await database.getManagedChannels();
        const target = await ctx.telegram.getChat(channel);
        const ids = await Promise.all(allowed.map(async id => {
          try { return String((await ctx.telegram.getChat(id)).id); } catch { return id; }
        }));
        if (!ids.includes(String(target.id))) { await ctx.reply('没有管理该频道的权限。'); return; }
      }
      try {
        const restored = await publicationQueue.resume(ctx.telegram, channel);
        await ctx.reply(restored ? '✅ 已解除频道暂停。请只补发尚未完成的资料，旧任务不会自动重发。' : '该频道当前没有因发布异常而暂停。');
      } catch (error: any) { await ctx.reply(`❌ ${error.message}`); }
    }));
    this.bot.command('watermark', this.withStrictAuthorization(async (ctx) => {
      await WatermarkHandler.handleMenu(ctx, database);
    }));
    this.bot.hears('🛡️ 水印管理', this.withStrictAuthorization(async (ctx) => {
      await WatermarkHandler.handleMenu(ctx, database);
    }));
    // ========== 账号控制功能（新增） ==========
    this.bot.command('account', this.withStrictAuthorization(this.handleAccountMenu.bind(this)));
    this.bot.hears('🎛️ 账号控制', this.withStrictAuthorization(this.handleAccountMenu.bind(this)));
    this.bot.hears('⬅️ 返回主菜单', this.withAuthorization(this.handleBackToMain.bind(this)));
    // 账号控制回调按钮
    this.bot.action('add_account_start', this.withStrictAuthorization(this.handleAddAccount.bind(this)));
    this.bot.action('back_to_account_menu', this.withStrictAuthorization(this.handleAccountMenu.bind(this)));
    this.bot.action('account_list_manage', this.withStrictAuthorization(this.handleAccountStatus.bind(this)));
    this.bot.action('auto_reply_menu', this.withStrictAuthorization(this.handleAutoReply.bind(this)));
    this.bot.action('send_media_library', this.withStrictAuthorization(this.handleSendMedia.bind(this)));
    this.bot.action('extract_publish_keywords', this.withStrictAuthorization(this.handleExtractPublishKeywords.bind(this)));
    this.bot.action('extract_kw_1h', this.withStrictAuthorization(async (ctx) => {
      const uid = ctx.from?.id;
      if (uid) {
        this.userSessions.delete(uid);
        try { await database.clearUserSession(uid); } catch {}
      }
      await userAccountCommands.handleExtractPreset(ctx, '1h');
    }));
    this.bot.action('extract_kw_3h', this.withStrictAuthorization(async (ctx) => {
      const uid = ctx.from?.id;
      if (uid) {
        this.userSessions.delete(uid);
        try { await database.clearUserSession(uid); } catch {}
      }
      await userAccountCommands.handleExtractPreset(ctx, '3h');
    }));
    // 兼容旧按钮
    this.bot.action(['extract_kw_today', 'extract_kw_yesterday', 'extract_kw_7d', 'extract_kw_30d', 'extract_kw_custom'],
      this.withStrictAuthorization(async (ctx) => {
        await userAccountCommands.handleExtractPublishKeywordsStart(ctx);
      }));
    this.bot.action('view_task_status', this.withStrictAuthorization(this.handleTaskStatus.bind(this)));
    this.bot.action('send_private_msg', this.withStrictAuthorization(this.handleSendMessage.bind(this)));
    this.bot.action('account_menu_close', this.withStrictAuthorization(this.handleAccountMenuClose.bind(this)));
    this.bot.action(/^switch_account_(\d+)$/, this.withStrictAuthorization(this.handleSwitchAccountCallback.bind(this)));
    this.bot.action(/^delete_account_(\d+)$/, this.withStrictAuthorization(this.handleDeleteAccountCallback.bind(this)));
    this.bot.action(/^confirm_delete_(\d+)$/, this.withStrictAuthorization(this.handleConfirmDeleteCallback.bind(this)));
    this.bot.action('cancel_delete', this.withStrictAuthorization(this.handleCancelDeleteCallback.bind(this)));
    this.bot.action('set_auto_reply_msg', this.withStrictAuthorization(this.handleSetAutoReplyMsg.bind(this)));
    this.bot.action('enable_auto_reply', this.withStrictAuthorization(this.handleEnableAutoReply.bind(this)));
    this.bot.action('disable_auto_reply', this.withStrictAuthorization(this.handleDisableAutoReply.bind(this)));
    this.bot.action('login_method_session', this.withStrictAuthorization(this.handleLoginMethodSession.bind(this)));
    this.bot.action(/^stop_task_(.+)$/, this.withStrictAuthorization(this.handleStopTaskCallback.bind(this)));
    // 发送媒体库时间选择回调（统一使用后台任务模式）
    this.bot.action(/^send_hours_(\d+)$/, this.withStrictAuthorization(this.handleSendHours.bind(this)));
    this.bot.action('send_custom_range', this.withStrictAuthorization(this.handleCustomRangeCallback.bind(this)));
    // 取消命令（账号控制功能的取消由文本消息处理器统一处理）
    // ========== 账号控制功能结束 ==========
    // 核心功能按钮处理
    this.bot.hears(BUTTONS.SEARCH_DATA, this.withAuthorization(this.handleSearchData.bind(this)));
    this.bot.hears(BUTTONS.UPLOAD_DATA, this.withStrictAuthorization(this.handleUploadData.bind(this)));
    this.bot.hears(BUTTONS.PUBLISH_CONTENT, this.withStrictAuthorization(this.handlePublishContent.bind(this)));
    this.bot.hears(BUTTONS.VIEW_DATA, this.withAuthorization(this.handleViewData.bind(this)));
    this.bot.hears('🔧 检查媒体', this.withStrictAuthorization(this.handleCheckMedia.bind(this)));
    this.bot.hears('🗑️ 清理过期', this.withStrictAuthorization(this.handleCleanExpired.bind(this)));
    this.bot.hears(BUTTONS.CHANNEL_MANAGE, this.withStrictAuthorization(this.handleChannelManage.bind(this)));
        // 按钮制作功能已关闭
        this.bot.hears(BUTTONS.BUTTON_MAKER, async (ctx) => {
          await ctx.reply('ℹ️ 按钮制作功能已关闭。');
        });
    this.bot.hears(BUTTONS.PERMISSION_MANAGE, this.withStrictAuthorization(this.handlePermissionManage.bind(this)));
    // 群发与关键词优化：同时支持按钮文本、无表情别名文本与命令
    this.bot.hears(BUTTONS.BROADCAST_MESSAGE, this.withAuthorization(this.handleBroadcastMessage.bind(this)));
    this.bot.hears('群发消息', this.withAuthorization(this.handleBroadcastMessage.bind(this)));
    this.bot.command('broadcast', this.withAuthorization(this.handleBroadcastMessage.bind(this)));
    this.bot.hears(BUTTONS.KEYWORD_OPTIMIZE, this.withAuthorization(this.handleKeywordOptimize.bind(this)));
    this.bot.hears('关键词优化', this.withAuthorization(this.handleKeywordOptimize.bind(this)));
    this.bot.command('optimize', this.withAuthorization(this.handleKeywordOptimize.bind(this)));
    this.bot.hears(BUTTONS.GRANT_MONTHLY, this.withAuthorization(this.handleGrantMonthly.bind(this)));
    this.bot.hears(BUTTONS.GRANT_QUARTERLY, this.withAuthorization(this.handleGrantQuarterly.bind(this)));
    this.bot.hears(BUTTONS.VIEW_PERMISSIONS, this.withAuthorization(this.handleViewPermissions.bind(this)));
    this.bot.hears(BUTTONS.REVOKE_PERMISSION, this.withAuthorization(this.handleRevokePermission.bind(this)));
    this.bot.hears(BUTTONS.APPROVAL, this.withAuthorization(this.handleApproval.bind(this)));
    this.bot.hears(BUTTONS.CHAT_WITH_ADMIN, this.withAuthorization(this.handleChatWithAdmin.bind(this)));
    this.bot.hears(BUTTONS.HELP, this.withAuthorization(this.handleHelp.bind(this)));
        this.bot.hears('🖼️ 网页相册', this.withAuthorization(this.handleAlbumStart.bind(this)));
    // 内联按钮处理
    this.bot.action('back_to_main', this.withAuthorization(this.handleBackToMain.bind(this)));
    this.bot.action('source_channels', this.withAuthorization(this.handleSourceChannels.bind(this)));
    this.bot.action('target_channels', this.withAuthorization(this.handleTargetChannels.bind(this)));
    this.bot.action('add_target_channel', this.withAuthorization(this.handleAddTargetChannel.bind(this)));
    this.bot.action(/remove_target_channel_(-?\d+)/, this.withAuthorization(this.handleRemoveTargetChannel.bind(this)));
    this.bot.action('forward_menu', this.withAuthorization(this.handleForwardCommand.bind(this)));
    this.bot.action('add_source_channel', this.withAuthorization(this.handleAddSourceChannel.bind(this)));
    this.bot.action(/remove_source_channel_(-?\d+)/, this.withAuthorization(this.handleRemoveSourceChannel.bind(this)));
    this.bot.action('batch_upload', this.handleBatchUpload.bind(this));
    this.bot.action('single_upload', this.handleSingleUpload.bind(this));
    // 查看资料相关
    this.bot.action('browse_keywords', this.handleBrowseKeywords.bind(this));
    this.bot.action('delete_keyword', this.handleDeleteKeyword.bind(this));
    this.bot.action('clean_data', this.handleCleanData.bind(this));
    this.bot.action('watermark_menu', this.withStrictAuthorization(async (ctx) => {
      await WatermarkHandler.handleMenu(ctx, database);
    }));
    this.bot.action('watermark_confirm', this.withStrictAuthorization(async (ctx) => {
      await WatermarkHandler.handleConfirm(ctx, database);
    }));
    this.bot.action(/^watermark_start(?::[a-f0-9]+)?$/, this.withStrictAuthorization(async (ctx) => {
      await WatermarkHandler.handleStart(ctx, database);
    }));
    this.bot.action('watermark_stop', this.withStrictAuthorization(async (ctx) => {
      await WatermarkHandler.handleStop(ctx);
    }));
    this.bot.action('start_review', this.withAuthorization(async (ctx) => {
      await ReviewHandler.handleStart(ctx, database);
    }));
    this.bot.action(/^review_page_(\d+)$/, this.withAuthorization(async (ctx) => {
      const page = parseInt((ctx as any).match[1]);
      await ReviewHandler.handleStart(ctx, database, page);
    }));
    this.bot.action(/^review_view_(.+)$/, this.withAuthorization(async (ctx) => {
      const keyword = (ctx as any).match[1];
      await ReviewHandler.handleViewReview(ctx, database, keyword);
    }));
    this.bot.action('admin_add_review', this.withStrictAuthorization(async (ctx) => {
      await ReviewHandler.handleAdminAddStart(ctx, database);
    }));
    // 频道管理相关
    this.bot.action('add_channel', this.handleAddChannel.bind(this));
    this.bot.action('remove_channel', this.handleRemoveChannel.bind(this));
    this.bot.action('channel_list', this.handleChannelList.bind(this));
    this.bot.action(/^remove_channel_/, this.handleRemoveChannelConfirm.bind(this));
    this.bot.action(/^confirm_remove_/, this.handleConfirmRemoveChannel.bind(this));
        // 频道管理相关
    // 聊天相关
    this.bot.action('exit_chat', this.handleExitChat.bind(this));
    this.bot.action(/^disconnect_chat_/, this.handleDisconnectChat.bind(this));
    this.bot.action(/^keywords_page_(\d+)$/, this.handleKeywordsPage.bind(this));
    this.bot.action('recent_searches', ctx => RecentSearchHandler.handle(ctx, database));
    this.bot.action(/^recent_search:/, ctx => RecentSearchHandler.handle(ctx, database));
    this.bot.action(/^keyword_/, this.handleKeywordClick.bind(this));
    this.bot.action(/^search_/, this.handleSearchKeyword.bind(this));
    this.bot.action('broadcast_text', this.handleBroadcastText.bind(this));
    this.bot.action('broadcast_photo', this.handleBroadcastPhoto.bind(this));
    this.bot.action('broadcast_video', this.handleBroadcastVideo.bind(this));
    this.bot.action('broadcast_document', this.handleBroadcastDocument.bind(this));
    this.bot.action('broadcast_users', this.handleBroadcastUsersCallback.bind(this));
    this.bot.action(/^users_page_(\d+)$/, this.handleUsersPage.bind(this));
    
    // 🏷️ 标签筛选相关
    this.bot.action('start_tag_filter', this.handleStartTagFilter.bind(this));
    this.bot.action('cancel_tag_filter', this.handleCancelTagFilter.bind(this));
    this.bot.action(/^tag_select_(.+)$/, this.handleTagSelectCallback.bind(this));
    this.bot.action(/^tag_view_(.+)$/, this.handleTagViewCallback.bind(this));
    this.bot.action('admin_manage_tags', this.handleAdminManageTags.bind(this));
    this.bot.action('admin_add_tag', this.handleAdminAddTagPrompt.bind(this));
    this.bot.action('admin_del_tag_list', this.handleAdminDelTagList.bind(this));
    this.bot.action(/^admin_del_tag_do_(.+)$/, this.handleAdminDelTagCallback.bind(this));

    this.bot.action('noop', this.handleNoop.bind(this));
        this.bot.action('view_logs', this.handleViewLogs.bind(this));
        this.bot.action('start_direct_send', this.handleStartDirectSend.bind(this));
        this.bot.action('start_broadcast_data', this.handleStartBroadcastData.bind(this));
        this.bot.action(/^confirm_broadcast_data_(.+)$/, this.handleExecuteBroadcastData.bind(this));
        this.bot.action('cancel_direct_send', this.handleCancelDirectSend.bind(this));
        this.bot.action('broadcast_menu', this.handleBroadcastMessage.bind(this));
    this.bot.action('confirm_broadcast', this.handleConfirmBroadcast.bind(this));
    this.bot.action('cancel_broadcast', this.handleCancelBroadcast.bind(this));
    this.bot.action('start_search', this.handleStartSearch.bind(this));
    this.bot.action('start_upload', this.withStrictAuthorization(this.handleStartUpload.bind(this)));
    this.bot.action('start_publish', this.handleStartPublish.bind(this));
    this.bot.action('start_keywords', this.handleStartKeywords.bind(this));
    this.bot.action('start_help', this.handleStartHelp.bind(this));
    this.bot.action('start_contact', this.handleStartContact.bind(this));
        this.bot.action('start_button_maker', async (ctx) => {
          await ctx.answerCbQuery('功能已关闭').catch(() => {});
          await ctx.reply('ℹ️ 按钮制作功能已关闭。');
        });
        this.bot.action('start_channel_manage', this.handleStartChannelManage.bind(this));
        this.bot.action('start_broadcast', this.handleStartBroadcast.bind(this));
        this.bot.action('start_account_control', this.handleStartAccountControl.bind(this));
    // 帮助系统
    this.bot.action('help_search', this.handleHelpSearch.bind(this));
    this.bot.action('help_keywords', this.handleHelpKeywords.bind(this));
    this.bot.action('help_upload', this.handleHelpUpload.bind(this));
    this.bot.action('help_publish', this.handleHelpPublish.bind(this));
    this.bot.action('help_channel', this.handleHelpChannel.bind(this));
    this.bot.action('help_user', this.handleHelpUser.bind(this));
    this.bot.action('help_permission', this.handleHelpPermission.bind(this));
    this.bot.action('help_chat', this.handleHelpChat.bind(this));
    this.bot.action('help_faq', this.handleHelpFAQ.bind(this));
    this.bot.action('help_back', this.handleHelpBack.bind(this));
    this.bot.action(/^replace_group:/, ctx => ReplaceGroupHandler.handleCallback(ctx, database));
    this.bot.on('message', async (ctx, next) => {
      if (await SearchHandler.handleReplyDelete(ctx, database)) return;
      if (await ReplaceGroupHandler.handleMessage(ctx, database)) return;
      return next();
    });
    // 文本消息处理
        
        // 按钮制作回调
        this.bot.action('send_button_to_me', this.handleSendButtonToMe.bind(this));
        this.bot.action('send_button_to_group', this.handleSendButtonToGroup.bind(this));
        this.bot.action('cancel_button_maker', this.handleCancelButtonMaker.bind(this));
        this.bot.action('add_more_button', this.handleAddMoreButton.bind(this));
        this.bot.action('preview_button_maker', this.handlePreviewButtonMaker.bind(this));

    // 频道选择
    this.bot.action(/^publish_toggle_/, this.handlePublishChannelToggle.bind(this));
    this.bot.action('publish_channels_confirm', this.handlePublishChannelsConfirm.bind(this));
    this.bot.action(/^schedule_/, (ctx) => PublishHandler.scheduleAction(ctx, this.userSessions, database));
    this.bot.action(/^upload_toggle_/, this.handleUploadChannelToggle.bind(this));
    this.bot.action('upload_channels_confirm', this.handleUploadChannelsConfirm.bind(this));
    this.bot.action(/^channel_/, this.handleChannelSelect.bind(this));
    this.bot.action(/^upload_channel_/, this.handleUploadChannelSelect.bind(this));
    // 上传确认
    this.bot.action('save_only', this.handleSaveOnly.bind(this));
    this.bot.action('save_and_publish', this.handleSaveAndPublish.bind(this));
    this.bot.action('select_channel', this.handleSelectChannel.bind(this));
    this.bot.action('cancel', this.handleCancel.bind(this));

        // 关注回复设置回调
        this.bot.action('set_join_welcome', this.handleSetJoinWelcome.bind(this));
        this.bot.action('cancel_join_welcome', this.handleCancelJoinWelcome.bind(this));
        this.bot.action('add_more_welcome_button', this.handleAddMoreWelcomeButton.bind(this));
        this.bot.action('confirm_save_join_welcome', this.handleConfirmSaveJoinWelcome.bind(this));
        this.bot.action('save_join_welcome_no_buttons', this.handleConfirmSaveJoinWelcome.bind(this));

        // 相册制作回调
    this.bot.action('cancel_album_maker', this.handleCancelAlbumMaker.bind(this));
    this.bot.action('finish_album', this.handleFinishAlbum.bind(this));
    this.bot.action('my_albums', this.handleMyAlbums.bind(this));
    this.bot.action('all_user_albums', this.handleAllUserAlbums.bind(this));
    this.bot.action('start_album_maker', this.handleAlbumStart.bind(this));
    this.bot.action('admin_album_auth', this.withStrictAuthorization(this.handleAdminAlbumAuth.bind(this)));
    this.bot.action(/^auth_album_(\d+)_(\w+)$/, this.withStrictAuthorization(this.handleGrantAlbumAuth.bind(this)));
        this.bot.action(/^delete_album_(.+)$/, this.handleDeleteAlbum.bind(this));

        // 按钮制作发送频道选择
        this.bot.action(/^bm_send_to_(-?\d+)$/, this.handleButtonMakerChannelSelect.bind(this));

        // 监听加入申请
        this.bot.on('chat_join_request', this.handleChatJoinRequest.bind(this));

    // 文本消息处理
    this.bot.on('text', this.handleTextMessage.bind(this));
    // 启动定时任务检查到期用户
    this.startExpiryChecker();
    // 媒体消息处理
    this.bot.on('photo', this.handlePhotoMessage.bind(this));
    this.bot.on('video', this.handleVideoMessage.bind(this));
    this.bot.on('animation', this.handleAnimationMessage.bind(this));
    this.bot.on('document', this.handleDocumentMessage.bind(this));
    this.bot.on('audio', this.handleAudioMessage.bind(this));
    this.bot.on('voice', this.handleVoiceMessage.bind(this));
    this.bot.on('video_note', this.handleVideoNoteMessage.bind(this));
    // 错误处理
    this.bot.catch((err, ctx) => {
      console.error('Bot error:', err);
      ctx.reply('❌ 发生错误，请稍后重试。');
    });
  }
    async handleForwardCommand(ctx: Context) {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📥 监听频道', 'source_channels')],
      [Markup.button.callback('🎯 目标频道', 'target_channels')],
      [Markup.button.callback('🔙 返回', 'back_to_main')]
    ]);
    await ctx.reply('请选择要管理的项目:', keyboard);
  }
    async handleAddTargetChannel(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
        this.userSessions.set(userId, { userId, mode: BotMode.AddingTargetChannel, step: 'idle' as const });
    await ctx.editMessageText('请转发一条目标频道的消息，或直接发送频道 ID (例如 -100123456789)。');
  }
    async handleRemoveTargetChannel(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
        const match = (ctx as any).match as RegExpMatchArray;
        const channelId = parseInt(match[1]);
    await this.forwardingService.removeTargetChannel(userId, channelId);
    await this.handleTargetChannels(ctx);
  }
    async handleSourceChannels(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    const userConfig = await this.forwardingService.getUserConfig(userId);
    const buttons = userConfig.sourceChannels.map(channel => [
      Markup.button.callback(`- 频道 ${channel}`, `remove_source_channel_${channel}`)
    ]);
    buttons.push([Markup.button.callback('➕ 添加频道', 'add_source_channel')]);
    buttons.push([Markup.button.callback('🔙 返回', 'forward_menu')]);
    const keyboard = Markup.inlineKeyboard(buttons);
    await ctx.editMessageText('管理监听频道:', keyboard);
  }
    async handleAddSourceChannel(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
        this.userSessions.set(userId, { userId, mode: BotMode.AddingSourceChannel, step: 'idle' as const });
    await ctx.editMessageText('请转发一条来自源频道的消息，或直接发送频道 ID。\n\n输入 /cancel 取消操作。');
  }
    async handleRemoveSourceChannel(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
        const match = (ctx as any).match as RegExpMatchArray;
        const channelId = parseInt(match[1]);
    await this.forwardingService.removeSourceChannel(userId, channelId);
    await this.handleSourceChannels(ctx);
  }
    async handleTargetChannels(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    const userConfig = await this.forwardingService.getUserConfig(userId);
    const buttons = userConfig.targetChannels.map(channel => [
      Markup.button.callback(`- 频道 ${channel}`, `remove_target_channel_${channel}`)
    ]);
    buttons.push([Markup.button.callback('➕ 添加频道', 'add_target_channel')]);
    buttons.push([Markup.button.callback('🔙 返回', 'forward_menu')]);
    const keyboard = Markup.inlineKeyboard(buttons);
    await ctx.editMessageText('管理目标频道:', keyboard);
  }
    async handleStart(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 跟踪用户活动（记录详细信息）
        await database.trackUser(userId, ctx.from?.first_name, ctx.from?.last_name, ctx.from?.username);
    const isAdmin = this.isAdmin(userId);
    const isRootAdmin = this.isRootAdmin(userId);
    
        // 创建整洁的欢迎消息
        let welcomeMessage = `🎉 欢迎使用智能资料管理机器人\n\n`;
    
    if (isAdmin) {
      welcomeMessage += `👑 管理员控制台\n\n`;
            welcomeMessage += `📋 可用功能：\n`;
            welcomeMessage += isRootAdmin
              ? `• 🔍 搜索资料 - 快速查找所有媒体资料\n`
              : `• 🔍 搜索资料 - 快速查找您的独立资料库\n`;
            welcomeMessage += `• 📁 上传资料 - 批量上传照片、视频、文档\n`;
            welcomeMessage += `• 📄 查看资料 - 浏览和管理资料库\n`;
            welcomeMessage += `• 🚀 发布内容 - 一键发布到指定频道\n`;
            welcomeMessage += `• 🖼️ 网页相册 - 制作网页相册链接\n`;
      if (isRootAdmin) {
        welcomeMessage += `• 🏢 频道管理 - 配置发布目标频道\n`;
        welcomeMessage += `• 📢 群发消息 - 向所有用户广播消息\n`;
        welcomeMessage += `• 🎛️ 账号控制 - 管理用户账号系统\n`;
      }
            welcomeMessage += `• 💬 联系管理员 - 处理用户咨询和反馈\n\n`;
    } else {
            welcomeMessage += `👤 用户功能\n\n`;
            welcomeMessage += `📋 可用功能：\n`;
            welcomeMessage += `• 🔍 搜索资料 - 快速查找资料\n`;
            welcomeMessage += `• 📄 查看资料 - 浏览和管理资料\n`;
            welcomeMessage += `• 🖼️ 网页相册 - 制作网页相册链接\n`;
            welcomeMessage += `• 💬 联系管理员 - 随时联系管理员\n\n`;
    }
    
        welcomeMessage += `💡 提示：点击下方按钮或使用键盘快捷按钮开始使用`;

        // 创建内联键盘按钮（显示在消息中）
    const inlineKeyboard = [];
    
    if (isAdmin) {
            // 管理员：第一行 - 核心功能
      inlineKeyboard.push([
                Markup.button.callback('🔍 搜索资料', 'start_search'),
                Markup.button.callback('📁 上传资料', 'start_upload'),
                Markup.button.callback('📄 查看资料', 'start_keywords')
      ]);
            // 第二行 - 发布和管理
      inlineKeyboard.push([
                Markup.button.callback('🚀 发布内容', 'start_publish'),
                Markup.button.callback('🖼️ 网页相册', 'start_album_maker')
      ]);
            if (isRootAdmin) {
              // 第三行 - 管理功能（仅超级管理员）
              inlineKeyboard.push([
                Markup.button.callback('🏢 频道管理', 'start_channel_manage'),
                Markup.button.callback('📢 群发消息', 'start_broadcast')
              ]);
              // 第四行 - 其他
              inlineKeyboard.push([
                Markup.button.callback('🎛️ 账号控制', 'start_account_control'),
                Markup.button.callback('💬 联系管理员', 'start_contact'),
                Markup.button.callback('ℹ️ 帮助', 'start_help')
              ]);
            } else {
              // 子管理员简化面板
              inlineKeyboard.push([
                Markup.button.callback('💬 联系管理员', 'start_contact'),
                Markup.button.callback('ℹ️ 帮助', 'start_help')
              ]);
            }
    } else {
            // 普通用户：第一行 - 核心功能
      inlineKeyboard.push([
                Markup.button.callback('🔍 搜索资料', 'start_search'),
                Markup.button.callback('📄 查看资料', 'start_keywords')
      ]);
            // 第二行 - 其他功能
    inlineKeyboard.push([
                Markup.button.callback('🖼️ 网页相册', 'start_album_maker'),
                Markup.button.callback('💬 联系管理员', 'start_contact'),
                Markup.button.callback('ℹ️ 帮助', 'start_help')
            ]);
        }
        
        // 获取键盘布局（底部键盘按钮）
        const keyboard = await this.getCoreFunctionKeyboard(userId);
        
        // 发送消息（包含内联按钮）
        await ctx.reply(welcomeMessage, Markup.inlineKeyboard(inlineKeyboard));
        
        // 单独发送键盘按钮提示
        await ctx.reply('💡 您也可以使用下方的键盘快捷按钮', keyboard);
    }
    async handleSearchData(ctx: Context) {
    // 搜索模式直接激活，不需要额外选择
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 权限检查：管理员和有权限用户可以搜索自己的数据，普通用户可以搜索管理员的公共资料
    const isAdmin = this.isAdmin(userId);
    const isRootAdmin = this.isRootAdmin(userId);
    const hasPermission = await database.checkUserPermission(userId);
    // 所有用户都可以使用搜索功能，但搜索范围不同
    let searchScope = '';
    if (isRootAdmin) {
      searchScope = '🔍 搜索模式已激活（管理员模式）\n\n可以搜索所有用户的资料\n直接发送关键词开始搜索：\n\n💡 可一次发多个：优米樊樊 或 优米 樊樊';
        }
        else if (isAdmin) {
      searchScope = '🔍 搜索模式已激活（管理员模式）\n\n可以搜索您自己的独立资料库\n直接发送关键词开始搜索：\n\n💡 可一次发多个：优米樊樊 或 优米 樊樊';
        }
        else if (hasPermission) {
      searchScope = '🔍 搜索模式已激活（会员模式）\n\n可以搜索您自己的资料\n直接发送关键词开始搜索：\n\n💡 可一次发多个：优米樊樊 或 优米 樊樊';
        }
        else {
      searchScope = '🔍 搜索模式已激活（访客模式）\n\n可以搜索公共资料库\n直接发送关键词开始搜索：\n\n💡 可一次发多个：优米樊樊 或 优米 樊樊';
    }
    // 设置用户为搜索模式
    if (isAdmin) userAccountCommands.silentCleanup(userId);
    const session: UserSession = {
      userId,
      mode: BotMode.Search,
            step: 'idle' as const
    };
    this.userSessions.set(userId, session);
    await database.saveUserSession(userId, session);
        await ctx.reply(searchScope, this.getBackKeyboard());
  }
    async handleUploadData(ctx: Context) {
    // 上传模式直接激活批量上传，不需要选择
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 设置管理员为上传模式
    if (this.isAdmin(userId)) userAccountCommands.silentCleanup(userId);
        const session = {
      userId,
      mode: BotMode.Upload,
            step: 'waiting_keyword' as const
    };
    this.userSessions.set(userId, session);
    await database.saveUserSession(userId, session);
        await ctx.reply(`📁 上传模式已激活\n\n请输入关键词：`, this.getBackKeyboard());
  }
    async handlePublishContent(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 会员制度已取消，发布功能对所有用户开放
    // 设置用户为发布模式
    if (this.isAdmin(userId)) userAccountCommands.silentCleanup(userId);
        const previous = this.userSessions.get(userId);
        const selected = previous?.mode === BotMode.Publish ? this.getSelectedChannels(previous) : [];
        const session = {
      userId,
      mode: BotMode.Publish,
      selectedChannels: selected,
      selectedChannel: selected[0],
            step: 'selecting_channel' as const
    };
    this.userSessions.set(userId, session);
    await database.saveUserSession(userId, session);
        await ctx.reply(`🚀 发布内容\n\n请选择一个或多个目标群/频道：${selected.length ? '\n已保留之前的目标选择，请确认或调整。' : ''}`, await this.getChannelSelectionKeyboard(userId, selected));
  }
    async handleCheckMedia(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    try {
      const stats = await database.getMediaStats();
      if (!stats) {
        await ctx.reply('❌ 无法获取媒体统计信息');
        return;
      }
      let message = `🔧 媒体文件检查\n\n`;
      message += `📊 统计信息:\n`;
      message += `• 总媒体数: ${stats.total}\n`;
      message += `• 带说明: ${stats.withCaption}\n\n`;
      message += `📁 按类型分布:\n`;
      if (stats.byType && Array.isArray(stats.byType)) {
                stats.byType.forEach((type: { file_type: string; count: number }) => {
                    const emojiMap: { [key: string]: string } = {
            'photo': '📷',
            'video': '🎥',
            'document': '📄',
            'audio': '🎵',
            'voice': '🎤'
          };
          const emoji = emojiMap[type.file_type] || '📎';
          message += `${emoji} ${type.file_type}: ${type.count} 个\n`;
        });
            }
            else {
        message += `📷 photo: ${stats.photo || 0} 个\n`;
        message += `🎥 video: ${stats.video || 0} 个\n`;
        message += `📄 document: ${stats.document || 0} 个\n`;
        message += `🎵 audio: ${stats.audio || 0} 个\n`;
        message += `🎤 voice: ${stats.voice || 0} 个\n`;
      }
      message += `\n💡 如果搜索时出现"跳资料"问题，可能是file_id过期导致的。`;
      message += `\n\n🗑️ 可以尝试清理过期文件`;
      await ctx.reply(message);
        }
        catch (error) {
      console.error('检查媒体错误:', error);
      await ctx.reply('❌ 检查媒体时发生错误');
    }
  }

  async handleVaultStatus(ctx: Context) {
    try {
      const stats = await getVaultCoverageStats(database);
      const pct = stats.total ? ((stats.withSource / stats.total) * 100).toFixed(1) : '0.0';
      const access = await checkVaultAccess(this.bot.telegram, stats.vaultChannelId);
      let msg =
        `📦 金库备份状态\n\n` +
        `频道: ${stats.vaultChannelId || '未配置 PERSISTENT_CHANNEL_ID'}\n` +
        `当前 bot: @${access.botUsername || '?'} (${access.botId || '?'})\n` +
        `可达: ${access.ok ? `✅ ${access.type}「${access.title}」(${access.botStatus})` : `❌ ${access.error}`}\n` +
        `媒体总数: ${stats.total}\n` +
        `已有坐标: ${stats.withSource} (${pct}%)\n` +
        `缺少坐标: ${stats.withoutSource}\n\n`;
      if (!access.ok && access.hint) {
        msg += `💡 ${access.hint}`;
      } else if (stats.withoutSource > 0) {
        msg += `👉 服务器上执行:\nnpm run vault:sync\n\n换 bot 认领:\nnpm run vault:claim`;
      } else {
        msg += `✅ 坐标齐全，换 Token 可跑 vault:claim`;
      }
      await ctx.reply(msg);
    } catch (error) {
      console.error('vaultstatus 错误:', error);
      await ctx.reply('❌ 查询金库状态失败');
    }
  }

    async handleCleanExpired(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    try {
      await ctx.reply('🗑️ 正在清理过期文件...');
      const cleanedCount = await database.cleanInvalidMedia();
            await ctx.reply(`✅ 清理完成\n\n` +
        `已删除 ${cleanedCount} 个无效的媒体文件\n\n` +
                `💡 建议重新上传这些文件`);
        }
        catch (error) {
      console.error('清理过期文件错误:', error);
      await ctx.reply('❌ 清理过期文件时发生错误');
    }
  }
    async handleKeywordOptimize(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    try {
      // 获取关键词统计信息
      const keywords = await database.getAllKeywords();
      const stats = await database.getMediaStats();
      let message = `🔧 关键词优化\n\n`;
      message += `📊 统计信息:\n`;
      message += `• 总关键词数: ${keywords.length}\n`;
      message += `• 总媒体数: ${stats?.total || 0}\n\n`;
      // 显示最新的10个关键词
      const recentKeywords = keywords.slice(0, 10);
      message += `🆕 最新关键词 (按时间排序):\n`;
      recentKeywords.forEach((keyword, index) => {
        message += `${index + 1}. ${keyword}\n`;
      });
      if (keywords.length > 10) {
        message += `\n... 还有 ${keywords.length - 10} 个关键词`;
      }
      message += `\n\n💡 关键词已按最新时间排序，方便快速查找`;
      await ctx.reply(message);
        }
        catch (error) {
      console.error('关键词优化错误:', error);
      await ctx.reply('❌ 获取关键词信息时发生错误');
    }
  }
    async handleViewData(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    try {
      // 确定查看范围：与搜索一致（普通用户看公共库，不是自己的空库）
      const isAdmin = this.isAdmin(userId);
      const isRootAdmin = this.isRootAdmin(userId);
      let keywordUserId;
      let scopeText = '';
      if (isRootAdmin) {
        keywordUserId = undefined;
        scopeText = '全局关键词列表';
      } else if (isAdmin) {
        keywordUserId = userId;
        scopeText = '您的关键词列表';
      } else {
        keywordUserId = config.superAdminId;
        scopeText = '公共关键词列表';
      }
      const keywords = await database.getAllKeywords(keywordUserId);
      if (keywords.length === 0) {
                await ctx.reply(`📄 查看资料\n\n` +
          `📊 ${scopeText}\n\n` +
          `❌ 暂无关键词数据\n\n` +
          `💡 您可以：\n` +
          `• 上传新的媒体文件\n` +
          `• 尝试使用 [🏷️ 标签筛选] 查找包含特定标志的文案`, 
          Markup.inlineKeyboard([
            [Markup.button.callback('🏷️ 标签筛选', 'start_tag_filter')],
            ...(isAdmin ? [[Markup.button.callback('🛡️ 水印管理', 'watermark_menu')]] : []),
            [Markup.button.callback('🕘 最近搜索', 'recent_searches')],
            [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
          ]));
        return;
      }
      // 使用新的分页显示功能
      await this.showKeywordsPage(ctx, keywords, 0);
        }
        catch (error) {
      console.error('查看资料错误:', error);
      await ctx.reply('❌ 查看资料时发生错误', await this.getCoreFunctionKeyboard(userId));
    }
  }
    async handleChannelManage(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      await ctx.reply('❌ 权限不足，只有超级管理员可以访问此功能。');
      return;
    }
    // 获取所有频道名称
        const managedChannels = await database.getManagedChannels();
        const channelList = await Promise.all(managedChannels.map(async (id) => `• ${await this.getChannelName(id)}`));
        await ctx.reply(`🏢 频道管理\n\n当前配置的频道：\n` +
      channelList.join('\n') +
            `\n\n请选择操作：`, this.getChannelManageKeyboard());
  }
    async handleUserManage(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      await ctx.reply('❌ 权限不足，只有超级管理员可以访问此功能。');
      return;
    }
        await ctx.reply(`👥 用户管理\n\n请选择操作：`, this.getUserManageKeyboard());
  }
    async handleApproval(ctx: Context) {
        await ctx.reply(`📝 申请审批\n\n请选择申请类型：`, this.getApprovalKeyboard());
  }
    async handleHelp(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    const isAdmin = this.isAdmin(userId);
    const isRootAdmin = this.isRootAdmin(userId);
    let helpMessage = `📚 智能资料管理系统 - 完整使用指南\n\n`;
    // 根据用户类型显示不同的帮助内容
    if (isRootAdmin) {
      helpMessage += `👑 管理员控制台指南\n\n`;
      helpMessage += `🎯 您拥有完整的管理权限\n`;
      helpMessage += `• 🔍 搜索所有用户资料\n`;
      helpMessage += `• 📁 上传和管理媒体文件\n`;
      helpMessage += `• 🚀 发布内容到频道\n`;
      helpMessage += `• 🏢 管理频道配置\n`;
      helpMessage += `• 👥 管理用户信息\n`;
      helpMessage += `• 📢 群发消息通知\n\n`;
        }
        else if (isAdmin) {
      helpMessage += `👑 管理员控制台指南\n\n`;
      helpMessage += `🎯 您拥有管理员权限（独立资料库）\n`;
      helpMessage += `• 🔍 搜索自己的资料库\n`;
      helpMessage += `• 📁 上传和管理媒体文件\n`;
      helpMessage += `• 🚀 发布内容到自己的频道\n`;
      helpMessage += `• 📄 查看和管理自己的关键词\n\n`;
        }
        else {
      helpMessage += `👤 用户使用指南\n\n`;
      helpMessage += `🎯 可直接使用以下功能\n`;
      helpMessage += `• 🔍 搜索资料\n`;
      helpMessage += `• 🖼️ 网页相册（单次最多20组，3天后自动清除）\n`;
      helpMessage += `• 📚 浏览资料\n`;
      helpMessage += `• 💬 联系管理员获取帮助\n\n`;
    }
    // 创建简洁的帮助菜单内联键盘
    const helpKeyboard = [];
    // 第一行：基础功能帮助
    helpKeyboard.push([
      Markup.button.callback('🔍 搜索指南', 'help_search'),
      Markup.button.callback('📚 资料浏览', 'help_keywords'),
      Markup.button.callback('💬 联系客服', 'help_chat')
    ]);
    if (isAdmin) {
      helpKeyboard.push([
        Markup.button.callback('📁 上传管理', 'help_upload'),
        Markup.button.callback('🚀 内容发布', 'help_publish')
      ]);
    }
    // 第二行：管理员功能帮助（仅管理员）
    if (isAdmin) {
      helpKeyboard.push([
        Markup.button.callback('🏢 频道管理', 'help_channel'),
        Markup.button.callback('📢 群发消息', 'help_broadcast')
      ]);
    }
    // 最后一行：常见问题和返回
    helpKeyboard.push([
      Markup.button.callback('❓ 常见问题', 'help_faq'),
      Markup.button.callback('🏠 返回主菜单', 'back_to_main')
    ]);
    helpMessage += `🎯 请选择需要了解的功能模块：\n\n`;
    // 会员制度已取消，功能对所有用户开放
    if (isAdmin) {
      helpMessage += `👑 **管理员权限** - 享有系统全部功能\n`;
      helpMessage += `📋 包含数据管理、用户管理、权限控制等\n\n`;
        }
        else {
      helpMessage += `✅ 可使用搜索、查看资料、网页相册等功能\n\n`;
    }
    helpMessage += `点击下方按钮获取详细使用指南：`;
    // 移除冗长的功能描述列表，让按钮标签更直观
    await ctx.reply(helpMessage, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(helpKeyboard)
    });
  }
    async handleChatWithAdmin(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 普通用户开启聊天模式
    if (userId !== config.superAdminId) {
            const session = {
        userId,
        mode: BotMode.Chat,
                step: 'chatting' as const
      };
      this.userSessions.set(userId, session);
      await database.saveUserSession(userId, session);
      await database.saveChatMessage(userId, config.superAdminId, '[发起聊天请求]');
            await ctx.reply(`💬 聊天模式已开启\n\n` +
        `您现在可以直接发送消息与管理员聊天。\n` +
        `管理员将收到您的消息并可以直接引用回复。\n\n` +
                `💡 输入 /exit 或点击退出按钮结束聊天`, Markup.inlineKeyboard([
          [Markup.button.callback('❌ 退出聊天模式', 'exit_chat')]
            ]));
    // 通知管理员有新的聊天请求
    try {
        const firstName = ctx.from?.first_name || '';
        const lastName = ctx.from?.last_name || '';
        const username = ctx.from?.username ? ` (@${ctx.from.username})` : '';
        const fullName = `${firstName} ${lastName}`.trim() || '用户';
        
        const sentMessage = await this.bot.telegram.sendMessage(config.superAdminId, `💬 <b>新的聊天请求</b>\n\n` +
          `👤 <b>用户</b>：${fullName}${username}\n` +
          `🆔 <b>ID</b>：<code>${userId}</code>\n\n` +
          `✅ <b>已开启聊天模式</b>\n` +
          `💡 提示：您可以直接<b>引用转发的消息</b>进行回复。`, {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: `❌ 断开与用户${userId}的聊天`, callback_data: `disconnect_chat_${userId}` }]
              ]
            }
        });
        // 请求卡本身也可以被管理员直接引用回复，不能只关联后续转发的聊天消息。
        this.adminMessageToUserMap.set(sentMessage.message_id, userId);
    }
    catch (error) {
        console.error('通知管理员失败:', error);
      }
        }
        else {
      // 管理员查看聊天用户列表
      await this.handleAdminChatList(ctx);
    }
  }
    async handleAdminChatList(ctx: Context) {
    try {
      const chatUsers = await database.getChatUsers();
      if (chatUsers.length === 0) {
                await ctx.reply('💬 聊天管理\n\n❌ 暂无用户聊天记录', Markup.inlineKeyboard([
            [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
                ]));
        return;
      }
            const userList = chatUsers.map((user, index) => `${index + 1}. 用户 ${user.user_id} (最后消息: ${new Date(user.last_message_time).toLocaleString()})`).join('\n');
            await ctx.reply(`💬 聊天用户列表\n\n${userList}\n\n` +
                `💡 直接回复用户消息或使用 /chat 用户ID 开始聊天`, Markup.inlineKeyboard([
          [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
            ]));
        }
        catch (error) {
      console.error('获取聊天用户列表错误:', error);
      await ctx.reply('❌ 获取聊天用户列表失败');
    }
  }
    async handleChatMessage(ctx: Context, text: any) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    try {
      // 用户发送消息给管理员
      await database.saveChatMessage(userId, config.superAdminId, text);
      try {
        // 🚀 使用消息转发模式 (带有转发源)
        const sentMessage = await ctx.forwardMessage(config.superAdminId);
        
        // 将用户ID和消息ID关联存储（以便管理员回复时查找目标）
        this.adminMessageToUserMap.set(sentMessage.message_id, userId);
        
        await ctx.reply(`✅ 消息已发送给管理员`);
      }
      catch (error) {
        await ctx.reply('❌ 消息发送失败，管理员可能暂时无法接收消息');
      }
    }
        catch (error) {
      console.error('处理聊天消息错误:', error);
      await ctx.reply('❌ 消息处理失败，请稍后重试');
    }
  }
    private getAdminReplyTargetUserId(ctx: Context): number | null {
      if (!ctx.message || !('reply_to_message' in ctx.message) || !ctx.message.reply_to_message) {
        return null;
      }
      const replied = ctx.message.reply_to_message as any;
      const mappedUserId = this.adminMessageToUserMap.get(replied.message_id);
      if (mappedUserId) return mappedUserId;

      // Bot 重启后内存映射会消失；新聊天请求卡依然带有用户 ID，可用作可靠兜底。
      const body = typeof replied.text === 'string'
        ? replied.text
        : typeof replied.caption === 'string'
          ? replied.caption
          : '';
      const match = body.match(/(?:\bID\b|用户\s*ID)\s*[：:]\s*(\d{4,})/i)
        || body.match(/\bID\b\D{0,16}(\d{4,})/i);
      return match ? Number(match[1]) : null;
    }

    async handleAdminReply(ctx: Context, text: any) {
    if (!ctx.message || !('reply_to_message' in ctx.message) || !ctx.message.reply_to_message) {
      return;
    }
    try {
      // 获取被回复消息的ID
      const repliedMessageId = ctx.message.reply_to_message.message_id;
      const finalTargetUserId = this.getAdminReplyTargetUserId(ctx);
      if (!finalTargetUserId) {
        await ctx.reply('❌ 无法识别回复目标用户，请引用用户转发消息或“新的聊天请求”通知。');
        return;
      }
      // 保存管理员消息到数据库
      await database.saveChatMessage(config.superAdminId, finalTargetUserId, text);
      // 发送消息给目标用户
      try {
        // 🚀 使用消息转发模式 (带有转发源)
        await ctx.forwardMessage(finalTargetUserId);
        
        await ctx.reply(`✅ 消息已发送给用户 ${finalTargetUserId}`);
        // 清理已使用的消息映射
        this.adminMessageToUserMap.delete(repliedMessageId);
      }
            catch (error) {
        await ctx.reply(`❌ 发送失败，用户 ${finalTargetUserId} 可能已停止机器人`);
      }
        }
        catch (error) {
      console.error('处理管理员回复错误:', error);
      await ctx.reply('❌ 回复处理失败，请稍后重试');
    }
  }
    async handleExitChat(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 清除聊天会话
    this.userSessions.delete(userId);
    await database.clearUserSession(userId);
        await ctx.editMessageText(`❌ 已退出聊天模式\n\n您已返回主菜单。`, Markup.inlineKeyboard([
        [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
        ]));
    // 如果是用户退出，通知管理员
    if (userId !== config.superAdminId) {
      try {
        const userName = ctx.from?.first_name || '用户';
                await this.bot.telegram.sendMessage(config.superAdminId, `💬 聊天结束\n\n用户 ${userName} (ID: ${userId}) 已退出聊天模式。`);
            }
            catch (error) {
        console.error('通知管理员失败:', error);
      }
    }
  }
    async handleDisconnectChat(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      await ctx.answerCbQuery('❌ 权限不足');
      return;
    }
    const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
        if (!callbackData)
            return;
    const targetUserId = parseInt(callbackData.replace('disconnect_chat_', ''));
    if (isNaN(targetUserId)) {
      await ctx.answerCbQuery('❌ 无效的用户ID');
      return;
    }
    try {
      // 清除目标用户的聊天会话
      this.userSessions.delete(targetUserId);
      await database.clearUserSession(targetUserId);
      // 通知用户聊天已被管理员结束
      try {
                await this.bot.telegram.sendMessage(targetUserId, `💬 聊天已结束\n\n管理员已断开与您的聊天连接。\n\n如需再次联系，请重新点击"💬 联系管理员"。`);
            }
            catch (error) {
        console.log(`用户 ${targetUserId} 可能已停止机器人，无法发送断开通知`);
      }
      // 更新管理员界面
            await ctx.editMessageText(`✅ 已断开与用户 ${targetUserId} 的聊天连接\n\n用户已收到断开通知。`, Markup.inlineKeyboard([
          [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
            ]));
      await ctx.answerCbQuery('✅ 聊天已断开');
        }
        catch (error) {
      console.error('断开聊天错误:', error);
      await ctx.answerCbQuery('❌ 断开聊天失败');
    }
  }
    async handleReplyCommand(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      await ctx.reply('❌ 权限不足，只有管理员可以使用此命令。');
      return;
    }
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : undefined;
        if (!text)
            return;
    // 解析命令：/reply 用户ID 消息内容
    const parts = text.split(' ');
    if (parts.length < 3) {
      await ctx.reply('❌ 命令格式错误\n\n使用格式：/reply 用户ID 消息内容\n例如：/reply 123456 您好！');
      return;
    }
    const targetUserId = parseInt(parts[1]);
    const replyMessage = parts.slice(2).join(' ');
    if (isNaN(targetUserId)) {
      await ctx.reply('❌ 用户ID格式错误，请输入有效的数字ID');
      return;
    }
    try {
      // 保存消息到数据库
      await database.saveChatMessage(userId, targetUserId, replyMessage);
      // 发送消息给用户
      const messageText = `💬 管理员回复：\n\n${replyMessage}`;
      await this.bot.telegram.sendMessage(targetUserId, messageText);
      await ctx.reply(`✅ 消息已发送给用户 ${targetUserId}`);
        }
        catch (error) {
      console.error('回复用户消息错误:', error);
      await ctx.reply(`❌ 发送失败，用户 ${targetUserId} 可能已停止机器人或ID不存在`);
    }
  }
    async handleExitCommand(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    const session = this.userSessions.get(userId);
        
        // 检查是否在按钮制作模式
        if (session && session.mode === BotMode.ButtonMaker && session.step === 'waiting_message') {
            await ButtonMakerHandler.handleMessage(ctx, database, session);
            return;
        }

    if (session && session.mode === 'chat') {
      // 退出聊天模式
      this.userSessions.delete(userId);
      await database.clearUserSession(userId);
            await ctx.reply('❌ 已退出聊天模式\n\n您已返回主菜单。', await this.getCoreFunctionKeyboard(userId));
        }
        else {
      await ctx.reply('💡 您当前不在聊天模式中。');
    }
  }
    async handleAdmin(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      await ctx.reply('❌ 权限不足，只有超级管理员可以访问此功能。');
      return;
    }
    const mediaCount = await database.getMediaCount();
    const keywordCount = await database.getKeywordCount();
        const managedChannels = await database.getManagedChannels();
    const adminText = `
👑 管理员面板

📊 统计信息：
• 媒体文件总数：${mediaCount}
• 关键词总数：${keywordCount}
• 频道数量：${managedChannels.length}

⚙️ 可用操作：
• 查看所有关键词
• 清理数据库
• 导出数据
    `;
    await ctx.reply(adminText, this.getBackKeyboard());
  }
    async handleModeSelect(ctx: Context, mode: any) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 更新用户会话
    const session: UserSession = {
      userId,
      mode,
            step: (mode === 'search' ? 'idle' : 'waiting_keyword') as UserSession['step']
    };
    this.userSessions.set(userId, session);
    await database.saveUserSession(userId, session);
    let message = '';
    switch (mode) {
      case 'search':
        message = '🔍 搜索模式已激活\n\n直接发送关键词开始搜索：';
        break;
      case 'upload':
        message = '📤 上传模式已激活\n\n请先输入关键词：';
        break;
      case 'publish':
        message = '📢 发布模式已激活\n\n请选择目标频道：';
        break;
    }
    await ctx.editMessageText(message, await this.getModeKeyboard(mode));
  }
    async handleBackToMain(ctx: Context) {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from?.id;
        if (!userId)
            return;
    this.userSessions.delete(userId);
    userAccountCommands.silentCleanup(userId);
    WatermarkHandler.clearInput(userId);
    await database.clearUserSession(userId);
        await ctx.reply('🤖 频道管理机器人\n\n请选择功能：', await this.getCoreFunctionKeyboard(userId));
  }
    private getSelectedChannels(session: UserSession): string[] {
      const selected = session.selectedChannels?.length
        ? session.selectedChannels
        : session.selectedChannel
          ? [session.selectedChannel]
          : [];
      return Array.from(new Set(selected.map(String).filter(Boolean)));
    }

    private async getAvailableChannels(userId: number): Promise<string[]> {
      const channelIds = hasAdminChannelMap(userId)
        ? getAdminChannelIds(userId)
        : await database.getManagedChannels();
      return Array.from(new Set(channelIds.map(String).filter(Boolean)));
    }

    private async getSelectedChannelNames(channelIds: string[]): Promise<string[]> {
      return Promise.all(channelIds.map(channelId => this.getChannelFullName(channelId)));
    }

    private async handlePublishChannelToggle(ctx: Context): Promise<void> {
      const userId = ctx.from?.id;
      const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
      if (!userId || !callbackData) return;

      const channelId = callbackData.replace('publish_toggle_', '');
      const session = this.userSessions.get(userId) || await database.getUserSession(userId);
      const availableChannels = await this.getAvailableChannels(userId);
      if (!session || session.mode !== BotMode.Publish || !availableChannels.includes(channelId)) {
        await ctx.answerCbQuery('频道选择已失效，请重新进入发布模式。', { show_alert: true }).catch(() => {});
        return;
      }

      const selected = new Set(this.getSelectedChannels(session));
      const isAdding = !selected.has(channelId);
      if (isAdding) selected.add(channelId);
      else selected.delete(channelId);

      session.selectedChannels = Array.from(selected);
      session.selectedChannel = session.selectedChannels[0];
      session.step = 'selecting_channel';
      this.userSessions.set(userId, session);
      await database.saveUserSession(userId, session);
      await ctx.answerCbQuery(isAdding ? '已选中' : '已取消').catch(() => {});

      const selectedNames = await this.getSelectedChannelNames(session.selectedChannels);
      const text = `🚀 发布内容\n\n请选择一个或多个目标群/频道：\n\n` +
        (selectedNames.length ? `已选择（${selectedNames.length}）：\n${selectedNames.map(name => `• ${name}`).join('\n')}` : '暂未选择目标。');
      try {
        await ctx.editMessageText(text, await this.getChannelSelectionKeyboard(userId, session.selectedChannels));
      } catch {
        await ctx.reply(text, await this.getChannelSelectionKeyboard(userId, session.selectedChannels));
      }
    }

    private async handlePublishChannelsConfirm(ctx: Context): Promise<void> {
      const userId = ctx.from?.id;
      if (!userId) return;
      const session = this.userSessions.get(userId) || await database.getUserSession(userId);
      if (!session || session.mode !== BotMode.Publish) return;

      const selectedChannels = this.getSelectedChannels(session);
      if (selectedChannels.length === 0) {
        await ctx.answerCbQuery('请至少选择一个群或频道。', { show_alert: true }).catch(() => {});
        return;
      }
      session.selectedChannels = selectedChannels;
      session.selectedChannel = selectedChannels[0];
      session.step = 'waiting_keyword';
      this.userSessions.set(userId, session);
      await database.saveUserSession(userId, session);
      await ctx.answerCbQuery('目标已确认').catch(() => {});

      const names = await this.getSelectedChannelNames(selectedChannels);
      await ctx.editMessageText(`📢 发布模式激活\n\n` +
        `已选择 ${names.length} 个目标：\n${names.map(name => `• ${name}`).join('\n')}\n\n` +
        `💡 请输入要发布的关键词：\n` +
        `• 单个：优米\n` +
        `• 多个连写：优米樊樊\n` +
        `• 或多个空格：优米 樊樊 北北\n` +
        `会按顺序同步发到所有已选目标。\n\n` +
        `🔄 发布模式将保持激活，可连续发布`, Markup.inlineKeyboard([
          ...(isAdminUser(userId) ? [[Markup.button.callback('⏰ 定时发送', 'schedule_begin'), Markup.button.callback('📋 定时任务', 'schedule_list')], [Markup.button.callback('⭐ 推荐推送', 'recommend_menu')], [Markup.button.callback('立即发送', 'schedule_immediate')]] : []),
          [Markup.button.callback('❌ 退出发布模式', 'cancel')]
        ])).catch(async () => {
          await ctx.reply('✅ 目标已确认，请直接输入要发布的关键词。');
        });
    }

    private async handleUploadChannelToggle(ctx: Context): Promise<void> {
      const userId = ctx.from?.id;
      const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
      if (!userId || !callbackData) return;
      const channelId = callbackData.replace('upload_toggle_', '');
      const session = await UploadHandler.resolveUploadSession(userId, this.userSessions, database);
      const availableChannels = await this.getAvailableChannels(userId);
      if (!session || !session.pendingMedia?.length || !availableChannels.includes(channelId)) {
        await ctx.answerCbQuery('上传会话已失效，请重新选择频道。', { show_alert: true }).catch(() => {});
        return;
      }

      const selected = new Set(this.getSelectedChannels(session));
      const isAdding = !selected.has(channelId);
      if (isAdding) selected.add(channelId);
      else selected.delete(channelId);
      session.selectedChannels = Array.from(selected);
      session.selectedChannel = session.selectedChannels[0];
      session.step = 'selecting_channel';
      this.userSessions.set(userId, session);
      await database.saveUserSession(userId, session);
      await ctx.answerCbQuery(isAdding ? '已选中' : '已取消').catch(() => {});
      await UploadHandler.renderChannelSelection(ctx, this.userSessions, this.bot, true);
    }

    private async handleUploadChannelsConfirm(ctx: Context): Promise<void> {
      const userId = ctx.from?.id;
      if (!userId) return;
      const session = await UploadHandler.resolveUploadSession(userId, this.userSessions, database);
      if (!session || !session.pendingMedia?.length) return;
      const selectedChannels = this.getSelectedChannels(session);
      if (selectedChannels.length === 0) {
        await ctx.answerCbQuery('请至少选择一个群或频道。', { show_alert: true }).catch(() => {});
        return;
      }
      session.selectedChannels = selectedChannels;
      session.selectedChannel = selectedChannels[0];
      session.step = 'confirming';
      this.userSessions.set(userId, session);
      await database.saveUserSession(userId, session);
      await ctx.answerCbQuery('目标已确认').catch(() => {});

      const names = await this.getSelectedChannelNames(selectedChannels);
      const text = `📤 上传确认\n\n关键词: "${session.currentKeyword}"\n` +
        `目标群/频道（${names.length}）：\n${names.map(name => `• ${name}`).join('\n')}\n` +
        `媒体文件: ${session.pendingMedia.length} 个\n\n请选择操作：`;
      try {
        await ctx.editMessageText(text, this.getUploadConfirmKeyboard());
      } catch {
        await ctx.reply(text, this.getUploadConfirmKeyboard());
      }
    }

    async handleChannelSelect(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
        if (!callbackData)
            return;
    const channelId = callbackData.replace('channel_', '');
    const session = this.userSessions.get(userId);
        if (!session)
            return;
    session.selectedChannel = channelId;
    session.selectedChannels = [channelId];
    session.step = 'waiting_keyword';
    this.userSessions.set(userId, session);
    await database.saveUserSession(userId, session);
    const channelName = await this.getChannelFullName(channelId);
    if (session.mode === 'publish') {
            await ctx.editMessageText(`📢 发布模式激活\n\n` +
        `已选择频道：${channelName}\n\n` +
        `💡 请输入要发布的关键词：\n` +
        `• 单个：优米\n` +
        `• 多个连写：优米樊樊\n` +
        `• 或多个空格：优米 樊樊 北北\n` +
        `会按顺序发完一个再发下一个，不打乱组序。\n\n` +
                `🔄 发布模式将保持激活，可连续发布`, Markup.inlineKeyboard([
          [Markup.button.callback('❌ 退出发布模式', 'cancel')]
            ]));
        }
        else {
            await ctx.editMessageText(`📢 已选择频道：${channelName}\n\n请输入要发布的关键词：`, this.getBackKeyboard());
    }
  }
    async handleUploadChannelSelect(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    await ctx.answerCbQuery('已选择频道').catch(() => {});
    const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
        if (!callbackData)
            return;
    const channelId = callbackData.replace('upload_channel_', '');
    const session = await UploadHandler.resolveUploadSession(userId, this.userSessions, database);
    if (!session || (session.mode !== 'upload' && session.mode !== BotMode.AddReview) || !session.pendingMedia || session.pendingMedia.length === 0) {
      await ctx.reply('❌ 上传会话已失效，请重新：上传资料 → 关键词 → 媒体 → 选择频道。').catch(() => {});
      return;
    }
    session.selectedChannel = channelId;
    session.step = 'confirming';
    this.userSessions.set(userId, session);
    await database.saveUserSession(userId, session);
    const channelName = await this.getChannelName(channelId);
        try {
            await ctx.editMessageText(`📤 上传确认\n\n` +
      `关键词: "${session.currentKeyword}"\n` +
      `目标频道: ${channelName}\n` +
      `媒体文件: ${session.pendingMedia.length} 个\n\n` +
            `请选择操作：`, this.getUploadConfirmKeyboard());
        } catch {
            await ctx.reply(`📤 上传确认\n\n` +
      `关键词: "${session.currentKeyword}"\n` +
      `目标频道: ${channelName}\n` +
      `媒体文件: ${session.pendingMedia.length} 个\n\n` +
            `请选择操作：`, this.getUploadConfirmKeyboard());
        }
  }
    async handleSaveOnly(ctx: Context) {
    await UploadHandler.handleSaveOnly(ctx, this.userSessions, database);
  }
    async handleSaveAndPublish(ctx: Context) {
    await UploadHandler.handleSaveAndPublish(ctx, this.userSessions, database, this.bot);
  }
    async handleSelectChannel(ctx: Context) {
    await UploadHandler.handleChannelSelection(ctx, this.userSessions, this.bot);
  }
    async handleBatchUpload(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 设置用户为批量上传模式
        const session = {
      userId,
      mode: BotMode.Upload,
            step: 'waiting_keyword' as const
    };
    this.userSessions.set(userId, session);
    await database.saveUserSession(userId, session);
        await ctx.editMessageText(`📁 批量上传模式已激活\n\n请输入关键词：`, this.getBackKeyboard());
  }
    async handleSingleUpload(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 设置用户为单文件上传模式
        const session = {
      userId,
      mode: BotMode.Upload,
            step: 'waiting_keyword' as const
    };
    this.userSessions.set(userId, session);
    await database.saveUserSession(userId, session);
        await ctx.editMessageText(`📷 单文件上传模式已激活\n\n请输入关键词：`, this.getBackKeyboard());
  }
    async handleCancel(ctx: Context) {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from?.id;
        if (!userId)
            return;
    this.userSessions.delete(userId);
    userAccountCommands.silentCleanup(userId);
    WatermarkHandler.clearInput(userId);
    await database.clearUserSession(userId);
        await ctx.reply('❌ 操作已取消\n\n请选择功能：', await this.getCoreFunctionKeyboard(userId));
  }
    async handleTextMessage(ctx: Context) {
        const userId = ctx.from?.id;
        if (!userId)
            return;

        const text = ctx.message && 'text' in ctx.message ? ctx.message.text : undefined;
        if (!text) return;
        if (await RecommendationHandler.input(ctx, text, this.userSessions)) return;
        if (await WatermarkHandler.handleKeywordInput(ctx, database)) return;

        // 🚀 增加全量日志，确保能看到每一条进来的消息
        const userDisplay = this.getUserDisplay(ctx);
        console.log(`💬 [文本消息] ${userDisplay} -> "${text}"`);
        
        // 追踪用户活动
        try {
            await database.trackUser(
                userId,
                ctx.from?.first_name,
                ctx.from?.last_name,
                ctx.from?.username
            );
        } catch (error) {
            console.error('追踪用户失败:', error);
        }

        // 提取发布关键词：最高优先级，避免掉进搜索模式
        if (userId === config.superAdminId && userAccountCommands.isAwaitingExtractInput(userId)) {
            const handled = await userAccountCommands.handleTextMessage(ctx);
            if (handled) return;
        }

        // 获取当前会话状态 (优先从内存获取)
        let session: UserSession | null | undefined = this.userSessions.get(userId);
        if (!session) {
            session = await database.getUserSession(userId);
            if (session) this.userSessions.set(userId, session);
        }

        // 🚀 核心修复：优先处理主机器人的核心交互模式，防止被账号控制逻辑误拦截
        if (session && (
          session.mode === BotMode.AddReview ||
          session.mode === BotMode.Upload ||
          session.mode === BotMode.Publish ||
          session.mode === BotMode.AlbumMaker
        )) {
            if (session.mode !== BotMode.AlbumMaker) {
              console.log(`[路由] 进入主机器人核心分支: mode=${session.mode}, step=${session.step}`);
            }
            
            // 复用现有的 switch 逻辑或直接处理
            if (session.mode === BotMode.AddReview) {
                if (session.step === 'waiting_keyword') {
                    await ReviewHandler.handleKeywordInput(ctx, text, database, this.userSessions);
                } else if (session.step === 'waiting_media') {
                    await this.handleUploadTextDescription(ctx, text);
                }
                return;
            }
            // 其他模式继续往下走，但在账号控制之前处理
            if (session.mode === BotMode.Upload) {
                if (session.step === 'waiting_keyword') {
                    if (session.currentKeyword === 'grant_monthly' || session.currentKeyword === 'grant_quarterly' || session.currentKeyword === 'revoke_permission') {
                        await this.handlePermissionInput(ctx, text);
                    } else {
                        await UploadHandler.handleKeywordInput(ctx, text, this.userSessions, database);
                    }
                } else if (session.step === 'waiting_media') {
                    await this.handleUploadTextDescription(ctx, text);
                }
                return;
            }
            if (session.mode === BotMode.Publish) {
                if (session.step === 'waiting_keyword') {
                    await PublishHandler.handleKeywordInput(ctx, text, this.userSessions, database, this.bot);
                }
                return;
            }
            if (session.mode === BotMode.AlbumMaker) {
                if (session.step === 'waiting_album_name') {
                    await AlbumHandler.handleNameInput(ctx, database, session, this.userSessions);
                } else if (session.step === 'waiting_media' || session.step === 'waiting_keyword') {
                    await AlbumHandler.handleKeyword(ctx, database, this.userSessions, text);
                } else if ((session.step as string) === 'waiting_album_auth_id') {
                    await AlbumHandler.handleAdminUserIdInput(ctx, text, this.userSessions);
                }
                return;
            }
        }

        // 优先处理账号控制命令
        if (userId === config.superAdminId) {
            const handled = await userAccountCommands.handleTextMessage(ctx);
            if (handled) return;
        }

        const addingSession = session; // 保持向后兼容
        if (addingSession && (addingSession.mode === BotMode.AddingSourceChannel || addingSession.mode === BotMode.AddingTargetChannel)) {
      const isAddingSource = addingSession.mode === BotMode.AddingSourceChannel;
      if (ctx.message && 'forward_from_chat' in ctx.message) {
        const chat = ctx.message.forward_from_chat;
                if (chat && typeof chat === 'object' && 'id' in chat) {
                    const chatId = typeof chat.id === 'number' ? chat.id : Number(chat.id);
        if (isAddingSource) {
                        this.forwardingService.addSourceChannel(userId, chatId);
                    }
                    else {
                        this.forwardingService.addTargetChannel(userId, chatId);
        }
                    const chatTitle = 'title' in chat ? chat.title : '未知频道';
                    await ctx.reply(`已添加监听频道: ${chatTitle}`);
                }
        this.userSessions.delete(userId);
        if (isAddingSource) {
          await this.handleSourceChannels(ctx);
                }
                else {
          await this.handleTargetChannels(ctx);
        }
            }
            else if (ctx.message && 'text' in ctx.message) {
        const textValue = ctx.message.text;
        if (textValue.startsWith('-') || !isNaN(parseInt(textValue))) {
          const channelId = parseInt(textValue);
          try {
            const chat = await this.bot.telegram.getChat(channelId);
            if (isAddingSource) {
              this.forwardingService.addSourceChannel(userId, chat.id);
                        }
                        else {
              this.forwardingService.addTargetChannel(userId, chat.id);
            }
            if (isAddingSource) {
              this.forwardingService.addSourceChannel(userId, chat.id);
                        }
                        else {
              this.forwardingService.addTargetChannel(userId, chat.id);
            }
                        const chatTitle = 'title' in chat ? chat.title : '未知频道';
                        await ctx.reply(`已添加监听频道: ${chatTitle}`);
            this.userSessions.delete(userId);
            if (isAddingSource) {
              await this.handleSourceChannels(ctx);
                        }
                        else {
              await this.handleTargetChannels(ctx);
            }
                    }
                    catch (error) {
            await ctx.reply('无效的频道 ID 或机器人不是该频道的成员。');
          }
        }
      }
      return;
    }
    
    // 检查是否是管理员的引用回复
    if (userId === config.superAdminId && ctx.message && 'reply_to_message' in ctx.message && ctx.message.reply_to_message) {
      await this.handleAdminReply(ctx, text);
      return;
    }
    // 管理员快捷触发：当命令监听未命中时，兜底在文本流里拦截
    if (userId === config.superAdminId) {
      const trimmed = text.trim();
      if (trimmed === '📢 群发消息' || trimmed === '群发消息' || trimmed === '/broadcast') {
        await this.handleBroadcastMessage(ctx);
        return;
      }
      if (trimmed === '🔧 关键词优化' || trimmed === '关键词优化' || trimmed === '/optimize') {
        await this.handleKeywordOptimize(ctx);
        return;
      }
    }
    // 检查是否在群发模式
    if (session && session.mode === 'broadcast' && session.step === 'waiting_message') {
      await this.handleBroadcastConfirmation(ctx, 'text', text);
      return;
    }
        // 检查是否在设置关注回复模式
        if (session && (session.step === 'waiting_join_welcome_message' || 
                        session.step === 'waiting_join_welcome_button_text' || 
                        session.step === 'waiting_join_welcome_button_url')) {
            if (session.step === 'waiting_join_welcome_message') {
                await JoinWelcomeHandler.handleMessage(ctx, database, session);
            } else if (session.step === 'waiting_join_welcome_button_text') {
                await JoinWelcomeHandler.handleButtonText(ctx, database, session);
            } else if (session.step === 'waiting_join_welcome_button_url') {
                await JoinWelcomeHandler.handleButtonUrl(ctx, database, session);
            }
      return;
    }
    
        // 检查是否在定向发送资料模式
        if (session && session.mode === BotMode.SendDataToUser) {
            if (session.step === 'waiting_direct_send_target') {
                await DirectSendHandler.handleTargetInput(ctx, database, session);
            } else if (session.step === 'waiting_keyword') {
                await DirectSendHandler.handleInput(ctx, database, session, this.bot);
            }
            return;
        }

        // 检查是否在相册制作模式（兜底，上面优先分支已处理）
        if (session && session.mode === BotMode.AlbumMaker) {
            if (session.step === 'waiting_album_name') {
                await AlbumHandler.handleNameInput(ctx, database, session, this.userSessions);
            } else if (session.step === 'waiting_media' || session.step === 'waiting_keyword') {
                await AlbumHandler.handleKeyword(ctx, database, this.userSessions, text);
            }
            return;
        }

        // 🚀 检查是否在标签筛选模式
        if (session && session.mode === BotMode.TagFilter) {
            if (session.step === 'waiting_keyword') {
                // 如果是管理员在添加标签
                if (session.pendingText === 'adding_tag' && userId === config.superAdminId) {
                    await TagFilterHandler.handleAdminAddTag(ctx, database, text);
                } else {
                    await TagFilterHandler.handleTagInput(ctx, database, text);
                }
            }
            return;
        }

        // 🚀 检查是否在全员资料群发模式
        if (session && session.mode === BotMode.BroadcastData) {
            if (session.step === 'waiting_keyword') {
                await BroadcastDataHandler.handleInput(ctx, database, session, this.bot);
            }
            return;
        }

      // 默认搜索模式
        if (!session) {
      await SearchHandler.handleSearch(ctx, text, database);
      return;
    }
    // 上传模式不再需要"完成"命令，直接通过按钮选择频道
    switch (session.mode) {
      case 'search':
        if (session.step === 'adding_channel') {
          await this.handleAddChannelInput(ctx, text);
                }
                else if (session.step === 'waiting_keyword' && userId === config.superAdminId) {
          // 处理删除关键词输入
          await this.handleDeleteKeywordInput(ctx, text);
                }
                else {
          await SearchHandler.handleSearch(ctx, text, database);
        }
        break;
      case 'chat':
        if (session.step === 'chatting') {
          await this.handleChatMessage(ctx, text);
        }
        break;
      case 'broadcast':
        if (session.step === 'waiting_text') {
          await this.handleBroadcastText(ctx);
        }
        break;
            case BotMode.ButtonMaker:
                if (session.step === 'waiting_message') {
                    await ButtonMakerHandler.handleMessage(ctx, database, session);
                } else if (session.step === 'waiting_button_text') {
                    await ButtonMakerHandler.handleButtonText(ctx, database, session);
                } else if (session.step === 'waiting_button_url') {
                    await ButtonMakerHandler.handleButtonUrl(ctx, database, session);
                }
                break;

        }
    }
    async handlePhotoMessage(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
        
        console.log(`[媒体] 📸 收到照片消息，来自用户: ${userId}`);
        
        // 追踪用户活动
        try {
            await database.trackUser(
                userId,
                ctx.from?.first_name,
                ctx.from?.last_name,
                ctx.from?.username
            );
        } catch (error) {
            console.error('追踪用户失败:', error);
        }

    // 检查是否是管理员的媒体回复
    if (userId === config.superAdminId && ctx.message && 'reply_to_message' in ctx.message && ctx.message.reply_to_message) {
      await this.handleAdminMediaReply(ctx, 'photo');
      return;
    }

    const session = this.userSessions.get(userId) || await database.getUserSession(userId);

        // 检查是否在相册制作模式
        if (session && session.mode === BotMode.AlbumMaker) {
            await AlbumHandler.handleMediaMessage(ctx, 'photo', this.userSessions, database);
            return;
        }

        // 🚀 检查是否在好评库新增模式
        if (session && session.mode === BotMode.AddReview) {
            await UploadHandler.handleMediaMessage(ctx, 'photo', this.userSessions, database);
            return;
        }

        // 检查是否在定向发送资料模式
        if (session && session.mode === BotMode.SendDataToUser && session.step === 'waiting_keyword') {
            await DirectSendHandler.handleInput(ctx, database, session, this.bot);
            return;
        }

        // 检查是否在设置关注回复模式
        if (session && session.mode === BotMode.JoinWelcome && session.step === 'waiting_join_welcome_message') {
            await JoinWelcomeHandler.handleMessage(ctx, database, session);
            return;
        }

        // 🚀 检查是否在好评库新增模式
        if (session && session.mode === BotMode.AddReview) {
            const message = ctx.message as any;
            const type = message.photo ? 'photo' : message.video ? 'video' : message.document ? 'document' : message.audio ? 'audio' : message.voice ? 'voice' : 'media';
            await UploadHandler.handleMediaMessage(ctx, type as any, this.userSessions, database);
            return;
        }

        // 检查是否在群发模式
    if (session && session.mode === 'broadcast' && session.step === 'waiting_message') {
      if (ctx.message && 'photo' in ctx.message) {
        const photo = ctx.message.photo;
        const fileId = photo[photo.length - 1].file_id;
        const caption = 'caption' in ctx.message ? ctx.message.caption || '' : '';
        await this.handleBroadcastConfirmation(ctx, 'photo', { file_id: fileId, caption });
        return;
      }
    }
    // 检查是否在聊天模式
        
        // 检查是否在按钮制作模式
        if (session && session.mode === BotMode.ButtonMaker && session.step === 'waiting_message') {
            await ButtonMakerHandler.handleMessage(ctx, database, session);
            return;
        }

        // 检查是否在设置关注回复模式
        if (session && session.step === 'waiting_join_welcome_message') {
            await JoinWelcomeHandler.handleMessage(ctx, database, session);
            return;
        }

    if (session && session.mode === 'chat' && session.step === 'chatting') {
      await this.handleChatMediaMessage(ctx, 'photo');
        }
        else {
      await UploadHandler.handleMediaMessage(ctx, 'photo', this.userSessions, database);
    }
  }
    async handleVideoMessage(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
        
        console.log(`[媒体] 🎥 收到视频消息，来自用户: ${userId}`);
        
        // 追踪用户活动
        try {
            await database.trackUser(
                userId,
                ctx.from?.first_name,
                ctx.from?.last_name,
                ctx.from?.username
            );
        } catch (error) {
            console.error('追踪用户失败:', error);
        }

    // 检查是否是管理员的媒体回复
    if (userId === config.superAdminId && ctx.message && 'reply_to_message' in ctx.message && ctx.message.reply_to_message) {
      await this.handleAdminMediaReply(ctx, 'video');
      return;
    }

    const session = this.userSessions.get(userId) || await database.getUserSession(userId);

        // ✅ 修复：在相册制作模式下，优先处理相册收集
        if (session && session.mode === BotMode.AlbumMaker) {
            await AlbumHandler.handleMediaMessage(ctx, 'video', this.userSessions, database);
            return;
        }

        // 🚀 检查是否在好评库新增模式
        if (session && session.mode === BotMode.AddReview) {
            await UploadHandler.handleMediaMessage(ctx, 'video', this.userSessions, database);
            return;
        }

        // 检查是否在群发模式
    if (session && session.mode === 'broadcast' && session.step === 'waiting_message') {
      if (ctx.message && 'video' in ctx.message) {
        const video = ctx.message.video;
        const fileId = video.file_id;
        const caption = 'caption' in ctx.message ? ctx.message.caption || '' : '';
        await this.handleBroadcastConfirmation(ctx, 'video', { file_id: fileId, caption });
        return;
      }
    }
    
        // 检查是否在定向发送资料模式
        if (session && session.mode === BotMode.SendDataToUser && session.step === 'waiting_keyword') {
            await DirectSendHandler.handleInput(ctx, database, session, this.bot);
            return;
        }

        // 检查是否在设置关注回复模式
        if (session && session.mode === BotMode.JoinWelcome && session.step === 'waiting_join_welcome_message') {
            await JoinWelcomeHandler.handleMessage(ctx, database, session);
            return;
        }

        // 🚀 检查是否在好评库新增模式
        if (session && session.mode === BotMode.AddReview) {
            const message = ctx.message as any;
            const type = message.photo ? 'photo' : message.video ? 'video' : message.document ? 'document' : message.audio ? 'audio' : message.voice ? 'voice' : 'media';
            await UploadHandler.handleMediaMessage(ctx, type as any, this.userSessions, database);
            return;
        }

    if (session && session.mode === 'chat' && session.step === 'chatting') {
      await this.handleChatMediaMessage(ctx, 'video');
        }
        else {
      await UploadHandler.handleMediaMessage(ctx, 'video', this.userSessions, database);
    }
  }
    async handleAnimationMessage(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;
    console.log(`[媒体] 🎞️ 收到动画(GIF)消息，来自用户: ${userId}`);
    const session = this.userSessions.get(userId) || await database.getUserSession(userId);
    if (session && session.mode === 'chat' && session.step === 'chatting') {
      await this.handleChatMediaMessage(ctx, 'animation');
    } else {
      await UploadHandler.handleMediaMessage(ctx, 'animation', this.userSessions, database);
    }
  }
    async handleDocumentMessage(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
        
        // 追踪用户活动
        try {
            await database.trackUser(
                userId,
                ctx.from?.first_name,
                ctx.from?.last_name,
                ctx.from?.username
            );
        } catch (error) {
            console.error('追踪用户失败:', error);
        }

    // 检查是否是管理员的媒体回复
    if (userId === config.superAdminId && ctx.message && 'reply_to_message' in ctx.message && ctx.message.reply_to_message) {
      await this.handleAdminMediaReply(ctx, 'document');
      return;
    }

    const session = this.userSessions.get(userId) || await database.getUserSession(userId);

        // 检查是否在相册制作模式 (相册通常不支持文档，但可以记录日志)
        if (session && session.mode === BotMode.AlbumMaker) {
            await ctx.reply('⚠️ 相册制作模式目前不支持文档文件，请发送照片或视频。');
            return;
        }

        // 检查是否在群发模式
    if (session && session.mode === 'broadcast' && session.step === 'waiting_message') {
      if (ctx.message && 'document' in ctx.message) {
        const document = ctx.message.document;
        const fileId = document.file_id;
        const caption = 'caption' in ctx.message ? ctx.message.caption || '' : '';
        await this.handleBroadcastConfirmation(ctx, 'document', { file_id: fileId, caption });
        return;
      }
    }
    
        // 检查是否在定向发送资料模式
        if (session && session.mode === BotMode.SendDataToUser && session.step === 'waiting_keyword') {
            await DirectSendHandler.handleInput(ctx, database, session, this.bot);
            return;
        }

        // 检查是否在设置关注回复模式
        if (session && session.mode === BotMode.JoinWelcome && session.step === 'waiting_join_welcome_message') {
            await JoinWelcomeHandler.handleMessage(ctx, database, session);
            return;
        }

        // 🚀 检查是否在好评库新增模式
        if (session && session.mode === BotMode.AddReview) {
            const message = ctx.message as any;
            const type = message.photo ? 'photo' : message.video ? 'video' : message.document ? 'document' : message.audio ? 'audio' : message.voice ? 'voice' : 'media';
            await UploadHandler.handleMediaMessage(ctx, type as any, this.userSessions, database);
            return;
        }

    if (session && session.mode === 'chat' && session.step === 'chatting') {
      await this.handleChatMediaMessage(ctx, 'document');
        }
        else {
      await UploadHandler.handleMediaMessage(ctx, 'document', this.userSessions, database);
    }
  }
    async handleAudioMessage(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
        
        // 追踪用户活动
        try {
            await database.trackUser(
                userId,
                ctx.from?.first_name,
                ctx.from?.last_name,
                ctx.from?.username
            );
        } catch (error) {
            console.error('追踪用户失败:', error);
        }

    // 检查是否是管理员的媒体回复
    if (userId === config.superAdminId && ctx.message && 'reply_to_message' in ctx.message && ctx.message.reply_to_message) {
      await this.handleAdminMediaReply(ctx, 'audio');
      return;
    }

    const session = this.userSessions.get(userId) || await database.getUserSession(userId);
    
        // 检查是否在定向发送资料模式
        if (session && session.mode === BotMode.SendDataToUser && session.step === 'waiting_keyword') {
            await DirectSendHandler.handleInput(ctx, database, session, this.bot);
            return;
        }

        // 检查是否在设置关注回复模式
        if (session && session.mode === BotMode.JoinWelcome && session.step === 'waiting_join_welcome_message') {
            await JoinWelcomeHandler.handleMessage(ctx, database, session);
            return;
        }

        // 🚀 检查是否在好评库新增模式
        if (session && session.mode === BotMode.AddReview) {
            const message = ctx.message as any;
            const type = message.photo ? 'photo' : message.video ? 'video' : message.document ? 'document' : message.audio ? 'audio' : message.voice ? 'voice' : 'media';
            await UploadHandler.handleMediaMessage(ctx, type as any, this.userSessions, database);
            return;
        }

    if (session && session.mode === 'chat' && session.step === 'chatting') {
      await this.handleChatMediaMessage(ctx, 'audio');
        }
        else {
      await UploadHandler.handleMediaMessage(ctx, 'audio', this.userSessions, database);
    }
  }
    async handleVoiceMessage(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
        
        // 追踪用户活动
        try {
            await database.trackUser(
                userId,
                ctx.from?.first_name,
                ctx.from?.last_name,
                ctx.from?.username
            );
        } catch (error) {
            console.error('追踪用户失败:', error);
        }

    // 检查是否是管理员的媒体回复
    if (userId === config.superAdminId && ctx.message && 'reply_to_message' in ctx.message && ctx.message.reply_to_message) {
      await this.handleAdminMediaReply(ctx, 'voice');
      return;
    }

    const session = this.userSessions.get(userId) || await database.getUserSession(userId);
    
        // 检查是否在定向发送资料模式
        if (session && session.mode === BotMode.SendDataToUser && session.step === 'waiting_keyword') {
            await DirectSendHandler.handleInput(ctx, database, session, this.bot);
            return;
        }

        // 检查是否在设置关注回复模式
        if (session && session.mode === BotMode.JoinWelcome && session.step === 'waiting_join_welcome_message') {
            await JoinWelcomeHandler.handleMessage(ctx, database, session);
            return;
        }

        // 🚀 检查是否在好评库新增模式
        if (session && session.mode === BotMode.AddReview) {
            const message = ctx.message as any;
            const type = message.photo ? 'photo' : message.video ? 'video' : message.document ? 'document' : message.audio ? 'audio' : message.voice ? 'voice' : 'media';
            await UploadHandler.handleMediaMessage(ctx, type as any, this.userSessions, database);
            return;
        }

    if (session && session.mode === 'chat' && session.step === 'chatting') {
      await this.handleChatMediaMessage(ctx, 'voice');
        }
        else {
      await UploadHandler.handleMediaMessage(ctx, 'voice', this.userSessions, database);
    }
  }
    async handleVideoNoteMessage(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;
    console.log(`[媒体] ⚪ 收到视频动态消息，来自用户: ${userId}`);
    const session = this.userSessions.get(userId) || await database.getUserSession(userId);
    if (session && session.mode === 'chat' && session.step === 'chatting') {
      await this.handleChatMediaMessage(ctx, 'video_note');
    } else {
      await UploadHandler.handleMediaMessage(ctx, 'video_note', this.userSessions, database);
    }
  }
    async handleChatMediaMessage(ctx: Context, mediaType: any) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    try {
            let fileId;
      let caption = '';
      // 根据媒体类型获取文件ID和说明文字
      switch (mediaType) {
        case 'photo':
          if (ctx.message && 'photo' in ctx.message) {
            fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            caption = ctx.message.caption || '';
                    }
                    else
                        return;
          break;
        case 'video':
          if (ctx.message && 'video' in ctx.message) {
            fileId = ctx.message.video.file_id;
            caption = ctx.message.caption || '';
                    }
                    else
                        return;
          break;
        case 'document':
          if (ctx.message && 'document' in ctx.message) {
            fileId = ctx.message.document.file_id;
            caption = ctx.message.caption || '';
                    }
                    else
                        return;
          break;
        case 'audio':
          if (ctx.message && 'audio' in ctx.message) {
            fileId = ctx.message.audio.file_id;
            caption = ctx.message.caption || '';
                    }
                    else
                        return;
          break;
        case 'voice':
          if (ctx.message && 'voice' in ctx.message) {
            fileId = ctx.message.voice.file_id;
            caption = ctx.message.caption || '';
                    }
                    else
                        return;
          break;
        default:
          return;
      }
      // 保存聊天消息到数据库（媒体类型）
      await database.saveChatMessage(userId, config.superAdminId, caption || `[${mediaType}]`);
      try {
        // 🚀 使用消息转发模式 (带有转发源)
        const sentMessage = await ctx.forwardMessage(config.superAdminId);
        
        // 存储消息ID映射以便管理员引用回复
        if (sentMessage) {
          this.adminMessageToUserMap.set(sentMessage.message_id, userId);
        }
        await ctx.reply(`✅ ${this.getMediaTypeName(mediaType)}已发送给管理员`);
      }
      catch (error) {
        await ctx.reply('❌ 媒体发送失败，管理员可能暂时无法接收消息');
      }
        }
        catch (error) {
      console.error('处理聊天媒体消息错误:', error);
      await ctx.reply('❌ 媒体处理失败，请稍后重试');
    }
  }
    getMediaTypeName(mediaType: string) {
    const typeNames: { [key: string]: string } = {
      'photo': '照片',
      'video': '视频',
      'document': '文档',
      'audio': '音频',
      'voice': '语音'
    };
    return typeNames[mediaType] || '媒体';
  }
    async handleAdminMediaReply(ctx: Context, mediaType: any) {
    if (!ctx.message || !('reply_to_message' in ctx.message) || !ctx.message.reply_to_message) {
      return;
    }
    try {
      // 获取被回复消息的ID
      const repliedMessageId = ctx.message.reply_to_message.message_id;
      const finalTargetUserId = this.getAdminReplyTargetUserId(ctx);
      if (!finalTargetUserId) {
        await ctx.reply('❌ 无法识别回复目标用户，请引用用户转发消息或“新的聊天请求”通知。');
        return;
      }
      // 获取媒体文件ID和说明文字
            let fileId;
      let caption = '';
      switch (mediaType) {
        case 'photo':
          if (ctx.message && 'photo' in ctx.message) {
            fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            caption = ctx.message.caption || '';
                    }
                    else
                        return;
          break;
        case 'video':
          if (ctx.message && 'video' in ctx.message) {
            fileId = ctx.message.video.file_id;
            caption = ctx.message.caption || '';
                    }
                    else
                        return;
          break;
        case 'document':
          if (ctx.message && 'document' in ctx.message) {
            fileId = ctx.message.document.file_id;
            caption = ctx.message.caption || '';
                    }
                    else
                        return;
          break;
        case 'audio':
          if (ctx.message && 'audio' in ctx.message) {
            fileId = ctx.message.audio.file_id;
            caption = ctx.message.caption || '';
                    }
                    else
                        return;
          break;
        case 'voice':
          if (ctx.message && 'voice' in ctx.message) {
            fileId = ctx.message.voice.file_id;
            caption = ctx.message.caption || '';
                    }
                    else
                        return;
          break;
        default:
          return;
      }
      // 保存管理员媒体消息到数据库
      await database.saveChatMessage(config.superAdminId, finalTargetUserId, caption || `[管理员回复${this.getMediaTypeName(mediaType)}]`);
      // 发送媒体消息给目标用户
      try {
        // 🚀 使用消息转发模式 (带有转发源)
        await ctx.forwardMessage(finalTargetUserId);
        
        await ctx.reply(`✅ ${this.getMediaTypeName(mediaType)}已发送给用户 ${finalTargetUserId}`);
        // 清理已使用的消息映射
        this.adminMessageToUserMap.delete(repliedMessageId);
      }
      catch (error) {
        await ctx.reply(`❌ 发送失败，用户 ${finalTargetUserId} 可能已停止机器人`);
      }
        }
        catch (error) {
      console.error('处理管理员媒体回复错误:', error);
      await ctx.reply('❌ 媒体回复处理失败，请稍后重试');
    }
  }
  // 键盘布局
    async getCoreFunctionKeyboard(userId: number) {
    const isAdmin = this.isAdmin(userId);
    const isRootAdmin = this.isRootAdmin(userId);
    if (isRootAdmin) {
      // 👑 超级管理员键盘 - 管理功能
      return Markup.keyboard([
                ['🖼️ 网页相册', BUTTONS.UPLOAD_DATA, BUTTONS.VIEW_DATA],
                [BUTTONS.PUBLISH_CONTENT, BUTTONS.CHANNEL_MANAGE],
        [BUTTONS.BROADCAST_MESSAGE, '🎛️ 账号控制', BUTTONS.CHAT_WITH_ADMIN],
      ]).resize();
        }
        else if (isAdmin) {
      // 👑 子管理员键盘 - 独立资料功能（不含全局管理）
      return Markup.keyboard([
                ['🖼️ 网页相册', BUTTONS.UPLOAD_DATA, BUTTONS.VIEW_DATA],
                [BUTTONS.PUBLISH_CONTENT, BUTTONS.CHAT_WITH_ADMIN],
      ]).resize();
        }
        else {
      // 👤 普通用户键盘
      return Markup.keyboard([
                ['🖼️ 网页相册', BUTTONS.VIEW_DATA],
                [BUTTONS.CHAT_WITH_ADMIN],
      ]).resize();
    }
  }
    getPermissionManageKeyboard() {
    return Markup.keyboard([
      [BUTTONS.GRANT_MONTHLY, BUTTONS.GRANT_QUARTERLY],
      [BUTTONS.VIEW_PERMISSIONS, BUTTONS.REVOKE_PERMISSION],
      [BUTTONS.BACK_TO_MAIN]
    ]).resize();
  }
    getUploadOptionsKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('📤 批量上传', 'batch_upload')],
      [Markup.button.callback('📷 单文件上传', 'single_upload')],
      [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
    ]);
  }
    getViewDataKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🔍 浏览关键词', 'browse_keywords')],
      [Markup.button.callback('❌ 删除关键词', 'delete_keyword')],
      [Markup.button.callback('🗑️ 清理数据', 'clean_data')],
      [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
    ]);
  }
    getChannelManageKeyboard() {
    return Markup.inlineKeyboard([
            [Markup.button.callback('➕ 添加频道', 'add_channel'), Markup.button.callback('➖ 删除频道', 'remove_channel')],
      [Markup.button.callback('📋 频道列表', 'channel_list')],
            [Markup.button.callback('📝 设置关注回复', 'set_join_welcome')],
      [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
    ]);
  }
    getUserManageKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('👥 用户列表', 'user_list')],
      [Markup.button.callback('🔑 权限管理', 'permission_manage')],
      [Markup.button.callback('📊 使用统计', 'usage_stats')],
      [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
    ]);
  }
    getApprovalKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('📝 频道申请', 'channel_approval')],
      [Markup.button.callback('👤 用户申请', 'user_approval')],
      [Markup.button.callback('📋 待审批列表', 'pending_approvals')],
      [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
    ]);
  }
    async getModeKeyboard(mode: BotMode | string) {
    const buttons = [];
    if (mode === 'publish') {
      // 发布模式显示频道选择 - 每个频道单独一行
            const managedChannels = await database.getManagedChannels();
            for (const channelId of managedChannels) {
        const channelName = await this.getChannelName(channelId);
        buttons.push([Markup.button.callback(channelName, `channel_${channelId}`)]);
      }
    }
    buttons.push([Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]);
    return Markup.inlineKeyboard(buttons);
  }
    async getChannelSelectionKeyboard(userId: number, selectedChannelIds: string[] = []) {
        // 子管理员有独立映射时只用映射；超管/默认：env CHANNEL_IDS ∪ 频道管理里动态添加的
        const managedChannels = hasAdminChannelMap(userId)
          ? getAdminChannelIds(userId)
          : await database.getManagedChannels();
        const selected = new Set(selectedChannelIds.map(String));
        const buttons = await Promise.all(
          managedChannels.map(async (channelId: string) => [
            Markup.button.callback(
              `${selected.has(String(channelId)) ? '✅ ' : '☐ '}${await this.getChannelFullName(channelId)}`,
              `publish_toggle_${channelId}`
            )
          ])
        );
        if (selected.size > 0) {
          buttons.push([Markup.button.callback(`✅ 确认 ${selected.size} 个目标`, 'publish_channels_confirm')]);
        }
        if (isAdminUser(userId)) buttons.push([Markup.button.callback('📋 定时任务', 'schedule_list')]);
        if (isAdminUser(userId)) buttons.push([Markup.button.callback('⭐ 推荐推送', 'recommend_menu')]);
        buttons.push([Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]);
        return Markup.inlineKeyboard(buttons);
  }
    getUploadConfirmKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback(BUTTONS.SAVE_ONLY, 'save_only')],
      [Markup.button.callback(BUTTONS.SAVE_AND_PUBLISH, 'save_and_publish')],
      [Markup.button.callback(BUTTONS.CANCEL, 'cancel')]
    ]);
  }
    getBackKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
    ]);
  }
    async getChannelName(channelId: string) {
    try {
      const chat = await this.bot.telegram.getChat(channelId);
      if ('title' in chat) {
        return chat.title;
            }
            else if ('first_name' in chat) {
        return chat.first_name + (chat.last_name ? ` ${chat.last_name}` : '');
      }
      return `📢 频道 ${channelId}`;
        }
        catch (error) {
      console.error(`获取频道名称失败 ${channelId}:`, error);
      return `📢 频道 ${channelId}`;
    }
  }
    async getChannelFullName(channelId: string) {
    try {
      const chat = await this.bot.telegram.getChat(channelId);
      if ('title' in chat) {
        return `${chat.title} - 功能正常`;
            }
            else if ('first_name' in chat) {
        const name = chat.first_name + (chat.last_name ? ` ${chat.last_name}` : '');
        return `${name} - 功能正常`;
      }
      return `📢 频道 ${channelId}`;
        }
        catch (error) {
      console.error(`获取频道完整名称失败 ${channelId}:`, error);
      return `📢 频道 ${channelId}`;
    }
  }
  // 缺失的内联按钮处理函数
    async handleViewStats(ctx: Context) {
    try {
      const mediaCount = await database.getMediaCount();
      const keywordCount = await database.getKeywordCount();
            await ctx.editMessageText(`📊 数据库统计信息\n\n` +
        `📄 媒体文件总数: ${mediaCount}\n` +
        `🔤 关键词总数: ${keywordCount}\n` +
                `📈 平均每关键词媒体数: ${keywordCount > 0 ? (mediaCount / keywordCount).toFixed(1) : 0}`, Markup.inlineKeyboard([
          [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
            ]));
        }
        catch (error) {
      console.error('查看统计错误:', error);
      await ctx.reply('❌ 获取统计信息失败');
    }
  }
    async handleBrowseKeywords(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;
    try {
      const hasPermission = await database.checkUserPermission(userId);
      const scopeUserId = this.getDataScopeUserId(userId, hasPermission);
      const keywords = await database.getAllKeywords(scopeUserId);
      if (keywords.length === 0) {
                await ctx.editMessageText('🔍 浏览关键词\n\n❌ 数据库中暂无关键词', Markup.inlineKeyboard([
            [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
                ]));
        return;
      }
      // 显示第一页关键词（每页10个）
      await this.showKeywordsPage(ctx, keywords, 0);
        }
        catch (error) {
      console.error('浏览关键词错误:', error);
            await ctx.editMessageText('❌ 获取关键词列表失败', Markup.inlineKeyboard([
          [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
            ]));
    }
  }
    async handleDeleteKeyword(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 会员制度已取消，删除功能对所有用户开放
        await ctx.editMessageText('❌ 删除关键词\n\n' +
      '⚠️ 警告：此操作将删除关键词及其所有相关媒体文件！\n\n' +
      '📝 请输入要删除的关键词名称：\n\n' +
      '💡 提示：\n' +
      '• 输入完整的关键词名称\n' +
      '• 此操作不可撤销\n' +
            '• 将删除该关键词的所有媒体资料', Markup.inlineKeyboard([
        [Markup.button.callback('❌ 取消', 'cancel')]
        ]));
    // 设置用户状态为删除关键词模式
        const session = {
      userId,
      mode: BotMode.Search, // 使用search模式避免冲突
            step: 'waiting_keyword' as const // 等待输入关键词
    };
    this.userSessions.set(userId, session);
    await database.saveUserSession(userId, session);
  }
    async handleCleanData(ctx: Context) {
        await ctx.editMessageText('🗑️ 清理数据功能\n\n该功能正在开发中...', Markup.inlineKeyboard([
        [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
        ]));
  }
    async handleAddChannel(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
            await ctx.editMessageText('❌ 权限不足\n\n只有超级管理员可以添加频道。', Markup.inlineKeyboard([
          [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
            ]));
      return;
    }
        await ctx.editMessageText('➕ 添加频道/群\n\n' +
      '📝 请发送聊天 ID（或 @用户名）：\n\n' +
      '📋 示例：\n' +
      '• `-1001234567890`（超级群/频道）\n' +
      '• `-5586936141`（普通群等）\n' +
      '• `@channelusername`\n\n' +
      '💡 提示：\n' +
      '• ID 可用 @userinfobot / @getidsbot 获取\n' +
      '• 机器人须已进群/频道且有发消息权限\n' +
            '• 系统会自动检测名称', Markup.inlineKeyboard([
        [Markup.button.callback('❌ 取消', 'cancel')]
        ]));
    // 设置用户状态为添加频道模式
        const session = {
      userId,
      mode: BotMode.Search, // 使用search模式避免冲突
            step: 'adding_channel' as const
    };
    this.userSessions.set(userId, session);
    await database.saveUserSession(userId, session);
  }
    async handleRemoveChannel(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
            await ctx.editMessageText('❌ 权限不足\n\n只有超级管理员可以删除频道。', Markup.inlineKeyboard([
          [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
            ]));
      return;
    }
        const managedChannels = await database.getManagedChannels();
        if (managedChannels.length === 0) {
            await ctx.editMessageText('❌ 没有可删除的频道\n\n当前没有配置任何频道。', Markup.inlineKeyboard([
          [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
            ]));
      return;
    }
    // 创建频道选择按钮
        const buttons = await Promise.all(managedChannels.map(async (channelId, index) => {
        const channelName = await this.getChannelFullName(channelId);
        return [Markup.button.callback(`🗑️ ${channelName}`, `remove_channel_${channelId}`)];
        }));
    buttons.push([Markup.button.callback('❌ 取消', 'cancel')]);
        await ctx.editMessageText('➖ 删除频道\n\n' +
      '⚠️ 请选择要删除的频道：\n\n' +
            '🚨 注意：删除频道将移除所有相关配置，此操作不可撤销！', Markup.inlineKeyboard(buttons));
  }
    async handleChannelList(ctx: Context) {
    let message = '📋 当前配置的频道列表:\n\n';
        const managedChannels = await database.getManagedChannels();
        for (let index = 0; index < managedChannels.length; index++) {
            const channelId = managedChannels[index];
      const channelName = await this.getChannelFullName(channelId);
      message += `${index + 1}. ${channelName}\n   ID: ${channelId}\n\n`;
    }
        await ctx.editMessageText(message, Markup.inlineKeyboard([
        [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
        ]));
  }
    async handleUserList(ctx: Context) {
        await ctx.editMessageText('👥 用户管理功能\n\n该功能正在开发中...', Markup.inlineKeyboard([
        [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
        ]));
  }
    async handleRemoveChannelConfirm(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      return;
    }
    const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
        if (!callbackData)
            return;
    const channelId = callbackData.replace('remove_channel_', '');
    const channelName = await this.getChannelFullName(channelId);
        await ctx.editMessageText(`🗑️ 确认删除频道\n\n` +
      `频道：${channelName}\n` +
      `ID：${channelId}\n\n` +
      `⚠️ 确认要删除此频道吗？\n` +
            `🚨 此操作不可撤销！`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ 确认删除', `confirm_remove_${channelId}`)],
        [Markup.button.callback('❌ 取消', 'remove_channel')]
        ]));
  }
    async handleConfirmRemoveChannel(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      return;
    }
    const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
        if (!callbackData)
            return;
    const channelId = callbackData.replace('confirm_remove_', '');
    const channelName = await this.getChannelFullName(channelId);
    try {
            // 从数据库中移除频道
            const removed = await database.removeManagedChannel(channelId);
            
            if (!removed) {
                await ctx.editMessageText(`❌ 无法删除频道\n\n` +
          `频道ID：${channelId}\n\n` +
                    `该频道属于初始配置文件 (env) 的硬性配置，无法在机器人内删除。`, Markup.inlineKeyboard([
            [Markup.button.callback('📋 查看频道列表', 'channel_list')],
            [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
                ]));
        return;
      }

            await ctx.editMessageText(`✅ 频道删除成功！\n\n` +
        `频道：${channelName}\n` +
        `ID：${channelId}\n\n` +
                `✅ 已从数据库中永久移除此频道`, Markup.inlineKeyboard([
          [Markup.button.callback('📋 查看频道列表', 'channel_list')],
          [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
            ]));
        }
        catch (error) {
      console.error('删除频道错误:', error);
      await ctx.reply('❌ 删除频道时发生错误');
    }
  }
    async handleUploadTextDescription(ctx: Context, text: any) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    const session = this.userSessions.get(userId);
    if (!session || (session.mode !== 'upload' && session.mode !== BotMode.AddReview) || session.step !== 'waiting_media') {
      return;
    }
    // 保存文本描述到session
    session.pendingText = text;
    this.userSessions.set(userId, session);
    await database.saveUserSession(userId, session);
    console.log(`📝 用户 ${userId} 添加文本描述: "${text}"`);
        await ctx.reply(`📝 已接收文本说明\n\n` +
      `说明内容: "${text}"\n\n` +
            `💡 可以继续上传媒体文件或选择目标频道`, {
        reply_markup: { 
          inline_keyboard: [
            [{ text: '📢 选择频道', callback_data: 'select_channel' }]
          ] 
        } 
        });
      }
    async handleDeleteKeywordInput(ctx: Context, text: any) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 检查权限：管理员或有权限的用户可以删除
    const isAdmin = this.isAdmin(userId);
    const isRootAdmin = this.isRootAdmin(userId);
    const hasPermission = await database.checkUserPermission(userId);
    if (!isAdmin && !hasPermission) {
      await ctx.reply('❌ 您没有删除关键词的权限');
      return;
    }
    try {
      const keyword = text.trim();
      if (!keyword) {
                await ctx.reply('❌ 关键词不能为空\n\n' +
                    '请输入要删除的关键词名称');
        return;
      }
      console.log(`🗑️ 尝试删除关键词: "${keyword}", 用户: ${userId}, 管理员: ${isAdmin}`);
      // 检查关键词是否存在（仅超级管理员可跨用户删除，其他管理员仅限自己的数据）
      const exists = await database.keywordExists(keyword, isRootAdmin ? undefined : userId);
      console.log(`🔍 关键词存在检查: ${exists}`);
      if (!exists) {
                await ctx.reply(`❌ 关键词不存在\n\n` +
          `关键词 "${keyword}" 在数据库中不存在。\n\n` +
                    `💡 请检查关键词拼写是否正确`, await this.getCoreFunctionKeyboard(userId));
        // 清理会话
        this.userSessions.delete(userId);
        await database.clearUserSession(userId);
        return;
      }
      // 获取该关键词的媒体数量（限制在用户自己的数据范围内）
      const mediaItems = await database.getMediaByKeyword(keyword, isRootAdmin ? undefined : userId);
      const mediaCount = mediaItems.length;
      console.log(`📊 找到 ${mediaCount} 个媒体文件`);
      // 执行删除操作（限制在用户自己的数据范围内）
      const deletedCount = await database.deleteKeyword(keyword, isRootAdmin ? undefined : userId);
      console.log(`🗑️ 删除了 ${deletedCount} 个媒体文件`);
      if (deletedCount > 0) {
                await ctx.reply(`✅ 关键词删除成功！\n\n` +
          `关键词：${keyword}\n` +
          `删除的媒体文件：${deletedCount} 个\n\n` +
                    `⚠️ 此操作已完成且不可撤销`, await this.getCoreFunctionKeyboard(userId));
            }
            else {
                await ctx.reply(`❌ 删除失败\n\n` +
          `关键词：${keyword}\n` +
                    `未删除任何文件，请稍后重试`, await this.getCoreFunctionKeyboard(userId));
      }
      // 清理会话
      this.userSessions.delete(userId);
      await database.clearUserSession(userId);
        }
        catch (error) {
      console.error('删除关键词错误:', error);
      await ctx.reply('❌ 删除关键词时发生错误', await this.getCoreFunctionKeyboard(userId));
      // 清理会话
      this.userSessions.delete(userId);
      await database.clearUserSession(userId);
    }
  }
    async handleAddChannelInput(ctx: Context, text: any) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      return;
    }
    try {
      let channelId = String(text || '').trim().replace(/^[`'"]+|[`'"]+$/g, '');
      if (!channelId) {
                await ctx.reply('❌ ID 不能为空\n\n' +
                    '示例：`-1001234567890` 或 `-5586936141` 或 `@channel`');
        return;
      }
      // 兼容：不再强制 -100；支持负数群/频道 ID、以及 @username
      const isUsername = /^@[A-Za-z0-9_]{4,}$/.test(channelId);
      const isNumericId = /^-?\d+$/.test(channelId) && Number.isSafeInteger(Number(channelId)) && Number(channelId) !== 0;
      if (!isUsername && !isNumericId) {
                await ctx.reply('❌ 聊天 ID 格式错误\n\n' +
          '支持：\n' +
          '• 数字 ID（可带负号）：`-1001234567890`、`-5586936141`\n' +
          '• 用户名：`@channelname`\n\n' +
                    '请用 @userinfobot 核对后再发。');
        return;
      }
      // 检查是否已存在
            const managedChannels = await database.getManagedChannels();
            if (managedChannels.includes(channelId)) {
                await ctx.reply('❌ 已存在\n\n' +
                    `ID ${channelId} 已在列表中。`);
        return;
      }
      // 测试机器人是否有权限访问并获取名称
      try {
        const chat = await this.bot.telegram.getChat(channelId);
        let channelName = `聊天 ${channelId}`;
        if ('title' in chat) {
          channelName = chat.title;
                }
                else if ('first_name' in chat) {
          channelName = chat.first_name + (chat.last_name ? ` ${chat.last_name}` : '');
        }
        // 若用 @username 添加，尽量存成稳定数字 ID
        const persistId = chat.id != null ? String(chat.id) : channelId;
                await database.addManagedChannel(persistId);
                await ctx.reply(`✅ 添加成功！\n\n` +
          `保存 ID：${persistId}\n` +
          (persistId !== channelId ? `输入：${channelId}\n` : '') +
          `名称：${channelName}\n\n` +
                    `✅ 已写入数据库，发布模式可选`, await this.getCoreFunctionKeyboard(userId));
            }
            catch (error) {
                await ctx.reply(`❌ 无法访问该聊天\n\n` +
          `ID：${channelId}\n` +
          `错误：机器人无法访问\n\n` +
          `💡 请确保：\n` +
          `1. 机器人已加入该群/频道\n` +
          `2. 有发消息/管理权限\n` +
                    `3. ID 正确`, await this.getCoreFunctionKeyboard(userId));
      }
      // 清理会话
      this.userSessions.delete(userId);
      await database.clearUserSession(userId);
        }
        catch (error) {
      console.error('添加频道错误:', error);
      await ctx.reply('❌ 添加时发生错误', await this.getCoreFunctionKeyboard(userId));
      // 清理会话
      this.userSessions.delete(userId);
      await database.clearUserSession(userId);
    }
  }
    async showKeywordsPage(ctx: Context, keywords: string[], page: number) {
        const itemsPerPage = 60;
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const pageKeywords = keywords.slice(startIndex, endIndex);
    const totalPages = Math.ceil(keywords.length / itemsPerPage);
    // 创建关键词按钮
    const keywordButtons = [];
        for (let i = 0; i < pageKeywords.length; i += 3) {
      const row = [];
      if (pageKeywords[i]) {
                row.push(Markup.button.callback(`📁 ${pageKeywords[i].substring(0, 12)}${pageKeywords[i].length > 12 ? '..' : ''}`, `keyword_${pageKeywords[i]}`));
      }
      if (pageKeywords[i + 1]) {
                row.push(Markup.button.callback(`📁 ${pageKeywords[i + 1].substring(0, 12)}${pageKeywords[i + 1].length > 12 ? '..' : ''}`, `keyword_${pageKeywords[i + 1]}`));
            }
            if (pageKeywords[i + 2]) {
                row.push(Markup.button.callback(`📁 ${pageKeywords[i + 2].substring(0, 12)}${pageKeywords[i + 2].length > 12 ? '..' : ''}`, `keyword_${pageKeywords[i + 2]}`));
      }
      keywordButtons.push(row);
    }
    // 添加分页按钮
    const navigationButtons = [];
    if (totalPages > 1) {
      const navRow = [];
      if (page > 0) {
        navRow.push(Markup.button.callback('⬅️ 上一页', `keywords_page_${page - 1}`));
      }
      if (page < totalPages - 1) {
        navRow.push(Markup.button.callback('下一页 ➡️', `keywords_page_${page + 1}`));
      }
      if (navRow.length > 0) {
        navigationButtons.push(navRow);
      }
    }
    // 添加功能按钮
    navigationButtons.push([
      Markup.button.callback('💎 好评库', 'start_review'),
      Markup.button.callback('🏷️ 标签筛选', 'start_tag_filter')
    ]);
    // 添加返回按钮
    if (ctx.from?.id && this.isAdmin(ctx.from.id)) {
      navigationButtons.push([Markup.button.callback('🛡️ 水印管理', 'watermark_menu')]);
    }
    navigationButtons.push([Markup.button.callback('🕘 最近搜索', 'recent_searches')]);
    navigationButtons.push([Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]);
    const allButtons = [...keywordButtons, ...navigationButtons];
        const text = `🔍 关键词列表 (第 ${page + 1}/${totalPages} 页)\n\n` +
      `📊 共 ${keywords.length} 个关键词\n\n` +
      `💡 点击关键词查看其媒体库`;
    // 如果是回调查询，则编辑原消息；否则发送新消息，避免 edit 错误
    const isCallback = !!(ctx.callbackQuery && 'data' in ctx.callbackQuery);
    if (isCallback) {
      await ctx.editMessageText(text, Markup.inlineKeyboard(allButtons));
        }
        else {
      await ctx.reply(text, Markup.inlineKeyboard(allButtons));
    }
  }
    async handleKeywordClick(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
        if (!callbackData)
            return;
    const keyword = callbackData.replace('keyword_', '');
    
    try {
            // 回答回调查询
            await ctx.answerCbQuery();
            
            // 直接调用搜索功能，发送完整资料
            await SearchHandler.handleSearch(ctx, keyword, database);
            
        } catch (error: any) {
            const userId = ctx.from?.id;
            const userName = ctx.from?.first_name || '未知用户';
            const username = ctx.from?.username || '';
            const userDisplay = username ? `${userName} (@${username})` : userName;
            console.error(`❌ [搜索错误] ${userDisplay} (ID: ${userId}) 点击关键词: "${keyword}" | 错误:`, error?.message || error);
            // 尝试编辑消息，如果失败则发送新消息
            try {
                await ctx.editMessageText('❌ 搜索关键词时发生错误', Markup.inlineKeyboard([
          [Markup.button.callback('🔙 返回关键词列表', 'browse_keywords')]
                ]));
            } catch (e) {
                await ctx.reply('❌ 搜索关键词时发生错误', Markup.inlineKeyboard([
          [Markup.button.callback('🔙 返回关键词列表', 'browse_keywords')]
                ]));
    }
  }
    }
    async handleSearchKeyword(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
        if (!callbackData)
            return;
    const keyword = callbackData.replace('search_', '');
    try {
      // 直接调用搜索功能
      await SearchHandler.handleSearch(ctx, keyword, database);
        }
        catch (error: any) {
            const userName = ctx.from?.first_name || '未知用户';
            const username = ctx.from?.username || '';
            const userDisplay = username ? `${userName} (@${username})` : userName;
            console.error(`❌ [搜索错误] ${userDisplay} (ID: ${userId}) 搜索关键词: "${keyword}" | 错误:`, error?.message || error);
            await ctx.editMessageText('❌ 搜索关键词时发生错误', Markup.inlineKeyboard([
          [Markup.button.callback('🔙 返回关键词列表', 'browse_keywords')]
            ]));
    }
  }
    async handleKeywordsPage(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
        if (!callbackData)
            return;
    const pageMatch = callbackData.match(/^keywords_page_(\d+)$/);
        if (!pageMatch)
            return;
    const pageNumber = parseInt(pageMatch[1]);
    try {
      const hasPermission = await database.checkUserPermission(userId);
      const scopeUserId = this.getDataScopeUserId(userId, hasPermission);
      const keywords = await database.getAllKeywords(scopeUserId);
      await this.showKeywordsPage(ctx, keywords, pageNumber);
        }
        catch (error) {
      console.error('分页显示关键词错误:', error);
            await ctx.editMessageText('❌ 获取关键词列表时发生错误', Markup.inlineKeyboard([
          [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
            ]));
    }
  }
    async handleStartSearch(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 直接调用搜索功能
    await this.handleSearchData(ctx);
  }
    async handleStartUpload(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 直接调用上传功能
    await this.handleUploadData(ctx);
  }
    async handleStartPublish(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 直接调用发布功能
    await this.handlePublishContent(ctx);
  }
    async handleStartKeywords(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 直接调用查看资料功能（已包含关键词查看）
    await this.handleViewData(ctx);
  }
    async handleStartHelp(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 直接调用帮助功能
    await this.handleHelp(ctx);
  }
    async handleStartContact(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 直接调用联系管理员功能
    await this.handleChatWithAdmin(ctx);
  }
    async handleStartButtonMaker(ctx: Context) {
        const userId = ctx.from?.id;
        if (!userId)
            return;
        // 直接调用按钮制作功能
        await this.handleButtonMaker(ctx);
    }
    async handleStartChannelManage(ctx: Context) {
        const userId = ctx.from?.id;
        if (!userId || userId !== config.superAdminId)
            return;
        // 直接调用频道管理功能
        await this.handleChannelManage(ctx);
    }
    async handleStartBroadcast(ctx: Context) {
        const userId = ctx.from?.id;
        if (!userId || userId !== config.superAdminId)
            return;
        // 直接调用群发消息功能
        await this.handleBroadcastMessage(ctx);
    }
    async handleStartAccountControl(ctx: Context) {
        const userId = ctx.from?.id;
        if (!userId || userId !== config.superAdminId)
            return;
        // 调用账号控制功能 - 需要找到对应的处理函数
        await ctx.reply('🎛️ 账号控制功能\n\n请使用键盘按钮 "🎛️ 账号控制" 或发送命令来访问此功能。');
    }
  // 权限管理相关方法
    async handleBroadcastMessage(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      await ctx.reply('❌ 只有超级管理员可以使用群发功能');
      return;
    }
    // 获取用户统计信息
    const userCount = await database.getUserCount();
        await ctx.reply(`📢 群发消息功能\n\n` +
      `📊 当前活跃用户数: ${userCount}\n\n` +
      `💡 请发送要群发的消息内容\n` +
      `📝 支持文字、图片、视频、文档等所有类型\n\n` +
      `⚠️ 发送后需要确认才会群发`, Markup.inlineKeyboard([
        [Markup.button.callback('📊 查看用户列表', 'broadcast_users')],
            [Markup.button.callback('📤 定向发送资料', 'start_direct_send')],
            [Markup.button.callback('📦 群发资料库', 'start_broadcast_data')],
            [Markup.button.callback('📋 查看日志', 'view_logs')],
        [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
        ]));
    // 设置用户会话为群发模式
    await database.saveUserSession(userId, {
      userId,
      mode: BotMode.Broadcast,
      step: 'waiting_message'
    });
  }
  // 群发确认处理
    async handleBroadcastConfirmation(ctx: Context, type: string, content: any) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 存储群发内容
    this.broadcastContent = { type, content };
    let previewText = '';
    if (type === 'text') {
      previewText = content;
        }
        else if (type === 'photo') {
      previewText = `📷 图片${content.caption ? ': ' + content.caption : ''}`;
        }
        else if (type === 'video') {
      previewText = `🎥 视频${content.caption ? ': ' + content.caption : ''}`;
        }
        else if (type === 'document') {
      previewText = `📄 文档${content.caption ? ': ' + content.caption : ''}`;
    }
        await ctx.reply(`📢 群发确认\n\n` +
      `📝 消息内容预览:\n${previewText}\n\n` +
            `⚠️ 确认要群发给所有用户吗？`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ 确认群发', 'confirm_broadcast')],
        [Markup.button.callback('❌ 取消群发', 'cancel_broadcast')]
        ]));
  }
  // 确认群发
    async handleConfirmBroadcast(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || !this.broadcastContent) {
      await ctx.reply('❌ 群发内容不存在');
      return;
    }
    try {
      const users = await database.getAllActiveUsers();
      if (users.length === 0) {
        await ctx.reply('❌ 没有活跃用户');
        return;
      }
      let successCount = 0;
      let failCount = 0;
      for (const user of users) {
        try {
          if (this.broadcastContent.type === 'text') {
            await this.bot.telegram.sendMessage(user.id, this.broadcastContent.content);
                    }
                    else if (this.broadcastContent.type === 'photo') {
            await this.bot.telegram.sendPhoto(user.id, this.broadcastContent.content.file_id, { 
              caption: this.broadcastContent.content.caption 
            });
                    }
                    else if (this.broadcastContent.type === 'video') {
            await this.bot.telegram.sendVideo(user.id, this.broadcastContent.content.file_id, { 
              caption: this.broadcastContent.content.caption 
            });
                    }
                    else if (this.broadcastContent.type === 'document') {
            await this.bot.telegram.sendDocument(user.id, this.broadcastContent.content.file_id, { 
              caption: this.broadcastContent.content.caption 
            });
          }
          successCount++;
          await new Promise(resolve => setTimeout(resolve, 100)); // 避免频率限制
                }
                catch (error) {
          failCount++;
          console.error(`群发失败 - 用户 ${user.id}:`, error);
        }
      }
      // 向超管报告群发结果
            await ctx.reply(`📢 群发完成\n\n` +
        `✅ 成功: ${successCount} 人\n` +
        `❌ 失败: ${failCount} 人\n` +
                `📊 总计: ${users.length} 人`, Markup.inlineKeyboard([
          [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
            ]));
      // 清除群发内容和会话
      this.broadcastContent = null;
      await database.clearUserSession(userId);
        }
        catch (error) {
      console.error('群发错误:', error);
      await ctx.reply('❌ 群发失败');
    }
  }
  // 取消群发
    async handleCancelBroadcast(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    // 清除群发内容和会话
    this.broadcastContent = null;
    await database.clearUserSession(userId);
        await ctx.reply('❌ 群发已取消', Markup.inlineKeyboard([
        [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
        ]));
  }
  // 自动群发功能
    async autoBroadcastMessage(ctx: Context, type: string, content: any) {
    try {
      const users = await database.getAllActiveUsers();
            if (users.length === 0)
                return;
      let successCount = 0;
      let failCount = 0;
      for (const user of users) {
        try {
          if (type === 'text') {
            await this.bot.telegram.sendMessage(user.id, content);
                    }
                    else if (type === 'photo') {
            await this.bot.telegram.sendPhoto(user.id, content.file_id, { caption: content.caption });
                    }
                    else if (type === 'video') {
            await this.bot.telegram.sendVideo(user.id, content.file_id, { caption: content.caption });
                    }
                    else if (type === 'document') {
            await this.bot.telegram.sendDocument(user.id, content.file_id, { caption: content.caption });
          }
          successCount++;
          await new Promise(resolve => setTimeout(resolve, 100)); // 避免频率限制
                }
                catch (error) {
          failCount++;
          console.error(`群发失败 - 用户 ${user.id}:`, error);
        }
      }
      // 向超管报告群发结果
            await ctx.reply(`📢 群发完成\n\n` +
        `✅ 成功: ${successCount} 人\n` +
        `❌ 失败: ${failCount} 人\n` +
                `📊 总计: ${users.length} 人`);
        }
        catch (error) {
      console.error('自动群发错误:', error);
    }
  }
  // 群发功能相关方法
    async handleBroadcastText(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId || userId !== config.superAdminId)
            return;
    // 设置群发模式
    const session: UserSession = {
      userId,
      mode: BotMode.Broadcast,
            step: 'waiting_text' as UserSession['step']
    };
    this.userSessions.set(userId, session);
    await database.saveUserSession(userId, session);
        await ctx.editMessageText('📝 群发文字消息\n\n' +
      '请输入要群发的文字内容：\n\n' +
            '💡 支持Markdown格式', Markup.inlineKeyboard([
        [Markup.button.callback('❌ 取消群发', 'cancel_broadcast')]
        ]));
  }
    async handleBroadcastPhoto(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId || userId !== config.superAdminId)
            return;
    const session: UserSession = {
      userId,
      mode: BotMode.Broadcast,
            step: 'waiting_photo' as UserSession['step']
    };
    this.userSessions.set(userId, session);
    await database.saveUserSession(userId, session);
        await ctx.editMessageText('📷 群发图片消息\n\n' +
      '请发送要群发的图片：\n\n' +
            '💡 可以添加图片说明文字', Markup.inlineKeyboard([
        [Markup.button.callback('❌ 取消群发', 'cancel_broadcast')]
        ]));
  }
    async handleBroadcastVideo(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId || userId !== config.superAdminId)
            return;
    const session: UserSession = {
      userId,
      mode: BotMode.Broadcast,
            step: 'waiting_video' as UserSession['step']
    };
    this.userSessions.set(userId, session);
    await database.saveUserSession(userId, session);
        await ctx.editMessageText('🎥 群发视频消息\n\n' +
      '请发送要群发的视频：\n\n' +
            '💡 可以添加视频说明文字', Markup.inlineKeyboard([
        [Markup.button.callback('❌ 取消群发', 'cancel_broadcast')]
        ]));
  }
    async handleBroadcastDocument(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId || userId !== config.superAdminId)
            return;
    const session: UserSession = {
      userId,
      mode: BotMode.Broadcast,
            step: 'waiting_document' as UserSession['step']
    };
    this.userSessions.set(userId, session);
    await database.saveUserSession(userId, session);
        await ctx.editMessageText('📄 群发文档消息\n\n' +
            '请发送要群发的文档：\n\n' +
            '💡 可以添加文档说明文字', Markup.inlineKeyboard([
            [Markup.button.callback('❌ 取消群发', 'cancel_broadcast')]
        ]));
    }
    // 群发用户列表回调（第1页）
    async handleBroadcastUsersCallback(ctx: Context) {
        await this.handleBroadcastUsers(ctx, 1);
    }
    
    // 查看日志功能
    async handleViewLogs(ctx: Context) {
        const userId = ctx.from?.id;
        if (!userId || userId !== config.superAdminId) {
            await ctx.answerCbQuery('❌ 只有管理员可以查看日志');
            return;
        }

        await ctx.answerCbQuery();
        await ctx.editMessageText('📋 正在收集最近7天的日志...');

        try {
            const fs = require('fs');
            const path = require('path');
            const { execSync } = require('child_process');

            // 获取当前时间和7天前的时间
            const now = new Date();
            const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            
            let logContent = '';
            let logFiles: string[] = [];

            // 方法1：尝试读取PM2日志
            try {
                const pm2LogsPath = path.join(require('os').homedir(), '.pm2', 'logs');
                if (fs.existsSync(pm2LogsPath)) {
                    const files = fs.readdirSync(pm2LogsPath);
                    
                    // 查找telegram相关的日志文件
                    const relevantLogs = files.filter((f: string) => 
                        f.includes('telegram') || f.includes('bot') || f.includes('out') || f.includes('error')
                    );
                    
                    for (const file of relevantLogs) {
                        const filePath = path.join(pm2LogsPath, file);
                        const stats = fs.statSync(filePath);
                        
                        // 只读取最近7天的文件
                        if (stats.mtime >= sevenDaysAgo) {
                            logFiles.push(filePath);
                        }
                    }
                }
            } catch (e) {
                console.log('PM2日志读取失败:', e);
            }

            // 方法2：尝试读取Docker日志（如果在Docker中运行）
            // 注意：在容器内无法直接执行 docker logs，需要从宿主机读取
            // 尝试多个可能的容器名称
            const containerNames = ['pindaobot', 'telegram-bot', 'deploy-telegram-bot'];
            let dockerLogFound = false;
            for (const containerName of containerNames) {
                try {
                    // 检查是否有 docker 命令可用
                    execSync('which docker', { encoding: 'utf8', stdio: 'ignore' });
                    
                    const dockerLogs = execSync(`docker logs ${containerName} --tail 1000 2>&1`, {
                        encoding: 'utf8',
                        timeout: 10000,
                        maxBuffer: 10 * 1024 * 1024 // 10MB buffer
                    });
                    if (dockerLogs && dockerLogs.trim().length > 0) {
                        logContent += `=== Docker日志 (${containerName}) ===\n${dockerLogs}\n\n`;
                        dockerLogFound = true;
                        break; // 找到日志后退出循环
                    }
                } catch (e: any) {
                    // 继续尝试下一个容器名称
                    continue;
                }
            }
            
            // 方法2.5：如果无法通过docker命令读取，尝试读取Docker日志文件（如果挂载了）
            if (!dockerLogFound) {
                try {
                    // Docker日志通常在这个路径，但容器内可能无法访问
                    const dockerLogPath = '/var/lib/docker/containers';
                    if (fs.existsSync(dockerLogPath)) {
                        const containers = fs.readdirSync(dockerLogPath);
                        for (const containerId of containers) {
                            const logFile = path.join(dockerLogPath, containerId, `${containerId}-json.log`);
                            if (fs.existsSync(logFile)) {
                                const stats = fs.statSync(logFile);
                                if (stats.mtime >= sevenDaysAgo) {
                                    try {
                                        const content = fs.readFileSync(logFile, 'utf8');
                                        // Docker JSON日志格式，需要解析
                                        const lines = content.split('\n').filter((l: string) => l.trim()).slice(-500);
                                        const parsedLines = lines.map((line: string) => {
                                            try {
                                                const log: any = JSON.parse(line);
                                                return `[${log.time || ''}] ${log.log || line}`;
                                            } catch {
                                                return line;
                                            }
                                        }).join('\n');
                                        logContent += `=== Docker容器日志 ===\n${parsedLines}\n\n`;
                                        dockerLogFound = true;
                                        break;
                                    } catch (e) {
                                        // 继续尝试
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    // 忽略错误
                }
            }

            // 方法3：如果找到了PM2日志文件，读取它们
            if (logFiles.length > 0) {
                logContent += '=== PM2日志文件 ===\n\n';
                
                for (const logFile of logFiles.slice(0, 5)) { // 最多读取5个文件
                    try {
                        const content = fs.readFileSync(logFile, 'utf8');
                        // 只读取最后1000行
                        const lines = content.split('\n').slice(-1000).join('\n');
                        logContent += `--- ${path.basename(logFile)} ---\n${lines}\n\n`;
                    } catch (e) {
                        console.error(`读取日志文件失败: ${logFile}`, e);
                    }
                }
            }

            // 方法3：尝试读取应用日志文件（如果存在）
            if (!logContent || logContent.trim().length === 0) {
                try {
                    // 检查多个可能的日志文件位置
                    const possibleLogPaths = [
                        path.join(process.cwd(), 'data', 'bot.log'),
                        path.join(process.cwd(), 'logs', 'bot.log'),
                        path.join(process.cwd(), 'bot.log'),
                        '/app/data/bot.log',
                        '/app/logs/bot.log'
                    ];
                    
                    for (const logPath of possibleLogPaths) {
                        if (fs.existsSync(logPath)) {
                            const stats = fs.statSync(logPath);
                            if (stats.mtime >= sevenDaysAgo) {
                                const content = fs.readFileSync(logPath, 'utf8');
                                const lines = content.split('\n').slice(-1000).join('\n');
                                if (lines.trim().length > 0) {
                                    logContent += `=== 应用日志文件 (${logPath}) ===\n${lines}\n\n`;
                                    break;
                                }
                            }
                        }
                    }
                } catch (e) {
                    // 忽略错误
                }
            }
            
            // 方法4：如果还是没有日志，提供当前运行信息
            if (!logContent || logContent.trim().length === 0) {
                logContent = '📊 机器人当前状态报告\n\n';
                logContent += `📅 当前时间: ${now.toLocaleString('zh-CN')}\n`;
                logContent += `🕐 启动时间: ${new Date(Date.now() - process.uptime() * 1000).toLocaleString('zh-CN')}\n`;
                logContent += `⏱️ 运行时长: ${Math.floor(process.uptime() / 60)} 分钟\n`;
                logContent += `📈 内存占用: ${Math.floor(process.memoryUsage().heapUsed / 1024 / 1024)} MB\n`;
                logContent += `📁 工作目录: ${process.cwd()}\n`;
                logContent += `🤖 机器人 ID: ${this.bot.botInfo?.id || '未知'}\n`;
                logContent += `👤 容器名称: ${process.env.HOSTNAME || '未知'}\n\n`;
                
                logContent += '💡 提示：在容器内部无法直接访问外部日志。\n';
                logContent += '请在服务器终端执行以下命令查看实时完整日志：\n\n';
                logContent += 'docker logs pindaobot --tail 500\n';
            }
            
            // 如果没有找到任何日志
            if (!logContent || logContent.trim().length === 0) {
                logContent = '📋 未找到日志文件\n\n';
                logContent += '💡 提示：\n';
                logContent += '• 如果使用PM2运行，日志在 ~/.pm2/logs/\n';
                logContent += '• 如果使用Docker运行，请在宿主机执行: docker logs pindaobot\n';
                logContent += '• 可以查看控制台输出获取实时日志\n\n';
                logContent += '当前运行信息：\n';
                logContent += `• Node版本: ${process.version}\n`;
                logContent += `• 运行时间: ${Math.floor(process.uptime() / 60)} 分钟\n`;
                logContent += `• 内存使用: ${Math.floor(process.memoryUsage().heapUsed / 1024 / 1024)} MB\n`;
                logContent += `• 工作目录: ${process.cwd()}\n`;
                logContent += `• 容器名称: ${process.env.HOSTNAME || '未知'}\n`;
            }

            // 创建临时日志文件
            const tempLogPath = path.join(process.cwd(), 'data', 'temp_logs.txt');
            
            // 确保data目录存在
            const dataDir = path.join(process.cwd(), 'data');
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            
            // 写入日志内容
            fs.writeFileSync(tempLogPath, logContent, 'utf8');

            // 发送日志文件
            await this.bot.telegram.sendDocument(
                userId,
                { source: tempLogPath, filename: `bot_logs_${now.toISOString().split('T')[0]}.txt` },
                { 
                    caption: `📋 机器人日志 (最近7天)\n\n` +
                             `📅 生成时间: ${now.toLocaleString('zh-CN')}\n` +
                             `📊 日志文件数: ${logFiles.length}\n` +
                             `📝 总大小: ${Math.floor(logContent.length / 1024)} KB`
                }
            );

            // 删除临时文件
            try {
                fs.unlinkSync(tempLogPath);
            } catch (e) {
                console.log('删除临时日志文件失败:', e);
            }

            await ctx.reply(
                '✅ 日志已发送\n\n💡 可以继续使用群发功能',
                Markup.inlineKeyboard([
                    [Markup.button.callback('📢 继续群发', 'broadcast_menu')],
                    [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
                ])
            );

        } catch (error: any) {
            console.error('查看日志错误:', error);
            // 尝试编辑消息，如果失败则发送新消息
            try {
    await ctx.editMessageText(
                    `❌ 获取日志失败\n\n错误信息: ${error?.message || '未知错误'}\n\n💡 请检查日志文件权限和路径`,
      Markup.inlineKeyboard([
                        [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
                    ])
                );
            } catch (e) {
                await ctx.reply(
                    `❌ 获取日志失败\n\n错误信息: ${error?.message || '未知错误'}\n\n💡 请检查日志文件权限和路径`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback(BUTTONS.BACK_TO_MAIN, 'back_to_main')]
      ])
    );
  }
        }
  }

  // 用户列表分页处理
    async handleUsersPage(ctx: Context) {
        const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
        if (!callbackData || typeof callbackData !== 'string') return;
    const page = parseInt(callbackData.replace('users_page_', ''));
    await ctx.answerCbQuery();
    await this.handleBroadcastUsers(ctx, page);
  }
  // 空操作处理（用于显示页码）
    async handleNoop(ctx: Context) {
    await ctx.answerCbQuery();
  }
    async handleBroadcastUsers(ctx: Context, page = 1) {
    const userId = ctx.from?.id;
        if (!userId || userId !== config.superAdminId)
            return;
    try {
      const users = await database.getAllActiveUsers();
      const userCount = users.length;
      // 分页设置
      const PAGE_SIZE = 15;
      const totalPages = Math.ceil(userCount / PAGE_SIZE);
      const currentPage = Math.max(1, Math.min(page, totalPages));
      const startIdx = (currentPage - 1) * PAGE_SIZE;
      const endIdx = Math.min(startIdx + PAGE_SIZE, userCount);
      let message = `📊 用户列表详情\n\n`;
      message += `👥 总用户数: ${userCount} 个\n`;
      message += `📄 当前页: ${currentPage}/${totalPages}\n`;
      message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      // 显示当前页的用户
      const displayUsers = users.slice(startIdx, endIdx);
      displayUsers.forEach((user, index) => {
        const globalIndex = startIdx + index + 1;
        // 用户名（@username）
        const username = user.username ? `@${user.username}` : '无用户名';
        // 姓名（first_name + last_name）
        let fullName = '';
        if (user.first_name || user.last_name) {
          fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
                }
                else {
          fullName = '未设置';
        }
        message += `${globalIndex}. 👤 ${fullName}\n`;
        message += `   📱 用户名: ${username}\n`;
        message += `   🆔 ID: ${user.id}\n`;
        // 最后活跃时间（如果有）
        if (user.last_active) {
          const lastActive = new Date(user.last_active);
          message += `   🕐 最后活跃: ${lastActive.toLocaleString('zh-CN')}\n`;
        }
        message += `\n`;
      });
      // 创建分页按钮
            const buttons = [];
      // 分页导航
      if (totalPages > 1) {
                const pageButtons = [];
        if (currentPage > 1) {
          pageButtons.push(Markup.button.callback('⬅️ 上一页', `users_page_${currentPage - 1}`));
        }
        pageButtons.push(Markup.button.callback(`📄 ${currentPage}/${totalPages}`, 'noop'));
        if (currentPage < totalPages) {
          pageButtons.push(Markup.button.callback('➡️ 下一页', `users_page_${currentPage + 1}`));
        }
        buttons.push(pageButtons);
      }
      // 返回按钮
      buttons.push([Markup.button.callback('🔙 返回群发菜单', 'broadcast_menu')]);
            await ctx.editMessageText(message, Markup.inlineKeyboard(buttons));
        }
        catch (error) {
      console.error('获取用户列表错误:', error);
            await ctx.editMessageText('❌ 获取用户列表时发生错误', Markup.inlineKeyboard([
          [Markup.button.callback('🔙 返回群发菜单', 'broadcast_menu')]
            ]));
    }
  }
    async handlePermissionManage(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      await ctx.reply('❌ 只有超级管理员可以管理用户权限');
      return;
    }
        await ctx.reply('🔐 权限管理\n\n' +
            '请选择操作：', this.getPermissionManageKeyboard());
  }
    async handleGrantMonthly(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      await ctx.reply('❌ 权限不足');
      return;
    }
    await ctx.reply('📅 授权1个月使用权限\n\n请发送用户ID或用户名：');
    // 设置会话状态
    const session: UserSession = {
      userId,
      mode: BotMode.Upload, // 临时使用upload模式
            step: 'waiting_keyword' as UserSession['step'],
            currentKeyword: 'grant_monthly' // 标记操作类型
    };
    this.userSessions.set(userId, session);
  }
    async handleGrantQuarterly(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      await ctx.reply('❌ 权限不足');
      return;
    }
    await ctx.reply('📅 授权3个月使用权限\n\n请发送用户ID或用户名：');
    // 设置会话状态
    const session: UserSession = {
      userId,
      mode: BotMode.Upload, // 临时使用upload模式
            step: 'waiting_keyword' as UserSession['step'],
            currentKeyword: 'grant_quarterly' // 标记操作类型
    };
    this.userSessions.set(userId, session);
  }
    async handleViewPermissions(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      await ctx.reply('❌ 权限不足');
      return;
    }
    try {
      const permissions = await database.getAllUserPermissions();
      if (permissions.length === 0) {
        await ctx.reply('📋 暂无用户权限记录', this.getPermissionManageKeyboard());
        return;
      }
      let message = '📋 所有用户权限：\n\n';
      for (const permission of permissions.slice(0, 20)) { // 限制显示前20个
        const status = '🟢';
        const expiry = '永久';
        message += `${status} 用户 ${permission.user_id}\n`;
        message += `ID: ${permission.user_id}\n`;
        message += `权限: ${permission.type}\n`;
        message += `到期: ${expiry}\n\n`;
      }
      if (permissions.length > 20) {
        message += `... 还有 ${permissions.length - 20} 个用户`;
      }
      await ctx.reply(message, this.getPermissionManageKeyboard());
        }
        catch (error) {
      console.error('查看权限错误:', error);
      await ctx.reply('❌ 查看权限时发生错误', this.getPermissionManageKeyboard());
    }
  }
    async handleRevokePermission(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      await ctx.reply('❌ 权限不足');
      return;
    }
    await ctx.reply('🚫 撤销用户权限\n\n请发送用户ID：');
    // 设置会话状态
    const session: UserSession = {
      userId,
      mode: BotMode.Upload, // 临时使用upload模式
            step: 'waiting_keyword' as UserSession['step'],
            currentKeyword: 'revoke_permission' // 标记操作类型
    };
    this.userSessions.set(userId, session);
  }
    getPermissionTypeName(type: string) {
    const typeNames: { [key: string]: string } = {
      'free': '免费版',
      'monthly': '包月版',
      'quarterly': '包季版',
      'lifetime': '终身版'
    };
    return typeNames[type] || type;
  }
  // 定时检查到期用户
    startExpiryChecker() {
    // 每小时检查一次
    setInterval(async () => {
      try {
        const expiringUsers = await database.getExpiringUsers();
        for (const user of expiringUsers) {
                    const expiryDate = new Date(user.expires_at);
          const daysLeft = Math.ceil((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
          let message = `⚠️ 权限即将到期提醒\n\n`;
          message += `您的${this.getPermissionTypeName(user.permission_type)}权限将在 ${daysLeft} 天后到期\n`;
          message += `到期时间：${expiryDate.toLocaleDateString('zh-CN')}\n\n`;
          message += `如需续费，请联系管理员`;
          try {
            await this.bot.telegram.sendMessage(user.user_id, message);
            await database.markReminderSent(user.user_id);
                    }
                    catch (error) {
            console.error(`发送到期提醒失败 - 用户ID: ${user.user_id}`, error);
          }
        }
            }
            catch (error) {
        console.error('检查到期用户错误:', error);
      }
    }, 60 * 60 * 1000); // 每小时执行一次
  }
  // 权限检查中间件（会员制度已取消，全部开放）
    async checkPermissionForAction(_userId: number, _action: string): Promise<boolean> {
    return true;
  }
    async handlePermissionInput(ctx: Context, text: any) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      await ctx.reply('❌ 权限不足');
      return;
    }
    const session = this.userSessions.get(userId);
        if (!session || !session.currentKeyword)
            return;
    try {
            let targetUserId;
      // 尝试解析用户ID
      if (/^\d+$/.test(text)) {
        targetUserId = parseInt(text);
            }
            else {
        await ctx.reply('❌ 请输入有效的用户ID（纯数字）', this.getPermissionManageKeyboard());
        this.userSessions.delete(userId);
        return;
      }
      const targetUser = ctx.from; // 这里应该获取目标用户信息，但Telegram API限制，暂时使用当前用户信息
      switch (session.currentKeyword) {
        case 'grant_monthly':
          await database.grantUserPermission(targetUserId, 'monthly');
                    await ctx.reply(`✅ 成功授权用户 ${targetUserId} 一个月使用权限\n` +
                        `到期时间：${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('zh-CN')}`, this.getPermissionManageKeyboard());
          // 通知目标用户
          try {
                        await this.bot.telegram.sendMessage(targetUserId, `🎉 恭喜！您已获得一个月使用权限\n\n` +
              `到期时间：${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('zh-CN')}\n` +
                            `现在您可以使用所有功能了！`, await this.getCoreFunctionKeyboard(targetUserId));
                    }
                    catch (error) {
            console.error('通知用户失败:', error);
          }
          break;
        case 'grant_quarterly':
          await database.grantUserPermission(targetUserId, 'quarterly');
                    await ctx.reply(`✅ 成功授权用户 ${targetUserId} 三个月使用权限\n` +
                        `到期时间：${new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toLocaleDateString('zh-CN')}`, this.getPermissionManageKeyboard());
          // 通知目标用户
          try {
                        await this.bot.telegram.sendMessage(targetUserId, `🎉 恭喜！您已获得三个月使用权限\n\n` +
              `到期时间：${new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toLocaleDateString('zh-CN')}\n` +
                            `现在您可以使用所有功能了！`, await this.getCoreFunctionKeyboard(targetUserId));
                    }
                    catch (error) {
            console.error('通知用户失败:', error);
          }
          break;
        case 'revoke_permission':
          await database.revokeUserPermission(targetUserId, 'monthly');
                    await ctx.reply(`✅ 已撤销用户 ${targetUserId} 的使用权限`, this.getPermissionManageKeyboard());
          // 通知目标用户
          try {
                        await this.bot.telegram.sendMessage(targetUserId, `⚠️ 您的使用权限已被撤销\n\n` +
                            `如有疑问，请联系管理员`, await this.getCoreFunctionKeyboard(targetUserId));
                    }
                    catch (error) {
            console.error('通知用户失败:', error);
          }
          break;
      }
      // 清理会话
      this.userSessions.delete(userId);
      await database.clearUserSession(userId);
        }
        catch (error) {
      console.error('处理权限输入错误:', error);
      await ctx.reply('❌ 处理权限时发生错误', this.getPermissionManageKeyboard());
      // 清理会话
      this.userSessions.delete(userId);
      await database.clearUserSession(userId);
    }
  }
    async start() {
    try {
      scheduledPublish.start(this.bot);
      console.log('[启动] 步骤1: 开始启动bot...');
      console.log('[启动] Bot Token长度:', config.botToken?.length || 0);
      console.log('[启动] 域名配置:', process.env.DOMAIN || '未配置 (将使用localhost)');
      console.log('[启动] 正在连接Telegram服务器...');
      
      // 1. 先测试网络连接
      try {
        console.log('[启动] 测试Telegram API连接...');
        const testUrl = 'https://api.telegram.org';
        const https = require('https');
        await new Promise<void>((resolve) => {
          const req = https.get(testUrl, { timeout: 5000 }, (res: any) => {
            console.log('[启动] ✅ Telegram API物理链路正常');
            resolve();
          });
          req.on('error', (err: Error) => {
            console.log('[启动] ⚠️ Telegram API物理链路异常:', err.message);
            resolve();
          });
          req.on('timeout', () => {
            req.destroy();
            console.log('[启动] ⚠️ Telegram API物理链路连接超时 (5s)');
            resolve();
          });
        });
      } catch (e) {
        console.log('[启动] ⚠️ 网络测试跳过');
      }
      
      // 2. 测试 Bot Token 有效性
      console.log('[启动] 测试Bot Token有效性...');
      try {
        const me = await this.bot.telegram.getMe();
        console.log(`[启动] ✅ Bot Token有效: @${me.username} (ID: ${me.id})`);
      } catch (e: any) {
        console.error(`[启动] ❌ Bot Token无效或网络严重阻塞: ${e.message}`);
        throw e;
      }

      // 2.5 金库可达性
      if (config.persistentChannelId) {
        console.log(`[启动] 检查金库频道 ${config.persistentChannelId}...`);
        const vault = await checkVaultAccess(this.bot.telegram, config.persistentChannelId);
        if (vault.ok) {
          console.log(`[启动] ✅ 金库可达: ${vault.type}「${vault.title}」status=${vault.botStatus}`);
        } else {
          console.error(`[启动] ❌ 金库不可达: ${vault.error}`);
          if (vault.hint) console.error(`[启动] 💡 ${vault.hint}`);
          console.error('[启动] ⚠️ 上传「仅保存」将无法写入备份频道，请先把当前 bot 加成该频道管理员');
        }
      } else {
        console.warn('[启动] ⚠️ 未配置 PERSISTENT_CHANNEL_ID，影子备份关闭');
      }
      
      // 3. 开始建立长连接 (launch)
      console.log('[启动] 开始建立长连接 (launch)...');
      const launchOptions = {
        dropPendingUpdates: true,
        polling: {
          timeout: 30,
          limit: 100
        }
      };
      
      try {
        await this.bot.launch(launchOptions);
        console.log('🤖 机器人正式启动成功，正在监听消息！');
      } catch (e: any) {
        console.error(`[启动] ⚠️ launch() 失败: ${e.message}`);
        console.log('[启动] 尝试直接检查bot状态...');
        try {
          const me = await this.bot.telegram.getMe();
          console.log(`[启动] ✅ Bot实际上已就绪: @${me.username}`);
        } catch (testError: any) {
          console.log(`[启动] ❌ Bot 最终确认不可用: ${testError?.message}`);
          throw e;
        }
      }
      
      // 4. 优雅关闭
      process.once('SIGINT', async () => {
        console.log('\n[关闭] 收到SIGINT信号，正在关闭...');
        try { await database.saveImmediately(); } catch {}
        this.bot.stop('SIGINT');
      });
      process.once('SIGTERM', async () => {
        console.log('\n[关闭] 收到SIGTERM信号，正在关闭...');
        try { await database.saveImmediately(); } catch {}
        this.bot.stop('SIGTERM');
      });
      
      // 5. 启动时自动恢复已登录的账号
      console.log('[启动] 步骤3: 准备自动恢复账号...');
      setImmediate(async () => {
        try {
          console.log('[启动] 步骤4: 开始执行自动恢复任务...');
          if (!accountController) {
            console.error('[启动] ❌ accountController未定义！');
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
          console.log('\n========================================');
          console.log('🔄 [自动恢复] 开始自动恢复已登录的账号...');
          console.log('========================================\n');
          await accountController.autoRestoreAccounts();
          console.log('[启动] ✅ 自动恢复流程完成！');
        } catch (error: any) {
          console.error('[启动] ❌ 自动恢复账号时出错:', error?.message);
        }
      });
      
      console.log('[启动] 步骤5: start方法完成，机器人已就绪');
    } catch (error: any) {
      console.error('[启动] ❌ 机器人启动过程发生致命错误:', error?.message || error);
      console.log('🔄 10秒后尝试重新启动整个系统...');
      setTimeout(() => this.start(), 10000);
      }
  }
    stop() {
    this.bot.stop();
    database.close();
  }
  // ===============================
  // 帮助系统详细方法
  // ===============================
    async handleHelpSearch(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    const isAdmin = this.isAdmin(userId);
    const hasPermission = await database.checkUserPermission(userId);
    let helpText = `🔍 **搜索功能详细使用指南**\n\n`;
    // 根据用户类型显示不同的搜索范围
    if (isAdmin) {
      helpText += `👑 **管理员搜索权限**\n`;
      helpText += `• 可以搜索所有用户上传的内容\n`;
      helpText += `• 包括自己和所有会员的资料\n\n`;
        }
        else if (hasPermission) {
      helpText += `💎 **会员搜索权限**\n`;
      helpText += `• 只能搜索您自己上传的内容\n`;
      helpText += `• 确保数据隐私和安全\n\n`;
        }
        else {
      helpText += `👤 **访客搜索权限**\n`;
      helpText += `• 只能搜索管理员公开的资料\n`;
      helpText += `• 体验基础搜索功能\n\n`;
    }
    helpText += `📝 **使用步骤：**\n\n`;
    helpText += `**步骤1：启动搜索**\n`;
    helpText += `• 点击 "🔍 搜索资料" 按钮\n`;
    helpText += `• 或在欢迎页面点击 "🔍 搜索模式"\n\n`;
    helpText += `**步骤2：输入关键词**\n`;
    helpText += `• 直接发送您要搜索的关键词\n`;
    helpText += `• 支持中文、英文、数字关键词\n`;
    helpText += `• 关键词不区分大小写\n\n`;
    helpText += `**步骤3：查看结果**\n`;
    helpText += `• 系统自动返回相关媒体文件\n`;
    helpText += `• 照片和视频会组合显示\n`;
    helpText += `• 文档、音频等单独显示\n`;
    helpText += `• 最多显示10个结果\n\n`;
    helpText += `✨ **搜索技巧：**\n`;
    helpText += `• 使用具体的关键词获得精确结果\n`;
    helpText += `• 可以搜索文件的描述内容\n`;
    helpText += `• 尝试不同的关键词变体\n`;
    helpText += `• 查看原始说明文字帮助理解内容\n\n`;
    helpText += `📊 **结果展示说明：**\n`;
    helpText += `• 照片+视频：网格形式展示\n`;
    helpText += `• 文档：显示文件名和大小\n`;
    helpText += `• 音频/语音：显示时长信息\n`;
    helpText += `• 显示上传时间和原始说明\n\n`;
    helpText += `🚀 **快速搜索：**\n`;
    helpText += `• 在任何界面直接发送关键词\n`;
    helpText += `• 系统自动识别并开始搜索\n`;
    helpText += `• 无需切换到搜索模式`;
    const backKeyboard = [
      [Markup.button.callback('⬅️ 返回帮助菜单', 'help_back')],
      [Markup.button.callback('🏠 返回主菜单', 'back_to_main')]
    ];
    await ctx.editMessageText(helpText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(backKeyboard)
    });
  }
    async handleHelpKeywords(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    const isAdmin = this.isAdmin(userId);
    const hasPermission = await database.checkUserPermission(userId);
    let helpText = `🗂️ **关键词管理详细使用指南**\n\n`;
    if (isAdmin) {
      helpText += `👑 **管理员关键词权限**\n`;
      helpText += `• 查看所有用户的关键词\n`;
      helpText += `• 删除任何关键词及其媒体\n`;
      helpText += `• 管理全局关键词库\n\n`;
        }
        else if (hasPermission) {
      helpText += `💎 **会员关键词权限**\n`;
      helpText += `• 查看和管理自己的关键词\n`;
      helpText += `• 删除自己的关键词和媒体\n`;
      helpText += `• 数据完全隔离\n\n`;
        }
        else {
      helpText += `👤 **访客关键词权限**\n`;
      helpText += `• 只能查看管理员公开的关键词\n`;
      helpText += `• 帮助了解可搜索的内容\n\n`;
    }
    helpText += `📝 **使用步骤：**\n\n`;
    helpText += `**方法1：使用命令（推荐）**\n`;
    helpText += `• /keywords - 查看关键词管理帮助\n`;
    helpText += `• /keywords list - 查看所有关键词\n`;
    helpText += `• /keywords add 关键词1 关键词2 - 添加关键词\n`;
    helpText += `• /keywords remove 关键词1 关键词2 - 删除关键词\n`;
    helpText += `• /keywords clear - 清空所有关键词\n\n`;
    helpText += `**方法2：使用按钮界面**\n`;
    helpText += `• 点击 "📄 查看资料" 按钮\n`;
    helpText += `• 或在欢迎页面点击 "📄 查看资料"\n\n`;
    helpText += `**步骤2：浏览关键词**\n`;
    helpText += `• 系统显示所有可用关键词\n`;
    helpText += `• 支持分页浏览（每页20个）\n`;
    helpText += `• 点击页码切换页面\n\n`;
    if (hasPermission || isAdmin) {
      helpText += `**步骤3：管理关键词**\n`;
      helpText += `• 点击 "🗑️ 删除关键词" 进入删除模式\n`;
      helpText += `• 输入要删除的关键词名称\n`;
      helpText += `• 确认删除后关键词及相关媒体全部清除\n\n`;
    }
    helpText += `📋 **关键词列表说明：**\n`;
    helpText += `• 按字母顺序排列\n`;
    helpText += `• 显示每个关键词下的媒体数量\n`;
    helpText += `• 支持快速定位\n\n`;
    if (hasPermission || isAdmin) {
      helpText += `⚠️ **删除关键词注意事项：**\n`;
      helpText += `• 删除关键词会同时删除所有相关媒体\n`;
      helpText += `• 操作不可撤销，请谨慎操作\n`;
      helpText += `• 建议删除前先确认内容\n\n`;
    }
    helpText += `💡 **使用技巧：**\n`;
    helpText += `• 定期整理无用关键词\n`;
    helpText += `• 使用有意义的关键词名称\n`;
    helpText += `• 避免重复或相似的关键词`;
    const backKeyboard = [
      [Markup.button.callback('⬅️ 返回帮助菜单', 'help_back')],
      [Markup.button.callback('🏠 返回主菜单', 'back_to_main')]
    ];
    await ctx.editMessageText(helpText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(backKeyboard)
    });
  }
    async handleHelpUpload(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    let helpText = `📁 **上传功能详细使用指南**\n\n`;
    helpText += `💎 **会员专享功能** - 上传和管理您的媒体文件\n\n`;
    helpText += `📝 **完整操作流程：**\n\n`;
    helpText += `**步骤1：启动上传模式**\n`;
    helpText += `• 点击 "📁 上传资料" 按钮\n`;
    helpText += `• 系统提示输入关键词\n\n`;
    helpText += `**步骤2：设置关键词**\n`;
    helpText += `• 输入描述性的关键词（必填）\n`;
    helpText += `• 关键词用于后续搜索和分类\n`;
    helpText += `• 建议使用有意义的词语\n`;
    helpText += `• 例如：会议记录、产品图片、培训视频等\n\n`;
    helpText += `**步骤3：上传媒体文件**\n`;
    helpText += `• 上传一个或多个媒体文件\n`;
    helpText += `• 支持的格式：\n`;
    helpText += `  📷 图片：JPG, PNG, GIF, WebP\n`;
    helpText += `  🎥 视频：MP4, AVI, MOV, MKV\n`;
    helpText += `  📄 文档：PDF, DOC, XLS, PPT, TXT\n`;
    helpText += `  🎵 音频：MP3, WAV, OGG, M4A\n`;
    helpText += `  🎤 语音消息：支持\n\n`;
    helpText += `**步骤4：添加说明（可选）**\n`;
    helpText += `• 为媒体文件添加文字说明\n`;
    helpText += `• 说明会保存并在搜索时显示\n`;
    helpText += `• 有助于后续查找和理解内容\n\n`;
    helpText += `**步骤5：选择操作**\n`;
    helpText += `• 系统自动显示 "选择频道" 按钮\n`;
    helpText += `• 无需手动输入 "完成" 命令\n`;
    helpText += `• 点击按钮进入频道选择\n\n`;
    helpText += `**步骤6：选择目标频道**\n`;
    helpText += `• 选择要发布的频道（如需发布）\n`;
    helpText += `• 或选择 "💾 仅保存" 只保存不发布\n\n`;
    helpText += `**步骤7：确认操作**\n`;
    helpText += `• "💾 仅保存"：保存到数据库，不发布\n`;
    helpText += `• "💾📢 保存并发布"：保存并发布到选中频道\n\n`;
    helpText += `✨ **高级功能：**\n`;
    helpText += `• **批量上传**：连续发送多个文件\n`;
    helpText += `• **媒体组合**：最多10个文件组合显示\n`;
    helpText += `• **智能缓冲**：3秒内的上传会合并处理\n`;
    helpText += `• **自动优化**：减少消息冗余\n\n`;
    helpText += `💡 **使用技巧：**\n`;
    helpText += `• 同类内容使用相同关键词便于管理\n`;
    helpText += `• 添加详细说明提高搜索准确性\n`;
    helpText += `• 合理选择仅保存或发布选项\n`;
    helpText += `• 利用批量上传提高效率\n\n`;
    helpText += `⚠️ **注意事项：**\n`;
    helpText += `• 确保有频道发布权限\n`;
    helpText += `• 文件大小需符合Telegram限制\n`;
    helpText += `• 上传的内容仅自己可见（数据隔离）\n`;
    helpText += `• 发布需要机器人在目标频道有管理员权限`;
    const backKeyboard = [
      [Markup.button.callback('⬅️ 返回帮助菜单', 'help_back')],
      [Markup.button.callback('🏠 返回主菜单', 'back_to_main')]
    ];
    await ctx.editMessageText(helpText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(backKeyboard)
    });
  }
    async handleHelpPublish(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    let helpText = `🚀 **发布功能详细使用指南**\n\n`;
    helpText += `💎 **会员专享功能** - 将已保存的内容发布到频道\n\n`;
    helpText += `📝 **完整操作流程：**\n\n`;
    helpText += `**步骤1：启动发布模式**\n`;
    helpText += `• 点击 "🚀 发布内容" 按钮\n`;
    helpText += `• 进入发布内容模式\n\n`;
    helpText += `**步骤2：输入关键词**\n`;
    helpText += `• 输入要发布内容的关键词\n`;
    helpText += `• 系统自动检索该关键词下的所有媒体\n`;
    helpText += `• 只能发布您自己上传的内容\n\n`;
    helpText += `**步骤3：系统处理**\n`;
    helpText += `• 系统自动获取该关键词的所有媒体\n`;
    helpText += `• 如果没有找到内容，会提示重新输入\n`;
    helpText += `• 找到内容后自动开始发布流程\n\n`;
    helpText += `**步骤4：选择目标频道**\n`;
    helpText += `• 系统显示所有可用频道的完整名称\n`;
    helpText += `• 每个频道显示为独立按钮\n`;
    helpText += `• 点击选择要发布的频道\n\n`;
    helpText += `**步骤5：自动发布**\n`;
    helpText += `• 系统自动将内容发布到选中频道\n`;
    helpText += `• 会保留原始说明文字\n`;
    helpText += `• 不会显示内部关键词标识\n`;
    helpText += `• 发布间隔2秒，避免频率限制\n\n`;
    helpText += `**步骤6：连续发布**\n`;
    helpText += `• 发布完成后自动返回关键词输入模式\n`;
    helpText += `• 可以继续发布其他关键词内容\n`;
    helpText += `• 无需重新启动发布模式\n`;
    helpText += `• 想要退出时点击 "❌ 取消"\n\n`;
    helpText += `📊 **发布内容处理：**\n`;
    helpText += `• **照片+视频**：组合为媒体组发布\n`;
    helpText += `• **文档**：保持原文件名和格式\n`;
    helpText += `• **音频/语音**：保持原时长信息\n`;
    helpText += `• **说明文字**：完整保留，不显示关键词\n\n`;
    helpText += `✨ **智能功能：**\n`;
    helpText += `• **自动频道检测**：实时获取频道真实名称\n`;
    helpText += `• **连续发布模式**：提高批量发布效率\n`;
    helpText += `• **错误处理**：友好的错误提示和重试机制\n`;
    helpText += `• **内容优化**：自动去除内部标识\n\n`;
    helpText += `🎯 **发布策略：**\n`;
    helpText += `• 一个关键词的所有内容会一次性发布\n`;
    helpText += `• 发布顺序按上传时间排列\n`;
    helpText += `• 媒体组最多包含10个文件\n`;
    helpText += `• 超出部分会分多个媒体组发布\n\n`;
    helpText += `⚠️ **重要注意事项：**\n`;
    helpText += `• 确保机器人在目标频道有管理员权限\n`;
    helpText += `• 只能发布自己上传的内容（数据隔离）\n`;
    helpText += `• 发布操作不可撤销\n`;
    helpText += `• 避免频繁发布相同内容\n\n`;
    helpText += `💡 **使用技巧：**\n`;
    helpText += `• 先用 "仅保存" 整理内容，再批量发布\n`;
    helpText += `• 合理规划关键词，便于分类发布\n`;
    helpText += `• 发布前可先在搜索中预览内容\n`;
    helpText += `• 利用连续发布模式提高效率`;
    const backKeyboard = [
      [Markup.button.callback('⬅️ 返回帮助菜单', 'help_back')],
      [Markup.button.callback('🏠 返回主菜单', 'back_to_main')]
    ];
    await ctx.editMessageText(helpText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(backKeyboard)
    });
  }
    async handleHelpChannel(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      await ctx.reply('❌ 此功能仅限管理员使用');
      return;
    }
    let helpText = `🏢 **频道管理详细使用指南**\n\n`;
    helpText += `👑 **管理员专属功能** - 管理机器人的目标频道\n\n`;
    helpText += `📝 **功能概述：**\n\n`;
    helpText += `频道管理功能允许您：\n`;
    helpText += `• 添加新的目标频道\n`;
    helpText += `• 删除不需要的频道\n`;
    helpText += `• 查看当前所有频道\n`;
    helpText += `• 实时更新频道配置\n\n`;
    helpText += `➕ **添加频道完整流程：**\n\n`;
    helpText += `**步骤1：启动添加功能**\n`;
    helpText += `• 点击 "🏢 频道管理"\n`;
    helpText += `• 选择 "➕ 添加频道"\n\n`;
    helpText += `**步骤2：获取频道ID**\n`;
    helpText += `• 将机器人添加到目标频道\n`;
    helpText += `• 给机器人管理员权限（重要！）\n`;
    helpText += `• 获取频道ID（通常以-100开头）\n\n`;
    helpText += `**获取频道ID的方法：**\n`;
    helpText += `• 方法1：转发频道消息给 @userinfobot\n`;
    helpText += `• 方法2：在频道中发送 /id（如有相关机器人）\n`;
    helpText += `• 方法3：查看频道链接中的数字部分\n\n`;
    helpText += `**步骤3：输入频道ID**\n`;
    helpText += `• 在机器人中输入完整的频道ID\n`;
    helpText += `• 格式：-1001234567890\n`;
    helpText += `• 必须包含负号\n\n`;
    helpText += `**步骤4：自动验证**\n`;
    helpText += `• 系统自动获取频道真实名称\n`;
    helpText += `• 验证机器人是否有发布权限\n`;
    helpText += `• 添加成功后立即生效\n\n`;
    helpText += `➖ **删除频道完整流程：**\n\n`;
    helpText += `**步骤1：查看频道列表**\n`;
    helpText += `• 点击 "🏢 频道管理"\n`;
    helpText += `• 选择 "📋 查看频道"\n\n`;
    helpText += `**步骤2：选择删除目标**\n`;
    helpText += `• 点击要删除的频道按钮\n`;
    helpText += `• 系统显示频道详细信息\n\n`;
    helpText += `**步骤3：确认删除**\n`;
    helpText += `• 点击 "🗑️ 删除频道"\n`;
    helpText += `• 确认删除操作\n`;
    helpText += `• 删除后立即生效\n\n`;
    helpText += `🔧 **频道权限设置：**\n\n`;
    helpText += `机器人需要以下权限：\n`;
    helpText += `• ✅ 发送消息\n`;
    helpText += `• ✅ 发送媒体文件\n`;
    helpText += `• ✅ 发送文档\n`;
    helpText += `• ✅ 添加网页预览\n\n`;
    helpText += `可选权限：\n`;
    helpText += `• 删除消息（用于管理）\n`;
    helpText += `• 编辑消息（用于更新）\n\n`;
    helpText += `✨ **智能功能：**\n`;
    helpText += `• **实时同步**：添加/删除立即生效，无需重启\n`;
    helpText += `• **自动命名**：自动获取频道真实名称\n`;
    helpText += `• **权限检测**：自动验证发布权限\n`;
    helpText += `• **错误提示**：详细的错误信息和解决方案\n\n`;
    helpText += `📊 **频道显示说明：**\n`;
    helpText += `• 频道列表显示完整频道名称\n`;
    helpText += `• 发布界面每个频道独立按钮\n`;
    helpText += `• 支持中文、英文、特殊字符频道名\n\n`;
    helpText += `⚠️ **注意事项：**\n`;
    helpText += `• 删除频道不会影响已发布的内容\n`;
    helpText += `• 机器人必须在频道中有管理员权限\n`;
    helpText += `• 频道ID格式必须正确\n`;
    helpText += `• 建议定期检查频道权限状态\n\n`;
    helpText += `🛠️ **故障排除：**\n`;
    helpText += `• **"频道未找到"**：检查ID格式和权限\n`;
    helpText += `• **"无发布权限"**：检查管理员权限设置\n`;
    helpText += `• **"频道已存在"**：该频道已在列表中\n`;
    helpText += `• **界面不更新**：重新进入频道管理`;
    const backKeyboard = [
      [Markup.button.callback('⬅️ 返回帮助菜单', 'help_back')],
      [Markup.button.callback('🏠 返回主菜单', 'back_to_main')]
    ];
    await ctx.editMessageText(helpText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(backKeyboard)
    });
  }
    async handleHelpUser(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      await ctx.reply('❌ 此功能仅限管理员使用');
      return;
    }
    let helpText = `👥 **用户管理详细使用指南**\n\n`;
    helpText += `👑 **管理员专属功能** - 管理机器人用户\n\n`;
    helpText += `📝 **功能概述：**\n\n`;
    helpText += `用户管理功能包括：\n`;
    helpText += `• 查看所有用户信息\n`;
    helpText += `• 管理用户权限状态\n`;
    helpText += `• 处理用户申请\n`;
    helpText += `• 监控用户活动\n\n`;
    helpText += `📊 **用户分类说明：**\n\n`;
    helpText += `**👑 超级管理员**\n`;
    helpText += `• 系统最高权限\n`;
    helpText += `• 管理所有功能和用户\n`;
    helpText += `• 查看全局数据\n\n`;
    helpText += `**💎 会员用户**\n`;
    helpText += `• 有完整使用权限\n`;
    helpText += `• 可上传、发布、管理个人内容\n`;
    helpText += `• 数据完全隔离\n\n`;
    helpText += `**👤 普通用户**\n`;
    helpText += `• 基础功能权限\n`;
    helpText += `• 仅可搜索公共内容\n`;
    helpText += `• 可联系管理员申请升级\n\n`;
    helpText += `🔍 **查看用户信息：**\n\n`;
    helpText += `**步骤1：进入用户管理**\n`;
    helpText += `• 点击 "👥 用户管理"\n`;
    helpText += `• 选择查看选项\n\n`;
    helpText += `**步骤2：用户信息内容**\n`;
    helpText += `• 用户ID和用户名\n`;
    helpText += `• 权限类型和状态\n`;
    helpText += `• 注册时间和最后活动\n`;
    helpText += `• 使用统计信息\n\n`;
    helpText += `📝 **申请处理流程：**\n\n`;
    helpText += `**步骤1：接收申请**\n`;
    helpText += `• 用户通过聊天功能发送申请\n`;
    helpText += `• 系统记录申请信息\n\n`;
    helpText += `**步骤2：审核申请**\n`;
    helpText += `• 点击 "📝 申请审批"\n`;
    helpText += `• 查看待处理申请列表\n`;
    helpText += `• 了解申请用户信息\n\n`;
    helpText += `**步骤3：处理决定**\n`;
    helpText += `• 批准：通过权限管理授权\n`;
    helpText += `• 拒绝：发送拒绝理由\n`;
    helpText += `• 延期：要求补充信息\n\n`;
    helpText += `📊 **用户数据分析：**\n\n`;
    helpText += `可以查看的统计信息：\n`;
    helpText += `• 总用户数量\n`;
    helpText += `• 各类型用户分布\n`;
    helpText += `• 活跃用户统计\n`;
    helpText += `• 权限使用情况\n\n`;
    helpText += `🔧 **用户状态管理：**\n\n`;
    helpText += `**激活用户**\n`;
    helpText += `• 通过权限管理授权\n`;
    helpText += `• 设置权限期限\n`;
    helpText += `• 发送通知消息\n\n`;
    helpText += `**停用用户**\n`;
    helpText += `• 撤销用户权限\n`;
    helpText += `• 保留历史数据\n`;
    helpText += `• 发送停用通知\n\n`;
    helpText += `**用户数据隔离说明：**\n`;
    helpText += `• 每个用户只能看到自己的数据\n`;
    helpText += `• 管理员可以查看全局统计\n`;
    helpText += `• 但不能直接访问用户私人内容\n`;
    helpText += `• 确保用户隐私安全\n\n`;
    helpText += `💡 **管理建议：**\n`;
    helpText += `• 定期审核用户权限状态\n`;
    helpText += `• 及时处理用户申请\n`;
    helpText += `• 维护良好的用户关系\n`;
    helpText += `• 合理分配权限资源\n\n`;
    helpText += `⚠️ **注意事项：**\n`;
    helpText += `• 用户管理操作需要谨慎\n`;
    helpText += `• 权限变更会立即生效\n`;
    helpText += `• 建议保留操作记录\n`;
    helpText += `• 尊重用户数据隐私`;
    const backKeyboard = [
      [Markup.button.callback('⬅️ 返回帮助菜单', 'help_back')],
      [Markup.button.callback('🏠 返回主菜单', 'back_to_main')]
    ];
    await ctx.editMessageText(helpText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(backKeyboard)
    });
  }
    async handleHelpPermission(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || userId !== config.superAdminId) {
      await ctx.reply('❌ 此功能仅限管理员使用');
      return;
    }
    let helpText = `🔐 **权限管理详细使用指南**\n\n`;
    helpText += `👑 **管理员专属功能** - 管理用户权限系统\n\n`;
    helpText += `📝 **权限系统概述：**\n\n`;
    helpText += `本机器人采用分级权限管理：\n`;
    helpText += `• **免费用户**：基础搜索功能\n`;
    helpText += `• **月度会员**：30天完整功能\n`;
    helpText += `• **季度会员**：90天完整功能\n`;
    helpText += `• **终身会员**：永久完整功能\n\n`;
    helpText += `➕ **授权月度会员流程：**\n\n`;
    helpText += `**步骤1：启动授权**\n`;
    helpText += `• 点击 "🔐 权限管理"\n`;
    helpText += `• 选择 "📅 授权1个月"\n\n`;
    helpText += `**步骤2：输入用户信息**\n`;
    helpText += `• 输入用户ID（纯数字）\n`;
    helpText += `• 或输入用户名（@username格式）\n`;
    helpText += `• 系统自动验证用户存在性\n\n`;
    helpText += `**步骤3：确认授权**\n`;
    helpText += `• 系统显示用户信息确认\n`;
    helpText += `• 设置30天有效期\n`;
    helpText += `• 发送授权成功通知\n\n`;
    helpText += `➕ **授权季度会员流程：**\n\n`;
    helpText += `**步骤1：启动授权**\n`;
    helpText += `• 点击 "🔐 权限管理"\n`;
    helpText += `• 选择 "📅 授权3个月"\n\n`;
    helpText += `**步骤2：用户识别**\n`;
    helpText += `• 输入目标用户ID或用户名\n`;
    helpText += `• 系统验证用户有效性\n\n`;
    helpText += `**步骤3：长期授权**\n`;
    helpText += `• 设置90天有效期\n`;
    helpText += `• 自动计算到期时间\n`;
    helpText += `• 通知用户授权信息\n\n`;
    helpText += `❌ **撤销权限流程：**\n\n`;
    helpText += `**步骤1：进入撤销模式**\n`;
    helpText += `• 点击 "🔐 权限管理"\n`;
    helpText += `• 选择 "🚫 撤销权限"\n\n`;
    helpText += `**步骤2：确定目标用户**\n`;
    helpText += `• 输入要撤销权限的用户ID\n`;
    helpText += `• 或输入用户名\n\n`;
    helpText += `**步骤3：执行撤销**\n`;
    helpText += `• 系统立即撤销用户权限\n`;
    helpText += `• 用户降级为免费用户\n`;
    helpText += `• 发送权限变更通知\n\n`;
    helpText += `📊 **查看权限状态：**\n\n`;
    helpText += `**步骤1：进入查看模式**\n`;
    helpText += `• 点击 "🔐 权限管理"\n`;
    helpText += `• 选择 "📋 查看权限"\n\n`;
    helpText += `**步骤2：权限列表信息**\n`;
    helpText += `• 显示所有有权限的用户\n`;
    helpText += `• 包含权限类型和到期时间\n`;
    helpText += `• 显示剩余天数\n`;
    helpText += `• 标识即将到期的用户\n\n`;
    helpText += `⏰ **到期提醒系统：**\n\n`;
    helpText += `**自动提醒机制：**\n`;
    helpText += `• 到期前2天自动发送提醒\n`;
    helpText += `• 每天检查一次到期状态\n`;
    helpText += `• 避免重复发送提醒\n\n`;
    helpText += `**提醒内容包括：**\n`;
    helpText += `• 当前权限类型\n`;
    helpText += `• 具体到期时间\n`;
    helpText += `• 续期联系方式\n`;
    helpText += `• 功能即将受限提示\n\n`;
    helpText += `🔄 **权限续期管理：**\n\n`;
    helpText += `**到期后处理：**\n`;
    helpText += `• 权限自动失效\n`;
    helpText += `• 用户降级为免费用户\n`;
    helpText += `• 保留用户数据不删除\n`;
    helpText += `• 可重新授权恢复功能\n\n`;
    helpText += `**续期操作：**\n`;
    helpText += `• 重新执行授权流程\n`;
    helpText += `• 权限会自动延期\n`;
    helpText += `• 无需额外设置\n\n`;
    helpText += `✨ **高级功能：**\n\n`;
    helpText += `**权限叠加：**\n`;
    helpText += `• 对已有权限用户可以续期\n`;
    helpText += `• 时间会在原有基础上增加\n`;
    helpText += `• 支持提前续期\n\n`;
    helpText += `**批量管理：**\n`;
    helpText += `• 查看权限支持批量显示\n`;
    helpText += `• 可以筛选不同类型用户\n`;
    helpText += `• 支持导出权限报表\n\n`;
    helpText += `💡 **管理建议：**\n`;
    helpText += `• 建议使用用户ID而非用户名\n`;
    helpText += `• 定期查看权限状态\n`;
    helpText += `• 及时处理到期提醒\n`;
    helpText += `• 记录权限变更历史\n\n`;
    helpText += `⚠️ **重要注意事项：**\n`;
    helpText += `• 权限变更立即生效\n`;
    helpText += `• 撤销权限不可撤销\n`;
    helpText += `• 用户数据会保留\n`;
    helpText += `• 确保输入信息准确性`;
    const backKeyboard = [
      [Markup.button.callback('⬅️ 返回帮助菜单', 'help_back')],
      [Markup.button.callback('🏠 返回主菜单', 'back_to_main')]
    ];
    await ctx.editMessageText(helpText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(backKeyboard)
    });
  }
    async handleHelpChat(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    const isAdmin = this.isAdmin(userId);
    let helpText = `💬 **聊天功能详细使用指南**\n\n`;
    if (isAdmin) {
      helpText += `👑 **管理员聊天功能**\n\n`;
      helpText += `📝 **功能概述：**\n`;
      helpText += `• 接收用户咨询消息\n`;
      helpText += `• 与用户进行双向对话\n`;
      helpText += `• 管理多个用户会话\n`;
      helpText += `• 主动断开用户连接\n\n`;
      helpText += `📨 **接收用户消息：**\n\n`;
      helpText += `**自动转发机制：**\n`;
      helpText += `• 用户发送的消息会自动转发给您\n`;
      helpText += `• 包含用户信息和消息内容\n`;
      helpText += `• 支持文字、图片、视频、文档、音频\n`;
      helpText += `• 显示用户ID便于识别\n\n`;
      helpText += `💬 **回复用户消息：**\n\n`;
      helpText += `**引用回复方式：**\n`;
      helpText += `• 直接回复(引用)用户转发的消息\n`;
      helpText += `• 系统自动识别回复目标\n`;
      helpText += `• 支持文字和媒体回复\n`;
      helpText += `• 消息会自动转发给用户\n\n`;
      helpText += `**步骤说明：**\n`;
      helpText += `1. 找到要回复的用户消息\n`;
      helpText += `2. 点击"回复"按钮\n`;
      helpText += `3. 输入您的回复内容\n`;
      helpText += `4. 发送，系统自动转发给用户\n\n`;
      helpText += `👥 **管理用户会话：**\n\n`;
      helpText += `**查看活跃用户：**\n`;
      helpText += `• 点击 "💬 联系管理员" 查看用户列表\n`;
      helpText += `• 显示正在聊天的用户\n`;
      helpText += `• 显示最后消息时间\n\n`;
      helpText += `**断开用户连接：**\n`;
      helpText += `• 点击用户旁的 "🔐 断开连接"\n`;
      helpText += `• 强制结束用户聊天会话\n`;
      helpText += `• 用户会收到连接断开通知\n\n`;
        }
        else {
      helpText += `👤 **用户聊天功能**\n\n`;
      helpText += `📝 **功能概述：**\n`;
      helpText += `• 与管理员进行实时对话\n`;
      helpText += `• 咨询使用问题\n`;
      helpText += `• 申请权限升级\n`;
      helpText += `• 反馈建议和问题\n\n`;
      helpText += `🚀 **开始聊天：**\n\n`;
      helpText += `**启动聊天模式：**\n`;
      helpText += `• 点击 "💬 联系管理员" 按钮\n`;
      helpText += `• 或在欢迎页面点击 "💬 联系管理员"\n`;
      helpText += `• 系统自动进入聊天模式\n\n`;
      helpText += `**发送消息：**\n`;
      helpText += `• 直接输入文字消息\n`;
      helpText += `• 发送图片、视频、文档等\n`;
      helpText += `• 消息会自动转发给管理员\n`;
      helpText += `• 等待管理员回复\n\n`;
      helpText += `📨 **接收回复：**\n\n`;
      helpText += `**管理员回复处理：**\n`;
      helpText += `• 管理员的回复会自动转发给您\n`;
      helpText += `• 支持文字和媒体内容\n`;
      helpText += `• 显示回复时间\n\n`;
      helpText += `🔚 **结束聊天：**\n\n`;
      helpText += `**主动退出方式：**\n`;
      helpText += `• 点击 "❌ 退出聊天" 按钮\n`;
      helpText += `• 或发送 "/exit" 命令\n`;
      helpText += `• 系统确认退出聊天模式\n\n`;
      helpText += `**被动断开：**\n`;
      helpText += `• 管理员可能会断开连接\n`;
      helpText += `• 您会收到断开通知\n`;
      helpText += `• 可以重新发起聊天\n\n`;
    }
    helpText += `📋 **聊天记录管理：**\n\n`;
    helpText += `**消息存储：**\n`;
    helpText += `• 所有聊天消息都会保存\n`;
    helpText += `• 管理员可以查看历史记录\n`;
    helpText += `• 用户隐私得到保护\n\n`;
    helpText += `**消息状态：**\n`;
    helpText += `• 已读/未读状态标识\n`;
    helpText += `• 消息发送时间记录\n`;
    helpText += `• 自动标记消息状态\n\n`;
    helpText += `✨ **智能功能：**\n\n`;
    helpText += `**自动识别：**\n`;
    helpText += `• 系统自动识别聊天模式\n`;
    helpText += `• 智能路由消息到正确接收方\n`;
    helpText += `• 支持多用户并发聊天\n\n`;
    helpText += `**消息格式化：**\n`;
    helpText += `• 自动添加用户信息标识\n`;
    helpText += `• 保持原始消息格式\n`;
    helpText += `• 清晰的对话界面\n\n`;
    helpText += `💡 **使用建议：**\n\n`;
    if (isAdmin) {
      helpText += `**管理员建议：**\n`;
      helpText += `• 及时回复用户咨询\n`;
      helpText += `• 保持专业和友好的态度\n`;
      helpText += `• 合理管理聊天会话\n`;
      helpText += `• 必要时断开无效连接\n\n`;
        }
        else {
      helpText += `**用户建议：**\n`;
      helpText += `• 清楚描述您的问题\n`;
      helpText += `• 提供必要的背景信息\n`;
      helpText += `• 耐心等待管理员回复\n`;
      helpText += `• 聊天结束后记得退出\n\n`;
    }
    helpText += `⚠️ **注意事项：**\n`;
    helpText += `• 聊天功能仅用于技术支持和咨询\n`;
    helpText += `• 请保持礼貌和尊重\n`;
    helpText += `• 不要发送无关或垃圾信息\n`;
    helpText += `• 聊天记录可能被保存用于改进服务`;
    const backKeyboard = [
      [Markup.button.callback('⬅️ 返回帮助菜单', 'help_back')],
      [Markup.button.callback('🏠 返回主菜单', 'back_to_main')]
    ];
    await ctx.editMessageText(helpText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(backKeyboard)
    });
  }
    async handleHelpFAQ(ctx: Context) {
    let helpText = `❓ **常见问题解答 (FAQ)**\n\n`;
    helpText += `🔍 **搜索相关问题：**\n\n`;
    helpText += `**Q1：为什么搜索不到内容？**\n`;
    helpText += `A：请检查以下几点：\n`;
    helpText += `• 关键词是否准确\n`;
    helpText += `• 是否有权限搜索该内容\n`;
    helpText += `• 内容是否已经上传\n`;
    helpText += `• 尝试使用不同的关键词\n\n`;
    helpText += `**Q2：搜索结果显示不完整？**\n`;
    helpText += `A：系统默认显示最多10个结果，如需查看更多：\n`;
    helpText += `• 使用更具体的关键词\n`;
    helpText += `• 分批次搜索不同关键词\n`;
    helpText += `• 联系管理员调整限制\n\n`;
    helpText += `📁 **上传相关问题：**\n\n`;
    helpText += `**Q3：为什么无法上传文件？**\n`;
    helpText += `A：可能的原因：\n`;
    helpText += `• 没有会员权限\n`;
    helpText += `• 文件格式不支持\n`;
    helpText += `• 文件大小超出限制\n`;
    helpText += `• 网络连接问题\n\n`;
    helpText += `**Q4：上传的文件在哪里？**\n`;
    helpText += `A：上传的文件会：\n`;
    helpText += `• 保存在您的个人数据库中\n`;
    helpText += `• 通过关键词可以搜索到\n`;
    helpText += `• 在 "查看资料" 中管理\n`;
    helpText += `• 只有您自己可以看到\n\n`;
    helpText += `🚀 **发布相关问题：**\n\n`;
    helpText += `**Q5："频道未找到" 错误？**\n`;
    helpText += `A：解决方法：\n`;
    helpText += `• 确保机器人在频道中\n`;
    helpText += `• 检查机器人管理员权限\n`;
    helpText += `• 联系管理员检查频道配置\n`;
    helpText += `• 重新添加机器人到频道\n\n`;
    helpText += `**Q6：发布内容不显示说明？**\n`;
    helpText += `A：可能原因：\n`;
    helpText += `• 上传时没有添加说明\n`;
    helpText += `• 说明文字过长被截断\n`;
    helpText += `• 系统处理延迟\n\n`;
    helpText += `👥 **权限相关问题：**\n\n`;
    helpText += `**Q7：如何获得会员权限？**\n`;
    helpText += `A：获取权限的方式：\n`;
    helpText += `• 点击 "💬 联系管理员"\n`;
    helpText += `• 说明您的需求和用途\n`;
    helpText += `• 等待管理员审核\n`;
    helpText += `• 获得授权后即可使用全功能\n\n`;
    helpText += `**Q8：权限到期后会怎样？**\n`;
    helpText += `A：到期处理：\n`;
    helpText += `• 权限自动失效\n`;
    helpText += `• 降级为免费用户\n`;
    helpText += `• 个人数据不会删除\n`;
    helpText += `• 可以重新申请权限\n\n`;
    helpText += `💬 **聊天相关问题：**\n\n`;
    helpText += `**Q9：管理员不回复怎么办？**\n`;
    helpText += `A：处理建议：\n`;
    helpText += `• 等待一段时间，管理员可能忙碌\n`;
    helpText += `• 确保问题描述清楚\n`;
    helpText += `• 避免重复发送相同信息\n`;
    helpText += `• 在合适的时间联系\n\n`;
    helpText += `**Q10：如何发送图片/文件给管理员？**\n`;
    helpText += `A：发送方法：\n`;
    helpText += `• 在聊天模式下直接发送\n`;
    helpText += `• 支持图片、视频、文档、音频\n`;
    helpText += `• 系统自动转发给管理员\n`;
    helpText += `• 等待管理员查看和回复\n\n`;
    helpText += `🔧 **技术相关问题：**\n\n`;
    helpText += `**Q11：机器人响应很慢？**\n`;
    helpText += `A：可能原因和解决方案：\n`;
    helpText += `• 网络连接问题 - 检查网络\n`;
    helpText += `• 服务器繁忙 - 稍后重试\n`;
    helpText += `• 操作过于频繁 - 减慢操作频率\n`;
    helpText += `• 联系管理员报告问题\n\n`;
    helpText += `**Q12：按钮点击没有反应？**\n`;
    helpText += `A：排查步骤：\n`;
    helpText += `• 重新发送 /start 刷新界面\n`;
    helpText += `• 检查网络连接状态\n`;
    helpText += `• 尝试重启Telegram应用\n`;
    helpText += `• 联系管理员检查系统状态\n\n`;
    helpText += `📊 **数据相关问题：**\n\n`;
    helpText += `**Q13：我的数据安全吗？**\n`;
    helpText += `A：数据安全保障：\n`;
    helpText += `• 每个用户数据完全隔离\n`;
    helpText += `• 其他用户无法访问您的内容\n`;
    helpText += `• 管理员也无法直接查看用户私人数据\n`;
    helpText += `• 所有操作都有访问权限控制\n\n`;
    helpText += `**Q14：如何删除我的数据？**\n`;
    helpText += `A：数据删除方法：\n`;
    helpText += `• 使用 "🗑️ 删除关键词" 功能\n`;
    helpText += `• 会删除关键词及所有相关媒体\n`;
    helpText += `• 或联系管理员协助处理\n`;
    helpText += `• 删除操作不可撤销\n\n`;
    helpText += `❌ **其他问题：**\n\n`;
    helpText += `**Q15：遇到未知错误怎么办？**\n`;
    helpText += `A：处理步骤：\n`;
    helpText += `• 记录错误信息和操作步骤\n`;
    helpText += `• 尝试重新操作\n`;
    helpText += `• 检查是否为网络问题\n`;
    helpText += `• 联系管理员并提供详细信息\n\n`;
    helpText += `📞 **获取更多帮助：**\n`;
    helpText += `如果以上解答无法解决您的问题：\n`;
    helpText += `• 点击 "💬 联系管理员" 获取人工支持\n`;
    helpText += `• 详细描述您遇到的问题\n`;
    helpText += `• 提供相关截图或错误信息\n`;
    helpText += `• 我们会尽快为您解决问题`;
    const backKeyboard = [
      [Markup.button.callback('⬅️ 返回帮助菜单', 'help_back')],
      [Markup.button.callback('🏠 返回主菜单', 'back_to_main')]
    ];
    await ctx.editMessageText(helpText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(backKeyboard)
    });
  }
  // 返回帮助菜单
    async handleHelpBack(ctx: Context) {
    await this.handleHelp(ctx);
  }
    async handleKeywordsCommand(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
        if (!ctx.message || !('text' in ctx.message)) return;
        const text = ctx.message.text;
    const args = text.split(' ').slice(1);
    if (args.length === 0) {
      // 显示帮助信息
            await ctx.reply('🔑 关键词管理\n\n' +
        '📝 使用方法：\n' +
        '• /keywords list - 查看所有关键词\n' +
        '• /keywords add 关键词1 关键词2 - 添加关键词\n' +
        '• /keywords remove 关键词1 关键词2 - 删除关键词\n' +
        '• /keywords clear - 清空所有关键词\n\n' +
                '💡 关键词用于搜索和分类媒体文件');
      return;
    }
    const action = args[0].toLowerCase();
    const keywords = args.slice(1);
    switch (action) {
      case 'list':
        await this.showAllKeywords(ctx, userId);
        break;
      case 'add':
        if (keywords.length === 0) {
          await ctx.reply('❌ 请提供要添加的关键词');
          return;
        }
        await this.addKeywords(ctx, userId, keywords);
        break;
      case 'remove':
        if (keywords.length === 0) {
          await ctx.reply('❌ 请提供要删除的关键词');
          return;
        }
        await this.removeKeywords(ctx, userId, keywords);
        break;
      case 'clear':
        await this.clearKeywords(ctx, userId);
        break;
      default:
        await ctx.reply('❌ 未知操作，请使用 /keywords 查看帮助');
    }
  }
    async showAllKeywords(ctx: Context, userId: any) {
    try {
      // 获取数据库中的所有关键词
      const allKeywords = await database.getAllKeywords(userId);
      if (allKeywords.length === 0) {
        await ctx.reply('📝 暂无关键词');
        return;
      }
      let message = '🔑 所有关键词：\n\n';
      allKeywords.forEach((keyword, index) => {
        message += `${index + 1}. ${keyword}\n`;
      });
      await ctx.reply(message);
        }
        catch (error) {
      console.error('Error showing keywords:', error);
      await ctx.reply('❌ 获取关键词失败');
    }
  }
    async addKeywords(ctx: Context, userId: number, keywords: string[]) {
    try {
      let addedCount = 0;
      let alreadyExistsCount = 0;
      for (const keyword of keywords) {
        const exists = await database.keywordExists(keyword, userId);
        if (!exists) {
          // 这里只是记录关键词，实际媒体文件需要在上传时关联
          addedCount++;
                }
                else {
          alreadyExistsCount++;
        }
      }
      let message = '';
      if (addedCount > 0) {
        message += `✅ 成功添加 ${addedCount} 个新关键词\n`;
      }
      if (alreadyExistsCount > 0) {
        message += `ℹ️ ${alreadyExistsCount} 个关键词已存在\n`;
      }
      await ctx.reply(message || '❌ 没有添加任何关键词');
        }
        catch (error) {
      console.error('Error adding keywords:', error);
      await ctx.reply('❌ 添加关键词失败');
    }
  }
    async removeKeywords(ctx: Context, userId: number, keywords: string[]) {
    try {
      let removedCount = 0;
      for (const keyword of keywords) {
        const deleted = await database.deleteKeyword(keyword, userId);
        if (deleted > 0) {
          removedCount++;
        }
      }
      if (removedCount > 0) {
        await ctx.reply(`✅ 成功删除 ${removedCount} 个关键词`);
            }
            else {
        await ctx.reply('❌ 没有找到要删除的关键词');
      }
        }
        catch (error) {
      console.error('Error removing keywords:', error);
      await ctx.reply('❌ 删除关键词失败');
    }
  }
    async clearKeywords(ctx: Context, userId: any) {
    try {
      // 获取所有关键词并删除
      const allKeywords = await database.getAllKeywords(userId);
      let removedCount = 0;
      for (const keyword of allKeywords) {
        const deleted = await database.deleteKeyword(keyword, userId);
        removedCount += deleted;
      }
      await ctx.reply(`✅ 已清空所有关键词（共删除 ${removedCount} 个关联）`);
        }
        catch (error) {
      console.error('Error clearing keywords:', error);
      await ctx.reply('❌ 清空关键词失败');
    }
  }
    async handleSetForwardDelay(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
        const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
        if (!messageText) return;
        const delay = parseInt(messageText.split(' ')[1]);
    if (isNaN(delay)) {
        await ctx.reply('Invalid delay. Please provide a number in seconds.');
        return;
    }
    await this.forwardingService.setForwardDelay(userId, delay);
    await ctx.reply(`Forward delay set to: ${delay} seconds`);
  }
    async handleShowForwardDelay(ctx: Context) {
    const userId = ctx.from?.id;
        if (!userId)
            return;
    const config = await this.forwardingService.getUserConfig(userId);
    await ctx.reply(`Current forward delay: ${config.forwardDelay} seconds`);
  }
  // ========== 账号控制功能处理器（新增） ==========
    async handleAccountMenu(ctx: Context) {
    if (ctx.callbackQuery) await ctx.answerCbQuery();
    await userAccountCommands.handleAccountMenu(ctx);
  }
    async handleAccountList(ctx: Context) {
    await userAccountCommands.handleAccountList(ctx);
  }
    async handleSwitchAccount(ctx: Context) {
    await userAccountCommands.handleSwitchAccount(ctx);
  }
    async handleDeleteAccount(ctx: Context) {
    await userAccountCommands.handleDeleteAccount(ctx);
  }
    async handleDeleteAccountCallback(ctx: Context) {
        const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
        if (!callbackData || typeof callbackData !== 'string') return;
    const accountId = parseInt(callbackData.replace('delete_account_', ''));
    await userAccountCommands.handleDeleteAccountCallback(ctx, accountId);
  }
    async handleConfirmDeleteCallback(ctx: Context) {
        const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
        if (!callbackData || typeof callbackData !== 'string') return;
    const accountId = parseInt(callbackData.replace('confirm_delete_', ''));
    await userAccountCommands.handleConfirmDelete(ctx, accountId);
  }
    async handleCancelDeleteCallback(ctx: Context) {
    await userAccountCommands.handleCancel(ctx);
  }
    async handleSendMessage(ctx: Context) {
    if (ctx.callbackQuery) await ctx.answerCbQuery();
    await ctx.reply('💬 请输入接收消息的用户名（带@）：');
  }
    async handleAutoReply(ctx: Context) {
    if (ctx.callbackQuery) await ctx.answerCbQuery();
    await userAccountCommands.handleAutoReplyMenu(ctx);
  }
    async handleSendMedia(ctx: Context) {
    if (ctx.callbackQuery) await ctx.answerCbQuery();
    await userAccountCommands.handleSendMediaLibrary(ctx);
  }
    async handleExtractPublishKeywords(ctx: Context) {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from?.id;
    // 清掉搜索等会话，防止输入时间段被当成搜索关键词
    if (userId) {
      this.userSessions.delete(userId);
      try { await database.clearUserSession(userId); } catch {}
    }
    await userAccountCommands.handleExtractPublishKeywordsStart(ctx);
  }
    async handleAccountStatus(ctx: Context) {
    if (ctx.callbackQuery) await ctx.answerCbQuery();
    await userAccountCommands.handleAccountList(ctx);
  }
    async handleAddAccount(ctx: Context) {
    if (ctx.callbackQuery) await ctx.answerCbQuery();
    await userAccountCommands.handleAddAccount(ctx);
  }
    async handleTaskStatus(ctx: Context) {
    if (ctx.callbackQuery) await ctx.answerCbQuery();
    await userAccountCommands.handleTaskStatus(ctx);
  }
    async handleSwitchAccountCallback(ctx: Context) {
        const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
        if (!callbackData || typeof callbackData !== 'string') return;
    const accountId = parseInt(callbackData.replace('switch_account_', ''));
    await userAccountCommands.handleSwitchAccountCallback(ctx, accountId);
  }
    async handleSetAutoReplyMsg(ctx: Context) {
    await ctx.answerCbQuery();
    await userAccountCommands.handleSetAutoReplyMessage(ctx);
  }
    async handleEnableAutoReply(ctx: Context) {
    await ctx.answerCbQuery();
    await userAccountCommands.handleEnableAutoReply(ctx);
  }
    async handleDisableAutoReply(ctx: Context) {
    await ctx.answerCbQuery();
    await userAccountCommands.handleDisableAutoReply(ctx);
  }
    async handleLoginMethodSession(ctx: Context) {
    await ctx.answerCbQuery();
    await userAccountCommands.handleLoginMethodCallback(ctx, 'session');
  }
  // 时间选择回调（统一使用后台任务模式）
    async handleSendHours(ctx: Context) {
        const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
        if (!callbackData || typeof callbackData !== 'string') return;
    const hours = parseInt(callbackData.replace('send_hours_', ''));
    await userAccountCommands.handleHoursCallback(ctx, hours);
  }
  
  async handleCustomRangeCallback(ctx: Context) {
    await ctx.answerCbQuery();
    await userAccountCommands.handleCustomRangeStart(ctx);
  }
  // 账号控制取消命令处理
    async handleAccountCancel(ctx: Context) {
    await userAccountCommands.handleCancel(ctx);
  }

  async handleStopTaskCallback(ctx: Context) {
    const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!callbackData || typeof callbackData !== 'string') return;
    const taskId = callbackData.replace('stop_task_', '');
    await userAccountCommands.handleStopTaskCallback(ctx, taskId);
  }

  async handleAccountMenuClose(ctx: Context) {
    await userAccountCommands.handleMenuClose(ctx);
  }

  // ========== 🔘 按钮制作功能处理器 ==========
  private async handleButtonMaker(ctx: Context): Promise<void> {
    await ButtonMakerHandler.handleStart(ctx, database);
  }

  private async handleSendButtonToMe(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    const session = this.userSessions.get(userId) || await database.getUserSession(userId);
    if (session && session.mode === BotMode.ButtonMaker) {
        await ButtonMakerHandler.handleSendToMe(ctx, database, session);
    }
  }

  private async handleSendButtonToGroup(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    const session = this.userSessions.get(userId) || await database.getUserSession(userId);
    if (session && session.mode === BotMode.ButtonMaker) {
        await ButtonMakerHandler.handleSendToGroup(ctx, database, session, this.bot);
    }
  }

  private async handleCancelButtonMaker(ctx: Context): Promise<void> {
    await ButtonMakerHandler.handleCancel(ctx, database);
  }

  private async handleAddMoreButton(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    const session = this.userSessions.get(userId) || await database.getUserSession(userId);
    if (session && session.mode === BotMode.ButtonMaker) {
        await ButtonMakerHandler.handleAddMoreButton(ctx, database, session);
    }
  }

  private async handlePreviewButtonMaker(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    const session = this.userSessions.get(userId) || await database.getUserSession(userId);
    if (session && session.mode === BotMode.ButtonMaker) {
        await ButtonMakerHandler.handlePreview(ctx, database, session);
    }
  }

  private async handleButtonMakerChannelSelect(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!callbackData) return;
    
    const channelId = callbackData.replace('bm_send_to_', '');
    const session = this.userSessions.get(userId) || await database.getUserSession(userId);
    if (session && session.mode === BotMode.ButtonMaker) {
        await ButtonMakerHandler.handleGroupSelection(ctx, database, session, channelId);
    }
  }

  // ========== 相册制作功能处理器 ==========
  private async handleAlbumStart(ctx: Context): Promise<void> {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    await AlbumHandler.handleStart(ctx, database, this.userSessions);
  }

  private async handleCancelAlbumMaker(ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    
    AlbumHandler.clearAlbumSessionState(userId);
    this.userSessions.delete(userId);
    await database.clearUserSession(userId);
    
    await ctx.reply('❌ 已退出相册制作模式。');
  }

  private async handleFinishAlbum(ctx: Context): Promise<void> {
    await ctx.answerCbQuery('已开始后台生成').catch(() => {});
    const userId = ctx.from?.id;
    if (!userId) return;

    // handleFinish 会立刻返回并把下载放到后台，不阻塞搜索/发布等
    await AlbumHandler.handleFinish(ctx, database, this.userSessions);
    this.userSessions.delete(userId);
  }

  private async handleMyAlbums(ctx: Context): Promise<void> {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    await AlbumHandler.handleMyAlbums(ctx, database);
  }

  private async handleAllUserAlbums(ctx: Context): Promise<void> {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    await AlbumHandler.handleAllUserAlbums(ctx, database);
  }

  private async handleAdminAlbumAuth(ctx: Context): Promise<void> {
    await AlbumHandler.handleAdminAuthStart(ctx, database);
  }

  private async handleGrantAlbumAuth(ctx: Context): Promise<void> {
    const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!callbackData) return;
    
    const parts = callbackData.split('_');
    const targetUserId = parseInt(parts[2]);
    const duration = parts[3]; // '90', '180', or 'lifetime'
    
    await AlbumHandler.handleGrantAuth(ctx, database, targetUserId, duration);
  }

  // ========== 🏷️ 标签筛选处理器 ==========
  private async handleStartTagFilter(ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
    await TagFilterHandler.handleStart(ctx, database);
  }

  private async handleCancelTagFilter(ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    
    this.userSessions.delete(userId);
    await database.clearUserSession(userId);
    
    await ctx.editMessageText('❌ 已退出标签筛选模式。');
  }

  private async handleTagSelectCallback(ctx: Context): Promise<void> {
    const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!callbackData) return;
    const tag = callbackData.replace('tag_select_', '');
    await ctx.answerCbQuery(`🔍 正在筛选: ${tag}`);
    await TagFilterHandler.handleTagInput(ctx, database, tag);
  }

  private async handleTagViewCallback(ctx: Context): Promise<void> {
    const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!callbackData) return;
    const keyword = callbackData.replace('tag_view_', '');
    await ctx.answerCbQuery();
    await SearchHandler.handleSearch(ctx, keyword, database);
  }

  private async handleAdminManageTags(ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
    await TagFilterHandler.handleAdminManageTags(ctx, database);
  }

  private async handleAdminAddTagPrompt(ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
    const userId = ctx.from?.id;
    if (userId) {
        const session = this.userSessions.get(userId) || await database.getUserSession(userId);
        if (session) {
            session.pendingText = 'adding_tag';
            this.userSessions.set(userId, session);
        }
    }
    await TagFilterHandler.handleAdminAddTagPrompt(ctx);
  }

  private async handleAdminDelTagList(ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
    await TagFilterHandler.handleAdminDelTagList(ctx, database);
  }

  private async handleAdminDelTagCallback(ctx: Context): Promise<void> {
    const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!callbackData) return;
    await ctx.answerCbQuery().catch(() => {});
    const tag = callbackData.replace('admin_del_tag_do_', '');
    await TagFilterHandler.handleAdminDelTag(ctx, database, tag);
  }

  private async handleDeleteAlbum(ctx: Context): Promise<void> {
    const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!callbackData) return;
    await ctx.answerCbQuery().catch(() => {});
    const albumId = callbackData.replace('delete_album_', '');
    await AlbumHandler.handleDeleteAlbum(ctx, database, albumId);
  }

  // ========== 关注欢迎功能处理器 ==========
  private async handleSetJoinWelcome(ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
    await JoinWelcomeHandler.handleStart(ctx, database);
  }

  private async handleCancelJoinWelcome(ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
    await JoinWelcomeHandler.handleCancel(ctx, database);
  }

  private async handleAddMoreWelcomeButton(ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    const session = this.userSessions.get(userId) || await database.getUserSession(userId);
    if (session) {
        await JoinWelcomeHandler.handleAddMoreButton(ctx, database, session);
    }
  }

  private async handleConfirmSaveJoinWelcome(ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    const session = this.userSessions.get(userId) || await database.getUserSession(userId);
    if (session) {
        await JoinWelcomeHandler.handleConfirmSave(ctx, database, session);
    }
  }

  // ========== 定向发送资料功能处理器 ==========
    private async handleStartDirectSend(ctx: Context): Promise<void> {
        await ctx.answerCbQuery();
        await DirectSendHandler.handleStart(ctx, database);
    }

    private async handleStartBroadcastData(ctx: Context): Promise<void> {
        await ctx.answerCbQuery();
        await BroadcastDataHandler.handleStart(ctx, database);
    }

    private async handleExecuteBroadcastData(ctx: Context): Promise<void> {
        const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
        if (!callbackData) return;
        const keyword = callbackData.replace('confirm_broadcast_data_', '');
        await BroadcastDataHandler.executeBroadcast(ctx, database, this.bot, keyword);
    }

    private async handleCancelDirectSend(ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    
    // 如果是编辑消息（来自内联按钮）
    try {
        await ctx.editMessageText('❌ 已退出定向发送模式。');
    } catch (e) {
        await ctx.reply('❌ 已退出定向发送模式。');
    }
    
    await database.clearUserSession(userId);
    this.userSessions.delete(userId);
  }

  private async handleChatJoinRequest(ctx: Context) {
    const joinRequest = ctx.chatJoinRequest;
    if (!joinRequest) return;

    const userId = joinRequest.from.id;
    const config = await database.getJoinWelcomeConfig();

    if (config && config.enabled) {
        try {
            // 构建内联键盘
            const buttonRows = config.buttons.map((b: any) => [Markup.button.url(b.text, b.url)]);
            const keyboard = buttonRows.length > 0 ? Markup.inlineKeyboard(buttonRows) : undefined;

            if (config.messageType === 'text') {
                await this.bot.telegram.sendMessage(userId, config.messageContent.text, keyboard);
            } else if (config.messageType === 'photo') {
                await this.bot.telegram.sendPhoto(userId, config.messageContent.file_id, {
                    caption: config.messageContent.caption,
                    ...keyboard
                });
            } else if (config.messageType === 'video') {
                await this.bot.telegram.sendVideo(userId, config.messageContent.file_id, {
                    caption: config.messageContent.caption,
                    ...keyboard
                });
            }
            console.log(`[自动欢迎] 🚀 已向用户 ${userId} 发送关注欢迎信息`);
        } catch (error) {
            console.error(`[自动欢迎] ❌ 向用户 ${userId} 发送私信失败:`, error);
        }
    }
  }
}
