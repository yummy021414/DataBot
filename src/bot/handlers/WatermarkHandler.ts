import { Context, Markup } from 'telegraf';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { database } from '../../database';
import { config, getAdminPersistentChannelId, isSuperAdmin, isAdminUser, watermarkConfig } from '../../config';
import { MediaItem } from '../../types';
import { watermarkService, WatermarkMediaType, watermarkError, watermarkApi } from '../../services/watermark';

interface MigrationJob {
  running: boolean;
  cancelRequested: boolean;
  requestedBy: number;
  total: number;
  done: number;
  failed: number;
  startedAt: string;
  finishedAt?: string;
  currentMediaId?: number;
  lastError?: string;
  phase?: string;
}

/** 管理新旧资料水印化。全局只允许一个迁移任务，避免抢占服务器资源。 */
export class WatermarkHandler {
  static clearInput(userId: number): void {
    this.inputs.delete(userId);
    this.selections.delete(userId);
  }
  private static job: MigrationJob | null = null;
  private static starting = false;
  private static inputs = new Map<number, { chatId: number; expiresAt: number }>();
  private static selections = new Map<number, {
    chatId: number; expiresAt: number; token: string; keywords: string[]; ids: number[];
  }>();

  static async handleMenu(ctx: Context, db: typeof database): Promise<void> {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId || !isAdminUser(userId)) return;
    this.inputs.delete(userId);
    this.selections.delete(userId);

    const scopeUserId = isSuperAdmin(userId) ? undefined : userId;
    const allMedia = await db.getAllMedia(scopeUserId);
    const visual = allMedia.filter(item => item.file_type === 'photo' || item.file_type === 'video');
    const pending = visual.filter(item => !this.isCurrentVersion(item));
    const completed = visual.length - pending.length;
    const queue = watermarkService.getStatus();
    const job = this.job && (isSuperAdmin(userId) || this.job.requestedBy === userId) ? this.job : null;

    let text =
      `🛡️ 水印管理\n\n` +
      `状态：${watermarkConfig.enabled ? '✅ 已启用' : '⚠️ 未启用'}\n` +
      `水印文字：${watermarkConfig.text || '（未配置）'}\n` +
      `模式：按关键词手动处理；新上传默认原版\n\n` +
      `照片/视频总数：${visual.length}\n` +
      `已完成：${completed}\n` +
      `未加水印：${pending.length}（不会自动处理）\n` +
      `处理队列：交互 ${queue.interactiveWaiting} / 迁移 ${queue.migrationWaiting}`;

    if (job) {
      const percent = job.total > 0 ? Math.floor((job.done + job.failed) / job.total * 100) : 100;
      text +=
        `\n\n最近任务：${job.running ? (job.cancelRequested ? '⏸ 正在安全暂停' : '🔄 运行中') : '已结束'}` +
        `\n进度：${job.done + job.failed}/${job.total}（${percent}%）` +
        `\n成功：${job.done}，失败：${job.failed}` +
        (job.currentMediaId ? `\n当前资料：#${job.currentMediaId}` : '') +
        (job.lastError ? `\n最后错误：${job.lastError.slice(0, 300)}` : '');
    }

    const rows: any[][] = [];
    if (job?.running) {
      rows.push([Markup.button.callback('⏸ 安全暂停', 'watermark_stop')]);
    } else if (pending.length > 0) {
      rows.push([Markup.button.callback('📝 输入关键词批量加水印', 'watermark_confirm')]);
    }
    rows.push([Markup.button.callback('🔄 刷新状态', 'watermark_menu')]);
    rows.push([Markup.button.callback('⬅️ 返回主菜单', 'back_to_main')]);

    const extra = Markup.inlineKeyboard(rows);
    try {
      if (ctx.callbackQuery) await ctx.editMessageText(text, extra);
      else await ctx.reply(text, extra);
    } catch {
      await ctx.reply(text, extra);
    }
  }

  static async handleConfirm(ctx: Context, _db: typeof database): Promise<void> {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId || !ctx.chat?.id || !isAdminUser(userId)) return;
    if (this.job?.running || this.starting) { await ctx.reply('请先暂停当前水印任务。'); return; }
    this.selections.delete(userId);
    this.inputs.set(userId, { chatId: ctx.chat.id, expiresAt: Date.now() + 10 * 60 * 1000 });
    await ctx.reply('请输入需要加水印的关键词，用空格、逗号或换行分隔。\n例如：11 22 33 44\n\n只精确匹配这些关键词，不会处理其他资料。输入“取消”退出。');
  }

  static async handleKeywordInput(ctx: Context, db: typeof database): Promise<boolean> {
    const userId = ctx.from?.id;
    if (!userId || !isAdminUser(userId)) return false;
    const input = this.inputs.get(userId);
    if (!input || input.chatId !== ctx.chat?.id) return false;
    if (input.expiresAt < Date.now()) { this.inputs.delete(userId); return false; }
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text.trim() : '';
    if (!text) return false;
    if (text === '取消' || text.startsWith('/')) { this.inputs.delete(userId); return text === '取消'; }
    const keywords = [...new Set(text.split(/[\s,，、]+/u).filter(Boolean))];
    if (!keywords.length || keywords.length > 100) {
      await ctx.reply('每次请输入 1～100 个关键词。'); return true;
    }
    const all = await db.getAllMedia(isSuperAdmin(userId) ? undefined : userId);
    const matches = all.filter(item => keywords.includes(item.keyword) && ['photo', 'video'].includes(item.file_type));
    const found = new Set(matches.map(item => item.keyword));
    const missing = keywords.filter(k => !found.has(k));
    const pending = matches.filter(item => !this.isCurrentVersion(item));
    if (!pending.length) {
      await ctx.reply('没有待处理照片或视频：关键词不存在，或所选资料已完成水印。请重新输入。'); return true;
    }
    const token = randomBytes(8).toString('hex');
    this.selections.set(userId, { chatId: input.chatId, expiresAt: Date.now() + 10 * 60 * 1000, token,
      keywords, ids: matches.map(item => item.id) });
    this.inputs.delete(userId);
    await ctx.reply('确认按关键词加水印\n\n关键词：' + keywords.join('、') +
      '\n照片/视频：' + matches.length + ' 个\n本次待处理：' + pending.length + ' 个' +
      (missing.length ? '\n未找到：' + missing.join('、') : '') +
      '\n\n新上传仍保存原版。本次只修改上面选中的资料，已发布消息不会自动改变。',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ 只处理以上关键词', 'watermark_start:' + token)],
        [Markup.button.callback('取消', 'watermark_menu')]
      ]));
    return true;
  }

  static async handleStart(ctx: Context, db: typeof database): Promise<void> {
    if (ctx.callbackQuery) await ctx.answerCbQuery('正在启动后台任务…').catch(() => {});
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId || !isAdminUser(userId)) return;
    const selection = this.selections.get(userId);
    const callback = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
    if (!selection || selection.chatId !== chatId || selection.expiresAt < Date.now() ||
        callback !== 'watermark_start:' + selection.token) {
      await ctx.reply('请先在水印管理里输入关键词并确认。旧的全库处理按钮已失效。');
      return;
    }
    if (this.starting || this.job?.running) {
      await ctx.reply('⏳ 已有一个旧资料水印任务正在运行，请先等待或暂停。');
      return;
    }

    this.starting = true;
    try {

    const scopeUserId = isSuperAdmin(userId) ? undefined : userId;
    const allMedia = (await db.getAllMedia(scopeUserId)).filter(item =>
      selection.ids.includes(item.id) && selection.keywords.includes(item.keyword));
    const pending = allMedia.filter(
      item => (item.file_type === 'photo' || item.file_type === 'video') && !this.isCurrentVersion(item)
    ).map(item => ({ ...item }));
    if (pending.length === 0) {
      await ctx.reply('✅ 当前没有需要处理的照片或视频。');
      return;
    }

    try {
      await watermarkService.assertReady(getAdminPersistentChannelId(pending[0].uploaded_by));
    } catch (error: any) {
      await ctx.reply(`❌ 无法启动：${error?.message || error}`);
      return;
    }

    this.job = {
      running: true,
      cancelRequested: false,
      requestedBy: userId,
      total: pending.length,
      done: 0,
      failed: 0,
      startedAt: new Date().toISOString()
    };
    this.selections.delete(userId);
    let statusMessage: { message_id: number };
    try { statusMessage = await ctx.reply(
      `🛡️ 旧资料水印任务已启动\n\n进度：0/${pending.length}\n机器人其他功能可继续正常使用。`
    ); } catch (e) { this.job.running = false; throw e; }
    setImmediate(() => {
      const affected = this.migrationGroups(allMedia).filter(group => group.some(item => !this.isCurrentVersion(item))).flat();
      void this.runMigration(ctx.telegram, chatId, statusMessage.message_id, affected.map(item => ({ ...item })), db).catch(() => {
        if (this.job) this.job.running = false;
      });
    });
    } finally { this.starting = false; }
  }

  static async handleStop(ctx: Context): Promise<void> {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    const uid = ctx.from?.id;
    if (!uid || !isAdminUser(uid)) return;
    if (this.job && !isSuperAdmin(uid) && this.job.requestedBy !== uid) {
      await ctx.reply('只能暂停自己发起的任务。');
      return;
    }
    if (!this.job?.running) {
      await ctx.reply('当前没有运行中的水印任务。');
      return;
    }
    this.job.cancelRequested = true;
    await ctx.reply('⏸ 已请求安全暂停。当前相册处理完后停止，已完成进度不会丢失。');
  }

  private static async runMigration(
    telegram: any,
    chatId: number,
    statusMessageId: number,
    pending: MediaItem[],
    db: typeof database
  ): Promise<void> {
    const job = this.job!;
    const groups = this.migrationGroups(pending);
    const heartbeat = setInterval(() => {
      void this.updateProgressMessage(telegram, chatId, statusMessageId, job);
    }, 15000);
    const recordFailure = async (items: MediaItem[], error: any) => {
      const affected = items.filter(item => !this.isCurrentVersion(item));
      job.failed += affected.length;
      job.lastError = affected.map(item => '#' + item.id).join(', ') + ': ' + watermarkError(error);
      console.error('[水印迁移]', job.lastError);
      try {
        await fs.promises.appendFile(path.join(path.dirname(path.resolve(config.databasePath)), 'watermark-failures.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), ids: affected.map(item => item.id), error: watermarkError(error) }) + '\n');
      } catch (e) { console.error('[水印迁移] 失败清单写入失败'); }
    };
    try {
      for (const group of groups) {
        for (let offset = 0; offset < group.length; offset += 10) {
          if (job.cancelRequested) return;
          const chunk = group.slice(offset, offset + 10);
          if (chunk.every(item => this.isCurrentVersion(item))) continue;
          job.currentMediaId = chunk[0].id;
          job.phase = '获取本组文件信息';
          const chat = getAdminPersistentChannelId(chunk[0].uploaded_by);
          const prepared: Array<{ item: MediaItem; fileId: string; type: WatermarkMediaType; ready: boolean; info?: any } | undefined> = new Array(chunk.length);
          // Two metadata requests at most; encoding stays serial/low priority.
          let cursor = 0;
          await Promise.all([0, 1].map(async () => {
            for (;;) {
              const i = cursor++;
              if (i >= chunk.length) return;
              const item = chunk[i];
              try {
                const ready = this.isCurrentVersion(item);
                if (!ready && item.watermarked && !item.original_file_id)
                  throw new Error('缺少原始文件，不能重复叠加水印');
                let fileId = ready ? item.file_id : item.original_file_id || item.file_id;
                let info: any;
                if (!ready) {
                  try {
                    info = await watermarkApi(telegram, 'getFile', { file_id: fileId });
                  } catch (error: any) {
                    if (error?.response?.error_code !== 400 || /too big/i.test(watermarkError(error))) throw error;
                    const sourceChat = item.watermarked ? item.original_source_chat_id : item.source_chat_id;
                    const sourceMsg = item.watermarked ? item.original_source_msg_id : item.source_msg_id;
                    if (!sourceChat || !sourceMsg) throw new Error('原文件标识失效且无金库恢复坐标');
                    // Reclaim in the requesting admin's private chat, never scatter raw posts in the vault.
                    const forwarded = await watermarkApi(telegram, 'forwardMessage', {
                      chat_id: job.requestedBy, from_chat_id: sourceChat, message_id: sourceMsg, disable_notification: true
                    });
                    try {
                      fileId = this.extractFileId(forwarded, item.file_type as WatermarkMediaType) || '';
                      if (!fileId) throw new Error('从原金库恢复失败');
                      info = await watermarkApi(telegram, 'getFile', { file_id: fileId });
                    } finally {
                      await watermarkApi(telegram, 'deleteMessage', { chat_id: job.requestedBy, message_id: forwarded.message_id }).catch(() => {});
                    }
                  }
                  const cloud = !process.env.TELEGRAM_API_ROOT || process.env.TELEGRAM_API_ROOT === 'https://api.telegram.org';
                  if (cloud && info.file_size > 20 * 1024 * 1024)
                    throw new Error('超过官方下载上限 20MB，需本地 Bot API 或压缩原视频');
                }
                prepared[i] = { item, fileId, type: item.file_type as WatermarkMediaType, ready, info };
              } catch (error) { await recordFailure([item], error); }
            }
          }));
          const usable = prepared.filter((x): x is NonNullable<typeof x> => !!x);
          if (!usable.some(x => !x.ready)) continue;
          try {
            const caption = offset === 0 ? group.find(item => item.caption?.trim())?.caption || '' : '';
            const results = await watermarkService.processTelegramAlbum(telegram, usable.map(({ item, ...input }) => input),
              chat!, caption, async done => {
                job.phase = '本组准备 ' + done + '/' + usable.length + '，随后整组上传';
              }, 'migration', () => job.cancelRequested);
            await db.updateMediaWatermarkBatch(usable.map((entry, i) => ({
              id: entry.item.id, ...results[i], expectedFileId: entry.item.file_id
            })));
            job.done += usable.filter(x => !x.ready).length;
          } catch (error) {
            if (job.cancelRequested) return;
            await recordFailure(usable.map(x => x.item), error);
          }
          job.phase = '本组结束';
          await this.updateProgressMessage(telegram, chatId, statusMessageId, job);
          // No per-file sleep: Telegram receives one album per group, not ten individual uploads.
        }
      }
    } finally {
      clearInterval(heartbeat);
      job.running = false;
      job.finishedAt = new Date().toISOString();
      job.currentMediaId = undefined;
      job.phase = undefined;
      await this.updateProgressMessage(telegram, chatId, statusMessageId, job, true);
    }
  }

  private static migrationGroups(items: MediaItem[]): MediaItem[][] {
    const groups = new Map<string, MediaItem[]>();
    for (const item of items) {
      if (item.file_type !== 'photo' && item.file_type !== 'video') continue;
      const key = JSON.stringify([item.uploaded_by, item.keyword, !!item.is_review, item.batchId || 'single_' + item.id]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
    return [...groups.values()];
  }

  private static async updateProgressMessage(
    telegram: any,
    chatId: number,
    messageId: number,
    job: MigrationJob,
    final = false
  ): Promise<void> {
    const processed = job.done + job.failed;
    const elapsed = (Date.now() - Date.parse(job.startedAt)) / 1000;
    const remainingMinutes = processed >= 20 && elapsed > 0
      ? Math.ceil(elapsed / processed * (job.total - processed) / 60) : undefined;
    const percent = job.total ? Math.floor(processed / job.total * 100) : 100;
    const state = final
      ? (job.cancelRequested ? '⏸ 已安全暂停' : '✅ 任务结束')
      : `🔄 后台处理中（${new Date().toLocaleTimeString('zh-CN')}）`;
    const text =
      `🛡️ 旧资料水印化：${state}\n\n` +
      `进度：${processed}/${job.total}（${percent}%）\n` +
      `成功：${job.done}\n` +
      `失败：${job.failed}` +
      (job.phase ? `\n阶段：${job.phase}` : '') +
      (!final && remainingMinutes !== undefined ? `\n预计本轮剩余：约 ${remainingMinutes} 分钟（含失败跳过，随视频耗时调整）` : '') +
      (job.currentMediaId ? `\n当前资料：#${job.currentMediaId}` : '') +
      (job.lastError ? `\n\n最后错误：${job.lastError.slice(0, 500)}` : '') +
      (final && job.failed > 0 ? `\n\n可再次点击“一键处理”重试失败项。` : '');
    await telegram.editMessageText(chatId, messageId, undefined, text, {
      reply_markup: {
        inline_keyboard: final
          ? [[{ text: '🛡️ 返回水印管理', callback_data: 'watermark_menu' }]]
          : [[{ text: '⏸ 安全暂停', callback_data: 'watermark_stop' }]]
      }
    }).catch(() => {});
  }

  private static extractFileId(message: any, type: WatermarkMediaType): string | undefined {
    if (type === 'photo') {
      const photos = message?.photo;
      return Array.isArray(photos) && photos.length ? photos[photos.length - 1].file_id : undefined;
    }
    return message?.video?.file_id;
  }

  private static isCurrentVersion(item: MediaItem): boolean {
    return Boolean(item.watermarked && item.watermark_version === watermarkConfig.version);
  }
}
