const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
Object.assign(process.env, { BOT_TOKEN: 'offline', SUPER_ADMIN_ID: '1', ADMIN_IDS: '2',
  DATABASE_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recent-search-')), 'bot.db') });
const { database: db, Database } = require('../dist/database');
const { RecentSearchHandler } = require('../dist/bot/handlers/RecentSearchHandler');
const { SearchHandler } = require('../dist/bot/handlers/SearchHandler');
let calls = [], msgId = 100;
function ctx(id, data = 'recent_searches') {
  return { from: { id }, chat: { id }, callbackQuery: { data },
    reply: async (text, extra) => { calls.push({ text, extra }); },
    editMessageText: async (text, extra) => { calls.push({ text, extra }); },
    answerCbQuery: async text => { if (text) calls.push({ text }); },
    replyWithPhoto: async () => ({ message_id: ++msgId }) };
}
const buttons = () => calls.at(-1).extra.reply_markup.inline_keyboard.flat();
(async () => {
  const media = (keyword, owner = 1) => ({ keyword, uploaded_by: owner, file_id: keyword,
    file_type: 'photo', uploaded_at: new Date().toISOString(), batchId: keyword, is_published: false });
  for (const k of ['热门', '新近', '较早', '过期', '子管理员', '长'.repeat(40)]) await db.saveMedia(media(k, k === '子管理员' ? 2 : 1));
  const now = Date.now();
  await db.recordKeywordSearch(1, '过期', now - 31 * 86400000);
  await db.recordKeywordSearch(1, '热门', now - 86400000);
  await db.recordKeywordSearch(1, '热门', now - 80000);
  await db.recordKeywordSearch(1, '较早', now - 40000);
  await db.recordKeywordSearch(1, '新近', now - 10000);
  await db.recordKeywordSearch(2, '子管理员', now);
  await db.recordKeywordSearch(2, '热门', now);
  assert.deepEqual((await db.getRecentSearches(1)).map(e => e.keyword), ['热门', '新近', '较早']);
  assert.deepEqual((await db.getRecentSearches(2, 2)).map(e => e.keyword), ['子管理员']);
  assert.deepEqual(await db.getRecentSearches(3, 1), []);
  await db.saveImmediately();
  const reloaded = new Database();
  assert.equal((await reloaded.getRecentSearches(1))[0].count, 2);
  await RecentSearchHandler.handle(ctx(1), db);
  const first = buttons().find(b => b.text.includes('热门'));
  assert(first.text.includes('2次'));
  await RecentSearchHandler.handle(ctx(2, first.callback_data), db);
  assert.match(calls.at(-1).text, /其他用户/);
  await RecentSearchHandler.handle(ctx(1, first.callback_data), db);
  assert.equal((await db.getRecentSearches(1))[0].count, 3);
  await SearchHandler.handleSearch(ctx(3), '未找到的词', db);
  assert.equal((await db.getRecentSearches(3, 1)).length, 0);
  await db.recordKeywordSearch(1, '长'.repeat(40), now);
  for (let i = 0; i < 61; i++) {
    await db.saveMedia(media('分页' + i));
    await db.recordKeywordSearch(1, '分页' + i, now);
  }
  await RecentSearchHandler.handle(ctx(1), db);
  assert.equal(buttons().filter(b => b.callback_data.includes(':view:')).length, 60);
  assert(buttons().every(b => Buffer.byteLength(b.callback_data) <= 64));
  const next = buttons().find(b => b.text.includes('下一页'));
  await RecentSearchHandler.handle(ctx(1, next.callback_data), db);
  assert(buttons().some(b => b.text.includes('上一页')));
  await db.deleteKeyword('热门', 1);
  assert(!(await db.getRecentSearches(1)).some(e => e.keyword === '热门'));
  await RecentSearchHandler.handle(ctx(1, first.callback_data), db);
  assert.match(calls.at(-1).text, /已失效/);
  await db.saveImmediately();
  console.log('PASS recent search: frequency, recency tie-break, 30-day expiry, per-user visibility, permissions, persistence, click counting, missing results, pagination, long keywords and deleted records');
})().catch(e => { console.error(e); process.exitCode = 1; });
