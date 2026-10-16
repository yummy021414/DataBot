#!/usr/bin/env node
'use strict';

// 默认仅预演；--apply 才会发送。断点文件按“频道分段/评论分段”记录，
// 中断后再次运行不会重发已完成的分段。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const argv = process.argv.slice(2);
const flags = new Set(argv);
const arg = (name, fallback) => argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const APPLY = flags.has('--apply');
const PREFLIGHT = flags.has('--preflight');
const JOIN = flags.has('--join');
const LIMIT = Math.max(0, Number(arg('limit', '0')) || 0);
const CHANNEL_ID = String(arg('channel', '-1001946547227'));
const DATA_DIR = path.resolve(arg('data-dir', path.join(process.cwd(), 'data')));
const DB_PATH = path.join(DATA_DIR, 'bot.json');
const ACCOUNT_PATH = path.join(DATA_DIR, 'user_accounts.json');
const STATE_PATH = path.join(DATA_DIR, `review-channel-${CHANNEL_ID.replace(/\D/g, '')}.checkpoint.json`);
const DELAY_MS = Math.max(1000, Number(arg('delay-ms', '4500')) || 4500);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function atomicWrite(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function batches(items) {
  const grouped = new Map();
  for (const item of items) {
    const id = String(item.batchId || `legacy_${item.id}`);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(item);
  }
  return [...grouped].map(([id, list]) => ({ id, items: list }));
}

function makePlan(db) {
  const media = db.media || [];
  const keywordOrder = [];
  const seen = new Set();
  for (const item of media) {
    const keyword = String(item.keyword || '');
    if (item.is_review && !seen.has(keyword)) {
      seen.add(keyword);
      keywordOrder.push(keyword);
    }
  }
  const byKeyword = keywordOrder.map(keyword => ({
    keyword,
    regular: batches(media.filter(x => !x.is_review && String(x.keyword || '') === keyword)),
    reviews: media.filter(x => x.is_review && String(x.keyword || '') === keyword)
  }));
  for (const item of byKeyword) if (!item.regular.length) throw new Error(`关键词“${item.keyword}”没有普通资料`);

  const plan = [];
  const rounds = Math.max(0, ...byKeyword.map(x => x.reviews.length));
  for (let round = 0; round < rounds; round += 1) {
    for (const item of byKeyword) {
      const review = item.reviews[round];
      if (!review) continue;
      const regular = item.regular[round % item.regular.length];
      plan.push({
        id: digest([item.keyword, review.id, review.file_id]).slice(0, 20), keyword: item.keyword, round: round + 1,
        regularBatchId: regular.id, reviewBatchId: String(review.batchId || `legacy_${review.id}`),
        regularItems: regular.items, reviewItems: [review]
      });
    }
  }
  return plan;
}

function planSummary(plan) {
  const reused = plan.filter((unit, i) => plan.slice(0, i).some(old =>
    old.keyword === unit.keyword && old.regularBatchId === unit.regularBatchId));
  return {
    units: plan.length, keywords: new Set(plan.map(x => x.keyword)).size,
    regularFiles: plan.reduce((n, x) => n + x.regularItems.length, 0),
    reviewFiles: plan.reduce((n, x) => n + x.reviewItems.length, 0),
    rounds: Math.max(0, ...plan.map(x => x.round)), reusedRegularKeywords: reused.map(x => x.keyword)
  };
}

function getToken() {
  if (process.env.BOT_TOKEN) return process.env.BOT_TOKEN;
  try { return require('../dist/config').config.botToken; } catch { return ''; }
}

async function botApi(token, method, body = {}, attempt = 0) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
  } catch (error) {
    if (attempt < 6) {
      await sleep(Math.min(30, 2 ** attempt) * 1000);
      return botApi(token, method, body, attempt + 1);
    }
    throw error;
  }
  const result = await response.json();
  if (result.ok) return result.result;
  const retry = Number(result.parameters?.retry_after) || 0;
  if (attempt < 6 && (retry || response.status >= 500)) {
    await sleep((retry ? retry + 1 : Math.min(30, 2 ** attempt)) * 1000);
    return botApi(token, method, body, attempt + 1);
  }
  throw new Error(`${method}: ${result.error_code || response.status} ${result.description || 'API error'}`);
}

async function fetchFile(url, attempt = 0) {
  try {
    const response = await fetch(url);
    if (response.ok) return response;
    if (attempt < 6 && response.status >= 500) {
      await sleep(Math.min(30, 2 ** attempt) * 1000);
      return fetchFile(url, attempt + 1);
    }
    throw new Error(`好评图下载失败 HTTP ${response.status}`);
  } catch (error) {
    if (attempt < 6) {
      await sleep(Math.min(30, 2 ** attempt) * 1000);
      return fetchFile(url, attempt + 1);
    }
    throw error;
  }
}

async function connectUser() {
  const account = (read(ACCOUNT_PATH).accounts || []).find(x => x.is_active);
  if (!account?.session || !account.api_id || !account.api_hash) throw new Error('没有有效的激活个人账号');
  const client = new TelegramClient(new StringSession(account.session), Number(account.api_id), account.api_hash, {
    connectionRetries: 5, retryDelay: 1000, autoReconnect: true
  });
  await client.connect();
  if (!await client.isUserAuthorized()) throw new Error('个人账号会话已失效');
  return { client, account: { id: account.id, nickname: account.nickname } };
}

async function resolveChannel(token, client, allowJoin) {
  try {
    return await client.getEntity(CHANNEL_ID);
  } catch (error) {
    if (!allowJoin) throw error;
    const channel = await botApi(token, 'getChat', { chat_id: CHANNEL_ID });
    const invite = String(channel.invite_link || '');
    const inviteHash = invite.match(/(?:joinchat\/|\+)([^/?]+)/)?.[1];
    if (!inviteHash) throw new Error('个人账号不在目标频道，且机器人无法取得可用邀请链接');
    const joined = await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash }));
    const targetId = CHANNEL_ID.replace('-100', '');
    const entity = (joined.chats || []).find(chat => String(chat.id) === targetId);
    return entity || client.getEntity(CHANNEL_ID);
  }
}

async function preflight(token, client, allowJoin) {
  const me = await botApi(token, 'getMe');
  const channel = await botApi(token, 'getChat', { chat_id: CHANNEL_ID });
  const member = await botApi(token, 'getChatMember', { chat_id: CHANNEL_ID, user_id: me.id });
  if (channel.type !== 'channel' || !channel.linked_chat_id) throw new Error('目标频道没有关联评论群');
  if (!['administrator', 'creator'].includes(member.status) || member.can_post_messages === false) throw new Error('机器人没有频道发帖权限');
  const entity = await resolveChannel(token, client, allowJoin);
  const latest = await client.getMessages(entity, { limit: 20 });
  const inputEntity = await client.getInputEntity(entity);
  let discussionReadable = false;
  for (const message of latest) {
    try {
      await client.invoke(new Api.messages.GetDiscussionMessage({ peer: inputEntity, msgId: message.id }));
      discussionReadable = true;
      break;
    } catch (error) {
      if (!['MSG_ID_INVALID', 'TOPIC_ID_INVALID'].includes(error?.errorMessage)) throw error;
    }
  }
  const user = await client.getMe();
  return { bot: `@${me.username || me.id}`, channel: channel.title,
    linkedChatId: String(channel.linked_chat_id), user: user.username ? `@${user.username}` : String(user.id),
    discussionReadable };
}

function regularSegments(items) {
  const caption = items.find(x => x.caption?.trim())?.caption || '';
  const groups = [
    ['visual', items.filter(x => ['photo', 'video', 'animation'].includes(x.file_type)), 10],
    ['document', items.filter(x => x.file_type === 'document'), 10],
    ['audio', items.filter(x => x.file_type === 'audio'), 10],
    ['single', items.filter(x => ['voice', 'video_note'].includes(x.file_type)), 1]
  ];
  const result = [];
  let captionUsed = false;
  for (const [name, list, size] of groups) {
    for (let start = 0; start < list.length; start += size) {
      result.push({ key: `${name}:${start}`, items: list.slice(start, start + size), caption: captionUsed ? '' : caption });
      captionUsed = true;
    }
  }
  return result;
}

async function sendRegular(token, segment) {
  if (segment.items.length > 1) return botApi(token, 'sendMediaGroup', {
    chat_id: CHANNEL_ID,
    media: segment.items.map((item, index) => ({
      type: item.file_type === 'animation' ? 'video' : item.file_type,
      media: item.file_id,
      ...(index === 0 && segment.caption ? { caption: segment.caption } : {})
    }))
  });
  const item = segment.items[0];
  const common = { chat_id: CHANNEL_ID, caption: segment.caption || undefined };
  const calls = {
    photo: ['sendPhoto', { ...common, photo: item.file_id }],
    video: ['sendVideo', { ...common, video: item.file_id }],
    animation: ['sendAnimation', { ...common, animation: item.file_id }],
    document: ['sendDocument', { ...common, document: item.file_id }],
    audio: ['sendAudio', { ...common, audio: item.file_id }],
    voice: ['sendVoice', { ...common, voice: item.file_id }],
    video_note: ['sendVideoNote', { chat_id: CHANNEL_ID, video_note: item.file_id }]
  };
  const call = calls[item.file_type];
  if (!call) throw new Error(`不支持的媒体类型 ${item.file_type}`);
  return [await botApi(token, call[0], call[1])];
}

async function downloadReviews(token, items) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-comment-'));
  const files = [];
  try {
    for (let index = 0; index < items.length; index += 1) {
      const info = await botApi(token, 'getFile', { file_id: items[index].file_id });
      const response = await fetchFile(`https://api.telegram.org/file/bot${token}/${info.file_path}`);
      const ext = path.extname(info.file_path || '') || '.jpg';
      const file = path.join(dir, `${String(index + 1).padStart(2, '0')}${ext}`);
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      files.push(file);
    }
    return { dir, files };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

async function floodRetry(operation, attempt = 0) {
  try { return await operation(); } catch (error) {
    const seconds = Number(error?.seconds || String(error?.errorMessage || '').match(/FLOOD_WAIT_(\d+)/)?.[1]) || 0;
    if (attempt < 6 && seconds) {
      console.log(`RATE_LIMIT wait=${seconds + 2}s`);
      await sleep((seconds + 2) * 1000);
      return floodRetry(operation, attempt + 1);
    }
    if (attempt < 8 && ['MSG_ID_INVALID', 'TOPIC_ID_INVALID'].includes(error?.errorMessage)) {
      const wait = Math.min(12, 2 + attempt * 2);
      console.log(`DISCUSSION_WAIT wait=${wait}s`);
      await sleep(wait * 1000);
      return floodRetry(operation, attempt + 1);
    }
    throw error;
  }
}

async function sendReviewChunk(token, client, channel, channelMessageId, items) {
  const temp = await downloadReviews(token, items);
  try {
    const captions = items.map(x => typeof x.caption === 'string' ? x.caption : '');
    const sent = await floodRetry(() => client.sendFile(channel, {
      file: temp.files.length === 1 ? temp.files[0] : temp.files,
      caption: temp.files.length === 1 ? captions[0] : captions,
      commentTo: channelMessageId,
      silent: true,
      workers: 2
    }));
    return (Array.isArray(sent) ? sent : [sent]).map(x => Number(x.id)).filter(Number.isFinite);
  } finally {
    fs.rmSync(temp.dir, { recursive: true, force: true });
  }
}

function loadCheckpoint(plan) {
  const planHash = digest(plan);
  if (fs.existsSync(STATE_PATH)) {
    const value = read(STATE_PATH);
    if (value.channelId !== CHANNEL_ID || value.planHash !== planHash) {
      throw new Error('资料库已变化，断点计划不一致；为避免重发已停止');
    }
    return value;
  }
  const value = { version: 1, channelId: CHANNEL_ID, planHash, createdAt: new Date().toISOString(), units: {} };
  atomicWrite(STATE_PATH, value);
  return value;
}

async function applyPlan(token, client, plan) {
  const state = loadCheckpoint(plan);
  const save = () => {
    state.updatedAt = new Date().toISOString();
    atomicWrite(STATE_PATH, state);
  };
  const channel = await client.getEntity(CHANNEL_ID);
  let completed = Object.values(state.units).filter(x => x.status === 'complete').length;
  let completedThisRun = 0;

  for (let index = 0; index < plan.length; index += 1) {
    const unit = plan[index];
    const progress = state.units[unit.id] ||= {
      keyword: unit.keyword, round: unit.round, channelSegments: {}, reviewChunks: {}, status: 'pending'
    };
    if (progress.status === 'complete') {
      console.log(`SKIP ${index + 1}/${plan.length} keyword=${unit.keyword}`);
      continue;
    }
    try {
      for (const segment of regularSegments(unit.regularItems)) {
        if (progress.channelSegments[segment.key]) continue;
        progress.status = 'sending_channel';
        save();
        const ids = (await sendRegular(token, segment)).map(message => Number(message.message_id));
        progress.channelSegments[segment.key] = ids;
        progress.channelMessageId ||= ids[0];
        progress.status = 'channel_sent';
        save();
      }
      if (!progress.channelMessageId) throw new Error('频道发帖后未取得消息 ID');

      for (let start = 0; start < unit.reviewItems.length; start += 10) {
        const key = `review:${start}`;
        if (progress.reviewChunks[key]) continue;
        progress.status = 'sending_review';
        save();
        progress.reviewChunks[key] = await sendReviewChunk(
          token, client, channel, progress.channelMessageId, unit.reviewItems.slice(start, start + 10)
        );
        save();
      }
      progress.status = 'complete';
      progress.completedAt = new Date().toISOString();
      delete progress.error;
      save();
      completed += 1;
      completedThisRun += 1;
      console.log(`DONE ${completed}/${plan.length} keyword=${unit.keyword} round=${unit.round} regular=${unit.regularItems.length} reviews=${unit.reviewItems.length}`);
      if (LIMIT && completedThisRun >= LIMIT) break;
      if (completed < plan.length) await sleep(DELAY_MS);
    } catch (error) {
      progress.status = progress.channelMessageId ? 'channel_sent' : 'pending';
      progress.error = String(error?.stack || error).slice(0, 2000);
      save();
      console.error(`FAILED ${index + 1}/${plan.length} keyword=${unit.keyword}: ${error?.message || error}`);
      throw error;
    }
  }
  return { complete: completed, total: plan.length, checkpoint: STATE_PATH };
}

async function main() {
  const token = getToken();
  if (!token) throw new Error('BOT_TOKEN 未配置');
  const plan = makePlan(read(DB_PATH));
  const info = planSummary(plan);
  console.log(`PLAN ${JSON.stringify(info)}`);
  const { client, account } = await connectUser();
  try {
    console.log(`PREFLIGHT ${JSON.stringify({ ...(await preflight(token, client, JOIN || APPLY)), account })}`);
    if (PREFLIGHT || !APPLY) {
      for (const unit of plan) {
        console.log(`DRY ${unit.round}/${info.rounds} keyword=${unit.keyword} regular=${unit.regularItems.length} review=${unit.reviewItems.length}`);
      }
      console.log('DRY_RUN_OK');
      return;
    }
    console.log(`ALL_DONE ${JSON.stringify(await applyPlan(token, client, plan))}`);
  } finally {
    await client.disconnect();
  }
}

main().catch(error => {
  console.error(`FATAL ${error?.stack || error}`);
  process.exitCode = 1;
});
