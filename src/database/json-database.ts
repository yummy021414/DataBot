import { MediaItem, UserPermission, PermissionType } from '../types';
import { config } from '../config';
import * as fs from 'fs';
import * as path from 'path';

interface UserInfo {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  last_active: string;
  album_trial_start?: string; // 🚀 新增：首次开启相册的时间
  album_auth_expires?: string; // 🚀 新增：相册授权到期时间
}

interface ChatMessageRecord {
  senderId: number;
  recipientId: number;
  content: string;
  createdAt: string;
}

interface DatabaseData {
  searchHistoryImports?: string[];
  searchUsage?: Array<{ userId: number; keyword: string; day: string; count: number; lastAt: number }>;
  media: MediaItem[];
  userPermissions: UserPermission[];
  userSessions: { [userId: number]: any };
  users: UserInfo[]; // 新增：用户信息
  joinWelcomeConfig?: any;
  channels?: string[]; // 新增：动态添加的频道ID
  albums?: { [albumId: string]: any }; // 新增：存储生成的相册数据
  recommendedTags?: string[]; // 新增：推荐标签
  chatMessages?: ChatMessageRecord[];
  searchReplyGroups?: { [key: string]: Array<Pick<MediaItem, 'id' | 'keyword' | 'uploaded_by' | 'uploaded_at' | 'batchId'>> };
}

export class JsonDatabase {
  private dataPath: string;
  private data: DatabaseData = {
    media: [],
    userPermissions: [],
    userSessions: {},
    users: [], // 新增
    chatMessages: []
  };

  constructor() {
    // 使用 path.join 和 __dirname 确保数据库路径是相对于项目根目录的绝对路径
    const projectRoot = path.join(__dirname, '..', '..');
    // 如果是绝对路径，直接使用；否则拼接到项目根目录
    if (path.isAbsolute(config.databasePath)) {
      this.dataPath = config.databasePath.replace('.db', '.json');
    } else {
      this.dataPath = path.join(projectRoot, config.databasePath.replace('.db', '.json'));
    }

    // 确保数据目录存在
    const dataDir = path.dirname(this.dataPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    console.log(`🗄️ JSON数据库路径: ${this.dataPath}`);
    
    this.loadData();
  }

  private loadData(): void {
    try {
      if (fs.existsSync(this.dataPath)) {
        const fileContent = fs.readFileSync(this.dataPath, 'utf8');
        const loadedData = JSON.parse(fileContent);

        // 兼容旧数据：如果没有users字段，初始化为空数组
        this.data = {
          media: loadedData.media || [],
          searchUsage: Array.isArray(loadedData.searchUsage) ? loadedData.searchUsage : [],
          searchHistoryImports: Array.isArray(loadedData.searchHistoryImports) ? loadedData.searchHistoryImports : [],
          searchReplyGroups: this.normalizeObjectMap(loadedData.searchReplyGroups),
          userPermissions: loadedData.userPermissions || [],
          userSessions: this.normalizeObjectMap(loadedData.userSessions),
          users: loadedData.users || [],
          joinWelcomeConfig: loadedData.joinWelcomeConfig || undefined,
          channels: Array.isArray(loadedData.channels) ? loadedData.channels : [],
          albums: this.normalizeObjectMap(loadedData.albums),
          recommendedTags: loadedData.recommendedTags || ['W⬆️', '5⬆️', '静安', '黄浦', 'VIP'],
          chatMessages: Array.isArray(loadedData.chatMessages) ? loadedData.chatMessages : []
        };

        // 主库 media 空但有 fallback 时自动恢复（保存失败过的场景）
        this.tryRestoreMediaFallback();

        // 🚀 核心修复：数据迁移，确保所有旧数据都有 batchId 和有效的时间戳
        let migrated = false;
        this.data.media.forEach(item => {
          let updated = false;
          if (!item.batchId) {
            item.batchId = 'legacy_batch';
            updated = true;
          }
          if (!item.uploaded_at || isNaN(new Date(item.uploaded_at).getTime())) {
            const baseDate = new Date('2025-01-01').getTime();
            item.uploaded_at = new Date(baseDate + (item.id * 1000)).toISOString();
            updated = true;
          }
          if (updated) migrated = true;
        });

        if (migrated) {
          console.log('📦 已完成旧数据的“批次ID”与“时间戳”体检修复');
          this.saveData();
        }

        console.log('✅ JSON数据库加载成功');
        console.log(`📊 用户数: ${this.data.users.length}, 媒体数: ${this.data.media.length}`);
      } else {
        this.data = {
          media: [],
          userPermissions: [],
          userSessions: {},
          users: [],
          joinWelcomeConfig: undefined,
          channels: [],
          albums: {},
          chatMessages: []
        };
        this.saveData();
        console.log('✅ 创建新的JSON数据库');
      }
    } catch (error) {
      console.error('❌ JSON数据库加载失败:', error);
      this.data = {
        media: [],
        userPermissions: [],
        userSessions: {},
        users: [],
        joinWelcomeConfig: undefined,
        channels: [],
          albums: {},
          chatMessages: []
      };
    }
  }

  /** 数组误当成 map 时，用大数字 userId/albumId 当索引会把 length 撑爆，JSON.stringify → Invalid string length */
  private normalizeObjectMap(value: any): { [key: string]: any } {
    if (!value || typeof value !== 'object') return {};
    if (Array.isArray(value)) {
      if (value.length === 0) return {};
      const obj: { [key: string]: any } = {};
      for (const [k, v] of Object.entries(value)) {
        if (v !== undefined && v !== null) obj[k] = v;
      }
      return obj;
    }
    return value;
  }

  private tryRestoreMediaFallback(): void {
    if ((this.data.media || []).length > 0) return;
    const fallbackPath = this.dataPath.replace(/\.json$/i, '.media-fallback.json');
    try {
      if (!fs.existsSync(fallbackPath)) return;
      const fb = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
      if (Array.isArray(fb.media) && fb.media.length > 0) {
        this.data.media = fb.media;
        console.log(`🛠️ 已从 media-fallback.json 恢复 ${fb.media.length} 条媒体`);
        this.saveImmediately().catch(() => {});
      }
    } catch (e: any) {
      console.warn('读取 media-fallback 失败:', e?.message || e);
    }
  }

  private saveTimer: NodeJS.Timeout | null = null;
  /** 所有 JSON 落盘串行执行，避免多个异步任务同时覆盖同一个 .tmp 文件。 */
  private persistQueue: Promise<void> = Promise.resolve();

  /** 白名单序列化；仅持久化上传会话中的原始值，排除 Context/计时器。 */
  private serializeData(): string {
    const albums = this.normalizeObjectMap(this.data.albums);
    const payload = {
      media: this.data.media || [],
      searchUsage: this.data.searchUsage || [],
      searchHistoryImports: this.data.searchHistoryImports || [],
      searchReplyGroups: this.data.searchReplyGroups || {},
      userPermissions: this.data.userPermissions || [],
      userSessions: this.uploadSessionSnapshots(),
      users: this.data.users || [],
      joinWelcomeConfig: this.data.joinWelcomeConfig,
      channels: Array.isArray(this.data.channels) ? this.data.channels : [],
      albums,
      recommendedTags: this.data.recommendedTags || [],
      chatMessages: this.data.chatMessages || []
    };
    return JSON.stringify(payload);
  }

  /** Persist only primitive upload fields; never serialize Context or timers. */
  private uploadSessionSnapshots(): Record<string, any> {
    const output: Record<string, any> = {};
    const fields = ['userId', 'mode', 'step', 'currentKeyword', 'selectedChannel', 'pendingText', 'expiresAt'];
    for (const [uid, session] of Object.entries(this.data.userSessions)) {
      if (!session || !['upload', 'add_review'].includes(session.mode)) continue;
      const snapshot: any = {};
      for (const key of fields) if (['string', 'number', 'boolean'].includes(typeof session[key])) snapshot[key] = session[key];
      snapshot.selectedChannels = (session.selectedChannels || []).filter((v: any) => typeof v === 'string');
      snapshot.pendingMedia = (session.pendingMedia || []).map((media: any) =>
        Object.fromEntries(Object.entries(media).filter(([_, value]) => ['string', 'number', 'boolean'].includes(typeof value))));
      output[uid] = snapshot;
    }
    return output;
  }

  private saveData(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.enqueuePersist(false);
    }, 500);
  }

  private enqueuePersist(throwOnError: boolean): Promise<void> {
    const operation = this.persistQueue.then(() => this.persistToDisk(throwOnError));
    // 队列本身保持可继续；调用方仍会收到本次 operation 的异常。
    this.persistQueue = operation.catch(() => {});
    return operation;
  }

  private async persistToDisk(throwOnError = false): Promise<void> {
    try {
      // 运行时也纠正：若被写成了数组，立刻改回对象，否则下一次还会炸
      this.data.userSessions = this.normalizeObjectMap(this.data.userSessions);
      this.data.albums = this.normalizeObjectMap(this.data.albums);

      const payload = this.serializeData();
      const tmp = `${this.dataPath}.tmp`;
      await fs.promises.writeFile(tmp, payload, 'utf8');
      await fs.promises.rename(tmp, this.dataPath);
    } catch (error: any) {
      console.error('❌ JSON数据库异步保存失败:', error?.message || error);
      console.error(
        `   当前内存: users=${this.data.users?.length || 0} media=${this.data.media?.length || 0} sessions=${Object.keys(this.data.userSessions || {}).length}`
      );
      try {
        const mediaOnly = JSON.stringify({ media: this.data.media || [], savedAt: new Date().toISOString() });
        await fs.promises.writeFile(this.dataPath.replace(/\.json$/i, '.media-fallback.json'), mediaOnly, 'utf8');
        console.error('   已写入 media-fallback.json（主库仍失败，重启会尝试自动恢复）');
      } catch (e2: any) {
        console.error('   media-fallback 也失败:', e2?.message || e2);
      }
      if (throwOnError) throw error;
    }
  }

  async saveImmediately(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.enqueuePersist(true);
  }

  // 媒体相关方法
  async saveMedia(mediaItem: Omit<MediaItem, 'id'>): Promise<number> {
    if (mediaItem.upload_key) {
      const existing = this.data.media.find(m => m.upload_key === mediaItem.upload_key);
      if (existing) return existing.id;
    }
    const newId = this.data.media.length > 0 ? Math.max(...this.data.media.map(m => m.id)) + 1 : 1;
    const item: MediaItem = {
      ...mediaItem,
      id: newId
    };
    this.data.media.push(item);
    this.saveData();
    // 关键后尽快落盘，避免进程被关掉丢数据
    setTimeout(() => { this.saveImmediately().catch(() => {}); }, 600);
    return newId;
  }

  async getMediaByKeyword(keyword: string, userId?: number): Promise<MediaItem[]> {
    let results = this.data.media.filter(item => item.keyword === keyword && !item.is_review); // 🚀 默认不包含好评图
    
    if (userId !== undefined) {
      results = results.filter(item => item.uploaded_by === userId);
    }
    
    // 🚀 核心修复：按上传时间升序排列，确保“组”的逻辑顺序
    return results.sort((a, b) => new Date(a.uploaded_at).getTime() - new Date(b.uploaded_at).getTime());
  }

  async recordKeywordSearch(userId: number, keyword: string, now = Date.now()): Promise<void> {
    const day = new Date(now).toISOString().slice(0, 10);
    const cutoff = new Date(now - 29 * 86400000).toISOString().slice(0, 10);
    this.data.searchUsage = (this.data.searchUsage || []).filter(entry => entry.day >= cutoff);
    const entry = this.data.searchUsage.find(entry => entry.userId === userId && entry.keyword === keyword && entry.day === day);
    if (entry) { entry.count++; entry.lastAt = now; }
    else this.data.searchUsage.push({ userId, keyword, day, count: 1, lastAt: now });
    this.saveData();
  }

  async getRecentSearches(userId: number, scopeUserId?: number, now = Date.now()): Promise<Array<{ keyword: string; count: number; lastAt: number }>> {
    const cutoff = new Date(now - 29 * 86400000).toISOString().slice(0, 10);
    const available = new Set(await this.getAllKeywords(scopeUserId));
    const totals = new Map<string, { keyword: string; count: number; lastAt: number }>();
    for (const entry of this.data.searchUsage || []) {
      if (entry.userId !== userId || entry.day < cutoff || !available.has(entry.keyword)) continue;
      const total = totals.get(entry.keyword) || { keyword: entry.keyword, count: 0, lastAt: 0 };
      total.count += entry.count;
      total.lastAt = Math.max(total.lastAt, entry.lastAt);
      totals.set(entry.keyword, total);
    }
    return [...totals.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt || a.keyword.localeCompare(b.keyword));
  }

  // 🚀 新增：专门获取好评图
  async getReviewsByKeyword(keyword: string): Promise<MediaItem[]> {
    const results = this.data.media.filter(item => item.keyword === keyword && item.is_review);
    return results.sort((a, b) => new Date(a.uploaded_at).getTime() - new Date(b.uploaded_at).getTime());
  }

  // 🚀 新增：获取所有带好评的关键词，按最新好评时间倒序
  async getKeywordsWithReviews(): Promise<string[]> {
    const keywordMap = new Map<string, number>();
    
    this.data.media.forEach(item => {
      if (item.is_review) {
        const time = new Date(item.uploaded_at).getTime();
        const existing = keywordMap.get(item.keyword) || 0;
        if (time > existing) {
          keywordMap.set(item.keyword, time);
        }
      }
    });

    return Array.from(keywordMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(entry => entry[0]);
  }

  async searchMedia(keyword: string, userId?: number, limit: number = 10): Promise<MediaItem[]> {
    let results = this.data.media.filter(item => 
      item.keyword === keyword
    );
    
    if (userId !== undefined) {
      results = results.filter(item => item.uploaded_by === userId);
    }
    
    return results.slice(0, limit);
  }

  async updateMediaPublished(id: number, channelId: string): Promise<void> {
    const item = this.data.media.find(m => m.id === id);
    if (item) {
      item.is_published = true;
      item.channel_id = channelId;
      item.published_at = new Date().toISOString();
      this.saveData();
    }
  }

  private chinaDayKey(ms: number): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(ms));
  }

  private chinaDaysInRange(startMs: number, endMs: number): Set<string> {
    const days = new Set<string>();
    if (endMs < startMs) return days;
    // 按 12 小时步进，避免漏跨天
    for (let t = startMs; t <= endMs; t += 12 * 60 * 60 * 1000) {
      days.add(this.chinaDayKey(t));
    }
    days.add(this.chinaDayKey(endMs));
    return days;
  }

  /** 频道 ID 归一化，避免 -100xxx / xxx 写法不一致漏匹配 */
  private normalizeChannelId(id: string): string {
    return String(id).trim().replace(/^-100/, '').replace(/^-/, '');
  }

  /**
   * 超管：按发布时间段提取已发布到指定频道的关键词（去重，按时间正序）
   * 匹配规则：
   * 1) published_at 落在时段内 → published_at
   * 2) uploaded_at 落在时段内 → uploaded_at
   * 3) 无 published_at 且已发布：入库日与查询日重叠 → same_day
   * 4) 无 published_at 且已发布（频道匹配）：一律纳入 no_time
   *    （覆盖「发布模式发旧资料」：入库早、发布在时段内但当时没记 published_at）
   */
  async getPublishedKeywordsByTimeRange(
    userId: number,
    start: Date,
    end: Date,
    channelIds?: string[]
  ): Promise<Array<{ keyword: string; publishedAt: string; channelId?: string; legacy?: boolean; fallback?: boolean; matchBy?: string }>> {
    // 结束时间含整分：13:50 → 13:50:59.999
    const startMs = start.getTime();
    const endMs = end.getTime() + 59 * 1000 + 999;
    const queryDays = this.chinaDaysInRange(startMs, endMs);
    const channelSet = channelIds && channelIds.length > 0
      ? new Set(channelIds.map(id => this.normalizeChannelId(id)))
      : null;

    type Row = { keyword: string; publishedAt: string; channelId?: string; legacy?: boolean; fallback?: boolean; matchBy?: string };
    const keywordMap = new Map<string, Row>();

    const channelOk = (channelId?: string): boolean => {
      if (!channelSet) return true;
      if (!channelId) return true;
      return channelSet.has(this.normalizeChannelId(channelId));
    };

    // 匹配优先级：published_at > uploaded_at > same_day > no_time
    const rank = (m?: string) =>
      m === 'published_at' ? 4 : m === 'uploaded_at' ? 3 : m === 'same_day' ? 2 : m === 'no_time' ? 1 : 0;

    const upsert = (row: Row) => {
      const existing = keywordMap.get(row.keyword);
      if (!existing) {
        keywordMap.set(row.keyword, row);
        return;
      }
      const er = rank(existing.matchBy);
      const nr = rank(row.matchBy);
      if (nr > er) {
        keywordMap.set(row.keyword, row);
        return;
      }
      if (nr === er && row.publishedAt > existing.publishedAt) {
        keywordMap.set(row.keyword, row);
      }
    };

    for (const item of this.data.media) {
      if (Number(item.uploaded_by) !== Number(userId)) continue;
      if (item.is_review) continue;
      if (!item.is_published && !item.channel_id) continue;
      if (!channelOk(item.channel_id)) continue;

      const pubMs = item.published_at ? new Date(item.published_at).getTime() : NaN;
      const upMs = item.uploaded_at ? new Date(item.uploaded_at).getTime() : NaN;
      const pubInRange = !Number.isNaN(pubMs) && pubMs >= startMs && pubMs <= endMs;
      const upInRange = !Number.isNaN(upMs) && upMs >= startMs && upMs <= endMs;
      const sameDayNoPublishAt =
        !item.published_at &&
        !!item.is_published &&
        !Number.isNaN(upMs) &&
        queryDays.has(this.chinaDayKey(upMs));
      // 发布模式发旧资料：只有 is_published，没有 published_at，入库日也不在今天
      const noTimePublished =
        !item.published_at &&
        !!item.is_published;

      if (!pubInRange && !upInRange && !sameDayNoPublishAt && !noTimePublished) continue;

      let matchBy: string;
      let timeStr: string;
      if (pubInRange && item.published_at) {
        matchBy = 'published_at';
        timeStr = item.published_at;
      } else if (upInRange && item.uploaded_at) {
        matchBy = 'uploaded_at';
        timeStr = item.uploaded_at;
      } else if (sameDayNoPublishAt) {
        matchBy = 'same_day';
        timeStr = item.uploaded_at || new Date(0).toISOString();
      } else {
        matchBy = 'no_time';
        timeStr = item.uploaded_at || new Date(0).toISOString();
      }

      upsert({
        keyword: item.keyword,
        publishedAt: timeStr,
        channelId: item.channel_id,
        legacy: !item.published_at,
        fallback: matchBy === 'same_day' || matchBy === 'no_time',
        matchBy
      });
    }

    return Array.from(keywordMap.values()).sort((a, b) => {
      const ra = rank(a.matchBy);
      const rb = rank(b.matchBy);
      if (rb !== ra) return rb - ra;
      return new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime();
    });
  }

  /** 提取诊断：方便排查「为什么只出 1 个」 */
  async getPublishExtractStats(userId: number, channelIds?: string[]): Promise<{
    totalMine: number;
    publishedMine: number;
    withPublishedAt: number;
    withoutPublishedAt: number;
    channelMatched: number;
  }> {
    const channelSet = channelIds && channelIds.length > 0
      ? new Set(channelIds.map(id => this.normalizeChannelId(id)))
      : null;
    const channelOk = (channelId?: string): boolean => {
      if (!channelSet) return true;
      if (!channelId) return true;
      return channelSet.has(this.normalizeChannelId(channelId));
    };

    let totalMine = 0;
    let publishedMine = 0;
    let withPublishedAt = 0;
    let withoutPublishedAt = 0;
    let channelMatched = 0;
    const seen = new Set<string>();
    const seenPub = new Set<string>();

    for (const item of this.data.media) {
      if (Number(item.uploaded_by) !== Number(userId)) continue;
      if (item.is_review) continue;
      totalMine++;
      if (!item.is_published && !item.channel_id) continue;
      if (!seen.has(item.keyword)) {
        seen.add(item.keyword);
        if (item.is_published || item.channel_id) publishedMine++;
      }
      if (item.is_published || item.channel_id) {
        if (item.published_at) withPublishedAt++;
        else withoutPublishedAt++;
        if (channelOk(item.channel_id) && !seenPub.has(item.keyword)) {
          seenPub.add(item.keyword);
          channelMatched++;
        }
      }
    }

    return { totalMine, publishedMine, withPublishedAt, withoutPublishedAt, channelMatched };
  }

  /**
   * 更新永久源坐标（金库）。
   * 默认不覆盖已有坐标，避免「发布到业务频道」把金库坐标冲掉。
   * force=true：金库归档 / vault-sync --force / 重置坐标时使用。
   * chatId 为空或 msgId 为 0 且 force：清除坐标。
   */
  async updateMediaSource(
    id: number,
    chatId: string,
    msgId: number,
    options?: { force?: boolean }
  ): Promise<void> {
    const item = this.data.media.find(m => m.id === id);
    if (!item) return;
    if (!options?.force && item.source_chat_id && item.source_msg_id) {
      return;
    }
    if (!chatId || !msgId) {
      delete item.source_chat_id;
      delete item.source_msg_id;
    } else {
      item.source_chat_id = chatId;
      item.source_msg_id = msgId;
    }
    this.saveData();
    setTimeout(() => { this.saveImmediately().catch(() => {}); }, 600);
  }

  /** 换 bot 认领：更新 file_id（可选同步类型） */
  async updateMediaFileId(id: number, fileId: string, fileType?: MediaItem['file_type']): Promise<void> {
    const item = this.data.media.find(m => m.id === id);
    if (item) {
      item.file_id = fileId;
      if (fileType) item.file_type = fileType;
      this.saveData();
    }
  }

  /**
   * 原子切换为带水印版本。首次迁移时保留旧 file_id/金库坐标；每条立即落盘，
   * 因而批量任务被重启或暂停后可以安全续跑，不会重复处理已完成资料。
   */
  async updateMediaWatermark(
    id: number,
    update: {
      fileId: string;
      version: number;
      sourceChatId: string;
      sourceMsgId: number;
      expectedFileId?: string;
    }
  ): Promise<void> {
    return this.updateMediaWatermarkBatch([{ id, ...update }]);
  }

  /** Commit the whole album in one durable write; never leave half an album switched. */
  async updateMediaWatermarkBatch(updates: Array<{
    id: number; fileId: string; version: number; sourceChatId: string; sourceMsgId: number; expectedFileId?: string;
  }>): Promise<void> {
    const entries = updates.map(update => {
      const item = this.data.media.find(m => m.id === update.id);
      if (!item) throw new Error('媒体 #' + update.id + ' 不存在');
      if (update.expectedFileId && item.file_id !== update.expectedFileId)
        throw new Error('资料处理期间发生变化，本次不覆盖，请重试');
      return { update, item, before: { ...item } };
    });
    for (const { update, item, before } of entries) {
      if (!item.original_file_id) item.original_file_id = item.file_id;
      if (!before.watermarked && !item.original_source_chat_id && item.source_chat_id)
        item.original_source_chat_id = item.source_chat_id;
      if (!before.watermarked && !item.original_source_msg_id && item.source_msg_id)
        item.original_source_msg_id = item.source_msg_id;
      item.file_id = update.fileId;
      item.source_chat_id = update.sourceChatId;
      item.source_msg_id = update.sourceMsgId;
      item.watermarked = true;
      item.watermark_version = update.version;
      item.watermarked_at = new Date().toISOString();
    }
    try { await this.saveImmediately(); }
    catch (error) {
      for (const { item, before } of entries) {
        for (const key of ['file_id', 'source_chat_id', 'source_msg_id', 'watermarked', 'watermark_version',
          'watermarked_at', 'original_file_id', 'original_source_chat_id', 'original_source_msg_id']) {
          if (Object.prototype.hasOwnProperty.call(before, key)) (item as any)[key] = (before as any)[key];
          else delete (item as any)[key];
        }
      }
      throw error;
    }
  }

  /** 批量更新 file_id，只落盘一次 */
  async batchUpdateMediaFileIds(
    updates: Array<{ id: number; fileId: string; fileType?: MediaItem['file_type'] }>
  ): Promise<number> {
    let n = 0;
    for (const u of updates) {
      const item = this.data.media.find(m => m.id === u.id);
      if (!item) continue;
      item.file_id = u.fileId;
      if (u.fileType) item.file_type = u.fileType;
      n++;
    }
    if (n > 0) this.saveData();
    return n;
  }

  async getMediaStats(): Promise<any> {
    const totalMedia = this.data.media.length;
    const publishedMedia = this.data.media.filter(m => m.is_published).length;
    const uniqueKeywords = new Set(this.data.media.map(m => m.keyword)).size;
    
    return {
      totalMedia,
      publishedMedia,
      uniqueKeywords,
      unpublishedMedia: totalMedia - publishedMedia
    };
  }

  async getAllKeywords(userId?: number): Promise<string[]> {
    let media = this.data.media;
    
    // 🚀 核心修复：在常规资料库排序时，排除好评图的时间干扰
    const regularMedia = media.filter(item => !item.is_review);
    
    if (userId !== undefined) {
      media = regularMedia.filter(item => item.uploaded_by === userId);
    } else {
      media = regularMedia;
    }
    
    // 按普通资料的最新上传时间排序（新到旧）
    const keywordMap = new Map<string, string>();
    
    media.forEach(item => {
      const existingTime = keywordMap.get(item.keyword);
      if (!existingTime || item.uploaded_at > existingTime) {
        keywordMap.set(item.keyword, item.uploaded_at);
      }
    });
    
    // 按时间排序（新到旧）
    const sortedKeywords = Array.from(keywordMap.entries())
      .sort(([, timeA], [, timeB]) => timeB.localeCompare(timeA))
      .map(([keyword]) => keyword);
    
    return sortedKeywords;
  }

  async keywordExists(keyword: string, userId?: number): Promise<boolean> {
    let media = this.data.media;
    
    if (userId !== undefined) {
      media = media.filter(item => item.uploaded_by === userId);
    }
    
    return media.some(item => item.keyword === keyword);
  }

  async deleteKeyword(keyword: string, userId?: number): Promise<number> {
    let deletedCount = 0;
    
    if (userId !== undefined) {
      // 删除特定用户的关键词
      const beforeLength = this.data.media.length;
      this.data.media = this.data.media.filter(item => 
        !(item.keyword === keyword && item.uploaded_by === userId)
      );
      deletedCount = beforeLength - this.data.media.length;
    } else {
      // 删除所有关键词
      const beforeLength = this.data.media.length;
      this.data.media = this.data.media.filter(item => item.keyword !== keyword);
      deletedCount = beforeLength - this.data.media.length;
    }
    
    if (deletedCount > 0) {
      this.saveData();
    }
    
    return deletedCount;
  }

  // 用户权限相关方法（会员制度已取消，全部开放）
  async checkUserPermission(_userId: number): Promise<boolean> {
    return true;
  }

  async addUserPermission(userId: number, type: PermissionType, days?: number): Promise<void> {
    const existingIndex = this.data.userPermissions.findIndex(perm => perm.user_id === userId);
    
    const now = new Date();
    let expiresAt: string | undefined;
    
    if (days) {
      expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    } else {
      // 默认逻辑
      if (type === 'monthly') expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      else if (type === 'quarterly') expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();
      else if ((type as string) === 'half_year') expiresAt = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
    }

    if (existingIndex >= 0) {
      const p: any = this.data.userPermissions[existingIndex];
      p.type = type;
      p.expires_at = expiresAt;
    } else {
      const newPerm: any = {
        user_id: userId,
        type,
        granted_at: now.toISOString(),
        expires_at: expiresAt
      };
      this.data.userPermissions.push(newPerm);
    }
    
    this.saveData();
  }

  // 相册访问权限（会员制度已取消，全部开放）
  async checkAlbumAccess(_userId: number): Promise<{ hasAccess: boolean; status: string; remainingDays?: number }> {
    return { hasAccess: true, status: 'open' };
  }

  async removeUserPermission(userId: number): Promise<void> {
    this.data.userPermissions = this.data.userPermissions.filter(perm => perm.user_id !== userId);
    this.saveData();
  }

  async getUserCount(): Promise<number> {
    return this.data.users.length; // 返回所有使用过机器人的用户数
  }

  // 用户会话相关方法
  async saveUserSession(userId: number, session: any): Promise<void> {
    this.data.userSessions = this.normalizeObjectMap(this.data.userSessions);
    // 只存可序列化的浅拷贝字段，避免把 Telegraf Context 等塞进“数组下标”
    session.expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    this.data.userSessions[String(userId)] = session;
    this.saveData();
  }

  async getUserSession(userId: number): Promise<any> {
    const session = this.data.userSessions[userId];
    if (!session) return null;
    
    // 🚀 防御机制：自动清理过期 Session
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      delete this.data.userSessions[userId];
      this.saveData();
      console.log(`[Session过期] 用户 ${userId} 的Session已自动清理`);
      return null;
    }
    
    return session;
  }

  async deleteUserSession(userId: number): Promise<void> {
    delete this.data.userSessions[userId];
    this.saveData();
  }

  // 清理过期数据
  async cleanExpiredData(): Promise<number> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    const beforeLength = this.data.media.length;
    this.data.media = this.data.media.filter(item => {
      const uploadDate = new Date(item.uploaded_at);
      return uploadDate > thirtyDaysAgo;
    });
    
    const deletedCount = beforeLength - this.data.media.length;
    if (deletedCount > 0) {
      this.saveData();
    }
    
    return deletedCount;
  }

  // 添加缺失的方法
  async getAllMedia(userId?: number): Promise<MediaItem[]> {
    if (userId) {
      return this.data.media.filter(item => item.uploaded_by === userId);
    }
    return this.data.media;
  }

  async deleteMedia(id: number): Promise<void> {
    this.data.media = this.data.media.filter(item => item.id !== id);
    this.saveData();
  }

  async rememberSearchGroup(chatId: number, messageIds: number[], items: MediaItem[]): Promise<void> {
    const refs = items.map(({ id, keyword, uploaded_by, uploaded_at, batchId }) =>
      ({ id, keyword, uploaded_by, uploaded_at, batchId }));
    this.data.searchReplyGroups ||= {};
    for (const id of messageIds) this.data.searchReplyGroups[`${chatId}:${id}`] = refs;
    await this.saveImmediately();
  }

  getSearchGroup(chatId: number, messageId: number, userId?: number): MediaItem[] {
    const refs = this.data.searchReplyGroups?.[`${chatId}:${messageId}`];
    if (!refs?.length) throw new Error('找不到对应资料组，请重新搜索后引用。');
    const items = this.data.media.filter(item => !item.is_review && refs.some(ref =>
      item.id === ref.id && item.keyword === ref.keyword && item.uploaded_by === ref.uploaded_by &&
      item.uploaded_at === ref.uploaded_at && item.batchId === ref.batchId));
    if (!items.length) throw new Error('这组资料已经删除，请重新搜索。');
    if (userId !== undefined && items.some(item => item.uploaded_by !== userId)) throw new Error('只能修改自己的资料。');
    return items.map(item => ({ ...item }));
  }

  async replaceSearchGroup(chatId: number, messageId: number, userId: number | undefined,
    expected: MediaItem[], replacement: MediaItem[]): Promise<void> {
    const current = this.getSearchGroup(chatId, messageId, userId);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('资料已发生变化，请重新引用并替换。');
    if (!replacement.length || replacement.some(item => item.keyword !== current[0].keyword ||
      item.uploaded_by !== current[0].uploaded_by || item.batchId !== current[0].batchId || item.is_review)) {
      throw new Error('替换资料组不一致');
    }
    const ids = new Set(current.map(item => item.id));
    let nextId = Math.max(0, ...this.data.media.map(item => item.id)) + 1;
    const saved = replacement.map(item => ({ ...item, id: nextId++, caption_overridden: true }));
    const oldRefs = this.data.searchReplyGroups;
    const updatedRefs = { ...oldRefs };
    const refs = saved.map(({ id, keyword, uploaded_by, uploaded_at, batchId }) =>
      ({ id, keyword, uploaded_by, uploaded_at, batchId }));
    for (const [key, value] of Object.entries(updatedRefs)) {
      if (value.some(ref => current.some(item => item.id === ref.id && item.uploaded_at === ref.uploaded_at &&
        item.keyword === ref.keyword && item.uploaded_by === ref.uploaded_by && item.batchId === ref.batchId))) updatedRefs[key] = refs;
    }
    this.data.media = this.data.media.filter(item => !ids.has(item.id)).concat(saved);
    this.data.searchReplyGroups = updatedRefs;
    try { await this.saveImmediately(); }
    catch (error) {
      const savedIds = new Set(saved.map(item => item.id));
      this.data.media = this.data.media.filter(item => !savedIds.has(item.id)).concat(current);
      this.data.searchReplyGroups = oldRefs;
      throw error;
    }
  }

  async deleteSearchGroup(chatId: number, messageId: number, userId?: number): Promise<{
    status: 'missing' | 'forbidden' | 'deleted'; keyword?: string; count?: number; remainingGroups?: number;
  }> {
    const refs = this.data.searchReplyGroups?.[`${chatId}:${messageId}`];
    if (!refs?.length) return { status: 'missing' };
    // IDs can be reused after deletion, so also verify the original group identity.
    const matches = (item: MediaItem) => !item.is_review && refs.some(ref =>
      item.id === ref.id && item.keyword === ref.keyword && item.uploaded_by === ref.uploaded_by &&
      item.uploaded_at === ref.uploaded_at && item.batchId === ref.batchId);
    const targets = this.data.media.filter(matches);
    if (!targets.length) return { status: 'missing' };
    if (userId !== undefined && targets.some(item => item.uploaded_by !== userId)) {
      return { status: 'forbidden' };
    }
    const keyword = refs[0].keyword;
    const previous = this.data.media;
    this.data.media = previous.filter(item => !matches(item));
    try {
      await this.saveImmediately();
    } catch (error) {
      this.data.media.push(...targets);
      throw error;
    }
    const remaining = this.data.media.filter(item => !item.is_review && item.keyword === keyword &&
      (userId === undefined || item.uploaded_by === userId));
    return { status: 'deleted', keyword, count: targets.length,
      remainingGroups: new Set(remaining.map(item => `${item.uploaded_by}:${item.batchId || 'default'}`)).size };
  }

  async getMediaCount(userId?: number): Promise<number> {
    if (userId) {
      return this.data.media.filter(item => item.uploaded_by === userId).length;
    }
    return this.data.media.length;
  }

  async cleanInvalidMedia(): Promise<number> {
    // 简单实现：返回0，表示没有清理任何媒体
    return 0;
  }

  async getUserPermissions(userId: number): Promise<UserPermission[]> {
    return this.data.userPermissions.filter(perm => perm.user_id === userId);
  }

  async grantUserPermission(userId: number, type: string): Promise<void> {
    const existing = this.data.userPermissions.find(perm => perm.user_id === userId && perm.type === type);
    if (!existing) {
      this.data.userPermissions.push({
        user_id: userId,
        type: type as PermissionType,
        granted_at: new Date().toISOString()
      });
      this.saveData();
    }
  }

  async revokeUserPermission(userId: number, type: string): Promise<void> {
    this.data.userPermissions = this.data.userPermissions.filter(
      perm => !(perm.user_id === userId && perm.type === type)
    );
    this.saveData();
  }

  async getAllUserPermissions(): Promise<UserPermission[]> {
    return this.data.userPermissions;
  }

  async getExpiringUsers(): Promise<any[]> {
    // 简单实现：返回空数组
    return [];
  }

  async markReminderSent(userId: number): Promise<void> {
    // 简单实现：不做任何操作
  }

  async clearUserSession(userId: number): Promise<void> {
    delete this.data.userSessions[userId];
    this.saveData();
  }

  async trackUser(userId: number, first_name?: string, last_name?: string, username?: string): Promise<void> {
    // 查找或创建用户记录
    let user = this.data.users.find(u => u.id === userId);
    const now = new Date().toISOString();
    
    if (user) {
      let changed = false;
      // 检查信息是否发生变化
      if (first_name && user.first_name !== first_name) { user.first_name = first_name; changed = true; }
      if (last_name && user.last_name !== last_name) { user.last_name = last_name; changed = true; }
      if (username && user.username !== username) { user.username = username; changed = true; }
      
      // 检查距离上次活跃时间是否超过1小时，避免过于频繁的保存
      const lastActive = new Date(user.last_active).getTime();
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      
      if (changed || lastActive < oneHourAgo) {
        user.last_active = now;
        this.saveData();
      }
    } else {
      // 创建新用户
      user = {
        id: userId,
        first_name: first_name || undefined,
        last_name: last_name || undefined,
        username: username || undefined,
        last_active: now
      };
      this.data.users.push(user);
      this.saveData();
    }
  }

  // 🚀 新增：获取用户信息
  async getUserInfo(userId: number): Promise<UserInfo | null> {
    return this.data.users.find(u => u.id === userId) || null;
  }

  // 🚀 新增：正式开始相册试用计时（在创建第一个相册成功时调用）
  async startAlbumTrial(userId: number): Promise<void> {
    const user = this.data.users.find(u => u.id === userId);
    if (user && !user.album_trial_start) {
      user.album_trial_start = new Date().toISOString();
      console.log(`[数据库] 👤 用户 ${userId} 成功创建首个相册，开始 15 天试用倒计时`);
      this.saveData();
    }
  }

  // 🚀 新增：给用户授权相册功能
  async grantAlbumAuth(userId: number, months: number): Promise<void> {
    const user = this.data.users.find(u => u.id === userId);
    if (user) {
      const now = new Date();
      let expires = new Date(user.album_auth_expires || now.toISOString());
      
      // 如果当前已经过期或从未授权，从现在开始算
      if (expires < now) expires = now;
      
      expires.setMonth(expires.getMonth() + months);
      user.album_auth_expires = expires.toISOString();
      this.saveData();
    }
  }

  // 🚀 新增：彻底移除某个用户（如拉黑机器人的用户）
  async removeUser(userId: number): Promise<void> {
    const initialLength = this.data.users.length;
    this.data.users = this.data.users.filter(u => u.id !== userId);
    
    // 同时清理权限和Session（保持数据库整洁）
    this.data.userPermissions = this.data.userPermissions.filter(p => p.user_id !== userId);
    delete this.data.userSessions[userId];

    if (this.data.users.length !== initialLength) {
      console.log(`[数据库] 👤 已从活跃列表中移除用户: ${userId}`);
      this.saveData();
    }
  }

  async getChatUsers(): Promise<any[]> {
    const latestByUser = new Map<number, string>();
    for (const message of this.data.chatMessages || []) {
      const userId = message.senderId === config.superAdminId
        ? message.recipientId
        : message.senderId;
      if (userId === config.superAdminId) continue;
      const previous = latestByUser.get(userId);
      if (!previous || message.createdAt > previous) {
        latestByUser.set(userId, message.createdAt);
      }
    }
    return Array.from(latestByUser.entries())
      .map(([user_id, last_message_time]) => ({ user_id, last_message_time }))
      .sort((a, b) => b.last_message_time.localeCompare(a.last_message_time));
  }

  async saveChatMessage(senderId: number, recipientId: number, content: string): Promise<void> {
    const messages = this.data.chatMessages || (this.data.chatMessages = []);
    messages.push({
      senderId,
      recipientId,
      content: String(content || '').slice(0, 4000),
      createdAt: new Date().toISOString()
    });
    // 聊天记录需要立即可见，不能等待防抖写盘后才出现在管理员列表中。
    if (messages.length > 5000) messages.splice(0, messages.length - 5000);
    await this.saveImmediately();
  }

  async getAllActiveUsers(): Promise<any[]> {
    // 返回所有使用过机器人的用户
    return this.data.users.map(user => ({
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      username: user.username,
      last_active: user.last_active
    }));
  }

  async getKeywordCount(): Promise<number> {
    const keywords = new Set(this.data.media.map(item => item.keyword));
    return keywords.size;
  }

  async getJoinWelcomeConfig(): Promise<any> {
    return this.data.joinWelcomeConfig || null;
  }

  async saveJoinWelcomeConfig(config: any): Promise<void> {
    this.data.joinWelcomeConfig = config;
    this.saveData();
  }

  // 频道管理相关
  async getManagedChannels(): Promise<string[]> {
    // 合并 env 中的频道和数据库中的频道
    const envChannels = config.channelIds;
    const dbChannels = this.data.channels || [];
    // 去重
    return Array.from(new Set([...envChannels, ...dbChannels]));
  }

  async addManagedChannel(channelId: string): Promise<void> {
    if (!this.data.channels) this.data.channels = [];
    if (!this.data.channels.includes(channelId)) {
      this.data.channels.push(channelId);
      this.saveData();
    }
  }

  async removeManagedChannel(channelId: string): Promise<boolean> {
    if (!this.data.channels) return false;
    const initialLength = this.data.channels.length;
    this.data.channels = this.data.channels.filter(id => id !== channelId);
    
    if (this.data.channels.length !== initialLength) {
      this.saveData();
      return true;
    }
    return false;
  }

  // 相册管理相关
  async saveAlbum(albumId: string, albumData: any): Promise<void> {
    this.data.albums = this.normalizeObjectMap(this.data.albums);
    this.data.albums[String(albumId)] = albumData;
    this.saveData();
  }

  async getAlbum(albumId: string): Promise<any> {
    return this.data.albums ? this.data.albums[albumId] : null;
  }

  // 推荐标签相关方法
  async getRecommendedTags(): Promise<string[]> {
    return this.data.recommendedTags || [];
  }

  async saveRecommendedTags(tags: string[]): Promise<void> {
    this.data.recommendedTags = tags;
    this.saveData();
  }

  async getUserAlbums(userId: number): Promise<any[]> {
    if (!this.data.albums) return [];
    return Object.values(this.data.albums)
      .filter((album: any) => album.userId === userId)
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async deleteAlbum(albumId: string): Promise<void> {
    if (this.data.albums && this.data.albums[albumId]) {
      delete this.data.albums[albumId];
      this.saveData();
    }
  }

  async getExpiredAlbums(days: number = 3): Promise<any[]> {
    if (!this.data.albums) return [];
    const now = new Date().getTime();
    const expiryMs = days * 24 * 60 * 60 * 1000;
    
    return Object.values(this.data.albums).filter((album: any) => {
      const createdTime = new Date(album.createdAt).getTime();
      return (now - createdTime) > expiryMs;
    });
  }

  async getAllAlbums(): Promise<any[]> {
    if (!this.data.albums) return [];
    return Object.values(this.data.albums)
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async close(): Promise<void> {
    // 简单实现：不做任何操作
  }

}
