export interface MediaItem {
  id: number;
  keyword: string;
  file_id: string;
  file_type: 'photo' | 'video' | 'document' | 'audio' | 'voice' | 'animation' | 'video_note';
  caption?: string;
  caption_overridden?: boolean; // 替换后不能从旧金库消息恢复过期文案
  channel_id?: string;
  uploaded_by: number;
  uploaded_at: string;
  is_published: boolean;
  published_at?: string; // 发布到频道的时间（发布模式/保存并发布时写入）
  batchId?: string; // 🚀 新增：批次标识，用于隔离同一关键词下的不同资料组
  is_review?: boolean; // 🚀 新增：是否为好评图（仅在好评库中显示）
  // 🚀 终极保险：永久坐标，用于换 Token 后的全自动复活
  source_chat_id?: string; // 原始频道或收藏夹的 ID
  source_msg_id?: number;  // 消息在原始频道里的 ID
  // 水印迁移状态。保留原坐标，便于审计及未来回滚。
  watermarked?: boolean;
  watermark_version?: number;
  watermarked_at?: string;
  original_file_id?: string;
  original_source_chat_id?: string;
  original_source_msg_id?: number;
  upload_key?: string;
}

export interface AlbumGroup {
  id: string;
  caption?: string;
  files: Array<{ id: string; type: string }>;
}

export interface UserSession {
  userId: number;
  mode: BotMode;
  currentKeyword?: string;
  pendingMedia?: any[];
  pendingText?: string;
  selectedChannel?: string;
  // 多选目标。selectedChannel 保留为首个目标，兼容已有会话和旧发布记录。
  selectedChannels?: string[];
  targetUserId?: number;
  targetUserDisplay?: string;
  pendingButtonData?: {
    messageContent?: any;
    messageType?: string;
    buttons: Array<{ text: string; url: string }>;
    tempButtonText?: string;
  };
  pendingJoinWelcomeData?: {
    messageContent?: any;
    messageType?: string;
    buttons: Array<{ text: string; url: string }>;
    tempButtonText?: string;
  };
  // 相册相关字段
  albumGroups?: any[];
  pendingAlbumMedia?: any[];
  albumName?: string;
  step: 'idle' | 'waiting_keyword' | 'waiting_media' | 'waiting_text' | 'waiting_channel' | 'confirming' | 'selecting_channel' | 'adding_channel' | 'adding_source_channel' | 'chatting' | 'waiting_photo' | 'waiting_video' | 'waiting_document' | 'waiting_message' | 'waiting_button_text' | 'waiting_button_url' | 'waiting_button_target' | 'waiting_join_welcome_message' | 'waiting_join_welcome_button_text' | 'waiting_join_welcome_button_url' | 'waiting_direct_send_target' | 'waiting_album_name' | 'waiting_album_auth_id';
}

export interface BotConfig {
  botToken: string;
  superAdminId: number;
  channelIds: string[];
  databasePath: string;
  // 🚀 新增：持久化存储配置
  persistentChannelId?: string; // 持久化频道 ID
  persistentGroupId?: string;   // 关联群组 ID（用于 UserBot 监听同步）
}

export enum BotMode {
  Search = 'search',
  Upload = 'upload',
  Publish = 'publish',
  Chat = 'chat',
  AddingSourceChannel = 'adding_source_channel',
  AddingTargetChannel = 'adding_target_channel',
  Broadcast = 'broadcast',
  ButtonMaker = 'button_maker',
  JoinWelcome = 'join_welcome',
  SendDataToUser = 'send_data_to_user',
  AlbumMaker = 'album_maker',
  TagFilter = 'tag_filter',
  BroadcastData = 'broadcast_data',
  AddReview = 'add_review',
}

export interface TagFilterSession extends UserSession {
  lastTag?: string;
}

export interface UserPermission {
  user_id: number;
  type: PermissionType;
  granted_at: string;
  expires_at?: string; // 🚀 新增：过期时间
}

export type PermissionType = 'free' | 'monthly' | 'quarterly' | 'half_year' | 'lifetime'; // 🚀 新增 half_year

export interface DatabaseData {
  joinWelcomeConfig?: JoinWelcomeConfig;
  recommendedTags?: string[];
}

export interface JoinWelcomeConfig {
  enabled: boolean;
  messageContent: any;
  messageType: string;
  buttons: Array<{ text: string; url: string }>;
}
