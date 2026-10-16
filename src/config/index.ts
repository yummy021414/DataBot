import dotenv from 'dotenv';
import path from 'path';
import { BotConfig } from '../types';

dotenv.config();

export const config: BotConfig = {
  // 必须从 .env 读取，不要在代码里写真实 Token / ID
  botToken: process.env.BOT_TOKEN || '',
  superAdminId: parseInt(process.env.SUPER_ADMIN_ID || '0', 10),
  channelIds: (process.env.CHANNEL_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean),
  databasePath: process.env.DATABASE_PATH || path.resolve(__dirname, '..', '..', 'data', 'bot.db'),
  persistentChannelId: process.env.PERSISTENT_CHANNEL_ID,
  persistentGroupId: process.env.PERSISTENT_GROUP_ID
};

const parseBoolean = (value: string | undefined, fallback = false): boolean => {
  if (value == null || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const parseNumber = (value: string | undefined, fallback: number, min: number, max: number): number => {
  if (value == null || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

/** 媒体水印配置。默认关闭，避免未配置文案时意外改写已有资料。 */
export const watermarkConfig = {
  enabled: parseBoolean(process.env.WATERMARK_ENABLED, false),
  text: (process.env.WATERMARK_TEXT || '').trim(),
  ffmpegPath: (process.env.FFMPEG_PATH || 'ffmpeg').trim(),
  fontFile: (process.env.WATERMARK_FONT_FILE || '').trim(),
  tempDir: (process.env.WATERMARK_TEMP_DIR || '').trim(),
  maxInputMb: parseNumber(process.env.WATERMARK_MAX_INPUT_MB, 2000, 20, 2000),
  opacity: parseNumber(process.env.WATERMARK_OPACITY, 0.35, 0.05, 1),
  videoPeriodSeconds: parseNumber(process.env.WATERMARK_VIDEO_PERIOD_SECONDS, 8, 2, 60),
  videoCrf: Math.round(parseNumber(process.env.WATERMARK_VIDEO_CRF, 23, 16, 35)),
  videoPreset: (process.env.WATERMARK_VIDEO_PRESET || 'veryfast').trim(),
  ffmpegThreads: Math.round(parseNumber(process.env.WATERMARK_FFMPEG_THREADS, 1, 1, 8)),
  jobTimeoutSeconds: Math.round(parseNumber(process.env.WATERMARK_JOB_TIMEOUT_SECONDS, 3600, 60, 21600)),
  version: Math.round(parseNumber(process.env.WATERMARK_VERSION, 1, 1, 9999))
};

if (!config.botToken) {
  console.warn('⚠️ 未配置 BOT_TOKEN，请在 .env 中填写后再启动');
}

const parseIdList = (raw: string): number[] =>
  raw
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
    .map(id => parseInt(id, 10))
    .filter(n => !Number.isNaN(n));

// 格式: "管理员ID=频道1,频道2;管理员ID=频道3"
const parseAdminChannelMap = (raw: string): Record<string, string[]> => {
  const result: Record<string, string[]> = {};
  raw
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .forEach(part => {
      const [adminIdRaw, channelsRaw] = part.split('=');
      const adminId = (adminIdRaw || '').trim();
      if (!adminId || !channelsRaw) return;
      const channels = channelsRaw
        .split(',')
        .map(c => c.trim())
        .filter(Boolean);
      if (channels.length > 0) {
        result[adminId] = channels;
      }
    });
  return result;
};

const parseAdminPersistentMap = (raw: string): Record<string, string> => {
  const result: Record<string, string> = {};
  raw
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .forEach(part => {
      const [adminIdRaw, channelIdRaw] = part.split('=');
      const adminId = (adminIdRaw || '').trim();
      const channelId = (channelIdRaw || '').trim();
      if (adminId && channelId) {
        result[adminId] = channelId;
      }
    });
  return result;
};

export const secondaryAdminIds: number[] = parseIdList(process.env.ADMIN_IDS || '');
export const adminIds: number[] = Array.from(
  new Set([config.superAdminId, ...secondaryAdminIds])
);

const adminChannelMap = parseAdminChannelMap(process.env.ADMIN_CHANNEL_MAP || '');
const adminPersistentChannelMap = parseAdminPersistentMap(process.env.ADMIN_PERSISTENT_CHANNEL_MAP || '');

export const isAdminUser = (userId: number): boolean => adminIds.includes(userId);
export const isSuperAdmin = (userId: number): boolean => userId === config.superAdminId;

export const getAdminChannelIds = (userId: number): string[] => {
  const scopedChannels = adminChannelMap[String(userId)];
  if (scopedChannels && scopedChannels.length > 0) {
    return scopedChannels;
  }
  return config.channelIds;
};

/** 是否配置了该管理员的独立频道映射（ADMIN_CHANNEL_MAP） */
export const hasAdminChannelMap = (userId: number): boolean => {
  const scoped = adminChannelMap[String(userId)];
  return Boolean(scoped && scoped.length > 0);
};

export const getAdminPersistentChannelId = (userId: number): string | undefined =>
  adminPersistentChannelMap[String(userId)] || config.persistentChannelId;

// 授权用户列表：来自环境变量 AUTHORIZED_USERS（逗号分隔），并且自动包含超级管理员
const envAuthorized = parseIdList(process.env.AUTHORIZED_USERS || '');

export const authorizedUsers: number[] = Array.from(
  new Set([...adminIds, ...envAuthorized])
);

// Telegram 公共 API 凭证（用于用户账号登录）
// 这些是 Telethon/GramJS 官方提供的测试凭证，完全可以使用
export const DEFAULT_API_CREDENTIALS = {
  API_ID: '6',
  API_HASH: 'eb06d4abfb49dc3eeb1aeb98ae0f581e'
};

export const BOT_COMMANDS = {
  START: 'start',
  SEARCH: 'search',
  UPLOAD: 'upload',
  PUBLISH: 'publish',
  HELP: 'help',
  ADMIN: 'admin'
} as const;

export const BUTTONS = {
  // 核心功能键盘按钮 (普通用户可见)
  SEARCH_DATA: '🔍 搜索资料',
  UPLOAD_DATA: '📁 上传资料',
  VIEW_KEYWORDS: '🗂️ 查看关键词',
  CHAT_WITH_ADMIN: '💬 联系管理员',
  HELP: 'ℹ️ 帮助',
  
  // 管理员功能键盘按钮
  PUBLISH_CONTENT: '🚀 发布内容',
  VIEW_DATA: '📄 查看资料',
  CHANNEL_MANAGE: '🏢 频道管理',
  BUTTON_MAKER: '🔘 按钮制作',
  PERMISSION_MANAGE: '🔐 权限管理',
  BROADCAST_MESSAGE: '📢 群发消息',
  KEYWORD_OPTIMIZE: '🔧 关键词优化',
  APPROVAL: '📝 申请审批',
  
  // 权限管理按钮
  GRANT_MONTHLY: '📅 授权1个月',
  GRANT_QUARTERLY: '📅 授权3个月',
  REVOKE_PERMISSION: '🚫 撤销权限',
  VIEW_PERMISSIONS: '📋 查看权限',
  
  // 内联按钮
  BACK_TO_MAIN: '⬅️ 返回主菜单',
  CANCEL: '❌ 取消',
  CONFIRM: '✅ 确认',
  SAVE_ONLY: '💾 仅保存',
  SAVE_AND_PUBLISH: '💾📢 保存并发布'
} as const;
