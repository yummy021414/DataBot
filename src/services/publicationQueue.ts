import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { MediaItem } from '../types';

export type PublishSender = (items: MediaItem[]) => Promise<any[]>;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)));

export function publicationBatches(items: MediaItem[]): MediaItem[][] {
  const groups = new Map<string, MediaItem[]>();
  for (const item of items) {
    const key = JSON.stringify([item.keyword, item.uploaded_by, item.batchId || `legacy_${item.id}`]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ ...item });
  }
  return [...groups.values()];
}

// Keep original order, split only at incompatible types or Telegram's 10-item limit.
export function publicationChunks(items: MediaItem[]): MediaItem[][] {
  const chunks: MediaItem[][] = [];
  let kind = '';
  const caption = items.find(item => item.caption?.trim())?.caption || '';
  for (const item of items) {
    const type = ['photo', 'video'].includes(item.file_type) ? 'visual' : item.file_type;
    const canGroup = ['visual', 'audio', 'document'].includes(type);
    if (!chunks.length || type !== kind || !canGroup || chunks[chunks.length - 1].length === 10) chunks.push([]);
    chunks[chunks.length - 1].push({ ...item, caption: '' });
    kind = type;
  }
  const primary = chunks.flat().find(item => item.file_type !== 'video_note');
  if (primary) primary.caption = caption;
  return chunks;
}

export class PublicationQueue {
  private tails = new Map<string, Promise<void>>();
  private chats = new Map<string, Promise<{ id: string; group: boolean }>>();
  private next = new Map<string, number>();
  private pending = new Map<string, number>();
  private blocked: Record<string, string> = {};
  private active = 0;
  private slots: Array<() => void> = [];
  private globalNext = 0;
  private cooldown = 0;

  constructor(private file = path.join(path.dirname(path.resolve(config.databasePath)), 'publish-paused.json'),
    private timing = { channel: 1100, group: 3100, timeout: 90000, globalPerMessage: 45 }) {
    if (fs.existsSync(file)) this.blocked = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  private async chat(telegram: any, channel: string) {
    if (!this.chats.has(channel)) {
      const promise = (async () => {
        const chat = telegram.getChat ? await telegram.getChat(channel) : { id: channel, type: 'channel' };
        return { id: String(chat.id), group: chat.type === 'group' || chat.type === 'supergroup' };
      })();
      this.chats.set(channel, promise);
      promise.catch(() => this.chats.delete(channel));
    }
    return this.chats.get(channel)!;
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.blocked));
    fs.renameSync(this.file + '.tmp', this.file);
  }
  private pause(id: string, reason: string) {
    this.blocked[id] = reason;
    this.persist();
  }
  private assertReady(id: string) {
    if (this.blocked[id]) throw new Error(`频道 ${id} 已暂停：${this.blocked[id]}。核对频道中最后一组后，发送 /publish_resume ${id} 恢复后续发布；未完成资料不会自动重发。`);
  }
  async resume(telegram: any, channel: string) {
    const { id } = await this.chat(telegram, channel);
    if (this.pending.get(id)) throw new Error('上一条发送请求尚未结束，请稍后再恢复。');
    if (!this.blocked[id]) return false;
    delete this.blocked[id]; this.persist(); return true;
  }

  async run<T>(telegram: any, channel: string, work: (send: PublishSender) => Promise<T>): Promise<T> {
    const chat = await this.chat(telegram, channel);
    const previous = this.tails.get(chat.id) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(chat.id, tail);
    await previous;
    let completed = 0;
    try {
      this.assertReady(chat.id);
      return await work(async items => {
        const result = await this.send(telegram, chat, items);
        completed += items.length;
        return result;
      });
    } catch (error: any) {
      if (completed && !this.blocked[chat.id]) {
        this.pause(chat.id, '发布中途失败，已有部分资料发出');
        throw new Error(`${error.message}。频道 ${chat.id} 已暂停；核对后发送 /publish_resume ${chat.id}，未完成资料不会自动重发。`);
      }
      throw error;
    } finally {
      release();
      if (this.tails.get(chat.id) === tail) this.tails.delete(chat.id);
    }
  }

  private async acquire() {
    if (this.active >= 2) await new Promise<void>(resolve => this.slots.push(resolve));
    else this.active++;
  }
  private release() {
    const next = this.slots.shift();
    if (next) next(); else this.active--;
  }
  private async send(telegram: any, chat: { id: string; group: boolean }, items: MediaItem[]): Promise<any[]> {
    if (!items.length || items.length > 10) throw new Error('无效资料组大小');
    this.assertReady(chat.id);
    for (let attempt = 0; attempt < 4; attempt++) {
      await wait(Math.max(this.next.get(chat.id) || 0, this.cooldown) - Date.now());
      await this.acquire();
      let timer: NodeJS.Timeout | undefined;
      let outstanding: Promise<any> | undefined;
      let requestPending = false;
      try {
        // Re-check the shared deadline after acquiring a slot; another channel may have hit 429.
        while (Date.now() < Math.max(this.globalNext, this.cooldown)) await wait(Math.max(this.globalNext, this.cooldown) - Date.now());
        const started = Date.now();
        this.globalNext = started + items.length * this.timing.globalPerMessage;
        this.next.set(chat.id, started + (chat.group ? this.timing.group * items.length : this.timing.channel));
        const methods: Record<string, string> = { photo: 'sendPhoto', video: 'sendVideo', document: 'sendDocument',
          audio: 'sendAudio', voice: 'sendVoice', animation: 'sendAnimation', video_note: 'sendVideoNote' };
        // Journal before sending: a restart must never silently retry an uncertain request.
        this.pause(chat.id, '上一条发布请求尚未确认，若发生重启请先核对频道');
        this.pending.set(chat.id, (this.pending.get(chat.id) || 0) + 1);
        requestPending = true;
        const request = Promise.resolve().then(async () => {
          if (items.length > 1) return telegram.sendMediaGroup(chat.id,
            items.map(item => ({ type: item.file_type, media: item.file_id, caption: item.caption || undefined })));
          const item = items[0];
          const result = await telegram[methods[item.file_type]](chat.id, item.file_id,
            item.file_type === 'video_note' ? {} : { caption: item.caption || undefined });
          return [result];
        });
        outstanding = request;
        const settled = () => {
          requestPending = false;
          this.pending.set(chat.id, Math.max(0, (this.pending.get(chat.id) || 1) - 1));
        };
        request.then(settled, settled);
        const result: any[] = await Promise.race([request, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('发送超时，结果不确定')), this.timing.timeout);
        })]);
        if (!Array.isArray(result) || result.length !== items.length || result.some(item => !item?.message_id)) {
          throw new Error('发送返回数量或消息标识异常，请核对频道');
        }
        delete this.blocked[chat.id]; this.persist();
        console.log(`📢 [发送耗时] 目标=${chat.id} 文件=${items.length} API=${Date.now() - started}ms 重试=${attempt}`);
        return result;
      } catch (error: any) {
        const code = error?.response?.error_code;
        if (code && code < 500) { delete this.blocked[chat.id]; this.persist(); }
        if (code === 429) {
          const delay = (Math.max(1, Number(error.response.parameters?.retry_after) || 30) * 1000) + 250;
          this.cooldown = Math.max(this.cooldown, Date.now() + delay);
          this.next.set(chat.id, this.cooldown);
          if (attempt < 3) continue;
        } else if (!code || code >= 500) {
          this.pause(chat.id, '上一组发送结果不确定，已停止继续发送');
          this.assertReady(chat.id);
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        if (outstanding && requestPending) outstanding.then(() => this.release(), () => this.release());
        else this.release();
      }
    }
    throw new Error('发送重试已达上限');
  }
}

export const publicationQueue = new PublicationQueue();
