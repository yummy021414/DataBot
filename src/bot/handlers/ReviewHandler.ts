import { Context, Markup } from 'telegraf';
import { BotMode, UserSession, MediaItem } from '../../types';
import { database } from '../../database';
import { config } from '../../config';
import { SearchHandler } from './SearchHandler';
import { UploadHandler } from './UploadHandler';

export class ReviewHandler {
  // 1. 用户进入好评库
  static async handleStart(ctx: Context, db: any, page: number = 0): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    try {
      const keywords = await db.getKeywordsWithReviews();
      const isAdmin = userId === config.superAdminId;
      
      console.log(`[好评库] 用户 ${userId} 进入好评库, 关键词总数: ${keywords.length}`);

      if (keywords.length === 0) {
        const msg = '💎 <b>好评库</b>\n\n目前暂无好评反馈记录。';
        const emptyButtons = [];
        if (isAdmin) {
          emptyButtons.push([Markup.button.callback('➕ 新增首条好评', 'admin_add_review')]);
        }
        emptyButtons.push([Markup.button.callback('🔙 返回', 'start_keywords')]);

        if (ctx.callbackQuery) await ctx.editMessageText(msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(emptyButtons) });
        else await ctx.reply(msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(emptyButtons) });
        return;
      }

      const itemsPerPage = 60;
      const startIndex = page * itemsPerPage;
      const totalPages = Math.ceil(keywords.length / itemsPerPage);
      const pageKeywords = keywords.slice(startIndex, startIndex + itemsPerPage);

      const buttons = [];
      for (let i = 0; i < pageKeywords.length; i += 3) {
        const row = pageKeywords.slice(i, i + 3).map((kw: string) => 
          Markup.button.callback(`⭐ ${kw.substring(0, 10)}`, `review_view_${kw}`)
        );
        buttons.push(row);
      }

      const navRow = [];
      if (page > 0) navRow.push(Markup.button.callback('⬅️ 上一页', `review_page_${page - 1}`));
      if (page < totalPages - 1) navRow.push(Markup.button.callback('下一页 ➡️', `review_page_${page + 1}`));
      if (navRow.length > 0) buttons.push(navRow);

      if (isAdmin) {
        buttons.push([Markup.button.callback('➕ 新增好评记录', 'admin_add_review')]);
      }
      
      buttons.push([Markup.button.callback('🔙 返回资料库', 'start_keywords')]);

      const text = `💎 <b>好评库 (第 ${page + 1}/${totalPages} 页)</b>\n\n` +
                   `以下是收到真实反馈的关键词列表：\n` +
                   `💡 排序：最新好评在前\n\n` +
                   `👇 点击下方关键词查看完整资料及好评：`;

      if (ctx.callbackQuery) {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
      } else {
        await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
      }

    } catch (error) {
      console.error('好评库启动失败:', error);
      await ctx.reply('❌ 无法加载好评库，请稍后重试。');
    }
  }

  // 2. 用户点击具体关键词查看好评
  static async handleViewReview(ctx: Context, db: any, keyword: string): Promise<void> {
    console.log(`[好评库] 用户 ${ctx.from?.id} 查看关键词 "${keyword}" 的好评`);
    await ctx.answerCbQuery(`🔍 正在加载 ${keyword} 的好评记录...`);
    
    try {
      const regularMedia = await db.getMediaByKeyword(keyword);
      if (regularMedia.length > 0) {
        const batches = SearchHandler.groupMediaByBatch(regularMedia);
        const batchIds = Object.keys(batches);
        for (const bId of batchIds) {
          await SearchHandler.sendMediaGroups(ctx, SearchHandler.groupMediaByType(batches[bId]), true);
          await new Promise(r => setTimeout(r, 800));
        }
      }

      const reviewMedia = await db.getReviewsByKeyword(keyword);
      if (reviewMedia.length > 0) {
        const grouped = SearchHandler.groupMediaByType(reviewMedia);
        await SearchHandler.sendMediaGroups(ctx, grouped, true);
      }

    } catch (error) {
      console.error('查看好评失败:', error);
      await ctx.reply('❌ 加载好评内容失败。');
    }
  }

  // 3. 管理员：启动新增好评流程
  static async handleAdminAddStart(ctx: Context, db: any): Promise<void> {
    if (ctx.from?.id !== config.superAdminId) return;

    console.log(`[好评库] 管理员 ${ctx.from?.id} 启动新增好评流程`);

    const session: UserSession = {
      userId: ctx.from!.id,
      mode: BotMode.AddReview, // 🚀 使用独立模式
      step: 'waiting_keyword'
    };

    await db.saveUserSession(ctx.from!.id, session);
    
    const text = '✨ <b>新增好评记录</b>\n\n请发送要关联的<b>关键词</b>：';
    const kbd = Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', 'cancel_upload')]]);

    if (ctx.callbackQuery) await ctx.editMessageText(text, { parse_mode: 'HTML', ...kbd });
    else await ctx.reply(text, { parse_mode: 'HTML', ...kbd });
  }

  // 4. 处理关键词输入
  static async handleKeywordInput(ctx: Context, text: string, db: any, userSessions: Map<number, UserSession>): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    console.log(`[好评库] 管理员 ${userId} 输入好评关键词: "${text}"`);

    const exists = await db.keywordExists(text);
    if (!exists) {
      console.log(`[好评库] 关键词 "${text}" 不存在`);
      await ctx.reply(`❌ 库内不存在关键词 "${text}"，请重新输入正确的关键词：`);
      return;
    }

    const session = userSessions.get(userId) || await db.getUserSession(userId);
    if (session) {
      session.currentKeyword = text;
      session.step = 'waiting_media';
      session.pendingMedia = [];
      session.pendingText = 'is_review_mode'; 
      userSessions.set(userId, session);
      await db.saveUserSession(userId, session);
      console.log(`[好评库] 状态已更新: step=waiting_media, keyword=${text}`);
    }

    await ctx.reply(`✅ 已关联关键词: <b>${text}</b>\n\n现在请发送该关键词对应的<b>好评图片/视频</b>：\n\n好评图片保存时自动添加水印，视频保持原版。`, { parse_mode: 'HTML' });
  }
}
