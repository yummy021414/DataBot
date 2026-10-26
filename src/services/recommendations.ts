import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { config, isSuperAdmin } from '../config';
import { MediaItem } from '../types';
import { MessageEntity } from 'telegraf/types';

export type Recommendation = {
  id: string; owner: number; active: boolean; revision: number;
  caption: string; keywords: string[]; channels: Array<{ id: string; title: string; username?: string }>;
  entities?: MessageEntity[];
  input?: 'caption' | 'keywords' | 'add' | 'remove';
  links: Record<string, Record<string, Array<{ key: string; messageId: number }>>>;
  posts: Record<string, { messageId?: number; pending?: boolean; error?: string }>;
};
export type Delivery = { items: MediaItem[]; messages: Array<{ message_id: number }> };
export class RecommendationStore {
  private drafts: Record<string, Recommendation> = {};
  readonly busy = new Set<number>();
  constructor(private file = path.join(path.dirname(path.resolve(config.databasePath)), 'recommendations.json')) {
    if (fs.existsSync(file)) this.drafts = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.drafts));
    fs.renameSync(this.file + '.tmp', this.file);
  }
  get(owner: number) { return this.drafts[String(owner)]; }
  create(owner: number, channels: Recommendation['channels']) {
    if (this.get(owner)?.active) throw new Error('请先结束本期推荐，再新建。');
    const draft: Recommendation = { id: randomUUID().slice(0, 8), owner, active: true, revision: 0,
      caption: '', keywords: [], channels, links: {}, posts: {}, input: 'caption' };
    this.drafts[String(owner)] = draft; this.save(); return draft;
  }
  change(draft: Recommendation) { draft.revision++; this.save(); }
  clearInput(owner: number) {
    const draft = this.get(owner);
    if (draft?.input) { delete draft.input; this.save(); }
  }
  // Capture the active edition before sending, so older in-flight jobs cannot enter a new edition.
  capture(channel: string) {
    return Object.values(this.drafts).filter(d => d.active && d.channels.some(c => c.id === channel))
      .map(d => ({ owner: d.owner, id: d.id }));
  }
  record(channel: string, editions: Array<{ owner: number; id: string }>, deliveries: Delivery[]) {
    for (const edition of editions) {
      const d = this.get(edition.owner);
      if (!d?.active || d.id !== edition.id) continue;
      const groups = new Map<string, Map<string, number>>();
      for (const delivery of deliveries) delivery.items.forEach((item, index) => {
        if (item.is_review || (!isSuperAdmin(d.owner) && item.uploaded_by !== d.owner)) return;
        const key = JSON.stringify([item.uploaded_by, item.batchId || `legacy_${item.id}`]);
        if (!groups.has(item.keyword)) groups.set(item.keyword, new Map());
        const batch = groups.get(item.keyword)!;
        if (!batch.has(key)) batch.set(key, delivery.messages[index].message_id);
      });
      if (!groups.size) continue;
      d.links[channel] ||= {};
      for (const [keyword, batches] of groups) Object.defineProperty(d.links[channel], keyword, {
        value: [...batches].map(([key, messageId]) => ({ key, messageId })), enumerable: true, configurable: true, writable: true
      });
      this.change(d);
    }
  }
  render(d: Recommendation, channel: string, preview = false) {
    if (!d.caption || !d.keywords.length) throw new Error('请先填写文案和推荐关键词。');
    const missing = d.keywords.filter(k => !Object.prototype.hasOwnProperty.call(d.links[channel] || {}, k) || !d.links[channel][k]?.length);
    if (missing.length && !preview) throw new Error(`尚未在本期成功发布：${missing.join('、')}`);
    if (!/^-100\d+$/.test(channel)) throw new Error('推荐链接仅支持频道或超级群。');
    const username = d.channels.find(c => c.id === channel)?.username;
    const prefix = username && /^\w+$/.test(username) ? username : `c/${channel.slice(4)}`;
    const buttons: any[] = d.keywords.flatMap<any>(keyword => missing.includes(keyword) ? [{
      text: `${keyword} · 待发布`, callback_data: `rec:${d.owner}:${d.id}:pending:${d.revision}`
    }] : d.links[channel][keyword].slice(0, 1).map(group => ({
      text: keyword,
      url: `https://t.me/${prefix}/${group.messageId}`
    })));
    if (buttons.length > 90) throw new Error('推荐资料超过 90 组，请移除部分关键词后再推送。');
    const rows = [];
    for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
    return { text: d.caption, entities: d.entities || [], missing, reply_markup: { inline_keyboard: rows } };
  }
  async push(d: Recommendation, revision: number, telegram: any) {
    if (!d.active || d.revision !== revision) throw new Error('推荐内容或资料链接已更新，请重新预览后确认。');
    if (this.busy.has(d.owner)) throw new Error('正在推送，请稍候。');
    const payloads = d.channels.map(c => ({ channel: c, body: this.render(d, c.id) }));
    this.busy.add(d.owner);
    const results: string[] = [];
    try {
      for (const { channel, body } of payloads) {
        const post = d.posts[channel.id] ||= {};
        if (post.pending && !post.messageId) { results.push(`${channel.title}：上次发送结果不确定，请核对频道，用 /recommend_bind 推荐消息链接 绑定已发消息，勿重复推送。`); continue; }
        try {
          if (post.messageId) {
            await telegram.editMessageText(channel.id, post.messageId, undefined, body.text,
              { entities: body.entities, reply_markup: body.reply_markup, link_preview_options: { is_disabled: true } });
          } else {
            post.pending = true; this.save();
            const sent = await telegram.sendMessage(channel.id, body.text,
              { entities: body.entities, reply_markup: body.reply_markup, link_preview_options: { is_disabled: true } });
            if (!sent?.message_id) throw new Error('未返回消息编号');
            post.messageId = sent.message_id;
          }
          delete post.pending; delete post.error; this.save();
          results.push(`${channel.title}：已推送/更新`);
        } catch (e: any) {
          if (String(e.description || e.message).includes('message is not modified')) {
            delete post.pending; delete post.error; this.save(); results.push(`${channel.title}：内容已是最新`); continue;
          }
          if (e.response?.error_code && e.response.error_code < 500) delete post.pending;
          post.error = String(e.description || e.message).slice(0, 300); this.save();
          results.push(`${channel.title}：${post.error}${post.pending ? '（结果不确定，已阻止重复发送）' : ''}`);
        }
      }
    } finally { this.busy.delete(d.owner); }
    return results.join('\n');
  }
}
export const recommendations = new RecommendationStore();
