const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-group-'));
Object.assign(process.env, { BOT_TOKEN: 'offline', SUPER_ADMIN_ID: '1', ADMIN_IDS: '',
  DATABASE_PATH: path.join(dir, 'bot.db'), PERSISTENT_CHANNEL_ID: '',
  ADMIN_PERSISTENT_CHANNEL_MAP: '', WATERMARK_ENABLED: 'false' });
const { Database } = require('../dist/database');
const { SearchHandler } = require('../dist/bot/handlers/SearchHandler');
const { ReplaceGroupHandler } = require('../dist/bot/handlers/ReplaceGroupHandler');
const media = [
  ...[1, 2, 3, 4].flatMap(batch => [0, 1].map(n => ({ id: batch * 10 + n,
    keyword: '测试', file_type: n ? 'video' : 'photo', file_id: `file-${batch}-${n}`,
    caption: n ? undefined : '旧文案\n#测试', batchId: `batch-${batch}`, uploaded_by: 1,
    uploaded_at: '2026-01-01T00:00:00.000Z', is_published: false }))),
  { id: 60, keyword: '测试', file_type: 'photo', file_id: 'review', is_review: true,
    uploaded_by: 1, batchId: 'review', uploaded_at: '2026-01-01T00:00:00.000Z' },
  { id: 70, keyword: '测试', file_type: 'photo', file_id: 'other-owner', uploaded_by: 2,
    batchId: 'batch-1', uploaded_at: '2026-01-01T00:00:00.000Z' }
];
const albums = { separate: { name: '独立相册', files: ['untouched'] } };
fs.writeFileSync(path.join(dir, 'bot.json'), JSON.stringify({ media, albums }));
let replies = [], sentId = 100;
function context(user = 1, text = '', replyId) {
  return { from: { id: user }, chat: { id: 99 },
    message: { message_id: ++sentId, text, ...(replyId ? { reply_to_message: { message_id: replyId } } : {}) },
    reply: async (text, extra) => { replies.push({ text, extra }); return { message_id: ++sentId }; },
    editMessageText: async (text, extra) => { replies.push({ text, extra }); },
    answerCbQuery: async () => {},
    replyWithMediaGroup: async items => items.map(() => ({ message_id: ++sentId })),
    replyWithPhoto: async () => ({ message_id: ++sentId }),
    replyWithVideo: async () => ({ message_id: ++sentId }), telegram: {} };
}
async function callback(db, data, user = 1) {
  const ctx = context(user); ctx.callbackQuery = { data };
  await ReplaceGroupHandler.handleCallback(ctx, db);
}
function button(label) {
  return replies.at(-1).extra.reply_markup.inline_keyboard.flat().find(b => b.text === label).callback_data;
}
(async () => {
  let db = new Database();
  // Search records every sent message, including different owners sharing a batch ID.
  await SearchHandler.handleSearch(context(), '测试', db);
  let persisted = JSON.parse(fs.readFileSync(path.join(dir, 'bot.json')));
  assert.equal(Object.keys(persisted.searchReplyGroups).length, 9);
  const reference = (batch, owner = 1) => Number(Object.entries(persisted.searchReplyGroups)
    .find(([, refs]) => refs[0].batchId === batch && refs[0].uploaded_by === owner)[0].split(':')[1]);
  const first = reference('batch-1');
  const second = reference('batch-2');
  const third = reference('batch-3');
  const fourth = reference('batch-4');
  db = new Database(); // References survive restart.
  assert.equal((await db.deleteSearchGroup(99, first, 2)).status, 'forbidden');
  assert.equal((await db.deleteSearchGroup(98, first)).status, 'missing');
  assert.equal((await db.deleteSearchGroup(99, first, 1)).remainingGroups, 3);
  assert.equal((await db.getMediaByKeyword('测试', 1)).length, 6);
  assert.equal((await db.deleteSearchGroup(99, first, 1)).status, 'missing');
  assert.equal((await db.getMediaByKeyword('测试', 2)).length, 1);
  assert.equal((await db.getReviewsByKeyword('测试')).length, 1);

  await ReplaceGroupHandler.handleMessage(context(1, '替换', second), db);
  const captionButton = button('替换文案');
  await callback(db, captionButton, 2); // Another user cannot use the menu.
  await callback(db, captionButton);
  const before = await db.getSearchGroup(99, second);
  await ReplaceGroupHandler.handleMessage(context(1, '新文案'), db);
  let group = await db.getSearchGroup(99, second);
  assert.equal(group[0].caption, '新文案\n#测试');
  assert.deepEqual(group.map(m => m.file_id), before.map(m => m.file_id));
  assert.equal(group.filter(m => m.caption).length, 1);
  assert.equal((await db.getSearchGroup(99, third))[0].caption, '旧文案\n#测试');

  await ReplaceGroupHandler.handleMessage(context(1, '替换', second), db);
  await callback(db, button('替换照片'));
  const save = button('✅ 完成替换');
  for (const file of ['new-photo-a', 'new-photo-b']) {
    const ctx = context(); ctx.message = { message_id: ++sentId, photo: [{ file_id: file }], media_group_id: 'incoming' };
    await ReplaceGroupHandler.handleMessage(ctx, db);
    await ReplaceGroupHandler.handleMessage(ctx, db); // Duplicate update is ignored.
  }
  assert.equal((await db.getSearchGroup(99, second)).length, 2); // No partial replacement.
  await callback(db, save);
  group = await db.getSearchGroup(99, second);
  assert.deepEqual(group.map(m => m.file_id), ['new-photo-a', 'new-photo-b', 'file-2-1']);
  assert.equal(group[0].caption, '新文案\n#测试');
  assert.equal(group.filter(m => m.caption).length, 1);
  await callback(db, save); // Stale buttons cannot repeat the replacement.
  assert.equal((await db.getSearchGroup(99, second)).length, 3);

  // Replace the whole group only after receiving new caption/media and confirming.
  await ReplaceGroupHandler.handleMessage(context(1, '替换', second), db);
  await callback(db, button('整组替换（文案＋照片/视频）'));
  const finishWhole = button('✅ 完成替换');
  const newPhoto = context();
  newPhoto.message = { message_id: ++sentId, photo: [{ file_id: 'whole-photo' }] };
  await ReplaceGroupHandler.handleMessage(newPhoto, db);
  await callback(db, finishWhole);
  assert.match(replies.at(-1).text, /请先发送新文案/);
  assert.equal((await db.getSearchGroup(99, second)).length, 3);
  const newVideo = context();
  newVideo.message = { message_id: ++sentId, video: { file_id: 'whole-video' }, caption: '整组新文案' };
  await ReplaceGroupHandler.handleMessage(newVideo, db);
  await callback(db, finishWhole);
  const confirmWhole = button('✅ 确认整组替换');
  assert.match(replies.at(-1).text, /1 张照片，1 个视频/);
  assert.equal((await db.getSearchGroup(99, second)).length, 3);
  await ReplaceGroupHandler.handleMessage(context(1, '最终文案'), db);
  await callback(db, confirmWhole);
  assert.match(replies.at(-1).text, /内容有变化/);
  await callback(db, finishWhole);
  await callback(db, button('✅ 确认整组替换'));
  group = await db.getSearchGroup(99, second);
  assert.deepEqual(group.map(m => m.file_id), ['whole-photo', 'whole-video']);
  assert.equal(group[0].caption, '最终文案\n#测试');
  assert.equal(group[1].caption, undefined);
  assert.equal((await db.getSearchGroup(99, third))[0].caption, '旧文案\n#测试');

  const stale = await db.getSearchGroup(99, third);
  await db.replaceSearchGroup(99, third, 1, stale, stale.map(m => ({ ...m, caption: 'changed' })));
  await assert.rejects(db.replaceSearchGroup(99, third, 1, stale, stale), /发生变化/);
  await db.deleteSearchGroup(99, second, 1);
  await db.deleteSearchGroup(99, third, 1);
  assert.equal((await db.deleteSearchGroup(99, fourth, 1)).remainingGroups, 0);
  assert.deepEqual(await db.getAllKeywords(1), []);
  assert.deepEqual(await db.getAllKeywords(2), ['测试']);
  await SearchHandler.handleReplyDelete(context(2, '删除', reference('batch-1', 2)), db);
  assert.match(replies.at(-1).text, /最后一组/);
  assert.equal(await SearchHandler.handleReplyDelete(context(1, '删除'), db), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'bot.json'))).albums, albums);
  console.log('PASS: search references, restart, group-only deletion, last keyword, owner isolation, caption replacement, multiple photos, video retention, duplicate updates, stale buttons, concurrent-change rejection, independent albums unchanged');
})().catch(error => { console.error(error); process.exitCode = 1; });
