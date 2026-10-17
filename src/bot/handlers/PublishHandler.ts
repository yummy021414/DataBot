import { Context, Telegraf } from 'telegraf';
import { database } from '../../database';
import { UserSession } from '../../types';
import { config, isAdminUser, isSuperAdmin } from '../../config';
import { recordPublishEvent } from '../../services/publishAudit';
import { SearchHandler } from './SearchHandler';
import { publicationQueue, publicationBatches, publicationChunks } from '../../services/publicationQueue';
import { scheduledPublish, parsePublishTime, publishTimeLabel } from '../../services/scheduledPublish';

export class PublishHandler {
  private static homeButtons = { reply_markup: { inline_keyboard: [[{ text: '🏠 返回主菜单', callback_data: 'back_to_main' }]] } };
  private static creatingSchedules = new Set<number>();
  static async scheduleAction(ctx: Context, sessions: Map<number, UserSession>, db: typeof database): Promise<void> {
    const uid = ctx.from?.id;
    if (!uid || !isAdminUser(uid)) { await ctx.answerCbQuery('仅管理员可用'); return; }
    const action = (ctx.callbackQuery as any)?.data as string;
    await ctx.answerCbQuery().catch(() => {});
    if (action === 'schedule_list' || action.startsWith('schedule_cancel_')) {
      if (action.startsWith('schedule_cancel_')) scheduledPublish.cancel(uid, action.slice('schedule_cancel_'.length));
      const jobs = scheduledPublish.list(uid);
      const labels = { queued: '等待发送', running: '发送中', complete: '完成', cancelled: '已取消', attention: '需核对' };
      await ctx.reply(jobs.length ? jobs.map(j => `${j.id} · ${labels[j.status]} · ${publishTimeLabel(j.at)}\n关键词：${j.keywords.join('、')}\n目标：${j.channels.join('、')}\n进度：${j.cursor}/${j.units.length}${j.error ? '\n原因：' + j.error : ''}`).join('\n\n').slice(0, 3900) : '暂无定时任务', {
        reply_markup: { inline_keyboard: [...jobs.filter(j => ['queued', 'attention'].includes(j.status)).map(j => [{ text: `取消 ${j.id}`, callback_data: `schedule_cancel_${j.id}` }]), [{ text: '🏠 返回主菜单', callback_data: 'back_to_main' }]] }
      }); return;
    }
    const session: any = sessions.get(uid) || await db.getUserSession(uid);
    if (!session || session.mode !== 'publish' || !this.getSelectedChannels(session).length) { await ctx.reply('请先进入发布模式并确认目标频道。'); return; }
    if (action === 'schedule_begin') {
      session.step = 'waiting_keyword';
      session.scheduleStage = 'time'; session.scheduleAt = undefined; session.scheduleKeywords = undefined;
      await ctx.reply('⏰ 请输入开始时间（北京时间）：\n18:00 或 2026-09-24 18:00\n只输入时分且今天已过，会设为明天。到点开始按队列依次发送。', this.homeButtons);
    } else if (action === 'schedule_immediate') {
      session.step = 'waiting_keyword';
      delete session.scheduleStage; delete session.scheduleAt; delete session.scheduleKeywords;
      await ctx.reply('已切换为立即发布，请输入关键词。', this.homeButtons);
    } else if (action === 'schedule_confirm' && session.scheduleStage === 'confirm') {
      if (this.creatingSchedules.has(uid)) return;
      this.creatingSchedules.add(uid);
      try {
        const job = await scheduledPublish.add(uid, session.scheduleAt, this.getSelectedChannels(session), session.scheduleKeywords);
        delete session.scheduleStage; delete session.scheduleAt; delete session.scheduleKeywords;
        session.step = 'idle';
        sessions.set(uid, session); await db.saveUserSession(uid, session);
        await ctx.reply(`✅ 已加入队列：${job.id}\n${publishTimeLabel(job.at)}\n目标：${job.channels.join('、')}\n关键词：${job.keywords.join('、')}\n可返回发布模式选择其他频道，继续创建独立任务。`, { reply_markup: { inline_keyboard: [
          [{ text: '⏰ 再建定时任务', callback_data: 'schedule_begin' }, { text: '📋 定时任务', callback_data: 'schedule_list' }],
          [{ text: '🏠 返回主菜单', callback_data: 'back_to_main' }]
        ] } });
      } catch (e: any) { await ctx.reply(`❌ ${e.message}`); }
      finally { this.creatingSchedules.delete(uid); }
    }
    sessions.set(uid, session); await db.saveUserSession(uid, session);
  }

  static async scheduleInput(ctx: Context, text: string, session: any, db: typeof database): Promise<boolean> {
    if (!session.scheduleStage) return false;
    const uid = ctx.from!.id;
    if (!isAdminUser(uid)) return true;
    try {
      if (session.scheduleStage === 'time') {
        session.scheduleAt = parsePublishTime(text); session.scheduleStage = 'keywords';
        await ctx.reply(`时间：${publishTimeLabel(session.scheduleAt)}\n请输入这次任务的关键词（空格分隔多个关键词）。`, this.homeButtons);
      } else if (session.scheduleStage === 'keywords') {
        const known = await db.getAllKeywords(isSuperAdmin(uid) ? undefined : uid);
        const keywords = SearchHandler.parseSearchKeywords(text, known);
        session.scheduleKeywords = keywords.length ? keywords : [text.trim()];
        session.scheduleStage = 'confirm';
        await ctx.reply(`确认定时发布\n${publishTimeLabel(session.scheduleAt)}\n目标：${this.getSelectedChannels(session).join('、')}\n关键词：${session.scheduleKeywords.join('、')}\n保存后可继续创建不同时间、不同频道的任务。`, { reply_markup: { inline_keyboard: [
          [{ text: '✅ 加入定时队列', callback_data: 'schedule_confirm' }],
          [{ text: '修改时间', callback_data: 'schedule_begin' }, { text: '取消定时设置', callback_data: 'cancel' }],
          [{ text: '🏠 返回主菜单', callback_data: 'back_to_main' }]
        ] } });
      } else await ctx.reply('请先点击“加入定时队列”或取消定时设置。');
      await db.saveUserSession(uid, session);
    } catch (e: any) { await ctx.reply(`❌ ${e.message}`); }
    return true;
  }
  /** 同一用户同时只跑一个发布任务，避免卡死长轮询后消息全堵死 */
  private static publishingUsers = new Set<number>();

  /** Telegram 调用超时，避免 await 永久挂起导致整个 bot 不再收消息 */
  private static withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  private static async safeReply(ctx: Context, text: string, extra?: any): Promise<void> {
    try {
      await this.withTimeout(Promise.resolve(ctx.reply(text, extra)), 15000, 'ctx.reply');
    } catch (e: any) {
      console.error(`📢 [发布] 回复用户失败: ${e?.message || e}`);
    }
  }

  private static getSelectedChannels(session: UserSession | null | undefined): string[] {
    if (!session) return [];
    const channels = session.selectedChannels?.length
      ? session.selectedChannels
      : session.selectedChannel
        ? [session.selectedChannel]
        : [];
    return Array.from(new Set(channels.map(String).filter(Boolean)));
  }

  static async handleKeywordInput(
    ctx: Context, 
    keyword: string, 
    userSessions: Map<number, UserSession>, 
    db: typeof database, 
    bot: Telegraf
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = userSessions.get(userId);
    const selectedChannels = this.getSelectedChannels(session);
    console.log(
      `📢 [发布] 收到输入="${keyword}" | mode=${session?.mode} step=${session?.step} channels=${selectedChannels.join(',') || '无'}`
    );

    if (!session || session.mode !== 'publish' || selectedChannels.length === 0) {
      console.warn(
        `📢 [发布] 静默跳过：session=${!!session} mode=${session?.mode} selectedChannels=${selectedChannels.join(',') || '无'}`
      );
      return;
    }

    if (await this.scheduleInput(ctx, keyword, session, db)) return;

    if (this.publishingUsers.has(userId)) {
      console.warn(`📢 [发布] 用户 ${userId} 仍有任务在跑，拒绝新关键词 "${keyword}"`);
      // 不 await，避免再次卡死长轮询
      void this.safeReply(ctx, '⏳ 上一次发布还在进行中，请等完成后再发下一个关键词');
      return;
    }

    // 超级管理员可发全库；普通管理员发自己的；用户跟超管库（与搜索一致）
    let scopeUserId: number | undefined;
    if (isSuperAdmin(userId)) {
      scopeUserId = undefined;
    } else if (isAdminUser(userId)) {
      scopeUserId = userId;
    } else {
      scopeUserId = config.superAdminId;
    }

    this.publishingUsers.add(userId);
    console.log(`📢 [发布] 已接手任务，后台执行（不阻塞收消息） scope=${scopeUserId ?? '全库'}`);

    // 关键关键 关键：不要在长轮询 update 里 await 整段发布
    // 否则 Telegram API 一旦卡住，后面所有消息都不会再进日志
    void this.runPublishJob(ctx, keyword, session, userSessions, db, bot, userId, scopeUserId)
      .catch((err) => {
        console.error('📢 [发布] 后台任务异常:', err);
        void this.safeReply(ctx, '❌ 发布时发生错误，请稍后重试。');
      })
      .finally(() => {
        this.publishingUsers.delete(userId);
        console.log(`📢 [发布] 用户 ${userId} 任务结束，解锁`);
      });
  }

  private static async runPublishJob(
    ctx: Context,
    keyword: string,
    session: UserSession,
    userSessions: Map<number, UserSession>,
    db: typeof database,
    bot: Telegraf,
    userId: number,
    scopeUserId: number | undefined
  ): Promise<void> {
    const channelIds = this.getSelectedChannels(session);
    const pausedChannels = new Set<string>();
    const failureReasons = new Map<string, string>();
    try {
      console.log(`📢 [发布] 开始解析关键词库…`);
      const knownKeywords = await db.getAllKeywords(scopeUserId);
      console.log(`📢 [发布] 词库 ${knownKeywords.length} 个，解析输入…`);

      let keywords = SearchHandler.parseSearchKeywords(keyword, knownKeywords);
      if (keywords.length === 0) {
        keywords = [keyword.trim()].filter(Boolean);
      }
      console.log(`📢 [发布] 解析结果: ${JSON.stringify(keywords)}`);

      await this.safeReply(
        ctx,
        keywords.length > 1
          ? `🔍 识别到 ${keywords.length} 个关键词，将按顺序发布：\n${keywords.map((k, i) => `${i + 1}. ${k}`).join('\n')}`
          : '🔍 正在搜索并发布...'
      );

      if (channelIds.length === 0) {
        await this.safeReply(ctx, '❌ 请先选择至少一个目标群或频道。');
        return;
      }
      const results: Array<{ kw: string; count: number; ok: boolean; missing: boolean; failedChannels: string[] }> = [];
      let totalPublished = 0;

      for (let ki = 0; ki < keywords.length; ki++) {
        const kw = keywords[ki];
        const mediaItems = await db.getMediaByKeyword(kw, scopeUserId);

        if (mediaItems.length === 0) {
          results.push({ kw, count: 0, ok: false, missing: true, failedChannels: [] });
          console.warn(`📢 [发布] 跳过未找到的关键词: "${kw}"`);
          await this.safeReply(ctx, `⚠️ 「${kw}」库里没有资料，已跳过`);
          continue;
        }

        const batchEstimate = publicationBatches(mediaItems).length;

        console.log(`📢 [发布] ${ki + 1}/${keywords.length} 关键词="${kw}" → ${mediaItems.length} 文件 / 约 ${batchEstimate} 组`);
        await this.safeReply(
          ctx,
          `⏳ 正在发布「${kw}」（${ki + 1}/${keywords.length}）：${mediaItems.length} 个文件 / ${batchEstimate} 组\n` +
          `（发送完成后会提示）`
        );
        const successes: Array<{ channelId: string; count: number }> = [];
        const failedChannels: string[] = [];
        await Promise.all(channelIds.map(async channelId => {
          if (pausedChannels.has(channelId)) { failedChannels.push(channelId); return; }
          try {
            const publishedCount = await this.publishToChannel(bot, channelId, mediaItems, kw, async (done, total) => {
              if (done === total || done % 5 === 0) {
                console.log(`📢 [发布进度] "${kw}" → ${channelId} ${done}/${total} 组`);
              }
            });
            successes.push({ channelId, count: publishedCount });
            recordPublishEvent({
              keyword: kw,
              userId,
              channelId,
              source: 'publish',
              count: publishedCount
            });
          } catch (error: any) {
            failedChannels.push(channelId);
            pausedChannels.add(channelId);
            failureReasons.set(channelId, String(error?.message || error).slice(0, 500));
            console.error(`📢 [发布] "${kw}" 发往 ${channelId} 失败:`, error?.message || error);
          }
        }));

        if (successes.length === 0) {
          results.push({ kw, count: 0, ok: false, missing: false, failedChannels });
          await this.safeReply(ctx, `⚠️ 「${kw}」发送到所有目标均失败，已继续处理下一个关键词。`);
          continue;
        }

        // 资料条目仍保留一个主发布频道，兼容现有统计与筛选；审计日志会记录全部目标。
        for (const item of mediaItems) {
          await db.updateMediaPublished(item.id, channelIds.find(id => successes.some(s => s.channelId === id))!);
        }

        const publishedCount = successes.reduce((sum, item) => sum + item.count, 0);
        results.push({ kw, count: publishedCount, ok: true, missing: false, failedChannels });
        totalPublished += publishedCount;

      }

      if (userSessions.get(userId) === session) {
        session.currentKeyword = undefined;
        session.step = 'waiting_keyword';
        await db.saveUserSession(userId, session);
      }

      const channelNames = await Promise.all(channelIds.map(channelId => this.getChannelName(bot, channelId)));
      const okList = results.filter(r => r.ok);
      const missList = results.filter(r => r.missing);
      const failedList = results.filter(r => !r.ok && !r.missing);

      let summary =
        `✅ 发布完成！\n\n` +
        `目标群/频道（${channelNames.length}）：\n${channelNames.map(name => `• ${name}`).join('\n')}\n` +
        `输入: 「${keyword}」\n` +
        `成功关键词: ${okList.length}/${keywords.length}\n` +
        `共发布 ${totalPublished} 个媒体文件\n`;

      if (okList.length > 0) {
        summary += `\n已发布：\n` + okList.map(r => `• ${r.kw}（${r.count}）`).join('\n') + '\n';
      }
      if (missList.length > 0) {
        summary += `\n未找到：\n` + missList.map(r => `• ${r.kw}`).join('\n') + '\n';
      }
      if (failedList.length > 0) {
        summary += `\n发送失败：\n` + failedList.map(r => `• ${r.kw}`).join('\n') + '\n';
      }
      const partialFailures = results.filter(result => result.failedChannels.length > 0);
      if (partialFailures.length > 0) {
        summary += `\n部分目标未完成（请核对频道最后一组，勿重复发送整批）：\n` + partialFailures
          .map(result => `• ${result.kw}：${result.failedChannels.join('、')}`)
          .join('\n') + '\n';
      }

      summary +=
        (failureReasons.size ? '\n未完成原因：\n' + [...failureReasons].map(([id, reason]) => `${id}：${reason}`).join('\n') + '\n' : '') +
        `\n🔄 发布模式仍然激活\n` +
        `💡 可继续输入多个关键词（如：优米樊樊 或 优米 樊樊），将按顺序连发。`;

      await this.safeReply(ctx, summary, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ 退出发布模式', callback_data: 'cancel' }],
            [{ text: '🏠 返回主菜单', callback_data: 'back_to_main' }]
          ]
        }
      });

    } catch (error) {
      console.error('发布搜索错误:', error);
      await this.safeReply(ctx, '❌ 搜索时发生错误，请稍后重试。');
    }
  }

  static async handleConfirmPublish(
    ctx: Context, 
    userSessions: Map<number, UserSession>, 
    db: typeof database, 
    bot: Telegraf
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = userSessions.get(userId);
    const channelIds = this.getSelectedChannels(session);
    if (!session || session.mode !== 'publish' || channelIds.length === 0 || !session.currentKeyword) {
      return;
    }

    try {
      await ctx.reply('📢 正在发布到频道...');

      // 获取媒体文件（只获取用户自己的数据）
      const mediaItems = await db.getMediaByKeyword(session.currentKeyword, userId);
      
      if (mediaItems.length === 0) {
        await ctx.reply('❌ 未找到要发布的媒体文件。');
        return;
      }

      // 发布到频道
      const successfulChannels: string[] = [];
      let publishedCount = 0;
      for (const channelId of channelIds) {
        try {
          publishedCount += await this.publishToChannel(bot, channelId, mediaItems, session.currentKeyword);
          successfulChannels.push(channelId);
        } catch (error) {
          console.error(`发布到频道 ${channelId} 失败:`, error);
        }
      }
      if (successfulChannels.length === 0) throw new Error('所有目标频道均发送失败');

      // 更新数据库中的发布状态（保留首个成功目标，兼容旧数据结构）
      for (const item of mediaItems) {
        await db.updateMediaPublished(item.id, successfulChannels[0]);
      }

      const publishedKeyword = session.currentKeyword; // 保存当前关键词用于显示
      recordPublishEvent({
        keyword: publishedKeyword,
        userId,
        channelId: successfulChannels[0],
        source: 'publish',
        count: publishedCount
      });
      
      // 重置会话状态，保持在发布模式但清空当前关键词，允许连续发布
      session.currentKeyword = undefined;
      session.step = 'waiting_keyword';
      userSessions.set(userId, session);
      await db.saveUserSession(userId, session);
      
      await ctx.reply(
        `✅ 发布完成！\n\n` +
        `关键词: "${publishedKeyword}"\n` +
        `目标频道: ${(await Promise.all(successfulChannels.map(channelId => this.getChannelName(bot, channelId)))).join('、')}\n` +
        `已发布 ${publishedCount} 个媒体文件\n\n` +
        `🔄 发布模式仍然激活\n` +
        `💡 继续输入下一个关键词进行发布，或点击取消退出发布模式。`,
        { 
          reply_markup: { 
            inline_keyboard: [
              [{ text: '❌ 退出发布模式', callback_data: 'cancel' }],
              [{ text: '🏠 返回主菜单', callback_data: 'back_to_main' }]
            ] 
          } 
        }
      );

    } catch (error) {
      console.error('发布错误:', error);
      await ctx.reply('❌ 发布时发生错误，请稍后重试。');
    }
  }

  private static async publishToChannel(
    bot: Telegraf, 
    channelId: string, 
    mediaItems: any[], 
    keyword: string,
    onBatchProgress?: (done: number, total: number) => void | Promise<void>
  ): Promise<number> {
    const batches = publicationBatches(mediaItems);
    return publicationQueue.run(bot.telegram, channelId, async send => {
      console.log('📢 开始发布 ' + mediaItems.length + ' 个媒体到频道 ' + channelId + ' | 关键词="' + keyword + '"');
      let count = 0;
      for (let i = 0; i < batches.length; i++) {
        for (const chunk of publicationChunks(batches[i])) {
          await send(chunk);
          count += chunk.length;
        }
        if (onBatchProgress) await onBatchProgress(i + 1, batches.length);
      }
      return count;
    });
  }

  private static groupMediaByType(mediaItems: any[]): { [key: string]: any[] } {
    const grouped: { [key: string]: any[] } = {};
    
    mediaItems.forEach(item => {
      if (!grouped[item.file_type]) {
        grouped[item.file_type] = [];
      }
      grouped[item.file_type].push(item);
    });
    
    return grouped;
  }

  private static formatMediaTypes(groupedMedia: { [key: string]: any[] }): string {
    let result = '';
    
    Object.entries(groupedMedia).forEach(([type, items]) => {
      const typeEmoji = this.getTypeEmoji(type);
      result += `${typeEmoji} ${type}: ${items.length} 个\n`;
    });
    
    return result;
  }

  private static getTypeEmoji(type: string): string {
    const emojiMap: { [key: string]: string } = {
      'photo': '🖼️',
      'video': '🎥',
      'document': '📄',
      'audio': '🎵',
      'voice': '🎤'
    };
    return emojiMap[type] || '📎';
  }

  private static chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private static async getChannelName(bot: Telegraf, channelId: string): Promise<string> {
    try {
      const chat = await bot.telegram.getChat(channelId);
      if ('title' in chat) {
        return chat.title;
      } else if ('first_name' in chat) {
        return chat.first_name + (chat.last_name ? ` ${chat.last_name}` : '');
      }
      return `📢 频道 ${channelId}`;
    } catch (error) {
      console.error(`获取频道名称失败 ${channelId}:`, error);
      return `📢 频道 ${channelId}`;
    }
  }

  private static async getChannelFullName(bot: Telegraf, channelId: string): Promise<string> {
    try {
      const chat = await bot.telegram.getChat(channelId);
      if ('title' in chat) {
        return `${chat.title} - 功能正常`;
      } else if ('first_name' in chat) {
        const name = chat.first_name + (chat.last_name ? ` ${chat.last_name}` : '');
        return `${name} - 功能正常`;
      }
      return `📢 频道 ${channelId}`;
    } catch (error) {
      console.error(`获取频道完整名称失败 ${channelId}:`, error);
      return `📢 频道 ${channelId}`;
    }
  }
}
