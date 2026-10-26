import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { config, isSuperAdmin } from '../config';
import { MediaItem } from '../types';
import { MessageEntity } from 'telegraf/types';

export type Recommendation = {
  id: string; owner: number; active: boolean; revision: number;
  mode?: 'bot' | 'manual';
  caption: string; keywords: string[]; channels: Array<{ id: string; title: string; username?: string }>;
  entities?: MessageEntity[];
  input?: 'caption' | 'link' | 'keywords' | 'remove';
  links: Record<string, Record<string, Array<{ key: string; messageId: number }>>>;
  posts: Record<string, { messageId?: number; pending?: boolean; error?: string }>;
};
export type Delivery = { items: MediaItem[]; messages: Array<{ message_id: number }> };
type Publication = { channel: string; owner: number; keyword: string; messageId: number; at: number };
export class RecommendationStore {
  private drafts: Record<string, Recommendation> = {};
  private history: Publication[] = [];
  private historyFile: string;
  readonly busy = new Set<number>();
  constructor(private file = path.join(path.dirname(path.resolve(config.databasePath)), 'recommendations.json')) {
    this.historyFile = path.join(path.dirname(file), 'recommendation-publications.json');
    if (fs.existsSync(file)) this.drafts = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (fs.existsSync(this.historyFile)) this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.drafts));
    fs.renameSync(this.file + '.tmp', this.file);
  }
  get(owner: number) {
    const d = this.drafts[String(owner)];
    return d?.active && d.mode ? d : undefined;
  }
  create(owner: number, channels: Recommendation['channels'], mode: 'bot' | 'manual' = 'bot') {
    if (this.get(owner)?.active) throw new Error('请先结束本期推荐，再新建。');
    const draft: Recommendation = { id: randomUUID().slice(0, 8), owner, active: true, revision: 0,
      mode, caption: '', keywords: [], channels, links: {}, posts: {}, input: mode === 'bot' ? 'caption' : 'link' };
    this.drafts[String(owner)] = draft; this.save(); return draft;
  }
  change(draft: Recommendation) { draft.revision++; this.save(); }
  clearInput(owner: number) {
    const draft = this.get(owner);
    if (draft?.input) { delete draft.input; this.save(); }
  }
  // Record completed publications even when no recommendation has been started yet.
  record(channel: string, deliveries: Delivery[]) {
    const first = new Map<string, Publication>();
    const at = Date.now();
    for (const delivery of deliveries) delivery.items.forEach((item, index) => {
      if (item.is_review) return;
      const key = JSON.stringify([item.uploaded_by, item.keyword]);
      if (!first.has(key)) first.set(key, { channel, owner: item.uploaded_by, keyword: item.keyword,
        messageId: delivery.messages[index].message_id, at });
    });
    if (!first.size) return;
    this.history.push(...first.values());
    this.history = this.history.filter(p => p.at >= at - 90 * 86400000).slice(-100000);
    fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
    fs.writeFileSync(this.historyFile + '.tmp', JSON.stringify(this.history));
    fs.renameSync(this.historyFile + '.tmp', this.historyFile);
  }
  find(d: Recommendation, channel: string, keyword: string) {
    const anchor = d.posts[channel]?.messageId || 0;
    if (!anchor) return undefined;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const p = this.history[i];
      if (p.channel === channel && p.keyword === keyword && p.messageId > anchor &&
          (isSuperAdmin(d.owner) || p.owner === d.owner)) return p.messageId;
    }
    return undefined;
  }
  render(d: Recommendation, channel: string, preview = false) {
    if (!d.keywords.length) throw new Error('请先输入特别推荐关键词。');
    if (!d.posts[channel]?.messageId) throw new Error('请先发送文案或绑定原文案消息链接。');
    const missing = d.keywords.filter(k => !this.find(d, channel, k));
    if (missing.length && !preview) throw new Error(`文案发布后尚未发布资料：${missing.join('、')}`);
    if (!/^-100\d+$/.test(channel)) throw new Error('推荐链接仅支持频道或超级群。');
    const username = d.channels.find(c => c.id === channel)?.username;
    const prefix = username && /^\w+$/.test(username) ? username : `c/${channel.slice(4)}`;
    const buttons: any[] = d.keywords.map(keyword => missing.includes(keyword) ? {
      text: `${keyword} · 待发布`, callback_data: `rec:${d.owner}:${d.id}:pending:${d.revision}`
    } : ({
      text: keyword,
      url: `https://t.me/${prefix}/${this.find(d, channel, keyword)}`
    }));
    if (buttons.length > 90) throw new Error('推荐资料超过 90 组，请移除部分关键词后再推送。');
    const rows = [];
    for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
    return { missing, reply_markup: { inline_keyboard: rows } };
  }
  async sendCaption(d: Recommendation, telegram: any) {
    if (d.mode !== 'bot' || !d.caption) throw new Error('请先输入文案。');
    if (this.busy.has(d.owner)) throw new Error('正在发送，请稍候。');
    this.busy.add(d.owner);
    const results: string[] = [];
    try {
      for (const c of d.channels) {
        const post = d.posts[c.id] ||= {};
        if (post.messageId) { results.push(`${c.title}：文案已发送`); continue; }
        if (post.pending) { results.push(`${c.title}：结果不确定，请核对频道并用 /recommend_bind 消息链接绑定。`); continue; }
        try {
          post.pending = true; this.save();
          const sent = await telegram.sendMessage(c.id, d.caption,
            { entities: d.entities || [], link_preview_options: { is_disabled: true } });
          if (!sent?.message_id) throw new Error('没有返回消息编号');
          post.messageId = sent.message_id; delete post.pending; delete post.error; this.save();
          results.push(`${c.title}：文案已发送`);
        } catch (e: any) {
          if (e.response?.error_code && e.response.error_code < 500) delete post.pending;
          post.error = String(e.description || e.message).slice(0, 200); this.save();
          results.push(`${c.title}：${post.error}${post.pending ? '（结果不确定，已阻止重发）' : ''}`);
        }
      }
    } finally { this.busy.delete(d.owner); }
    return results.join('\n');
  }
  async push(d: Recommendation, revision: number, telegram: any) {
    if (!d.active || d.revision !== revision) throw new Error('推荐已变化，请重新预览后确认。');
    if (this.busy.has(d.owner)) throw new Error('正在编辑，请稍候。');
    const payloads = d.channels.map(c => ({ c, body: this.render(d, c.id) }));
    this.busy.add(d.owner);
    const results: string[] = [];
    try {
      for (const { c, body } of payloads) {
        try {
          await telegram.editMessageReplyMarkup(c.id, d.posts[c.id].messageId, undefined, body.reply_markup);
          results.push(`${c.title}：已在原文案添加按钮`);
        } catch (e: any) {
          const reason = String(e.description || e.message);
          if (reason.includes('message is not modified')) results.push(`${c.title}：按钮已是最新`);
          else results.push(`${c.title}：无法编辑原消息（${reason.slice(0, 180)}）。请用机器人代发文案后重试。`);
        }
      }
    } finally { this.busy.delete(d.owner); }
    return results.join('\n');
  }
}
export const recommendations = new RecommendationStore();
