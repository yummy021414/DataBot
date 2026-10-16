import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Telegraf } from 'telegraf';
import { database } from '../database';
import { config, isAdminUser, isSuperAdmin, hasAdminChannelMap, getAdminChannelIds } from '../config';
import { MediaItem } from '../types';

export function parsePublishTime(input: string, now = Date.now()): number {
  const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const match = input.trim().match(/^(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{1,2})[:：](\d{2})$/);
  if (!match || +match[2] > 23 || +match[3] > 59) throw new Error('请输入 18:00 或 2026-09-24 18:00（北京时间）');
  const date = match[1] || today;
  let time = Date.parse(`${date}T${match[2].padStart(2, '0')}:${match[3]}:00+08:00`);
  if (!Number.isFinite(time) || new Date(time + 8 * 3600000).toISOString().slice(0, 10) !== date) throw new Error('日期无效');
  if (!match[1] && time <= now) time += 86400000;
  if (time <= now) throw new Error('请选择未来的时间');
  return time;
}
export const publishTimeLabel = (time: number) => new Date(time + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' 北京时间';
type Unit = { channel: string; keyword: string; items: MediaItem[] };
type Job = { id: string; owner: number; at: number; keywords: string[]; channels: string[]; units: Unit[];
  cursor: number; status: 'queued' | 'running' | 'complete' | 'cancelled' | 'attention'; error?: string };

export class ScheduledPublishQueue {
  private jobs: Job[] = [];
  private busy = false;
  private timer?: NodeJS.Timeout;
  constructor(private file = path.resolve('data/scheduled-publish.json')) {
    if (fs.existsSync(file)) {
      this.jobs = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(this.jobs)) throw new Error('定时发布队列格式损坏');
      for (const job of this.jobs) if (job.status === 'running') {
        job.status = 'attention'; job.error = '发送期间发生重启，请核对频道中最后一组，避免重复发送';
      }
      this.save();
    }
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.jobs));
    fs.renameSync(this.file + '.tmp', this.file);
  }
  list(owner: number) { return this.jobs.filter(j => j.owner === owner).slice(-15).reverse(); }
  cancel(owner: number, id: string) {
    const job = this.jobs.find(j => j.owner === owner && j.id === id);
    if (!job || !['queued', 'attention'].includes(job.status)) return false;
    job.status = 'cancelled'; this.save(); return true;
  }
  async add(owner: number, at: number, channels: string[], keywords: string[]) {
    if (!isAdminUser(owner)) throw new Error('仅管理员可以创建定时任务');
    if (at <= Date.now()) throw new Error('时间已过，请重新设置');
    const allowed = hasAdminChannelMap(owner) ? getAdminChannelIds(owner) : await database.getManagedChannels();
    if (!channels.length || channels.some(c => !allowed.includes(c))) throw new Error('目标频道权限已变化，请重新选择');
    const units: Unit[] = [];
    for (const keyword of keywords) {
      const items = await database.getMediaByKeyword(keyword, isSuperAdmin(owner) ? undefined : owner);
      if (!items.length) throw new Error(`未找到「${keyword}」，任务未创建`);
      const groups = new Map<string, MediaItem[]>();
      for (const item of items) {
        const type = ['photo', 'video'].includes(item.file_type) ? 'visual' : item.file_type;
        const key = `${item.batchId || 'legacy_' + item.id}:${type}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(item);
      }
      for (const channel of channels) for (const group of groups.values()) {
        const size = ['photo', 'video', 'audio', 'document'].includes(group[0].file_type) ? 10 : 1;
        const caption = group.find(m => m.caption)?.caption || '';
        for (let i = 0; i < group.length; i += size) units.push({ channel, keyword,
          items: group.slice(i, i + size).map((m, k) => ({ ...m, caption: i === 0 && k === 0 ? caption : '' })) });
      }
    }
    const job: Job = { id: randomUUID().slice(0, 8), owner, at, channels: [...channels], keywords: [...keywords],
      units, cursor: 0, status: 'queued' };
    this.jobs.push(job); this.save(); return job;
  }
  start(bot: Telegraf) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(bot).catch(e => console.error('定时队列错误', e)); }, 5000);
    this.timer.unref();
  }
  private async tick(bot: Telegraf) {
    if (this.busy) return;
    const job = this.jobs.filter(j => j.status === 'queued' && j.at <= Date.now()).sort((a, b) => a.at - b.at)[0];
    if (!job) return;
    this.busy = true;
    const notify = async (s: string) => { await bot.telegram.sendMessage(job.owner, s).catch(() => {}); };
    try {
      const allowed = hasAdminChannelMap(job.owner) ? getAdminChannelIds(job.owner) : await database.getManagedChannels();
      if (!isAdminUser(job.owner) || job.channels.some(c => !allowed.includes(c))) throw new Error('管理员或频道权限已失效');
      await notify(`⏰ 定时任务 ${job.id} 开始发送：${job.keywords.join('、')}`);
      for (; job.cursor < job.units.length; ) {
        const unit = job.units[job.cursor];
        job.status = 'running'; this.save();
        try {
          if (unit.items.length > 1) {
            await bot.telegram.sendMediaGroup(unit.channel, unit.items.map(m => ({ type: m.file_type, media: m.file_id, caption: m.caption })) as any);
          } else {
            const m = unit.items[0];
            const methods: Record<string, string> = { photo: 'sendPhoto', video: 'sendVideo', animation: 'sendAnimation',
              document: 'sendDocument', audio: 'sendAudio', voice: 'sendVoice', video_note: 'sendVideoNote' };
            await (bot.telegram as any)[methods[m.file_type]](unit.channel, m.file_id, m.file_type === 'video_note' ? {} : { caption: m.caption });
          }
        } catch (e: any) {
          // Only a definite rate-limit rejection is safe to retry automatically.
          if (e?.response?.error_code === 429) {
            job.status = 'queued'; job.at = Date.now() + ((e.response.parameters?.retry_after || 30) + 1) * 1000;
            this.save(); return;
          }
          throw e;
        }
        job.cursor++; job.status = job.cursor === job.units.length ? 'complete' : 'queued'; this.save();
        for (const m of unit.items) await database.updateMediaPublished(m.id, unit.channel);
        if (job.status !== 'complete') await new Promise(r => setTimeout(r, 2500));
      }
      await notify(`✅ 定时任务 ${job.id} 已完成：${job.cursor}/${job.units.length} 组`);
    } catch (e: any) {
      job.status = 'attention'; job.error = String(e?.description || e?.message || e).slice(0, 300); this.save();
      await notify(`⚠️ 定时任务 ${job.id} 已暂停，完成 ${job.cursor}/${job.units.length} 组。${job.error}\n请核对频道，勿直接重复创建整批任务。`);
    } finally { this.busy = false; }
  }
}
export const scheduledPublish = new ScheduledPublishQueue();
