import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { config, watermarkConfig } from '../config';

export type WatermarkMediaType = 'photo' | 'video';
export type WatermarkPriority = 'interactive' | 'migration';
/** Abort the underlying request, not just the waiting promise. */
export async function watermarkApi(telegram: any, method: string, payload: any, timeoutMs = 30000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await telegram.callApi(method, payload, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
export interface WatermarkResult {
  fileId: string;
  sourceChatId: string;
  sourceMsgId: number;
  version: number;
}
type Task = { run: () => Promise<any>; resolve: (v: any) => void; reject: (e: any) => void };
export class PrioritySerialQueue {
  private interactive: Task[] = [];
  private migration: Task[] = [];
  private running = false;
  add<T>(run: () => Promise<T>, priority: WatermarkPriority): Promise<T> {
    if (this.interactive.length + this.migration.length >= 100) return Promise.reject(new Error('水印队列已满，请稍后重试'));
    return new Promise((resolve, reject) => {
      (priority === 'interactive' ? this.interactive : this.migration).push({ run, resolve, reject });
      void this.pump();
    });
  }
  status() {
    return { running: this.running, interactiveWaiting: this.interactive.length, migrationWaiting: this.migration.length };
  }
  private async pump() {
    if (this.running) return;
    const task = this.interactive.shift() || this.migration.shift();
    if (!task) return;
    this.running = true;
    try { task.resolve(await task.run()); } catch (e) { task.reject(e); }
    finally { this.running = false; setImmediate(() => void this.pump()); }
  }
}

export function watermarkError(error: any): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status ? '文件下载失败：HTTP ' + status : '文件下载失败：网络连接异常或超时（' + (error.code || 'NETWORK') + '）';
  }
  return String(error?.description || error?.message || error)
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]').slice(0, 700);
}

export class WatermarkService {
  private readonly queue = new PrioritySerialQueue();
  private probePromise?: Promise<void>;
  private fontPath = '';
  isEnabled() { return watermarkConfig.enabled; }
  getStatus() { return { enabled: this.isEnabled(), ...this.queue.status() }; }
  async assertReady(stagingChatId?: string) {
    if (!this.isEnabled()) throw new Error('请先设置 WATERMARK_ENABLED=true');
    if (!watermarkConfig.text || watermarkConfig.text.length > 100 || /[\r\n]/.test(watermarkConfig.text)) {
      throw new Error('WATERMARK_TEXT 必须是 1～100 字符的单行文字');
    }
    if (!stagingChatId) throw new Error('请配置 PERSISTENT_CHANNEL_ID 或管理员独立金库');
    if (!/^(ultrafast|superfast|veryfast|faster|fast|medium|slow)$/.test(watermarkConfig.videoPreset)) {
      throw new Error('WATERMARK_VIDEO_PRESET 不合法');
    }
    if (!this.probePromise) this.probePromise = this.preflight().catch(e => { this.probePromise = undefined; throw e; });
    await this.probePromise;
  }
  private async setupDirectory(): Promise<string> {
    const base = watermarkConfig.tempDir || os.tmpdir();
    await fs.promises.mkdir(base, { recursive: true });
    const dir = await fs.promises.mkdtemp(path.join(base, 'pindaobot-watermark-'));
    try {
      await fs.promises.writeFile(path.join(dir, 'watermark.txt'), watermarkConfig.text, 'utf8');
      await fs.promises.copyFile(this.fontPath, path.join(dir, 'font.ttf'));
      return dir;
    } catch (e) { await fs.promises.rm(dir, { recursive: true, force: true }); throw e; }
  }
  private async preflight() {
    const candidates = watermarkConfig.fontFile ? [watermarkConfig.fontFile] : [
      '/usr/share/fonts/noto/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
      'C:/Windows/Fonts/msyh.ttc'
    ];
    this.fontPath = candidates.find(p => fs.existsSync(p)) || '';
    if (!this.fontPath) throw new Error('找不到中文字体，请设置 WATERMARK_FONT_FILE');
    const dir = await this.setupDirectory();
    try {
      await this.runFfmpeg(['-f', 'lavfi', '-i', 'color=s=320x240:d=0.1',
        '-vf', this.textFilter('20', '(w-text_w)/2', '(h-text_h)/2'),
        '-frames:v', '1', '-c:v', 'libx264', '-threads', '1', '-f', 'null', '-'], dir, 15000);
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  }
  processTelegramMedia(telegram: any, fileId: string, mediaType: WatermarkMediaType,
    stagingChatId: string, priority: WatermarkPriority = 'interactive', caption = '',
    cancelled: () => boolean = () => false): Promise<WatermarkResult> {
    return this.queue.add(async () => {
      if (cancelled()) throw new Error('任务已暂停');
      try { return await this.processNow(telegram, fileId, mediaType, stagingChatId, caption); }
      catch (error) { throw new Error(watermarkError(error)); }
    }, priority);
  }
  private async processNow(telegram: any, fileId: string, type: WatermarkMediaType, chat: string, caption: string) {
    await this.assertReady(chat);
    const key = createHash('sha256').update(JSON.stringify([
      config.botToken, fileId, type, chat, caption, watermarkConfig.text, watermarkConfig.opacity,
      watermarkConfig.version, watermarkConfig.videoCrf, watermarkConfig.videoPeriodSeconds
    ])).digest('hex');
    const cacheDir = path.join(path.dirname(path.resolve(config.databasePath)), 'watermark-cache');
    const cachePath = path.join(cacheDir, key + '.json');
    try {
      const cached: WatermarkResult = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
      if (cached.fileId && cached.sourceMsgId) {
        await telegram.getFile(cached.fileId);
        return cached;
      }
    } catch { /* No cache or stale bot-scoped file id: process again. */ }
    const dir = await this.setupDirectory();
    try {
      const info = await telegram.getFile(fileId);
      const cloud = !process.env.TELEGRAM_API_ROOT || process.env.TELEGRAM_API_ROOT === 'https://api.telegram.org';
      const downloadLimit = (cloud ? 20 : watermarkConfig.maxInputMb) * 1024 * 1024;
      if (info.file_size > downloadLimit) throw new Error('文件超过下载上限；大视频需配置本地 Bot API 服务');
      const input = path.join(dir, 'input');
      if (info.file_path && path.isAbsolute(info.file_path) && fs.existsSync(info.file_path)) {
        if ((await fs.promises.stat(info.file_path)).size > downloadLimit) throw new Error('文件超过下载上限');
        await fs.promises.copyFile(info.file_path, input);
      } else {
        const link = await telegram.getFileLink(fileId);
        await this.download(link.href, input, downloadLimit);
      }
      const output = path.join(dir, type === 'photo' ? 'output.jpg' : 'output.mp4');
      await this.render(input, output, type, dir);
      const size = (await fs.promises.stat(output)).size;
      if (size > (type === 'photo' ? 10 : cloud ? 50 : watermarkConfig.maxInputMb) * 1024 * 1024) {
        throw new Error('水印输出超过上传上限；请压缩源文件或配置本地 Bot API');
      }
      const extra = { disable_notification: true, caption: caption || undefined };
      const message = type === 'photo'
        ? await telegram.sendPhoto(chat, { source: output }, extra)
        : await telegram.sendVideo(chat, { source: output }, { ...extra, supports_streaming: true });
      const newId = type === 'photo' ? message.photo?.[message.photo.length - 1]?.file_id : message.video?.file_id;
      if (!newId || !message.message_id) throw new Error('Telegram 未返回处理后文件标识');
      const result: WatermarkResult = {
        fileId: newId, sourceChatId: chat, sourceMsgId: message.message_id, version: watermarkConfig.version
      };
      // A small durable receipt allows retry after process restart without another encode/upload.
      await fs.promises.mkdir(cacheDir, { recursive: true });
      await fs.promises.writeFile(cachePath + '.tmp', JSON.stringify(result), 'utf8');
      await fs.promises.rename(cachePath + '.tmp', cachePath);
      return result;
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  }

  /** Render a bounded album locally, then upload it once; no staging messages. */
  processTelegramAlbum(telegram: any, items: Array<{ fileId: string; type: WatermarkMediaType; ready?: boolean; info?: any }>,
    chat: string, caption: string, onProgress?: (done: number) => Promise<void>,
    priority: WatermarkPriority = 'interactive', cancelled: () => boolean = () => false): Promise<WatermarkResult[]> {
    return this.queue.add(async () => {
      if (cancelled()) throw new Error('任务已暂停');
      if (!items.length || items.length > 10) throw new Error('水印相册每组必须为 1～10 个');
      const startedAt = Date.now();
      await this.assertReady(chat);
      const key = createHash('sha256').update(JSON.stringify([
        'album-v1', config.botToken, items.map(({ fileId, type, ready }) => ({ fileId, type, ready })), chat, caption, watermarkConfig
      ])).digest('hex');
      const cacheDir = path.join(path.dirname(path.resolve(config.databasePath)), 'watermark-cache');
      const cachePath = path.join(cacheDir, key + '.json');
      try {
        const cached = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
        if (cached.length === items.length && cached.every((r: WatermarkResult) => r.fileId && r.sourceMsgId)) {
          for (const r of cached) {
            if (telegram.callApi) await watermarkApi(telegram, 'getFile', { file_id: r.fileId });
            else await telegram.getFile(r.fileId);
          }
          return cached;
        }
      } catch { /* Missing or expired receipt. */ }
      const dir = await this.setupDirectory();
      try {
        const cloud = !process.env.TELEGRAM_API_ROOT || process.env.TELEGRAM_API_ROOT === 'https://api.telegram.org';
        const limit = (cloud ? 20 : watermarkConfig.maxInputMb) * 1024 * 1024;
        const group: any[] = [];
        let retainedBytes = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          let source: any = item.fileId;
          if (!item.ready) {
            const info = item.info || (telegram.callApi
              ? await watermarkApi(telegram, 'getFile', { file_id: item.fileId })
              : await telegram.getFile(item.fileId));
            if (info.file_size > limit) throw new Error('文件超过下载上限；大视频需配置本地 Bot API 服务');
            const input = path.join(dir, 'input-' + i);
            const output = path.join(dir, 'output-' + i + (item.type === 'photo' ? '.jpg' : '.mp4'));
            if (info.file_path && path.isAbsolute(info.file_path) && fs.existsSync(info.file_path)) {
              if ((await fs.promises.stat(info.file_path)).size > limit) throw new Error('文件超过下载上限');
              await fs.promises.copyFile(info.file_path, input);
            } else {
              await this.download((await telegram.getFileLink(info)).href, input, limit);
            }
            await this.render(input, output, item.type, dir);
            await fs.promises.rm(input, { force: true });
            const size = (await fs.promises.stat(output)).size;
            if (size > (item.type === 'photo' ? 10 : cloud ? 50 : watermarkConfig.maxInputMb) * 1024 * 1024)
              throw new Error('水印输出超过上传上限');
            retainedBytes += size;
            if (retainedBytes > 500 * 1024 * 1024) throw new Error('单组临时文件超过 500MB，请拆分上传');
            source = { source: output };
          }
          group.push({ type: item.type, media: source, caption: i === 0 ? caption || undefined : undefined });
          await onProgress?.(i + 1);
        }
        const messages = group.length > 1
          ? (telegram.callApi
            ? await watermarkApi(telegram, 'sendMediaGroup', { chat_id: chat, media: group, disable_notification: true }, 180000)
            : await telegram.sendMediaGroup(chat, group, { disable_notification: true }))
          : [await (telegram.callApi
            ? watermarkApi(telegram, items[0].type === 'photo' ? 'sendPhoto' : 'sendVideo', {
              chat_id: chat, [items[0].type]: group[0].media, caption: group[0].caption,
              disable_notification: true, ...(items[0].type === 'video' ? { supports_streaming: true } : {})
            }, 180000)
            : items[0].type === 'photo'
            ? telegram.sendPhoto(chat, group[0].media, { caption: group[0].caption, disable_notification: true })
            : telegram.sendVideo(chat, group[0].media, { caption: group[0].caption, disable_notification: true, supports_streaming: true }))];
        if (messages.length !== items.length) throw new Error('相册上传结果数量不一致');
        const results = messages.map((m: any, i: number) => {
          const fileId = items[i].type === 'photo' ? m.photo?.[m.photo.length - 1]?.file_id : m.video?.file_id;
          if (!fileId || !m.message_id) throw new Error('Telegram 未返回相册文件标识');
          return { fileId, sourceChatId: chat, sourceMsgId: m.message_id, version: watermarkConfig.version };
        });
        await fs.promises.mkdir(cacheDir, { recursive: true });
        await fs.promises.writeFile(cachePath + '.tmp', JSON.stringify(results), 'utf8');
        await fs.promises.rename(cachePath + '.tmp', cachePath);
        console.log('[水印相册] 完成 ' + items.length + ' 个，用时 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒');
        return results;
      } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
    }, priority);
  }
  private async download(url: string, destination: string, limit: number) {
    // GET is safe to retry; never retry a Telegram upload with an uncertain outcome.
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      try {
        const response = await axios.get(url, { responseType: 'stream', signal: controller.signal, timeout: 60000 });
        let bytes = 0;
        const guard = new Transform({
          transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            callback(bytes > limit ? new Error('文件实际大小超过下载上限') : null, chunk);
          }
        });
        await pipeline(response.data, guard, fs.createWriteStream(destination));
        return;
      } catch (error: any) {
        const status = error?.response?.status;
        error?.response?.data?.destroy?.();
        const retryable = controller.signal.aborted || ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ERR_CANCELED', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error?.code)
          || status === 429 || status >= 500;
        if (attempt === 0 && retryable) {
          clearTimeout(timer);
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        if (controller.signal.aborted) throw new Error('文件下载超时：120秒内未完成，已进行一次重试');
        if (status === 404) throw new Error('文件下载失败：HTTP 404，文件链接失效或文件不可用');
        if (status === 413) throw new Error('文件下载失败：HTTP 413，服务器拒绝超大文件');
        if (axios.isAxiosError(error)) throw new Error(watermarkError(error));
        throw error;
      } finally { clearTimeout(timer); }
    }
  }
  private textFilter(size: string, x: string, y: string, opacity = watermarkConfig.opacity) {
    return "drawtext=textfile=watermark.txt:expansion=none:fontfile=font.ttf:" +
      "fontcolor=white@" + opacity + ":borderw=1:bordercolor=black@0.25:" +
      "fontsize='" + size + "':x='" + x + "':y='" + y + "'";
  }
  /** Exposed for offline render tests, uses only local files and never calls Telegram. */
  async render(input: string, output: string, type: WatermarkMediaType, workingDir?: string) {
    const ownDir = !workingDir;
    if (ownDir) {
      await this.assertReady('offline-test');
      workingDir = await this.setupDirectory();
    }
    const widthUnits = Math.max(1, [...watermarkConfig.text].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 1 : 0.7), 0));
    try {
      if (type === 'photo') {
        const text = this.textFilter('min(w*0.65/' + widthUnits + ',h/12)', '(w-text_w)/2', '(h-text_h)/2', 1);
        const filter = '[0:v]split[base][layer];[layer]format=rgba,colorchannelmixer=aa=0,' +
          text + ',rotate=-PI/6:c=none,colorchannelmixer=aa=' + watermarkConfig.opacity +
          '[wm];[base][wm]overlay=0:0:format=auto,format=yuvj420p[out]';
        await this.runFfmpeg(['-i', input, '-filter_complex', filter, '-map', '[out]',
          '-frames:v', '1', '-threads', '1', '-q:v', '2', output], workingDir!);
      } else {
        const text = this.textFilter('min(h/18,w*0.65/' + widthUnits + ')',
          '(w-text_w)/2*(1-cos(2*PI*t/' + watermarkConfig.videoPeriodSeconds + '))', 'h-text_h-h*0.06');
        await this.runFfmpeg(['-i', input, '-map', '0:v:0', '-map', '0:a:0?',
          '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,' + text,
          '-c:v', 'libx264', '-preset', watermarkConfig.videoPreset, '-crf', String(watermarkConfig.videoCrf),
          '-threads', String(watermarkConfig.ffmpegThreads), '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output], workingDir!);
      }
    } finally { if (ownDir) await fs.promises.rm(workingDir!, { recursive: true, force: true }); }
  }
  private runFfmpeg(args: string[], cwd: string, timeout = watermarkConfig.jobTimeoutSeconds * 1000): Promise<void> {
    return new Promise((resolve, reject) => {
      const threads = String(watermarkConfig.ffmpegThreads);
      const allArgs = ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
        '-threads', threads, '-filter_threads', threads, '-filter_complex_threads', threads, ...args];
      const child = spawn(watermarkConfig.ffmpegPath, allArgs,
        { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      // One best-effort priority change only. Combining nice with setPriority races:
      // BusyBox nice can try to raise an already lowered priority and fail with EPERM.
      try { if (child.pid) os.setPriority(child.pid, 15); } catch {}
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
      child.stderr?.on('data', data => { stderr = (stderr + data.toString()).slice(-3000); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      // Wait for actual child exit before deleting files or starting the next queue item.
      child.on('close', code => {
        clearTimeout(timer);
        if (timedOut) reject(new Error('FFmpeg 处理超时'));
        else if (code === 0) resolve();
        else reject(new Error(stderr || 'FFmpeg 退出码 ' + code));
      });
    });
  }
}
export const watermarkService = new WatermarkService();
