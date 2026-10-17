const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-progress-'));
process.chdir(temp);
Object.assign(process.env, { DATABASE_PATH: path.join(temp, 'bot.json'), BOT_TOKEN: 'offline' });
const { PublishHandler } = require('../dist/bot/handlers/PublishHandler');
const { SearchHandler } = require('../dist/bot/handlers/SearchHandler');

(async () => {
  const events = [];
  const session = { mode: 'publish', selectedChannels: ['target'], step: 'waiting_keyword' };
  const db = {
    getAllKeywords: async () => ['甲', '乙'],
    getMediaByKeyword: async keyword => [1, 2].map(id => ({ id, keyword, uploaded_by: 1, batchId: String(id), file_type: 'photo', file_id: String(id) })),
    updateMediaPublished: async () => {}, saveUserSession: async () => {}
  };
  SearchHandler.parseSearchKeywords = () => ['甲', '乙'];
  PublishHandler.publishToChannel = async (bot, channel, items, keyword) => {
    events.push(`send:${keyword}`);
    const notice = events.findIndex(e => e.includes(`正在发布「${keyword}」`));
    assert(notice >= 0 && notice < events.length - 1, 'Current keyword must be shown before its first media send');
    return items.length;
  };
  const bot = { telegram: { getChat: async () => ({ title: '测试目标' }) } };
  const ctx = { reply: async text => { events.push(text); } };
  await PublishHandler.runPublishJob(ctx, '甲 乙', session, new Map([[1, session]]), db, bot, 1, 1);
  assert(events.some(e => e.includes('正在发布「甲」（1/2）：2 个文件 / 2 组')));
  assert(events.some(e => e.includes('正在发布「乙」（2/2）：2 个文件 / 2 组')));
  assert(events.at(-1).includes('发布完成'));
  // A failed progress notification must not prevent publication.
  events.length = 0;
  await PublishHandler.runPublishJob({ reply: async text => {
    events.push(text);
    if (text.includes('正在发布「')) throw new Error('mock notification failure');
  } }, '甲 乙', session, new Map([[1, session]]), db, bot, 1, 1);
  assert.equal(events.filter(e => e.startsWith('send:')).length, 2);
  assert(events.at(-1).includes('发布完成'));
  console.log('PASS: per-keyword progress before sending, correct group counts, final summary, notification failure isolation');
})().catch(error => { console.error(error); process.exitCode = 1; });
