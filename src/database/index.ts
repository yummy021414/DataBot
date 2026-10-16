import { MediaItem, UserPermission, UserSession, PermissionType } from '../types';
import { JsonDatabase } from './json-database';

export class Database {
  private jsonDb: JsonDatabase;

  constructor() {
    // 使用 JSON 数据库替代 SQLite
    this.jsonDb = new JsonDatabase();
  }

  // 媒体相关方法
  async saveMedia(media: Omit<MediaItem, 'id'>): Promise<number> {
    return this.jsonDb.saveMedia(media);
  }

  async getMediaByKeyword(keyword: string, userId?: number): Promise<MediaItem[]> {
    return this.jsonDb.getMediaByKeyword(keyword, userId);
  }

  async getReviewsByKeyword(keyword: string): Promise<MediaItem[]> {
    return this.jsonDb.getReviewsByKeyword(keyword);
  }

  async getKeywordsWithReviews(): Promise<string[]> {
    return this.jsonDb.getKeywordsWithReviews();
  }

  async getAllMedia(userId?: number): Promise<MediaItem[]> {
    return this.jsonDb.getAllMedia(userId);
  }

  async deleteMedia(id: number): Promise<void> {
    return this.jsonDb.deleteMedia(id);
  }

  async rememberSearchGroup(chatId: number, messageIds: number[], items: MediaItem[]): Promise<void> {
    return this.jsonDb.rememberSearchGroup(chatId, messageIds, items);
  }

  async deleteSearchGroup(chatId: number, messageId: number, userId?: number) {
    return this.jsonDb.deleteSearchGroup(chatId, messageId, userId);
  }

  async getSearchGroup(chatId: number, messageId: number, userId?: number) {
    return this.jsonDb.getSearchGroup(chatId, messageId, userId);
  }

  async replaceSearchGroup(chatId: number, messageId: number, userId: number | undefined,
    expected: MediaItem[], replacement: MediaItem[]): Promise<void> {
    return this.jsonDb.replaceSearchGroup(chatId, messageId, userId, expected, replacement);
  }

  async updateMediaPublished(id: number, channelId: string): Promise<void> {
    return this.jsonDb.updateMediaPublished(id, channelId);
  }

  async getPublishedKeywordsByTimeRange(
    userId: number,
    start: Date,
    end: Date,
    channelIds?: string[]
  ): Promise<Array<{ keyword: string; publishedAt: string; channelId?: string; legacy?: boolean; fallback?: boolean; matchBy?: string }>> {
    return this.jsonDb.getPublishedKeywordsByTimeRange(userId, start, end, channelIds);
  }

  async getPublishExtractStats(userId: number, channelIds?: string[]) {
    return this.jsonDb.getPublishExtractStats(userId, channelIds);
  }

  async updateMediaSource(
    id: number,
    chatId: string,
    msgId: number,
    options?: { force?: boolean }
  ): Promise<void> {
    return this.jsonDb.updateMediaSource(id, chatId, msgId, options);
  }

  async updateMediaFileId(id: number, fileId: string, fileType?: MediaItem['file_type']): Promise<void> {
    return this.jsonDb.updateMediaFileId(id, fileId, fileType);
  }

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
    return this.jsonDb.updateMediaWatermark(id, update);
  }

    async updateMediaWatermarkBatch(updates: Array<{
      id: number; fileId: string; version: number; sourceChatId: string; sourceMsgId: number; expectedFileId?: string;
    }>): Promise<void> {
      return this.jsonDb.updateMediaWatermarkBatch(updates);
    }

    async batchUpdateMediaFileIds(
    updates: Array<{ id: number; fileId: string; fileType?: MediaItem['file_type'] }>
  ): Promise<number> {
    return this.jsonDb.batchUpdateMediaFileIds(updates);
  }

  async getMediaCount(userId?: number): Promise<number> {
    return this.jsonDb.getMediaCount(userId);
  }

  async cleanInvalidMedia(): Promise<number> {
    return this.jsonDb.cleanInvalidMedia();
  }

  // 用户权限相关方法
  async getUserPermissions(userId: number): Promise<UserPermission[]> {
    return this.jsonDb.getUserPermissions(userId);
  }

  async grantUserPermission(userId: number, type: PermissionType, days?: number): Promise<void> {
    return this.jsonDb.addUserPermission(userId, type, days);
  }

  async checkAlbumAccess(userId: number): Promise<{ hasAccess: boolean; status: string; remainingDays?: number }> {
    return this.jsonDb.checkAlbumAccess(userId);
  }

  async revokeUserPermission(userId: number, type: string): Promise<void> {
    return this.jsonDb.revokeUserPermission(userId, type);
  }

  async getAllUserPermissions(): Promise<UserPermission[]> {
    return this.jsonDb.getAllUserPermissions();
  }

  async getExpiringUsers(): Promise<any[]> {
    return this.jsonDb.getExpiringUsers();
  }

  async markReminderSent(userId: number): Promise<void> {
    return this.jsonDb.markReminderSent(userId);
  }

  // 用户会话相关方法
  async saveUserSession(userId: number, session: UserSession): Promise<void> {
    return this.jsonDb.saveUserSession(userId, session);
  }

  async getUserSession(userId: number): Promise<UserSession | null> {
    return this.jsonDb.getUserSession(userId);
  }

  async clearUserSession(userId: number): Promise<void> {
    return this.jsonDb.clearUserSession(userId);
  }

  async trackUser(userId: number, first_name?: string, last_name?: string, username?: string): Promise<void> {
    return this.jsonDb.trackUser(userId, first_name, last_name, username);
  }

  async removeUser(userId: number): Promise<void> {
    return this.jsonDb.removeUser(userId);
  }

  async getChatUsers(): Promise<any[]> {
    return this.jsonDb.getChatUsers();
  }

  async saveChatMessage(userId: number, messageId: number, content: string): Promise<void> {
    return this.jsonDb.saveChatMessage(userId, messageId, content);
  }

  async getAllActiveUsers(): Promise<any[]> {
    return this.jsonDb.getAllActiveUsers();
  }

  async getKeywordCount(): Promise<number> {
    return this.jsonDb.getKeywordCount();
  }

  async getJoinWelcomeConfig(): Promise<any> {
    return this.jsonDb.getJoinWelcomeConfig();
  }

  async saveJoinWelcomeConfig(config: any): Promise<void> {
    return this.jsonDb.saveJoinWelcomeConfig(config);
  }

  async getManagedChannels(): Promise<string[]> {
    return this.jsonDb.getManagedChannels();
  }

  async addManagedChannel(channelId: string): Promise<void> {
    return this.jsonDb.addManagedChannel(channelId);
  }

  async removeManagedChannel(channelId: string): Promise<boolean> {
    return this.jsonDb.removeManagedChannel(channelId);
  }

  async saveAlbum(albumId: string, albumData: any): Promise<void> {
    return this.jsonDb.saveAlbum(albumId, albumData);
  }

  async getAlbum(albumId: string): Promise<any> {
    return this.jsonDb.getAlbum(albumId);
  }

  async getRecommendedTags(): Promise<string[]> {
    return this.jsonDb.getRecommendedTags();
  }

  async saveRecommendedTags(tags: string[]): Promise<void> {
    return this.jsonDb.saveRecommendedTags(tags);
  }

  async getUserAlbums(userId: number): Promise<any[]> {
    return this.jsonDb.getUserAlbums(userId);
  }

  async getAllAlbums(): Promise<any[]> {
    return this.jsonDb.getAllAlbums();
  }

  async deleteAlbum(albumId: string): Promise<void> {
    return this.jsonDb.deleteAlbum(albumId);
  }

  async getExpiredAlbums(days: number = 3): Promise<any[]> {
    return this.jsonDb.getExpiredAlbums(days);
  }

  async close(): Promise<void> {
    return this.jsonDb.close();
  }

  // 添加缺失的方法
  async checkUserPermission(userId: number): Promise<boolean> {
    return this.jsonDb.checkUserPermission(userId);
  }

  async searchMedia(keyword: string, userId?: number, limit?: number): Promise<MediaItem[]> {
    return this.jsonDb.searchMedia(keyword, userId, limit);
  }

  async getMediaStats(): Promise<any> {
    return this.jsonDb.getMediaStats();
  }

  async getAllKeywords(userId?: number): Promise<string[]> {
    return this.jsonDb.getAllKeywords(userId);
  }

  async keywordExists(keyword: string, userId?: number): Promise<boolean> {
    return this.jsonDb.keywordExists(keyword, userId);
  }

  async deleteKeyword(keyword: string, userId?: number): Promise<number> {
    return this.jsonDb.deleteKeyword(keyword, userId);
  }

  async getUserCount(): Promise<number> {
    return this.jsonDb.getUserCount();
  }

  async getUserInfo(userId: number): Promise<any> {
    return this.jsonDb.getUserInfo(userId);
  }

  async startAlbumTrial(userId: number): Promise<void> {
    return this.jsonDb.startAlbumTrial(userId);
  }

  async grantAlbumAuth(userId: number, months: number): Promise<void> {
    return this.jsonDb.grantAlbumAuth(userId, months);
  }

  async saveImmediately(): Promise<void> {
    return this.jsonDb.saveImmediately();
  }
}

// 创建数据库实例
export const database = new Database();
