import { Context, Markup } from 'telegraf';
import { randomBytes } from 'crypto';
import { database } from '../../database';
import { getAdminPersistentChannelId, isSuperAdmin } from '../../config';
import { MediaItem } from '../../types';
import { appendKeywordTag } from '../../utils/keywordTag';
import { watermarkService } from '../../services/watermark';

interface ReplacementSession {
  token: string;
  chatId: number;
  messageId: number;
  mode: 'choose' | 'caption' | 'photos';
  photos: Array<{ fileId: string; messageId: number }>;
  expires: number;
  busy: boolean;
  expected: MediaItem[];
}

export class ReplaceGroupHandler {
  private static sessions = new Map<string, ReplacementSession>();

  static async cancelForNavigation(ctx: Context): Promise<boolean> {
    const key = this.key(ctx);
    if (this.sessions.get(key)?.busy) {
      if (ctx.callbackQuery) await ctx.answerCbQuery('正在保存替换，请稍候。');
      else await ctx.reply('正在保存替换，请稍候。');
      return false;
    }
    this.sessions.delete(key);
    return true;
  }

  private static key(ctx: Context): string { return `${ctx.chat?.id}:${ctx.from?.id}`; }
  private static scope(ctx: Context): number | undefined {
    return isSuperAdmin(ctx.from!.id) ? undefined : ctx.from!.id;
  }
  private static keyboard(session: ReplacementSession, photos = false) {
    const prefix = `replace_group:${session.token}:`;
    return Markup.inlineKeyboard(photos ? [
      [Markup.button.callback('✅ 完成替换', prefix + 'save')],
      [Markup.button.callback('取消', prefix + 'cancel')]
    ] : [
      [Markup.button.callback('替换文案', prefix + 'caption'), Markup.button.callback('替换照片', prefix + 'photos')],
      [Markup.button.callback('取消', prefix + 'cancel')]
    ]);
  }

  static async handleMessage(ctx: Context, db: typeof database): Promise<boolean> {
    if (!ctx.from || !ctx.chat || !ctx.message) return false;
    const key = this.key(ctx);
    for (const [id, state] of this.sessions) {
      if (!state.busy && state.expires < Date.now()) this.sessions.delete(id);
    }
    let session = this.sessions.get(key);
    const message = ctx.message;
    const text = 'text' in message ? message.text : '';
    if (text.trim() === '替换' && 'reply_to_message' in message && message.reply_to_message) {
      if (session?.busy) { await ctx.reply('正在保存替换，请稍候。'); return true; }
      try {
        const items = await db.getSearchGroup(ctx.chat.id, message.reply_to_message.message_id, this.scope(ctx));
        session = { token: randomBytes(8).toString('hex'), chatId: ctx.chat.id,
          messageId: message.reply_to_message.message_id, mode: 'choose', photos: [],
          expires: Date.now() + 30 * 60 * 1000, busy: false, expected: items };
        this.sessions.set(key, session);
        await ctx.reply(`请选择要替换「${items[0].keyword}」这组资料的内容：`, this.keyboard(session));
      } catch (error: any) { await ctx.reply(`❌ ${error.message}`); }
      return true;
    }
    if (!session || session.mode === 'choose') return false;
    if (session.busy) { await ctx.reply('正在保存替换，请稍候。'); return true; }
    if (text.trim() === '取消') {
      this.sessions.delete(key);
      await ctx.reply('已取消替换。');
      return true;
    }
    session.expires = Date.now() + 30 * 60 * 1000;
    if (session.mode === 'caption') {
      if (!text.trim()) { await ctx.reply('请发送新文案文字，或回复“取消”。'); return true; }
      session.busy = true;
      try {
        const current = await db.getSearchGroup(session.chatId, session.messageId, this.scope(ctx));
        if (JSON.stringify(current) !== JSON.stringify(session.expected)) throw new Error('资料已发生变化，请重新引用并替换');
        const caption = appendKeywordTag(text, current[0].keyword);
        const updated = current.map((item, index) => ({ ...item, caption: index === 0 ? caption : undefined }));
        await db.replaceSearchGroup(session.chatId, session.messageId, this.scope(ctx), current, updated);
        this.sessions.delete(key);
        await ctx.reply('✅ 这组资料的文案已替换，重新搜索即可查看。');
      } catch (error: any) { await ctx.reply(`❌ ${error.message}，可重新发送或取消。`); }
      finally { session.busy = false; }
      return true;
    }
    if ('photo' in message) {
      if (!session.photos.some(photo => photo.messageId === message.message_id)) {
        session.photos.push({ fileId: message.photo[message.photo.length - 1].file_id, messageId: message.message_id });
      }
      // A finish button is shown before collecting, so albums need no timing heuristic.
      return true;
    }
    await ctx.reply('请发送新照片，全部发送后点击“完成替换”；也可以回复“取消”。', this.keyboard(session, true));
    return true;
  }

  static async handleCallback(ctx: Context, db: typeof database): Promise<void> {
    if (!ctx.from || !ctx.chat || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
    const [, token, action] = ctx.callbackQuery.data.split(':');
    const key = this.key(ctx);
    const session = this.sessions.get(key);
    if (!session || session.token !== token || (!session.busy && session.expires < Date.now())) {
      await ctx.answerCbQuery('按钮已失效，请重新引用资料回复“替换”。');
      return;
    }
    if (session.busy) { await ctx.answerCbQuery('正在保存，请稍候。'); return; }
    await ctx.answerCbQuery();
    if (session.busy) return;
    if (action === 'cancel') {
      this.sessions.delete(key);
      await ctx.editMessageText('已取消替换。');
      return;
    }
    if (action === 'caption' || action === 'photos') {
      try { await db.getSearchGroup(session.chatId, session.messageId, this.scope(ctx)); }
      catch (error: any) { this.sessions.delete(key); await ctx.reply(`❌ ${error.message}`); return; }
      session.mode = action;
      session.photos = [];
      session.expires = Date.now() + 30 * 60 * 1000;
      if (action === 'caption') {
        await ctx.editMessageText('请发送这组资料的新文案（含关键词标签不超过 1024 字符），或回复“取消”。',
          Markup.inlineKeyboard([[Markup.button.callback('取消', `replace_group:${token}:cancel`)]]));
      } else {
        await ctx.editMessageText('请发送新照片，可连续发送多张。全部发送后点击“完成替换”。\n原有文案、视频等其他文件保留。', this.keyboard(session, true));
      }
      return;
    }
    if (action !== 'save' || session.mode !== 'photos') return;
    if (!session.photos.length) { await ctx.reply('请先发送新照片。'); return; }
    session.busy = true;
    try {
      const current = await db.getSearchGroup(session.chatId, session.messageId, this.scope(ctx));
      if (JSON.stringify(current) !== JSON.stringify(session.expected)) throw new Error('资料已发生变化，请重新引用并替换');
      const caption = current.find(item => item.caption)?.caption;
      const base = current[0];
      const vault = getAdminPersistentChannelId(base.uploaded_by);
      const photos: MediaItem[] = session.photos.map((photo, index) => ({
        id: -(index + 1), keyword: base.keyword, batchId: base.batchId, uploaded_by: base.uploaded_by,
        uploaded_at: base.uploaded_at, is_published: false, file_type: 'photo', file_id: photo.fileId,
        source_chat_id: String(session.chatId), source_msg_id: photo.messageId
      }));
      await ctx.reply('正在保存新照片，请稍候。');
      if (current.some(item => item.file_type === 'photo' && item.watermarked)) {
        await watermarkService.assertReady(vault);
        for (let offset = 0; offset < photos.length; offset += 10) {
          const chunk = photos.slice(offset, offset + 10);
          const results = await watermarkService.processTelegramAlbum(ctx.telegram,
            chunk.map(item => ({ fileId: item.file_id, type: 'photo' })), vault!, offset === 0 ? caption || '' : '');
          results.forEach((result, index) => Object.assign(chunk[index], {
            original_file_id: chunk[index].file_id, file_id: result.fileId, watermarked: true,
            watermark_version: result.version, watermarked_at: new Date().toISOString(),
            source_chat_id: result.sourceChatId, source_msg_id: result.sourceMsgId
          }));
        }
      } else if (vault) {
        for (const photo of photos) {
          const sent = await ctx.telegram.copyMessage(vault, session.chatId, photo.source_msg_id!, { caption: '' });
          photo.source_chat_id = vault;
          photo.source_msg_id = sent.message_id;
        }
      }
      const updated = [...photos, ...current.filter(item => item.file_type !== 'photo')]
        .map((item, index) => ({ ...item, caption: index === 0 ? caption : undefined }));
      await db.replaceSearchGroup(session.chatId, session.messageId, this.scope(ctx), current, updated);
      this.sessions.delete(key);
      await ctx.editMessageText(`✅ 这组资料的照片已替换为 ${photos.length} 张，重新搜索即可查看。`);
    } catch (error: any) {
      await ctx.reply(`❌ 替换未完成：${error.message}。可点击“完成替换”重试或取消。`);
    } finally { session.busy = false; }
  }
}
