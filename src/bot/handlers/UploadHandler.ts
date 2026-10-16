import { Context, Telegraf } from 'telegraf';
import { database } from '../../database';
import { UserSession, MediaItem, BotMode } from '../../types';
import { config, getAdminChannelIds, getAdminPersistentChannelId, hasAdminChannelMap } from '../../config';
import { recordPublishEvent } from '../../services/publishAudit';
import { checkVaultAccess } from '../../services/vault';
import { tagCaptionForMedia } from '../../utils/keywordTag';
import { watermarkService } from '../../services/watermark';
import { publicationQueue, publicationBatches, publicationChunks, PublishSender } from '../../services/publicationQueue';

export class UploadHandler {
  /** 同一 Telegram 相册内收齐等待（ms） */
  private static readonly GROUP_SETTLE_MS = 1600;
  /** 全部停手后弹出「选择频道」（ms） */
  private static readonly SESSION_READY_MS = 2800;
  /** key = `${userId}:${groupKey}` */
  private static groupTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private static sessionReadyTimeouts: Map<number, NodeJS.Timeout> = new Map();
  /** 防止保存按钮重复点击造成重复入库/重复转码 */
  private static activeUploadJobs: Set<number> = new Set();

  static isProcessing(userId: number): boolean { return this.activeUploadJobs.has(userId); }

  private static dispatch(ctx: Context, work: () => Promise<void>): void {
    const uid = ctx.from?.id;
    if (!uid) return;
    if (this.activeUploadJobs.has(uid)) {
      void ctx.answerCbQuery('资料正在处理中').catch(() => {});
      return;
    }
    this.activeUploadJobs.add(uid);
    setImmediate(() => {
      void work().catch(async () => {
        await ctx.reply('处理未完成，资料会话已保留，请重试。').catch(() => {});
      }).finally(() => this.activeUploadJobs.delete(uid));
    });
  }

  static async handleSaveOnly(ctx: Context, sessions: Map<number, UserSession>, db: typeof database): Promise<void> {
    this.dispatch(ctx, () => this.saveOnly(ctx, sessions, db));
  }

  static async handleSaveAndPublish(ctx: Context, sessions: Map<number, UserSession>, db: typeof database, bot: Telegraf): Promise<void> {
    this.dispatch(ctx, () => this.saveAndPublish(ctx, sessions, db, bot));
  }

  /** 资料 caption 含非法字符时 Telegram 会 400，导致上传完成却无反馈 */
  private static sanitizeTelegramText(text: string): string {
    if (text == null) return '';
    const out: string[] = [];
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        if (i + 1 < s.length) {
          const next = s.charCodeAt(i + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            out.push(s[i], s[i + 1]);
            i++;
            continue;
          }
        }
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) continue;
      if (code === 0) continue;
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
      if (code === 0x7f) continue;
      out.push(s[i]);
    }
    let result = out.join('');
    result = Buffer.from(result, 'utf8').toString('utf8');
    if (result.length > 3900) result = result.slice(0, 3900) + '…';
    return result;
  }

  static async resolveUploadSession(
    userId: number,
    userSessions: Map<number, UserSession>,
    db: typeof database
  ): Promise<UserSession | null> {
    let session = userSessions.get(userId);
    if (!session) {
      session = await db.getUserSession(userId);
      if (session) userSessions.set(userId, session);
    }
    return session || null;
  }

  private static isUploadSession(session: UserSession | null | undefined): boolean {
    if (!session) return false;
    return session.mode === BotMode.Upload || session.mode === BotMode.AddReview;
  }

  private static async safeNotifyUser(
    telegram: any,
    chatId: number,
    text: string,
    extra?: { reply_markup?: any }
  ): Promise<void> {
    try {
      await telegram.sendMessage(chatId, this.sanitizeTelegramText(text), extra);
    } catch (e: any) {
      console.error('[上传] 通知用户失败:', e?.message || e);
    }
  }

  private static countBatches(pending: any[]): number {
    return new Set(pending.map(m => m.batchId || 'legacy')).size;
  }

  private static getOrCreateBatchId(session: UserSession, groupKey: string): string {
    const map = ((session as any).batchIdByGroup || {}) as Record<string, string>;
    if (!map[groupKey]) {
      map[groupKey] = `batch_${groupKey}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      (session as any).batchIdByGroup = map;
    }
    return map[groupKey];
  }

  /** 相册通常只有第一条带 caption：收齐后把本组文案写到组内每条，避免丢失/串组 */
  private static syncGroupCaption(pending: any[], groupKey: string): string | undefined {
    const items = pending.filter((m: any) => m.groupKey === groupKey);
    if (items.length === 0) return undefined;
    const groupCaption = items.find((m: any) => m.caption && String(m.caption).trim())?.caption?.trim();
    for (const m of items) {
      m.groupCaption = groupCaption || undefined;
      // 保证组内至少有一条带 caption，供发布/搜索取「本组文案」
      if (groupCaption && !m.caption) {
        // 不给每条都写 caption（避免单发时刷屏），只记 groupCaption；发布时按组取
      }
    }
    // 把文案落到组内第一条（有 caption 的优先已有；否则补到第一条）
    if (groupCaption) {
      const hasAny = items.some((m: any) => m.caption && String(m.caption).trim());
      if (!hasAny) items[0].caption = groupCaption;
    }
    return groupCaption;
  }

  /** 按 batch 顺序生成文案预览（每组各自一条，不会串成第一组） */
  private static buildGroupCaptionSummary(pending: any[]): string {
    const order: string[] = [];
    const byBatch = new Map<string, any[]>();
    for (const m of pending) {
      const b = m.batchId || 'legacy';
      if (!byBatch.has(b)) {
        byBatch.set(b, []);
        order.push(b);
      }
      byBatch.get(b)!.push(m);
    }
    const lines: string[] = [];
    order.forEach((b, idx) => {
      const items = byBatch.get(b)!;
      const cap =
        items.find((m: any) => m.groupCaption && String(m.groupCaption).trim())?.groupCaption ||
        items.find((m: any) => m.caption && String(m.caption).trim())?.caption ||
        '';
      const preview = String(cap).replace(/\s+/g, ' ').trim();
      const short = preview.length > 40 ? preview.slice(0, 40) + '…' : preview;
      lines.push(
        short
          ? `${idx + 1}. ${items.length}个文件 — <i>${this.escapeHtml(short)}</i>`
          : `${idx + 1}. ${items.length}个文件 — <i>(无文案)</i>`
      );
    });
    // 预览太长时截断
    if (lines.length <= 12) return lines.join('\n');
    return lines.slice(0, 12).join('\n') + `\n…共 ${lines.length} 组`;
  }

  private static escapeHtml(s: string): string {
    return this.sanitizeTelegramText(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private static buildUploadReadyMessage(session: UserSession, brief = false): string {
    const total = session.pendingMedia?.length || 0;
    const groups = this.countBatches(session.pendingMedia || []);
    const kw = this.escapeHtml(session.currentKeyword || '');
    if (brief) {
      return (
        `📤 <b>上传模式</b>\n\n` +
        `✅ <b>资料收集完成</b>\n` +
        `• 关键词: <code>${kw}</code>\n` +
        `• 已接收: <b>${groups}</b> 组 / <b>${total}</b> 个文件\n\n` +
        `请点击下方按钮选择目标频道：`
      );
    }
    const captionSummary = this.buildGroupCaptionSummary(session.pendingMedia || []);
    return (
      `📤 <b>上传模式</b>\n\n` +
      `✅ <b>资料收集完成</b>\n` +
      `• 关键词: <code>${kw}</code>\n` +
      `• 已接收: <b>${groups}</b> 组 / <b>${total}</b> 个文件\n\n` +
      `<b>各组文案（各自独立，不会串组）：</b>\n${captionSummary}\n\n` +
      `💡 多组相册已自动分开，发布/搜索时每组用自己的文案。\n` +
      `请点击下方按钮选择目标频道：`
    );
  }

  private static itemCaption(media: any): string | undefined {
    const c = (media.caption || media.groupCaption || '').trim();
    return c || undefined;
  }

  private static captionWithTag(item: { caption?: string; keyword: string }, media: any, pending: any[]): string | undefined {
    const group = pending.filter(m => m.batchId === media.batchId);
    const noCaption = !group.some(m => this.itemCaption(m));
    return tagCaptionForMedia(item, noCaption && group[0] === media);
  }

  static async handleKeywordInput(
    ctx: Context, 
    keyword: string, 
    userSessions: Map<number, UserSession>, 
    db: typeof database
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    let session = userSessions.get(userId);
    if (!session) {
      session = await db.getUserSession(userId);
      if (session) userSessions.set(userId, session);
    }
    if (!session || !this.isUploadSession(session)) return;

    session.currentKeyword = keyword;
    session.step = 'waiting_media';
    session.pendingMedia = [];
    (session as any).batchIdByGroup = {};
    (session as any).currentBatchId = undefined;
    
    userSessions.set(userId, session);
    await db.saveUserSession(userId, session);

    await ctx.reply(
      `📤 上传模式\n\n` +
      `关键词: "${keyword}"\n\n` +
      `请上传媒体文件（支持图片、视频、文档、音频等）：\n\n` +
      `💡 可连续甩多组相册，机器人会按 Telegram 相册自动分组，不会并成一组。\n` +
      `💡 发完后稍等片刻，再点「选择频道」。`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ 取消', callback_data: 'cancel' }]] } }
    );
  }

  static async handleMediaMessage(
    ctx: Context, 
    mediaType: string, 
    userSessions: Map<number, UserSession>, 
    db: typeof database
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    let session = userSessions.get(userId);
    if (!session) {
      session = await db.getUserSession(userId);
      if (session) userSessions.set(userId, session);
    }
    const allowedSteps = ['waiting_media', 'selecting_channel', 'confirming'];
    if (!session || !this.isUploadSession(session)) {
      return;
    }
    if (!allowedSteps.includes(session.step)) {
      if (session.step === 'waiting_keyword') {
        await ctx.reply('💡 请先输入关键词，再上传媒体文件。');
      }
      return;
    }

    if (!session.pendingMedia) {
      session.pendingMedia = [];
    }

    let fileId: string | undefined;
    let caption: string | undefined;
    const msg: any = ctx.message;
    const mediaGroupId: string | undefined = msg?.media_group_id
      ? String(msg.media_group_id)
      : undefined;
    const messageId: number | undefined = typeof msg?.message_id === 'number' ? msg.message_id : undefined;

    if (ctx.message) {
      switch (mediaType) {
        case 'photo':
          if ('photo' in ctx.message && ctx.message.photo) {
            const photo = ctx.message.photo;
            if (photo.length > 0) {
              fileId = photo[photo.length - 1].file_id;
              caption = 'caption' in ctx.message ? ctx.message.caption : undefined;
            }
          }
          break;
        case 'video':
          if ('video' in ctx.message && ctx.message.video) {
            const video = ctx.message.video;
            fileId = video.file_id;
            caption = 'caption' in ctx.message ? ctx.message.caption : undefined;
          }
          break;
        case 'document':
          if ('document' in ctx.message && ctx.message.document) {
            const document = ctx.message.document;
            fileId = document.file_id;
            caption = 'caption' in ctx.message ? ctx.message.caption : undefined;
          }
          break;
        case 'audio':
          if ('audio' in ctx.message && ctx.message.audio) {
            const audio = ctx.message.audio;
            fileId = audio.file_id;
            caption = 'caption' in ctx.message ? ctx.message.caption : undefined;
          }
          break;
        case 'voice':
          if ('voice' in ctx.message && ctx.message.voice) {
            const voice = ctx.message.voice;
            fileId = voice.file_id;
            caption = 'caption' in ctx.message ? ctx.message.caption : undefined;
          }
          break;
        case 'animation':
          if ('animation' in ctx.message && ctx.message.animation) {
            const animation = ctx.message.animation;
            fileId = animation.file_id;
            caption = 'caption' in ctx.message ? ctx.message.caption : undefined;
          }
          break;
        case 'video_note':
          if ('video_note' in ctx.message && ctx.message.video_note) {
            const video_note = ctx.message.video_note;
            fileId = video_note.file_id;
            caption = undefined; // 视频动态没有caption
          }
          break;
      }
    }

    if (fileId) {
      // 确保caption不为空字符串
      const cleanCaption = caption && caption.trim().length > 0 ? caption.trim() : undefined;
      // Telegram 相册用 media_group_id；单图/单视频各自一组，避免和别的并在一起
      const groupKey = mediaGroupId || `single_${messageId || Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const batchId = this.getOrCreateBatchId(session, groupKey);
      
      session.pendingMedia.push({
        file_id: fileId,
        file_type: mediaType,
        caption: cleanCaption,
        batchId,
        mediaGroupId: mediaGroupId || null,
        groupKey
      });

      userSessions.set(userId, session);
      await db.saveUserSession(userId, session);

      const groupTimerKey = `${userId}:${groupKey}`;
      const existingGroupTimer = this.groupTimeouts.get(groupTimerKey);
      if (existingGroupTimer) clearTimeout(existingGroupTimer);

      // 仅等待「当前这一组相册」收齐，不影响其它组
      const groupTimer = setTimeout(() => {
        this.groupTimeouts.delete(groupTimerKey);
        const cur = userSessions.get(userId);
        if (!cur?.pendingMedia) return;
        const groupCap = this.syncGroupCaption(cur.pendingMedia, groupKey);
        const n = cur.pendingMedia.filter((m: any) => m.groupKey === groupKey).length;
        const batchCount = this.countBatches(cur.pendingMedia);
        console.log(
          `📦 [上传分组] 用户 ${userId} 组 ${groupKey} 收齐 ${n} 个 | 文案="${(groupCap || '').slice(0, 40)}" | 当前共 ${batchCount} 组 / ${cur.pendingMedia.length} 文件`
        );
        userSessions.set(userId, cur);
      }, this.GROUP_SETTLE_MS);
      this.groupTimeouts.set(groupTimerKey, groupTimer);

      // 全部停手后再提示选频道（连甩多组时不会中途乱弹）
      const existingReady = this.sessionReadyTimeouts.get(userId);
      if (existingReady) clearTimeout(existingReady);

      const readyTimer = setTimeout(async () => {
        this.sessionReadyTimeouts.delete(userId);
        const currentSession = userSessions.get(userId) || await db.getUserSession(userId);
        if (!currentSession || !this.isUploadSession(currentSession) || !currentSession.pendingMedia?.length) return;

        const keys = Array.from(new Set(currentSession.pendingMedia.map((m: any) => m.groupKey).filter(Boolean)));
        for (const gk of keys) this.syncGroupCaption(currentSession.pendingMedia, gk as string);
        userSessions.set(userId, currentSession);

        const total = currentSession.pendingMedia.length;
        const groups = this.countBatches(currentSession.pendingMedia);
        console.log(`📋 媒体收集完成 - 用户: ${userId}, ${groups} 组 / ${total} 文件`);

        const chatId = ctx.chat?.id || userId;
        const markup = {
          reply_markup: {
            inline_keyboard: [[{ text: '📢 选择频道', callback_data: 'select_channel' }]]
          }
        };

        const trySend = async (brief: boolean) => {
          const messageText = this.buildUploadReadyMessage(currentSession, brief);
          await ctx.telegram.sendMessage(chatId, this.sanitizeTelegramText(messageText), {
            parse_mode: 'HTML',
            ...markup
          });
        };

        try {
          await trySend(false);
        } catch (error: any) {
          console.warn(`[上传] 详细收集反馈失败，改发简版: ${error?.message || error}`);
          try {
            await trySend(true);
          } catch (error2: any) {
            console.error('[上传] 收集反馈最终失败:', error2?.message || error2);
            await this.safeNotifyUser(
              ctx.telegram,
              chatId,
              `✅ 已收齐 ${groups} 组 / ${total} 个文件。\n请点击菜单「上传资料」重新进入后点「选择频道」，或重新发一次关键词再选频道。`,
              markup
            );
          }
        }
      }, this.SESSION_READY_MS);

      this.sessionReadyTimeouts.set(userId, readyTimer);
    }
  }

  static async handleChannelSelection(
    ctx: Context, 
    userSessions: Map<number, UserSession>,
    bot: Telegraf
  ): Promise<void> {
    await this.renderChannelSelection(ctx, userSessions, bot, false);
  }

  /**
   * 仅好评图片自动水印；普通上传保持原版。每组完成后持久化，可安全重试。
   */
  private static async prepareOriginalUploads(opts: {
    telegram: any;
    userId: number;
    session: UserSession;
    userSessions: Map<number, UserSession>;
    db: typeof database;
    onProgress?: (done: number, total: number, phase: string) => Promise<void>;
  }): Promise<number> {
    if (opts.session.pendingText === 'is_review_mode') return this.prepareReviewPhotos(opts);
    // Ordinary uploads always retain the original.
    const { userId, session, userSessions, db } = opts;
    let restored = 0;
    for (const media of session.pendingMedia || []) {
      if (!media.watermarked) continue;
      if (!media.original_file_id) throw new Error('待上传资料缺少原件，请重新上传');
      media.file_id = media.original_file_id;
      if (media.original_source_chat_id && media.original_source_msg_id) {
        media.source_chat_id = media.original_source_chat_id;
        media.source_msg_id = media.original_source_msg_id;
      } else {
        delete media.source_chat_id;
        delete media.source_msg_id;
      }
      for (const key of ['watermarked', 'watermark_version', 'watermarked_at', 'watermark_album_saved',
        'watermark_album_caption', 'original_file_id', 'original_source_chat_id', 'original_source_msg_id']) delete media[key];
      restored++;
    }
    if (restored) {
      userSessions.set(userId, session);
      await db.saveUserSession(userId, session);
      await db.saveImmediately();
    }
    return restored;
  }


  private static async prepareReviewPhotos(opts: {
    telegram: any; userId: number; session: UserSession; userSessions: Map<number, UserSession>; db: typeof database;
    onProgress?: (done: number, total: number, phase: string) => Promise<void>;
  }): Promise<number> {
    const { telegram, userId, session, userSessions, db, onProgress } = opts;
    const pending = session.pendingMedia || [];
    const total = pending.filter(m => m.file_type === 'photo').length;
    if (!total) return 0;
    const chat = getAdminPersistentChannelId(userId);
    await watermarkService.assertReady(chat);
    const groups = new Map<string, any[]>();
    for (const media of pending) {
      if (media.file_type !== 'photo' && media.file_type !== 'video') continue;
      const key = media.batchId || 'single_' + pending.indexOf(media);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(media);
    }
    let done = 0;
    const heartbeat = setInterval(() => {
      void onProgress?.(done, total, '正在为好评图片添加水印').catch(() => {});
    }, 15000);
    try {
      for (const group of groups.values()) {
        if (!group.some(m => m.file_type === 'photo')) continue;
        const primary = group.find(m => this.itemCaption(m)) || group[0];
        const caption = this.captionWithTag({ caption: this.itemCaption(primary), keyword: session.currentKeyword! }, primary, pending) || '';
        for (let offset = 0; offset < group.length; offset += 10) {
          const chunk = group.slice(offset, offset + 10);
          const photos = chunk.filter(m => m.file_type === 'photo');
          if (chunk.every(m => m.watermark_album_saved)) { done += photos.length; continue; }
          // Original videos accompany the photos solely to preserve the album.
          const results = await watermarkService.processTelegramAlbum(telegram, chunk.map(media => ({
            fileId: media.file_id, type: media.file_type,
            ready: media.file_type !== 'photo' || !!media.watermarked
          })), chat!, offset === 0 ? caption : '',
          async n => { await onProgress?.(done, total, '好评相册准备 ' + n + '/' + chunk.length); });
          for (let i = 0; i < chunk.length; i++) {
            const media = chunk[i], result = results[i];
            if (media.file_type === 'photo') {
              media.original_file_id ||= media.file_id;
              media.original_source_chat_id ||= media.source_chat_id;
              media.original_source_msg_id ||= media.source_msg_id;
              media.file_id = result.fileId;
              media.watermarked = true;
              media.watermark_version = result.version;
              media.watermarked_at = new Date().toISOString();
            }
            media.source_chat_id = result.sourceChatId;
            media.source_msg_id = result.sourceMsgId;
            media.watermark_album_saved = true;
            media.watermark_album_caption = offset === 0 && i === 0 ? caption : '';
          }
          userSessions.set(userId, session);
          await db.saveUserSession(userId, session);
          await db.saveImmediately();
          done += photos.length;
          await onProgress?.(done, total, '好评图片水印完成');
        }
      }
    } finally { clearInterval(heartbeat); }
    return done;
  }

  static async renderChannelSelection(
    ctx: Context,
    userSessions: Map<number, UserSession>,
    bot: Telegraf,
    editExisting: boolean
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    if (!editExisting) await ctx.answerCbQuery('加载频道列表…').catch(() => {});

    const session = await this.resolveUploadSession(userId, userSessions, database);
    if (!session || !this.isUploadSession(session) || !session.pendingMedia?.length) {
      await ctx.reply('❌ 没有待上传的资料，请重新：上传资料 → 输入关键词 → 发送媒体。');
      return;
    }

    session.step = 'selecting_channel';
    userSessions.set(userId, session);
    await database.saveUserSession(userId, session);

    const adminChannelIds = hasAdminChannelMap(userId)
      ? getAdminChannelIds(userId)
      : await database.getManagedChannels();
    const selected = new Set(
      (session.selectedChannels?.length ? session.selectedChannels : session.selectedChannel ? [session.selectedChannel] : [])
        .map(String)
    );
    const channelButtons = await Promise.all(
      adminChannelIds.map(async channelId => [
        {
          text: `${selected.has(String(channelId)) ? '✅ ' : '☐ '}${await this.getChannelFullName(bot, channelId)}`,
          callback_data: `upload_toggle_${channelId}`
        }
      ]
      )
    );
    if (selected.size > 0) {
      channelButtons.push([{ text: `✅ 确认 ${selected.size} 个目标`, callback_data: 'upload_channels_confirm' }]);
    }
    channelButtons.push([{ text: '💾 仅保存到数据库', callback_data: 'save_only' }]);

    // 确认前再同步各组文案
    const gkeys = Array.from(new Set(session.pendingMedia.map((m: any) => m.groupKey).filter(Boolean)));
    for (const gk of gkeys) this.syncGroupCaption(session.pendingMedia, gk as string);

    const groupCount = this.countBatches(session.pendingMedia);
    const kw = this.escapeHtml(session.currentKeyword || '');
    const captionSummary = this.buildGroupCaptionSummary(session.pendingMedia);
    const fullText =
      `📤 <b>上传确认</b>\n\n` +
      `关键词: <code>${kw}</code>\n` +
      `媒体: <b>${groupCount}</b> 组 / <b>${session.pendingMedia.length}</b> 个文件\n\n` +
      `<b>各组文案：</b>\n${captionSummary}\n\n` +
      `请选择一个或多个目标群/频道：`;
    const briefText =
      `📤 <b>上传确认</b>\n\n` +
      `关键词: <code>${kw}</code>\n` +
      `媒体: <b>${groupCount}</b> 组 / <b>${session.pendingMedia.length}</b> 个文件\n\n` +
      `请选择一个或多个目标群/频道：`;
    const markup = { parse_mode: 'HTML' as const, reply_markup: { inline_keyboard: channelButtons } };
    try {
      if (editExisting) await ctx.editMessageText(this.sanitizeTelegramText(fullText), markup);
      else await ctx.reply(this.sanitizeTelegramText(fullText), markup);
    } catch (error: any) {
      console.warn('[上传] 频道选择详细文案失败，改发简版:', error?.message || error);
      try {
        if (editExisting) await ctx.editMessageText(this.sanitizeTelegramText(briefText), markup);
        else await ctx.reply(this.sanitizeTelegramText(briefText), markup);
      } catch (error2: any) {
        console.error('[上传] 频道选择发送失败:', error2?.message || error2);
        await this.safeNotifyUser(
          ctx.telegram,
          ctx.chat?.id || userId,
          `📤 选择目标\n\n关键词: ${session.currentKeyword}\n媒体: ${groupCount} 组 / ${session.pendingMedia.length} 个文件\n\n请选择一个或多个目标群/频道：`,
          { reply_markup: { inline_keyboard: channelButtons } }
        );
      }
    }
  }

  private static async saveOnly(
    ctx: Context, 
    userSessions: Map<number, UserSession>, 
    db: typeof database
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCbQuery('保存中…').catch(() => {});

    const session = await this.resolveUploadSession(userId, userSessions, db);
    if (!session || !this.isUploadSession(session) || !session.pendingMedia?.length || !session.currentKeyword) {
      await ctx.reply('❌ 上传会话已失效或没有资料，请重新开始上传。');
      return;
    }

    try {
      const processingMsg = await ctx.reply('💾 正在保存并同步备份…');

      await this.prepareOriginalUploads({
        telegram: ctx.telegram,
        userId,
        session,
        userSessions,
        db,
        onProgress: async (done, total, phase) => {
          await ctx.telegram.editMessageText(
            ctx.chat?.id,
            processingMsg.message_id,
            undefined,
            `🛡️ ${phase}：${done}/${total}\n\n机器人其他功能仍可正常使用，请勿重复点击。`
          ).catch(() => {});
        }
      });

      let savedCount = 0;
      const savedItems: MediaItem[] = []; // 🚀 记录以便后续备份
      const isReviewMode = session.pendingText === 'is_review_mode';

      for (const media of session.pendingMedia) {
        // 每组用自己的文案（caption / groupCaption），不会套用其它组
        let finalCaption = this.itemCaption(media) || '';
        if (session.pendingText && session.pendingText.trim() && !isReviewMode) {
          // pendingText 是用户额外补的总说明：只加到「本组有文案的那条」或每组第一条，避免污染整组
          const isGroupPrimary =
            !!media.caption ||
            session.pendingMedia.find((x: any) => x.batchId === media.batchId) === media;
          if (isGroupPrimary) {
            finalCaption = finalCaption
              ? finalCaption + '\n\n' + session.pendingText.trim()
              : session.pendingText.trim();
          }
        }

        const mediaItem: Omit<MediaItem, 'id'> = {
          upload_key: `${userId}:${media.batchId}:${session.pendingMedia.indexOf(media)}`,
          keyword: session.currentKeyword,
          file_id: media.file_id,
          file_type: media.file_type as any,
          caption: finalCaption || undefined,
          uploaded_by: userId,
          uploaded_at: new Date().toISOString(),
          is_published: false,
          batchId: media.batchId || (session as any).currentBatchId || `batch_${Date.now()}`,
          is_review: isReviewMode,
          source_chat_id: media.source_chat_id,
          source_msg_id: media.source_msg_id,
          watermarked: media.watermarked,
          watermark_version: media.watermark_version,
          watermarked_at: media.watermarked_at,
          original_file_id: media.original_file_id,
          original_source_chat_id: media.original_source_chat_id,
          original_source_msg_id: media.original_source_msg_id
        };

        mediaItem.caption = media.watermark_album_saved ? (media.watermark_album_caption || undefined) : this.captionWithTag(mediaItem, media, session.pendingMedia);
        const id = await db.saveMedia(mediaItem);
        savedItems.push({ ...mediaItem, id });
        savedCount++;
      }

      // 即使是「仅保存」，也强制发到金库并锁定 source_*（换 Token 可复活）
      await db.saveImmediately();
      const persistentChannelId = getAdminPersistentChannelId(userId);
      let vaultOk = false;
      let vaultError = '';
      if (persistentChannelId) {
        // Reassemble the existing album/caption in the vault using cached file_ids.
        const missingVaultItems = savedItems.filter(item => !session.pendingMedia!.some(m => m.file_id === item.file_id && m.watermark_album_saved));
        try {
          if (missingVaultItems.length > 0) {
            await this.publishToChannel(ctx as any, persistentChannelId, missingVaultItems, session.currentKeyword, db, {
              writeSource: true,
              forceSource: true,
              requireSuccess: true
            });
          }
          vaultOk = true;
        } catch (e: any) {
          vaultError = e?.message || String(e);
          console.error('📡 [影子备份] 失败:', vaultError);
        }
      } else {
        vaultError = '未配置 PERSISTENT_CHANNEL_ID';
        console.warn('⚠️ 未配置 PERSISTENT_CHANNEL_ID，本次仅入库、无金库坐标，换 Token 后可能无法自愈');
      }

      // 清理会话
      userSessions.delete(userId);
      await db.clearUserSession(userId);

      // 如果是好评模式，触发全员推送
      if (isReviewMode) {
        this.broadcastReviewUpdate(ctx.telegram, db);
      }

      const groupCount = this.countBatches(savedItems);
      let completionText: string;
      if (isReviewMode) {
        completionText = vaultOk
          ? `✅ 好评记录已保存并完成备份！\n\n关键词: "${session.currentKeyword}"`
          : `⚠️ 好评已入库，但金库备份失败！\n\n关键词: "${session.currentKeyword}"\n原因: ${vaultError}\n\n请确认当前 bot 已是备份频道管理员后重试。`;
      } else if (vaultOk) {
        completionText =
          `✅ 资料已保存并完成同步备份！\n\n关键词: "${session.currentKeyword}"\n已备份 ${groupCount} 组 / ${savedCount} 个媒体文件。\n\n💡 即使换了 Token，这些资料也将永不丢失。`;
      } else {
        completionText =
          `⚠️ 资料已写入数据库，但金库备份失败（频道里不会有文件）！\n\n` +
          `关键词: "${session.currentKeyword}"\n` +
          `已入库 ${groupCount} 组 / ${savedCount} 个文件\n` +
          `金库: ${persistentChannelId || '未配置'}\n` +
          `原因: ${vaultError}\n\n` +
          `👉 把【当前这个】bot 加成备份频道管理员后，再上传一次或跑 vault:sync。`;
      }
      
      const completionKeyboard = { inline_keyboard: [[{ text: '🏠 返回主菜单', callback_data: 'back_to_main' }]] };

      try {
        await ctx.telegram.editMessageText(ctx.chat?.id, processingMsg.message_id, undefined, completionText, { reply_markup: completionKeyboard });
      } catch (editError) {
        await ctx.reply(completionText, { reply_markup: completionKeyboard });
      }

    } catch (error: any) {
      console.error('保存媒体错误:', error);
      await ctx.reply(`❌ 保存时发生错误：${error?.message || '请稍后重试'}`);
    }
  }

  private static async saveAndPublish(
    ctx: Context, 
    userSessions: Map<number, UserSession>, 
    db: typeof database, 
    bot: Telegraf
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCbQuery('处理中…').catch(() => {});

    const session = await this.resolveUploadSession(userId, userSessions, db);
    const selectedChannels = session?.selectedChannels?.length
      ? Array.from(new Set(session.selectedChannels.map(String).filter(Boolean)))
      : session?.selectedChannel
        ? [session.selectedChannel]
        : [];
    if (!session || !this.isUploadSession(session) || !session.pendingMedia?.length || !session.currentKeyword || selectedChannels.length === 0) {
      await ctx.reply('❌ 上传会话已失效，请重新：上传资料 → 关键词 → 媒体 → 选择频道。');
      return;
    }
    session.selectedChannels = selectedChannels;
    session.selectedChannel = selectedChannels[0];

    const chatId = ctx.chat?.id || userId;
    let processingMsg: { message_id: number } | null = null;
    try {
      processingMsg = await ctx.reply('💾📢 正在保存并发布（请勿重复点击）…');
    } catch {}

    try {
      await this.prepareOriginalUploads({
        telegram: ctx.telegram,
        userId,
        session,
        userSessions,
        db,
        onProgress: async (done, total, phase) => {
          if (!processingMsg?.message_id) return;
          await ctx.telegram.editMessageText(
            chatId,
            processingMsg.message_id,
            undefined,
            `🛡️ ${phase}：${done}/${total}\n\n机器人其他功能仍可正常使用，请勿重复点击。`
          ).catch(() => {});
        }
      });
    } catch (error: any) {
      await this.safeNotifyUser(
        ctx.telegram,
        chatId,
        `❌ ${error?.message || error}\n\n上传会话仍已保留，可修复配置后再次点击继续。`
      );
      return;
    }

    const sessionSnap = {
      currentKeyword: session.currentKeyword,
      selectedChannel: session.selectedChannel,
      selectedChannels: session.selectedChannels,
      pendingMedia: JSON.parse(JSON.stringify(session.pendingMedia)),
      pendingText: session.pendingText,
      mode: session.mode
    };

    await (async () => {
      try {
        await this.runSaveAndPublishJob({
          telegram: ctx.telegram,
          chatId,
          processingMsgId: processingMsg?.message_id,
          userId,
          sessionSnap,
          userSessions,
          db,
          bot
        });
      } catch (error: any) {
        console.error('保存并发布后台任务失败:', error);
        await this.safeNotifyUser(
          ctx.telegram,
          chatId,
          `❌ 保存并发布失败：${error?.message || '未知错误'}\n\n请检查 bot 是否为频道管理员后重试。`,
          { reply_markup: { inline_keyboard: [[{ text: '🏠 返回主菜单', callback_data: 'back_to_main' }]] } }
        );
      }
    })();
  }

  private static async runSaveAndPublishJob(opts: {
    telegram: any;
    chatId: number;
    processingMsgId?: number;
    userId: number;
    sessionSnap: {
      currentKeyword: string;
      selectedChannel: string;
      selectedChannels: string[];
      pendingMedia: any[];
      pendingText?: string;
      mode: string;
    };
    userSessions: Map<number, UserSession>;
    db: typeof database;
    bot: Telegraf;
  }): Promise<void> {
    const { telegram, chatId, processingMsgId, userId, sessionSnap, userSessions, db, bot } = opts;
    const session = sessionSnap;

    try {

      let savedCount = 0;
      const mediaIds: number[] = [];
      const isReviewMode = session.pendingText === 'is_review_mode';

      // 保存到数据库
      console.log('📊 开始保存到数据库...');
      const savedItems: MediaItem[] = []; // 🚀 修改：记录保存成功的完整对象
      for (const media of session.pendingMedia) {
        try {
        const mediaItem: Omit<MediaItem, 'id'> = {
          upload_key: `${userId}:${media.batchId}:${session.pendingMedia.indexOf(media)}`,
          keyword: session.currentKeyword,
          file_id: media.file_id,
          file_type: media.file_type as any,
          caption: (() => {
            // 本组原始 caption 优先；否则仅组内第一条补上 groupCaption，其它条保持空
            if (media.caption && String(media.caption).trim()) return String(media.caption).trim();
            const firstOfBatch = session.pendingMedia.find((x: any) => x.batchId === media.batchId);
            if (firstOfBatch === media) return this.itemCaption(media);
            return undefined;
          })(),
          channel_id: session.selectedChannel,
          uploaded_by: userId,
          uploaded_at: new Date().toISOString(),
          is_published: true,
          published_at: new Date().toISOString(),
          batchId: media.batchId || (session as any).currentBatchId || `batch_${Date.now()}`,
          is_review: isReviewMode,
          source_chat_id: media.source_chat_id,
          source_msg_id: media.source_msg_id,
          watermarked: media.watermarked,
          watermark_version: media.watermark_version,
          watermarked_at: media.watermarked_at,
          original_file_id: media.original_file_id,
          original_source_chat_id: media.original_source_chat_id,
          original_source_msg_id: media.original_source_msg_id
        };

        mediaItem.caption = media.watermark_album_saved ? (media.watermark_album_caption || undefined) : this.captionWithTag(mediaItem, media, session.pendingMedia);
        const id = await db.saveMedia(mediaItem);
        savedItems.push({ ...mediaItem, id }); // 🚀 记录
        savedCount++;
          console.log(`✅ 已保存媒体 ${savedCount}/${session.pendingMedia.length}`);
        } catch (saveError) {
          console.error('❌ 保存单个媒体失败:', saveError);
          throw saveError;
        }
      }

      console.log('📢 开始发布到频道...');
      await db.saveImmediately();
      // 先发金库锁定 source_*，再发业务频道（业务频道不得覆盖金库坐标）
      const persistentChannelId = getAdminPersistentChannelId(userId);
      let vaultNote = '';
      if (persistentChannelId && !session.selectedChannels.includes(persistentChannelId)) {
        console.log(`📡 [影子备份] 发布前同步到永久仓库...`);
        try {
          const missingVaultItems = savedItems.filter(item => !session.pendingMedia.some(m => m.file_id === item.file_id && m.watermark_album_saved));
          if (missingVaultItems.length > 0) {
            await this.publishToChannel(bot, persistentChannelId, missingVaultItems, session.currentKeyword, db, {
              writeSource: true,
              forceSource: true,
              requireSuccess: true
            });
          }
          vaultNote = '\n📦 金库备份: 成功';
        } catch (e: any) {
          console.error('备份同步失败:', e.message);
          vaultNote = `\n⚠️ 金库备份失败: ${e.message}`;
        }
      }

      // 不同目标并行排队，公共队列限制并发；单个目标失败不阻止其余目标。
      const publishResults: Array<{ channelId: string; sent: number }> = [];
      const publishFailures: Array<{ channelId: string; error: string }> = [];
      await Promise.all([...new Set(session.selectedChannels)].map(async channelId => {
        try {
          const targetItems = channelId === persistentChannelId
            ? savedItems.filter(item => !session.pendingMedia.some(m => m.file_id === item.file_id && m.watermark_album_saved))
            : savedItems;
          const result = targetItems.length ? await this.publishToChannel(bot, channelId, targetItems, session.currentKeyword, db, {
            writeSource: true,
            forceSource: persistentChannelId === channelId,
            requireSuccess: true
          }) : { sent: 0, failed: 0 };
          publishResults.push({ channelId, sent: result.sent });
          recordPublishEvent({
            keyword: session.currentKeyword,
            userId,
            channelId,
            source: 'save_and_publish',
            count: result.sent
          });
        } catch (error: any) {
          const detail = error?.message || String(error);
          publishFailures.push({ channelId, error: detail });
          console.error(`保存并发布到 ${channelId} 失败:`, detail);
        }
      }));
      if (publishResults.length === 0) {
        throw new Error(`无法发布到所选目标：${publishFailures.map(item => `${item.channelId}（${item.error}）`).join('；')}`);
      }

      // 清理会话
      userSessions.delete(userId);
      await db.clearUserSession(userId);

      if (isReviewMode) {
        this.broadcastReviewUpdate(telegram, db);
      }

      const groupCount = this.countBatches(savedItems);
      const channelNames = await Promise.all(publishResults.map(item => this.getChannelName(bot, item.channelId)));
      const completionMsg = `✅ 保存并发布完成！\n\n` +
        `关键词: "${session.currentKeyword}"\n` +
        `已发送目标（${channelNames.length}/${session.selectedChannels.length}）：\n${channelNames.map(name => `• ${name}`).join('\n')}\n` +
        `已处理 ${groupCount} 组 / ${savedCount} 个媒体文件` +
        `${vaultNote}\n\n` +
        (publishFailures.length
          ? `⚠️ 以下目标发送失败：\n${publishFailures.map(item => `• ${item.channelId}`).join('\n')}\n\n`
          : '') +
        `💡 多组已分开发布，不会并成一组。`;
      const completionKbd = { inline_keyboard: [[{ text: '🏠 返回主菜单', callback_data: 'back_to_main' }]] };

      if (processingMsgId) {
        try {
          await telegram.editMessageText(chatId, processingMsgId, undefined, completionMsg, {
            reply_markup: completionKbd
          });
        } catch {
          await this.safeNotifyUser(telegram, chatId, completionMsg, { reply_markup: completionKbd });
        }
      } else {
        await this.safeNotifyUser(telegram, chatId, completionMsg, { reply_markup: completionKbd });
      }

    } catch (error: any) {
      console.error('保存并发布错误:', error);

      // Preserve the upload session on failure. upload_key makes a retry idempotent at save time.

      let errorMessage = '❌ 发布时发生错误，请稍后重试。';
      if (error.message?.includes('发布超时')) {
        errorMessage = '❌ 发布超时，可能是网络问题或媒体文件过多。\n\n💡 建议：\n1. 减少一次上传的文件数量\n2. 检查网络连接\n3. 稍后重试';
      } else if (error.message?.includes('无法发布到频道')) {
        errorMessage = `❌ ${error.message}\n\n💡 请确保：\n1. 机器人已添加到频道\n2. 机器人有发布权限\n3. 频道ID正确`;
      } else if (error.response?.error_code === 429) {
        errorMessage = '❌ 发布频率过快，请稍后重试。\n\n💡 建议：减少一次上传的文件数量';
      }

      const errorKbd = {
        reply_markup: { inline_keyboard: [[{ text: '🏠 返回主菜单', callback_data: 'back_to_main' }]] }
      };
      if (processingMsgId) {
        try {
          await telegram.editMessageText(chatId, processingMsgId, undefined, errorMessage, errorKbd);
        } catch {
          await this.safeNotifyUser(telegram, chatId, errorMessage, errorKbd);
        }
      } else {
        await this.safeNotifyUser(telegram, chatId, errorMessage, errorKbd);
      }
    }
  }

  /** 金库归档：把一组资料发到永久备份频道并强制写入 source_* */
  static async archiveBatchToChannel(
    botOrCtx: Telegraf | Context,
    channelId: string,
    mediaList: MediaItem[],
    keyword: string,
    db: typeof database,
    options?: { forceSource?: boolean }
  ): Promise<{ sent: number; failed: number }> {
    return this.publishToChannel(botOrCtx, channelId, mediaList, keyword, db, {
      writeSource: true,
      forceSource: options?.forceSource !== false,
      requireSuccess: true
    });
  }

  private static async publishToChannel(
    botOrCtx: Telegraf | Context,
    channelId: string,
    mediaList: MediaItem[],
    keyword: string,
    db: typeof database,
    options?: { writeSource?: boolean; forceSource?: boolean; requireSuccess?: boolean }
  ): Promise<{ sent: number; failed: number }> {
    const telegram = (botOrCtx as any).telegram || (botOrCtx as any).tg || (botOrCtx as Context).telegram;
    const writeSource = options?.writeSource !== false;
    const forceSource = Boolean(options?.forceSource);

    if (forceSource) {
      const access = await checkVaultAccess(telegram, channelId);
      if (!access.ok) {
        const detail = [
          access.error || '无法访问目标聊天',
          access.hint,
          access.botUsername ? `当前 bot: @${access.botUsername}` : ''
        ].filter(Boolean).join(' | ');
        console.error(`❌ [发布预检失败] ${channelId}: ${detail}`);
        throw new Error(detail);
      }
      console.log(`✅ [发布预检] ${access.type}「${access.title}」bot=@${access.botUsername} status=${access.botStatus}`);
    }

    const batches = publicationBatches(mediaList);
    return publicationQueue.run(telegram, channelId, async send => {
      let sent = 0;
      for (const batch of batches) {
        const result = await this.publishOneBatch(telegram, channelId, batch, keyword, db, { writeSource, forceSource }, send);
        sent += result.sent;
      }
      return { sent, failed: 0 };
    });
  }

  private static async publishOneBatch(
    telegram: any, channelId: string, batchItems: MediaItem[], keyword: string, db: typeof database,
    options?: { writeSource?: boolean; forceSource?: boolean }, sender?: PublishSender
  ): Promise<{ sent: number; failed: number }> {
    const work = async (send: PublishSender) => {
      let sent = 0;
      for (const chunk of publicationChunks(batchItems)) {
        const messages = await send(chunk);
        for (let i = 0; i < messages.length; i++) {
          if (options?.writeSource !== false) await db.updateMediaSource(chunk[i].id, channelId, messages[i].message_id,
            { force: Boolean(options?.forceSource) });
          sent++;
        }
      }
      return { sent, failed: 0 };
    };
    return sender ? work(sender) : publicationQueue.run(telegram, channelId, work);
  }

  private static groupMediaByType(mediaList: any[]): { [key: string]: any[] } {
    const grouped: { [key: string]: any[] } = {};
    
    mediaList.forEach(item => {
      if (!grouped[item.file_type]) {
        grouped[item.file_type] = [];
      }
      grouped[item.file_type].push(item);
    });
    
    return grouped;
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

  private static buildCaption(keyword: string, originalCaption?: string): string {
    console.log(`🔍 buildCaption调用 - keyword: "${keyword}", originalCaption: "${originalCaption}"`);
    
    // 只返回原始说明，不添加关键词标签
    const result = originalCaption || '';
    
    console.log(`📝 buildCaption结果: "${result}"`);
    return result;
  }

  /**
   * 🚀 新增：群发好评库更新通知给所有活跃用户
   */
  private static async broadcastReviewUpdate(telegram: Context['telegram'], db: typeof database): Promise<void> {
    try {
      const users = await db.getAllActiveUsers();
      if (users.length === 0) return;

      const broadcastMsg = "资料好评库已经更新  请点击 “查看资料” 好评库 查看详情好评";
      
      console.log(`📢 [好评库群发] 开始推送给 ${users.length} 个活跃用户...`);
      
      // 异步执行，不阻塞当前的保存/发布流程
      setImmediate(async () => {
        let successCount = 0;
        let blockedCount = 0;
        const adminId = config.superAdminId;

        for (const user of users) {
          try {
            await telegram.sendMessage(user.id, broadcastMsg);
            successCount++;
            
            // 🚀 频率限制保护
            await new Promise(resolve => setTimeout(resolve, 50)); 
          } catch (e: any) {
            // 🚀 核心逻辑：如果用户拉黑了机器人
            if (e.message && (e.message.includes('blocked') || e.message.includes('Forbidden') || e.code === 403)) {
              blockedCount++;
              // 1. 从数据库移除该活跃用户
              await db.removeUser(user.id);
              // 2. 提醒管理员
              const userDisplay = user.username ? `@${user.username}` : (user.first_name || '未知用户');
              await telegram.sendMessage(adminId, `🗑️ **用户已失效**\n\n用户 \`${userDisplay}\` (ID: \`${user.id}\`) 已拉黑机器人，已自动将其从活跃列表中移除。`, { parse_mode: 'Markdown' }).catch(() => {});
            }
          }
        }
        console.log(`📢 [好评库群发] 推送完成: 成功 ${successCount}/${users.length}, 移除拉黑用户 ${blockedCount} 个`);
      });
    } catch (error) {
      console.error('好评库群发初始化失败:', error);
    }
  }
}
