const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'search-pacing-'));
process.chdir(temp);
Object.assign(process.env, { DATABASE_PATH: path.join(temp, 'bot.json'), BOT_TOKEN: 'offline' });
const { SearchHandler } = require('../dist/bot/handlers/SearchHandler');
(async () => {
  const calls = [], recorded = [];
  const items = Array.from({ length: 12 }, (_, id) => ({ id, file_id: String(id), file_type: 'photo', caption: id === 0 ? '文案' : '' }));
  const ctx = { chat: { id: 1 }, replyWithMediaGroup: async media => {
    calls.push({ at: Date.now(), media });
    if (calls.length === 1) await new Promise(resolve => setTimeout(resolve, 1200));
    return media.map(m => ({ message_id: Number(m.media) + 1 }));
  } };
  await SearchHandler.sendMediaGroups(ctx, { photo: items }, true, async messages => recorded.push(...messages));
  assert.deepEqual(calls.map(c => c.media.length), [10, 2]);
  assert.deepEqual(calls.flatMap(c => c.media.map(m => m.media)), items.map(m => m.file_id));
  assert.equal(calls.flatMap(c => c.media).filter(m => m.caption).length, 1);
  assert.equal(recorded.length, 12);
  assert(calls[1].at - calls[0].at < 2400, 'Slow API requests must not be followed by an extra fixed two-second delay');
  console.log('PASS: search album batching, order, caption, reply references, no stacked fixed delay');
})().catch(error => { console.error(error); process.exitCode = 1; });
