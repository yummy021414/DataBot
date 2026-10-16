import { Context } from 'telegraf';
import { database } from '../../database';
import { MediaItem } from '../../types';
import { config, isAdminUser, isSuperAdmin } from '../../config';
import { refreshFileIdFromVault } from '../../services/vault';

type SentRecorder = (messages: { message_id: number }[]) => Promise<void>;

export class SearchHandler {
  static async handleReplyDelete(ctx: Context, db: typeof database): Promise<boolean> {
    const message = ctx.message;
    if (!message || !('text' in message) || message.text.trim() !== '删除' || !message.reply_to_message) return false;
    if (!ctx.from || !ctx.chat) return true;
    try {
      const result = await db.deleteSearchGroup(ctx.chat.id, message.reply_to_message.message_id,
        isSuperAdmin(ctx.from.id) ? undefined : ctx.from.id);
      if (result.status === 'forbidden') {
        await ctx.reply('❌ 只能删除自己的资料。');
      } else if (result.status === 'missing') {
        await ctx.reply('❌ 未找到这条消息对应的资料组，可能已经删除。请重新搜索关键词，引用要删除的那组资料并回复“删除”。');
      } else {
        await ctx.reply('✅ 已删除「' + result.keyword + '」的这组资料（' + result.count + ' 个文件）。' +
          (result.remainingGroups ? '\n该关键词还剩 ' + result.remainingGroups + ' 组资料。' : '\n这是最后一组资料，关键词已从资料库移除。'));
      }
    } catch (error) {
      console.error('引用删除资料失败:', error);
      await ctx.reply('❌ 删除失败，请稍后重试。');
    }
    return true;
  }

  /**
   * 解析一次输入里的多个关键词：
   * - 整句精确匹配优先（避免「优米樊樊」本身就是一个词时被拆开）
   * - 支持空格/逗号等分隔：优米 樊樊
   * - 支持连写：优米樊樊 → 按库内关键词最长匹配拆分
   */
  static parseSearchKeywords(raw: string, knownKeywords: string[]): string[] {
    const text = (raw || '').trim();
    if (!text) return [];

    const known = knownKeywords.filter(Boolean);
    if (known.includes(text)) return [text];

    const parts = text.split(/[\s,，、|／/]+/).map(s => s.trim()).filter(Boolean);
    const found: string[] = [];

    if (parts.length > 1) {
      for (const part of parts) {
        if (known.includes(part)) {
          found.push(part);
        } else {
          found.push(...this.matchConcatenatedKeywords(part, known));
        }
      }
    } else {
      const single = parts[0] || text;
      if (known.includes(single)) {
        found.push(single);
      } else {
        found.push(...this.matchConcatenatedKeywords(single, known));
      }
    }

    // 去重保序
    const seen = new Set<string>();
    return found.filter(k => {
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /** 从左到右最长匹配库内关键词 */
  private static matchConcatenatedKeywords(text: string, knownKeywords: string[]): string[] {
    const sorted = [...knownKeywords].sort((a, b) => b.length - a.length || a.localeCompare(b));
    const found: string[] = [];
    let i = 0;
    const chars = Array.from(text); // 按码点，避免拆坏表情

    while (i < chars.length) {
      const rest = chars.slice(i).join('');
      let hit: string | null = null;
      for (const kw of sorted) {
        if (kw && rest.startsWith(kw)) {
          hit = kw;
          break;
        }
      }
      if (hit) {
        found.push(hit);
        i += Array.from(hit).length;
      } else {
        i += 1; // 跳过无法匹配的字符
      }
    }
    return found;
  }

  static async handleSearch(ctx: Context, keyword: string, db: typeof database): Promise<void> {
    try {
      const userId = ctx.from?.id;
      if (!userId) return;
      
      // 获取用户信息用于日志
      const userName = ctx.from?.first_name || '';
      const lastName = ctx.from?.last_name || '';
      const username = ctx.from?.username || '';
      const fullName = `${userName}${lastName ? ' ' + lastName : ''}`.trim() || '未知用户';
      const userDisplay = username ? `${fullName} (@${username})` : fullName;
      
      // 确定搜索范围 - 简化权限逻辑
      const isAdmin = isAdminUser(userId);
      const isRootAdmin = isSuperAdmin(userId);
      
      let searchUserId: number | undefined;
      if (isRootAdmin) {
        searchUserId = undefined;
      } else if (isAdmin) {
        searchUserId = userId;
      } else {
        searchUserId = config.superAdminId;
      }

      const knownKeywords = await db.getAllKeywords(searchUserId);
      let keywords = this.parseSearchKeywords(keyword, knownKeywords);

      // 库中一个都拆不出来时，退回整句精确搜（兼容旧行为）
      if (keywords.length === 0) {
        keywords = [keyword.trim()];
      }

      let anyFound = false;
      for (let ki = 0; ki < keywords.length; ki++) {
        const kw = keywords[ki];
        const mediaItems = await db.getMediaByKeyword(kw, searchUserId);

        if (mediaItems.length === 0) {
          if (keywords.length === 1) {
            await ctx.reply(`❌ 未找到关键词 "${kw}" 的相关媒体文件。`);
          } else {
            await ctx.reply(`⚠️ 跳过：未找到「${kw}」`);
          }
          continue;
        }

        anyFound = true;
        await db.recordKeywordSearch(userId, kw).catch(error => console.error('搜索统计保存失败:', error));
        const photoCount = mediaItems.filter(item => item.file_type === 'photo').length;
        const videoCount = mediaItems.filter(item => item.file_type === 'video').length;
        const documentCount = mediaItems.filter(item => item.file_type === 'document').length;
        const audioCount = mediaItems.filter(item => item.file_type === 'audio').length;
        const voiceCount = mediaItems.filter(item => item.file_type === 'voice').length;

        console.log(
          `🔍 [搜索] ${userDisplay} -> 关键词: "${kw}"` +
          (keywords.length > 1 ? ` (${ki + 1}/${keywords.length} 来自「${keyword}」)` : '') +
          ` | 结果: 📷${photoCount} 🎥${videoCount} 📄${documentCount} 🎵${audioCount} 🎤${voiceCount} (共${mediaItems.length}个)`
        );

        const batches = this.groupMediaByBatch(mediaItems);
        const batchIds = Object.keys(batches);

        for (let i = 0; i < batchIds.length; i++) {
          const batchItems = batches[batchIds[i]];
          const groupedMedia = this.groupMediaByType(batchItems);
          try {
            await this.sendMediaGroups(ctx, groupedMedia, true, async messages => {
              try {
                await db.rememberSearchGroup(ctx.chat!.id, messages.map(message => message.message_id), batchItems);
              } catch (error) {
                // Recording failure is not a Telegram send failure; do not resend the media.
                console.error('搜索结果引用记录保存失败:', error);
                await ctx.reply('⚠️ 资料已发送，但引用记录保存失败。请稍后重新搜索，再使用引用删除或替换。').catch(() => {});
              }
            });
          } catch (err: any) {
            console.error(`[搜索发送失败] 关键词="${kw}" 组 ${i + 1}:`, err.message);
          }
          if (i < batchIds.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }

        // 多关键词之间稍作间隔，避免连发被限流
        if (ki < keywords.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 800));
        }
      }

      if (!anyFound && keywords.length > 1) {
        await ctx.reply(`❌ 未找到与「${keyword}」匹配的关键词资料。`);
      }

    } catch (error) {
      const userId = ctx.from?.id;
      const userName = ctx.from?.first_name || '未知用户';
      const username = ctx.from?.username || '';
      const userDisplay = username ? `${userName} (@${username})` : userName;
      console.error(`❌ [搜索错误] ${userDisplay} (ID: ${userId}) 搜索关键词: "${keyword}" | 错误:`, error);
      await ctx.reply('❌ 搜索时发生错误，请稍后重试。');
    }
  }

  public static groupMediaByBatch(mediaItems: MediaItem[]): { [key: string]: MediaItem[] } {
    const batches: { [key: string]: MediaItem[] } = {};
    
    mediaItems.forEach(item => {
      const bId = JSON.stringify([item.uploaded_by, item.batchId || 'default']);
      if (!batches[bId]) {
        batches[bId] = [];
      }
      batches[bId].push(item);
    });
    
    return batches;
  }

  public static groupMediaByType(mediaItems: MediaItem[]): { [key: string]: MediaItem[] } {
    const grouped: { [key: string]: MediaItem[] } = {};
    
    mediaItems.forEach(item => {
      if (!grouped[item.file_type]) {
        grouped[item.file_type] = [];
      }
      grouped[item.file_type].push(item);
    });
    
    return grouped;
  }

  private static formatSearchResults(groupedMedia: { [key: string]: MediaItem[] }): string {
    let result = '';
    
    Object.entries(groupedMedia).forEach(([type, items]) => {
      const typeEmoji = this.getTypeEmoji(type);
      result += `${typeEmoji} ${type}: ${items.length} 个文件\n`;
    });
    
    return result;
  }

  private static formatSearchResultsOptimized(groupedMedia: { [key: string]: MediaItem[] }): string {
    let result = '';
    
    // 合并照片和视频显示
    const photoCount = groupedMedia['photo']?.length || 0;
    const videoCount = groupedMedia['video']?.length || 0;
    const documentCount = groupedMedia['document']?.length || 0;
    const audioCount = groupedMedia['audio']?.length || 0;
    const voiceCount = groupedMedia['voice']?.length || 0;
    
    if (photoCount > 0 || videoCount > 0) {
      result += `📷 照片+视频: ${photoCount + videoCount} 个文件\n`;
    }
    if (documentCount > 0) {
      result += `📄 文档: ${documentCount} 个文件\n`;
    }
    if (audioCount > 0) {
      result += `🎵 音频: ${audioCount} 个文件\n`;
    }
    if (voiceCount > 0) {
      result += `🎤 语音: ${voiceCount} 个文件\n`;
    }
    
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

  public static async sendMediaGroups(ctx: Context, groupedMedia: { [key: string]: MediaItem[] }, sendCaption: boolean = true, record?: SentRecorder): Promise<void> {
    // 完全按照上传时的格式：所有媒体一起发送，文字说明只显示一次
    
    // 获取所有媒体
    const allMedia = Object.values(groupedMedia).flat();
    
    if (allMedia.length === 0) return;
    
    // 找到第一个有文字说明的媒体，作为主要说明
    const mainCaptionMedia = allMedia.find(item => item.caption && item.caption.trim().length > 0);
    const mainCaption = (mainCaptionMedia && sendCaption && mainCaptionMedia.caption) ? mainCaptionMedia.caption : '';
    
    // 按类型分组
    const photoItems = allMedia.filter(item => item.file_type === 'photo');
    const videoItems = allMedia.filter(item => item.file_type === 'video');
    const animationItems = allMedia.filter(item => item.file_type === 'animation');
    const documentItems = allMedia.filter(item => item.file_type === 'document');
    const audioItems = allMedia.filter(item => item.file_type === 'audio');
    const voiceItems = allMedia.filter(item => item.file_type === 'voice');
    const videoNoteItems = allMedia.filter(item => item.file_type === 'video_note');

    // 🚀 优化策略：Telegram 限制 sendMediaGroup 只能混合 photo 和 video (animation 也是 video)
    
    // 1. 发送照片、视频、动画组合
    const visualMedia = [...photoItems, ...videoItems, ...animationItems];
    if (visualMedia.length > 0) {
      await this.sendCompatibleMediaGroup(ctx, visualMedia, mainCaption, record);
    }

    // 2. 发送文档组合
    if (documentItems.length > 0) {
      await this.sendCompatibleMediaGroup(ctx, documentItems, visualMedia.length === 0 ? mainCaption : '', record);
    }

    // 3. 发送音频组合
    if (audioItems.length > 0) {
      await this.sendCompatibleMediaGroup(ctx, audioItems, (visualMedia.length === 0 && documentItems.length === 0) ? mainCaption : '', record);
    }
    
    // 4. 发送语音消息（不能放在媒体组中）
    for (const item of voiceItems) {
      try {
        await this.sendSingleMedia(ctx, item, record);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error('发送语音消息错误:', error);
      }
    }

    // 5. 发送视频动态（不能放在媒体组中）
    for (const item of videoNoteItems) {
      try {
        await this.sendSingleMedia(ctx, item, record);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error('发送视频动态错误:', error);
      }
    }
  }

  /**
   * 发送兼容类型的媒体组（带自动切分和错误回退）
   */
  private static async sendCompatibleMediaGroup(
    ctx: Context, 
    items: MediaItem[], 
    caption: string,
    record?: SentRecorder
  ): Promise<void> {
    const chunks = this.chunkArray(items, 10);
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // 🚀 核心改进：Bot 级自愈（保持 Bot 身份 + 相册完整）
    const tryBotLevelHealing = async (chunk: MediaItem[]) => {
      // Migrated watermark copies can be individual vault messages. Reclaim ids and
      // reconstruct the album from database metadata instead of copying isolated posts.
      if (chunk.length > 0) {
        try {
          for (const item of chunk) {
            const result = await refreshFileIdFromVault(ctx.telegram, item, database, item.source_chat_id);
            if (!result.ok) throw new Error('金库认领失败');
          }
          const sent = await ctx.replyWithMediaGroup(chunk.map((item, index) => ({
            type: (item.file_type === 'animation' ? 'video' : item.file_type) as any,
            media: item.file_id,
            caption: index === 0 ? caption || undefined : undefined
          })));
          if (record) await record(sent);
          return true;
        } catch {
          // A changed caption must never be restored from an old vault post.
          if (chunk.some(item => item.watermarked || item.caption_overridden)) return false;
        }
      }
      const sourceChatId = chunk[0]?.source_chat_id;
      const sourceMsgIds = chunk.map(m => m.source_msg_id).filter(id => id) as number[];
      
      if (sourceChatId && sourceMsgIds.length > 0) {
        console.log(`[Bot自愈触发] 正在尝试通过 Bot 复制永久仓库资料 (数量: ${sourceMsgIds.length})...`);
        
        try {
          // 尝试使用 Bot API 的批量复制功能
          // @ts-ignore - 使用 Telegram Bot API 7.0+ 的批量复制接口
          const result = await ctx.telegram.callApi('copyMessages', {
            chat_id: chatId,
            from_chat_id: sourceChatId,
            message_ids: sourceMsgIds,
            remove_caption: false
          });

          if (result) {
            if (record) await record(result);
            console.log(`[Bot自愈成功] 资料已由 Bot 完美复刻送达`);
            // 后台认领新 file_id，下次可直接用 file_id 发送
            for (const m of chunk) {
              refreshFileIdFromVault(ctx.telegram, m, database).then(r => {
                if (r.ok) console.log(`[金库认领] media#${m.id} file_id 已刷新`);
              }).catch(() => {});
            }
            return true;
          }
        } catch (botErr: any) {
          console.warn(`[Bot自愈受阻] Bot 无法直接复制 (${botErr.message})，降级为 UserBot 转发...`);
          const { accountController } = require('../../userAccount');
          const healed = await accountController.forwardByPermanentIds(chatId, sourceChatId, sourceMsgIds);
          if (record && healed.messageIds?.length) await record(healed.messageIds.map((id: number) => ({ message_id: id })));
          return healed.success;
        }
      }
      return false;
    };
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk.length === 1) {
        try {
          await this.sendSingleMedia(ctx, chunk[0], record);
        } catch (err) {}
        continue;
      }

      try {
        const mediaGroup = chunk.map((item, index) => {
          const type = item.file_type === 'animation' ? 'video' : item.file_type;
          return {
            type: type as any,
            media: item.file_id,
            caption: (i === 0 && index === 0 && caption) ? caption : undefined
          };
        });

        const sent = await ctx.replyWithMediaGroup(mediaGroup);
        if (record) await record(sent);
      } catch (error: any) {
        // 如果整组发送失败（常见于 Token 变更后的 file_id 失效）
        const handled = await tryBotLevelHealing(chunk);
        if (!handled) {
          console.error('媒体组发送失败且自愈失败，尝试逐个发送:', error.message);
          for (const item of chunk) {
            try {
              await this.sendSingleMedia(ctx, item, record);
              await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (singleError) {}
          }
        }
      }

      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  private static async sendSingleMedia(ctx: Context, item: MediaItem, record?: SentRecorder): Promise<void> {
    const caption = item.caption || '';
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const trySingleBotHealing = async (err: any) => {
      if (item.source_chat_id && item.source_msg_id) {
        console.log(`[单项Bot自愈] 正在尝试由 Bot 直接复刻...`);
        try {
          const sent = await ctx.telegram.copyMessage(chatId, item.source_chat_id, item.source_msg_id, { caption });
          if (record) await record([sent]);
          refreshFileIdFromVault(ctx.telegram, item, database).then(r => {
            if (r.ok) console.log(`[金库认领] media#${item.id} file_id 已刷新`);
          }).catch(() => {});
          return true;
        } catch (copyErr) {
          if (item.caption_overridden) return false;
          const { accountController } = require('../../userAccount');
          const healed = await accountController.forwardByPermanentIds(chatId, item.source_chat_id, [item.source_msg_id]);
          if (healed.success) {
            if (record && healed.messageIds?.length) await record(healed.messageIds.map((id: number) => ({ message_id: id })));
            refreshFileIdFromVault(ctx.telegram, item, database).catch(() => {});
          }
          return healed.success;
        }
      }
      return false;
    };

    try {
      switch (item.file_type) {
        case 'photo':
          if (record) { await record([await ctx.replyWithPhoto(item.file_id, { caption })]); }
          else { await ctx.replyWithPhoto(item.file_id, { caption }); }
          break;
        case 'video':
          if (record) { await record([await ctx.replyWithVideo(item.file_id, { caption })]); }
          else { await ctx.replyWithVideo(item.file_id, { caption }); }
          break;
        case 'document':
          if (record) { await record([await ctx.replyWithDocument(item.file_id, { caption })]); }
          else { await ctx.replyWithDocument(item.file_id, { caption }); }
          break;
        case 'audio':
          if (record) { await record([await ctx.replyWithAudio(item.file_id, { caption })]); }
          else { await ctx.replyWithAudio(item.file_id, { caption }); }
          break;
        case 'voice':
          if (record) { await record([await ctx.replyWithVoice(item.file_id, { caption })]); }
          else { await ctx.replyWithVoice(item.file_id, { caption }); }
          break;
        case 'animation':
          if (record) { await record([await ctx.replyWithAnimation(item.file_id, { caption })]); }
          else { await ctx.replyWithAnimation(item.file_id, { caption }); }
          break;
        case 'video_note':
          if (record) { await record([await ctx.replyWithVideoNote(item.file_id)]); }
          else { await ctx.replyWithVideoNote(item.file_id); }
          break;
      }
    } catch (error: any) {
      const handled = await trySingleBotHealing(error);
      if (!handled) {
        console.error(`[发送失败] 即使尝试自愈也未能送达:`, error.message);
      }
    }
  }

  private static chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

}
