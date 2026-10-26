import { Context, Markup } from 'telegraf';
import { database } from '../../database';
import { UserSession, BotMode } from '../../types';
import { getAdminChannelIds, hasAdminChannelMap, isAdminUser } from '../../config';
import { recommendations, Recommendation } from '../../services/recommendations';

export class RecommendationHandler {
  static async bind(ctx: Context) {
    try {
      const uid = ctx.from!.id, d = recommendations.get(uid);
      if (ctx.chat?.type !== 'private' || !d?.active || recommendations.busy.has(uid)) throw new Error('请在私聊中等待当前操作结束，再绑定本期推荐。');
      const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
      const match = text.trim().match(/^\/recommend_bind(?:@\w+)?\s+https:\/\/t\.me\/(?:c\/(\d+)|(\w+))\/(\d+)$/);
      if (!match) throw new Error('格式：/recommend_bind 推荐消息链接（从频道复制已发出的推荐消息链接）');
      const chat = await ctx.telegram.getChat(match[1] ? '-100' + match[1] : '@' + match[2]);
      const id = String(chat.id), post = d.posts[id];
      if (!(await this.allowed(ctx)).some(c => c.id === id) || !post?.pending || post.messageId) throw new Error('该频道没有需要绑定的未知结果。');
      post.messageId = Number(match[3]); delete post.pending; recommendations.change(d);
      await ctx.reply('已绑定。请重新预览并更新原推荐消息。');
    } catch (e: any) { await ctx.reply(`⚠️ ${e.message}`); }
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
    if (!d?.active) {
      const session = sessions?.get(ctx.from!.id) || await database.getUserSession(ctx.from!.id);
      const selected = session?.mode === 'publish' ? (session.selectedChannels?.length ? session.selectedChannels : session.selectedChannel ? [session.selectedChannel] : []) : [];
      const allowed = selected.length ? await this.allowed(ctx) : [];
      const targets = selected.length ? await Promise.all(selected.map(id => ctx.telegram.getChat(id))) : [];
      const valid = targets.filter(c => allowed.some(a => a.id === String(c.id)));
      await ctx.reply('⭐ 推荐推送未开启。普通发布不受影响。\n' + (valid.length === selected.length && valid.length
        ? `已选择 ${valid.length} 个目标：\n${valid.map(c => 'title' in c ? c.title : String(c.id)).join('\n')}\n点击“新建一期推荐”开始填写文案。`
        : '请先在发布模式选择目标，再新建一期推荐。'), Markup.inlineKeyboard([
        [Markup.button.callback('⭐ 新建一期推荐', 'recommend_new')],
        [Markup.button.callback('⬅️ 返回发布模式', 'start_publish')]
      ])); return;
    }
    const status = d.channels.map(c => {
      const ready = d.keywords.filter(k => d.links[c.id]?.[k]?.length).length;
      return `${c.title}：${ready}/${d.keywords.length} 个关键词已发布${d.posts[c.id]?.messageId ? ' · 已有推荐消息' : ''}`;
    }).join('\n');
    await ctx.reply(`⭐ 本期推荐\n${status.slice(0, 1000)}\n\n${d.caption ? '文案和关键词按钮见下方草稿预览。' : '文案待填写。'}\n追加关键词不会清空已有内容。待发布按钮仅供预览，资料发布成功后会关联跳转链接。`, Markup.inlineKeyboard([
      [this.button(d, '✏️ 修改文案', 'caption'), this.button(d, '➕ 添加关键词', 'add')],
      [this.button(d, '➖ 移除关键词', 'remove')],
      [this.button(d, '👀 预览并推送／更新', 'preview')],
      [this.button(d, '📢 继续普通发布', 'continue')],
      [this.button(d, '结束本期推荐', 'end')]
    ]));
    if (d.caption && d.keywords.length) await this.showPreview(ctx, d);
    else if (d.caption) await ctx.reply(d.caption, { entities: d.entities || [] });
  }
  static async showPreview(ctx: Context, d: Recommendation) {
    const previews = d.channels.map(c => ({ c, body: recommendations.render(d, c.id, true) }));
    for (const { c, body } of previews) {
      await ctx.reply(`「${c.title}」草稿预览${body.missing.length ? '：带“待发布”的按钮尚无资料链接' : ''}`);
      await ctx.reply(body.text, { entities: body.entities, reply_markup: body.reply_markup, link_preview_options: { is_disabled: true } } as any);
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
        await ctx.reply('请输入本期推荐文案（最多 3500 字），下一步添加特别推荐关键词。', Markup.inlineKeyboard([[Markup.button.callback('取消输入／返回推荐', 'recommend_menu')]])); return;
      }
      const [, owner, id, action, rev] = data.split(':');
      if (Number(owner) !== uid || !d?.active || d.id !== id) throw new Error('这不是你的当前推荐，请重新打开推荐菜单。');
      if (action === 'pending') { await ctx.reply('这组资料还没有在本期发布到该目标。正常发布成功后，重新打开推荐菜单就能看到跳转按钮。'); return; }
      if (['caption', 'add', 'remove'].includes(action)) {
        d.input = action; recommendations.save();
        await ctx.reply(action === 'caption' ? '请输入新的推荐文案（最多 3500 字）。' : '请输入关键词，一行一个，或用空格、逗号分隔。', Markup.inlineKeyboard([[Markup.button.callback('取消输入／返回推荐', 'recommend_menu')]])); return;
      }
      recommendations.clearInput(uid);
      if (action === 'continue') {
        const allowed = await this.allowed(ctx);
        if (d.channels.some(c => !allowed.some(a => a.id === c.id))) throw new Error('目标权限已变化，请重新选择发布目标。');
        const session: UserSession = { userId: uid, mode: BotMode.Publish, step: 'waiting_keyword',
          selectedChannel: d.channels[0].id, selectedChannels: d.channels.map(c => c.id) };
        sessions.set(uid, session); await database.saveUserSession(uid, session);
        await ctx.reply(`推荐草稿已保存，普通发布模式已开启。\n目标：${d.channels.map(c => c.title).join('、')}\n请直接输入要发布的关键词。更新完后回到推荐菜单预览推送。`, Markup.inlineKeyboard([
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
          await ctx.reply('草稿可以提前查看。请先发布待发布的资料，或移除对应关键词，再确认推送。'); return;
        }
        await ctx.reply('确认后发送到本期目标；已推送过的频道会更新原消息。私有频道链接需要加入频道后才能查看。', Markup.inlineKeyboard([
          [Markup.button.callback('✅ 确认推送／更新', `rec:${uid}:${d.id}:push:${version}`)],
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
        d.input = d.keywords.length ? undefined : 'keywords'; recommendations.change(d);
        if (d.input) { await ctx.reply('文案已保存。请输入特别推荐关键词，一行一个，或用空格、逗号分隔。'); return true; }
      } else {
        const known = await database.getAllKeywords();
        const values = text.split(/[\n,，、]+/).flatMap(part => known.includes(part.trim()) ? [part.trim()] : part.trim().split(/\s+/)).filter(Boolean);
        const next = d.input === 'remove' ? d.keywords.filter(k => !values.includes(k)) : [...new Set([...d.keywords, ...values])];
        if (!values.length || next.length > 60) throw new Error('请输入关键词，每期最多 60 个推荐关键词。');
        d.keywords = next; delete d.input; recommendations.change(d);
      }
      await this.menu(ctx, d);
    } catch (e: any) { await ctx.reply(`⚠️ ${e.message}`); }
    return true;
  }
}
