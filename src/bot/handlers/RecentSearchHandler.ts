import { Context, Markup } from 'telegraf';
import { createHash } from 'crypto';
import { database } from '../../database';
import { config, isAdminUser, isSuperAdmin } from '../../config';
import { SearchHandler } from './SearchHandler';

export class RecentSearchHandler {
  private static hash(keyword: string): string {
    return createHash('sha256').update(keyword).digest('hex').slice(0, 24);
  }

  static async handle(ctx: Context, db: typeof database): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    const data = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
    const parts = data.split(':');
    if (parts[0] === 'recent_search' && Number(parts[1]) !== userId) {
      await ctx.answerCbQuery('这是其他用户的搜索记录，请从“查看资料”打开自己的最近搜索。');
      return;
    }
    if (ctx.callbackQuery) await ctx.answerCbQuery();
    const scope = isSuperAdmin(userId) ? undefined : isAdminUser(userId) ? userId : config.superAdminId;
    const entries = await db.getRecentSearches(userId, scope);
    if (parts[2] === 'view') {
      const entry = entries.find(item => this.hash(item.keyword) === parts[3]);
      if (!entry) { await ctx.reply('该关键词已失效或不在最近搜索中，请重新打开列表。'); return; }
      await SearchHandler.handleSearch(ctx, entry.keyword, db);
      return;
    }
    const totalPages = Math.max(1, Math.ceil(entries.length / 60));
    const requested = Number(parts[3]) || 0;
    const page = Math.min(totalPages - 1, Math.max(0, Math.floor(requested)));
    const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
    const items = entries.slice(page * 60, (page + 1) * 60);
    for (let i = 0; i < items.length; i += 3) {
      buttons.push(items.slice(i, i + 3).map(item => Markup.button.callback(
        `📁 ${Array.from(item.keyword).slice(0, 10).join('')}${Array.from(item.keyword).length > 10 ? '…' : ''} · ${item.count}次`,
        `recent_search:${userId}:view:${this.hash(item.keyword)}`)));
    }
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('⬅️ 上一页', `recent_search:${userId}:page:${page - 1}`));
    if (page + 1 < totalPages) nav.push(Markup.button.callback('下一页 ➡️', `recent_search:${userId}:page:${page + 1}`));
    if (nav.length) buttons.push(nav);
    buttons.push([Markup.button.callback('🔄 刷新', `recent_search:${userId}:page:${page}`)]);
    buttons.push([Markup.button.callback('⬅️ 返回查看资料', 'start_keywords')]);
    const text = `🕘 最近搜索（第 ${page + 1}/${totalPages} 页）\n\n` +
      '显示你最近 30 天搜索过的关键词，最近搜索的排最前，按钮保留这 30 天的搜索次数。\n\n' +
      (entries.length ? `共 ${entries.length} 个关键词，点击即可查看资料。` : '近 30 天暂无可查看的搜索记录。搜索关键词或点击资料关键词后会自动记录。');
    if (ctx.callbackQuery) {
      try { await ctx.editMessageText(text, Markup.inlineKeyboard(buttons)); }
      catch (error: any) { if (!String(error.description || error.message).includes('message is not modified')) throw error; }
    } else await ctx.reply(text, Markup.inlineKeyboard(buttons));
  }
}
