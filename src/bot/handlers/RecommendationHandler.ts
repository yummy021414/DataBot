import { Context, Markup } from 'telegraf';
import { database } from '../../database';
import { UserSession, BotMode } from '../../types';
import { getAdminChannelIds, hasAdminChannelMap, isAdminUser, isSuperAdmin } from '../../config';
import { recommendations, Recommendation } from '../../services/recommendations';

export class RecommendationHandler {
  static parseKeywords(text: string, known: string[]): string[] {
    if (known.includes(text.trim())) return [text.trim()];
    const sorted = known.filter(Boolean).sort((a, b) => b.length - a.length || a.localeCompare(b));
    return [...new Set(text.split(/[\s,，、|／/]+/).filter(Boolean).flatMap(part => {
      const matches: string[] = [];
      for (let offset = 0; offset < part.length;) {
        const hit = sorted.find(k => part.startsWith(k, offset));
        if (!hit) return [part]; // Preserve unknown names rather than silently dropping characters.
        matches.push(hit); offset += hit.length;
      }
      return matches;
    }))];
  }
  static async normalize(d: Recommendation) {
    const known = await database.getAllKeywords(isSuperAdmin(d.owner) ? undefined : d.owner);
    const values = [...new Set(d.keywords.flatMap(k => this.parseKeywords(k, known)))];
    if (values.length <= 60 && JSON.stringify(values) !== JSON.stringify(d.keywords)) {
      d.keywords = values; recommendations.change(d);
    }
  }
  static async bind(ctx: Context) {
    try {
      const uid = ctx.from!.id;
      if (ctx.chat?.type !== 'private' || !isAdminUser(uid) || recommendations.busy.has(uid)) throw new Error('请私聊机器人完成本期推荐。');
      const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
      const match = text.trim().match(/^\/recommend_bind(?:@\w+)?\s+(https:\/\/t\.me\/(?:c\/\d+|\w+)\/\d+)$/);
      if (!match) throw new Error('格式：/recommend_bind 推荐消息链接（从频道复制已发出的推荐消息链接）');
      const d = recommendations.get(uid) || recommendations.create(uid, [], 'manual');
      await this.bindLink(ctx, d, match[1]);
      await ctx.reply('文案消息已绑定。资料发布后输入特别推荐关键词，机器人会编辑这条原消息的按钮。');
    } catch (e: any) { await ctx.reply(`⚠️ ${e.message}`); }
  }
  static async bindLink(ctx: Context, d: Recommendation, link: string) {
    const match = link.trim().match(/^https:\/\/t\.me\/(?:c\/(\d+)|(\w+))\/(\d+)\/?$/);
    if (!match) throw new Error('请发送从目标频道或超级群复制的文案消息链接。');
    const chat = await ctx.telegram.getChat(match[1] ? '-100' + match[1] : '@' + match[2]);
    const allowed = (await this.allowed(ctx)).find(c => c.id === String(chat.id));
    if (!allowed || !['channel', 'supergroup'].includes(chat.type)) throw new Error('该链接不属于你有权限的频道或超级群。');
    if (d.channels.length && !d.channels.some(c => c.id === allowed.id)) throw new Error('该链接不是本期推荐的目标频道。');
    const post = d.posts[allowed.id];
    if (post?.messageId && post.messageId !== Number(match[3])) throw new Error('本期已经绑定另一条文案消息；请先结束本期再新建。');
    if (!d.channels.length) d.channels = [allowed];
    d.posts[allowed.id] = { messageId: Number(match[3]) };
    delete d.input; recommendations.change(d);
  }
  static async allowed(ctx: Context) {
    const uid = ctx.from!.id;
    if (!isAdminUser(uid)) throw new Error('仅管理员可使用推荐推送。');
    const ids = hasAdminChannelMap(uid) ? getAdminChannelIds(uid) : await database.getManagedChannels();
    const chats = await Promise.all(ids.map(id => ctx.telegram.getChat(id)));
    return chats.map(c => ({ id: String(c.id), title: 'title' in c ? c.title : String(c.id), username: 'username' in c ? c.username : undefined }));
  }
  static button(d: Recommendation, text: string, action: string) {
    return Markup.button.callback(text, `rec:${d.owner}:${d.id}:${action}:${d.revision}`);
  }
  static async menu(ctx: Context, d?: Recommendation, sessions?: Map<number, UserSession>) {
    if (d?.active) await this.normalize(d);
    if (!d?.active) {
      const session = sessions?.get(ctx.from!.id) || await database.getUserSession(ctx.from!.id);
      const selected = session?.mode === 'publish' ? (session.selectedChannels?.length ? session.selectedChannels : session.selectedChannel ? [session.selectedChannel] : []) : [];
      const allowed = selected.length ? await this.allowed(ctx) : [];
      const targets = selected.length ? await Promise.all(selected.map(id => ctx.telegram.getChat(id))) : [];
      const valid = targets.filter(c => allowed.some(a => a.id === String(c.id)));
      await ctx.reply('⭐ 特别推荐：先发文案，再普通发布资料，最后给原文案加跳转按钮。\n' + (valid.length === selected.length && valid.length
        ? `当前发布目标：\n${valid.map(c => 'title' in c ? c.title : String(c.id)).join('\n')}`
        : '机器人代发文案前，请先在发布模式选择目标。'), Markup.inlineKeyboard([
        [Markup.button.callback('📝 让机器人先发文案', 'recommend_new')],
        [Markup.button.callback('🔗 我已手动发文案', 'recommend_link')],
        [Markup.button.callback('⬅️ 返回发布模式', 'start_publish')]
      ])); return;
    }
    const status = d.channels.map(c => {
      const ready = d.keywords.filter(k => recommendations.find(d, c.id, k)).length;
      return `${c.title}：文案${d.posts[c.id]?.messageId ? '已发／已绑定' : '未就绪'}，推荐资料 ${ready}/${d.keywords.length} 组`;
    }).join('\n');
    await ctx.reply(`⭐ 本期推荐\n${status.slice(0, 1000)}\n\n先完成普通发布，再添加关键词并编辑原文案按钮。`, Markup.inlineKeyboard([
      [this.button(d, '➕ 添加特别推荐关键词', 'keywords')],
      ...(d.keywords.length ? [[this.button(d, '➖ 移除推荐关键词', 'remove')]] : []),
      [this.button(d, '👀 预览按钮／编辑原消息', 'preview')],
      [this.button(d, '📢 继续普通发布', 'continue')],
      ...(d.mode === 'bot' && d.caption && d.channels.some(c => !d.posts[c.id]?.messageId) ? [[this.button(d, '重试发送文案', 'send_caption')]] : []),
      [this.button(d, '结束本期推荐', 'end')]
    ]));
  }
  static async showPreview(ctx: Context, d: Recommendation) {
    if (!d.keywords.length) throw new Error('请先添加特别推荐关键词。');
    const previews = d.channels.map(c => ({ c, body: recommendations.render(d, c.id, true) }));
    for (const { c, body } of previews) {
      await ctx.reply(`「${c.title}」按钮预览${body.missing.length ? `；待发布：${body.missing.join('、')}` : ''}`);
      await ctx.reply(d.caption || '原消息文案保持不变；将添加以下按钮。',
        { entities: d.caption ? d.entities || [] : [], reply_markup: body.reply_markup, link_preview_options: { is_disabled: true } } as any);
    }
    return previews.some(p => p.body.missing.length);
  }
  static async action(ctx: Context, sessions: Map<number, UserSession>) {
    const uid = ctx.from!.id;
    await ctx.answerCbQuery().catch(() => {});
    try {
      if (!isAdminUser(uid)) throw new Error('仅管理员可用');
      if (ctx.chat?.type !== 'private') throw new Error('请私聊机器人设置推荐。');
      if (recommendations.busy.has(uid)) throw new Error('正在推送，请稍候。');
      const data = (ctx.callbackQuery as any).data;
      let d = recommendations.get(uid);
      if (data === 'recommend_menu') { recommendations.clearInput(uid); await this.menu(ctx, d, sessions); return; }
      if (data === 'recommend_new') {
        if (d?.active) { await this.menu(ctx, d); return; }
        const session = sessions.get(uid) || await database.getUserSession(uid);
        const selected = session?.selectedChannels?.length ? session.selectedChannels : session?.selectedChannel ? [session.selectedChannel] : [];
        if (session?.mode !== 'publish' || !selected.length) throw new Error('请先在发布模式选择并确认目标频道。');
        delete (session as any).scheduleStage;
        const allowed = await this.allowed(ctx);
        const chats = await Promise.all(selected.map(id => ctx.telegram.getChat(id)));
        if (chats.some(c => !['channel', 'supergroup'].includes(c.type) || !allowed.some(a => a.id === String(c.id)))) throw new Error('目标必须是有权限的频道或超级群，请重新选择。');
        d = recommendations.create(uid, [...new Map(chats.map(c => [String(c.id), { id: String(c.id), title: 'title' in c ? c.title : String(c.id), username: 'username' in c ? c.username : undefined }])).values()]);
        await ctx.reply('请把文案发给机器人（最多 3500 字）。机器人会立即发到所选目标，保留文字链接和格式。之后照常发布资料。', Markup.inlineKeyboard([[Markup.button.callback('取消输入／返回推荐', 'recommend_menu')]])); return;
      }
      if (data === 'recommend_link') {
        if (d?.active) { await this.menu(ctx, d); return; }
        recommendations.create(uid, [], 'manual');
        await ctx.reply('请发送你已发到频道或超级群的文案消息链接。发布完资料后，再回来输入特别推荐关键词。', Markup.inlineKeyboard([[Markup.button.callback('取消输入／返回推荐', 'recommend_menu')]])); return;
      }
      const [, owner, id, action, rev] = data.split(':');
      if (Number(owner) !== uid || !d?.active || d.id !== id) throw new Error('这不是你的当前推荐，请重新打开推荐菜单。');
      await this.normalize(d);
      if (action === 'pending') { await ctx.reply('这组资料还没有在本期发布到该目标。正常发布成功后，重新打开推荐菜单就能看到跳转按钮。'); return; }
      if (action === 'keywords' || action === 'remove') {
        d.input = action; recommendations.save();
        await ctx.reply(action === 'remove' ? '请输入要移除的推荐关键词。' : '请输入特别推荐关键词。每个已存在的资料关键词会生成一个按钮；支持连写、空格、换行或逗号分隔。', Markup.inlineKeyboard([[Markup.button.callback('取消输入／返回推荐', 'recommend_menu')]])); return;
      }
      if (action === 'send_caption') {
        await ctx.reply(await recommendations.sendCaption(d, ctx.telegram)); await this.menu(ctx, d); return;
      }
      recommendations.clearInput(uid);
      if (action === 'continue') {
        if (d.channels.some(c => !d.posts[c.id]?.messageId)) throw new Error('请先发送文案，或绑定原文案消息链接。');
        const allowed = await this.allowed(ctx);
        if (d.channels.some(c => !allowed.some(a => a.id === c.id))) throw new Error('目标权限已变化，请重新选择发布目标。');
        const session: UserSession = { userId: uid, mode: BotMode.Publish, step: 'waiting_keyword',
          selectedChannel: d.channels[0].id, selectedChannels: d.channels.map(c => c.id) };
        sessions.set(uid, session); await database.saveUserSession(uid, session);
        await ctx.reply(`普通发布模式已开启。\n目标：${d.channels.map(c => c.title).join('、')}\n请直接输入要发布的关键词。更新完后回到推荐菜单添加特别推荐关键词。`, Markup.inlineKeyboard([
          [Markup.button.callback('⏰ 定时发送', 'schedule_begin'), Markup.button.callback('📋 定时任务', 'schedule_list')],
          [Markup.button.callback('⭐ 推荐推送', 'recommend_menu')],
          [Markup.button.callback('更换发布目标', 'start_publish')]
        ])); return;
      }
      if (action === 'end') {
        await ctx.reply('结束后不再收集新发布资料，频道里已推送的消息保留。确认结束本期？', Markup.inlineKeyboard([[this.button(d, '确认结束', 'end_confirm')], [Markup.button.callback('返回推荐', 'recommend_menu')]])); return;
      }
      if (action === 'end_confirm') {
        if (d.revision !== Number(rev)) throw new Error('本期资料已更新，请重新确认结束。');
        d.active = false; recommendations.change(d); await this.menu(ctx, d); return;
      }
      const allowed = await this.allowed(ctx);
      if (d.channels.some(c => !allowed.some(a => a.id === c.id))) throw new Error('目标频道权限已变化，不能推送。');
      if (d.channels.some(c => c.username !== allowed.find(a => a.id === c.id)!.username)) {
        for (const c of d.channels) c.username = allowed.find(a => a.id === c.id)!.username;
        recommendations.change(d);
      }
      if (action === 'preview') {
        const version = d.revision;
        if (await this.showPreview(ctx, d)) {
        await ctx.reply('请先发布标记“待发布”的资料，或重新选择关键词，再编辑原消息按钮。'); return;
        }
        await ctx.reply('确认后只编辑原文案消息的按钮。私有频道链接需要加入频道后才能查看。', Markup.inlineKeyboard([
          [Markup.button.callback('✅ 编辑原文案按钮', `rec:${uid}:${d.id}:push:${version}`)],
          [Markup.button.callback('返回修改', 'recommend_menu')]
        ])); return;
      }
      if (action === 'push') await ctx.reply(await recommendations.push(d, Number(rev), ctx.telegram));
    } catch (e: any) { await ctx.reply(`⚠️ ${e.message}`, Markup.inlineKeyboard([[Markup.button.callback('返回推荐', 'recommend_menu')]])); }
  }
  static async input(ctx: Context, text: string, sessions: Map<number, UserSession>) {
    const uid = ctx.from!.id;
    const d = recommendations.get(uid);
    if (!d?.active || !d.input) return false;
    if (!isAdminUser(uid) || ctx.chat?.type !== 'private') return false;
    if (recommendations.busy.has(uid)) { await ctx.reply('正在推送，请稍后修改。'); return true; }
    try {
      if (d.input === 'caption') {
        if (!text.trim() || text.length > 3500) throw new Error('文案不能为空，最多 3500 字。');
        d.caption = text;
        d.entities = ctx.message && 'entities' in ctx.message ? JSON.parse(JSON.stringify(ctx.message.entities || [])) : [];
        delete d.input; recommendations.change(d);
        await ctx.reply(await recommendations.sendCaption(d, ctx.telegram));
      } else if (d.input === 'link') {
        await this.bindLink(ctx, d, text);
      } else {
        const known = await database.getAllKeywords(isSuperAdmin(uid) ? undefined : uid);
        const values = this.parseKeywords(text, known);
        const next = d.input === 'remove' ? d.keywords.filter(k => !values.includes(k)) : [...new Set([...d.keywords, ...values])];
        if (!values.length || next.length > 60) throw new Error('请输入关键词，每期最多 60 个推荐关键词。');
        d.keywords = next; delete d.input; recommendations.change(d);
      }
      await this.menu(ctx, d);
    } catch (e: any) { await ctx.reply(`⚠️ ${e.message}`); }
    return true;
  }
}
