const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recommendations-'));
process.chdir(root);
Object.assign(process.env, { DATABASE_PATH: path.join(root, 'bot.json'), BOT_TOKEN: 'offline', SUPER_ADMIN_ID: '1', ADMIN_IDS: '2' });
const { RecommendationStore, recommendations } = require('../dist/services/recommendations');
const { PublicationQueue } = require('../dist/services/publicationQueue');
const { RecommendationHandler: Handler } = require('../dist/bot/handlers/RecommendationHandler');
const { database } = require('../dist/database');
const channel = id => ({ id, title: '目标' + id });
const item = (keyword, batchId = 'a', owner = 1) => ({ id: 1, keyword, batchId, uploaded_by: owner, file_id: keyword, file_type: 'photo' });
const delivery = (keyword, id, batch = 'a', owner = 1) => ({ items: [item(keyword, batch, owner)], messages: [{ message_id: id }] });
(async () => {
  const file = path.join(root, 'isolated.json'), store = new RecommendationStore(file);
  assert.deepEqual(store.capture('-10011'), []);
  const d = store.create(1, [channel('-10011'), channel('-10022')]);
  d.caption = '本期特别推荐'; d.keywords = ['可可']; store.change(d);
  assert.throws(() => store.render(d, '-10011'), /尚未/);
  store.record('-10011', store.capture('-10011'), [delivery('可可', 11), delivery('可可', 12), delivery('可可', 15, 'b'), delivery('喜多多', 20)]);
  store.record('-10022', store.capture('-10022'), [delivery('可可', 91)]);
  assert.deepEqual(store.render(d, '-10011').reply_markup.inline_keyboard.flat().map(b => b.url), ['https://t.me/c/11/11', 'https://t.me/c/11/15']);
  assert.equal(store.render(d, '-10022').reply_markup.inline_keyboard[0][0].url, 'https://t.me/c/22/91');
  d.channels[1].username = 'public_channel';
  assert.equal(store.render(d, '-10022').reply_markup.inline_keyboard[0][0].url, 'https://t.me/public_channel/91');
  const calls = [];
  const telegram = { sendMessage: async (id, text, extra) => { calls.push(['send', id, text, extra]); return { message_id: id === '-10011' ? 100 : 200 }; },
    editMessageText: async (id, msg, _, text, extra) => { calls.push(['edit', id, msg, text, extra]); } };
  await store.push(d, d.revision, telegram);
  assert.equal(calls.filter(c => c[0] === 'send').length, 2);
  const loaded = new RecommendationStore(file), restored = loaded.get(1);
  restored.keywords.push('喜多多'); loaded.change(restored);
  assert.throws(() => loaded.render(restored, '-10022'), /喜多多/);
  loaded.record('-10022', loaded.capture('-10022'), [delivery('喜多多', 95)]);
  await loaded.push(restored, restored.revision, telegram);
  assert.deepEqual(calls.filter(c => c[0] === 'edit').map(c => c[2]), [100, 200]);
  assert.equal(calls.filter(c => c[0] === 'send').length, 2);
  await assert.rejects(loaded.push(restored, restored.revision - 1, telegram), /重新预览/);
  const oldEdition = loaded.capture('-10011'); restored.active = false; loaded.change(restored);
  const newEdition = loaded.create(1, [channel('-10011')]);
  loaded.record('-10011', oldEdition, [delivery('旧资料', 500)]);
  assert.deepEqual(newEdition.links, {});
  const admin = loaded.create(2, [channel('-10011')]);
  loaded.record('-10011', loaded.capture('-10011'), [delivery('别人', 501), delivery('自己', 502, 'a', 2)]);
  assert(!admin.links['-10011']['别人']); assert(admin.links['-10011']['自己']);

  const uncertain = new RecommendationStore(path.join(root, 'unknown.json'));
  const u = uncertain.create(1, [channel('-10011')]); u.caption = '文案'; u.keywords = ['可可'];
  uncertain.record('-10011', uncertain.capture('-10011'), [delivery('可可', 1)]);
  let sends = 0;
  const failing = { sendMessage: async () => { sends++; throw new Error('network timeout'); } };
  await uncertain.push(u, u.revision, failing);
  const restart = new RecommendationStore(path.join(root, 'unknown.json'));
  await restart.push(restart.get(1), restart.get(1).revision, failing);
  assert.equal(sends, 1, 'Unknown delivery must not be automatically repeated after restart');

  // Actual shared transport records only fully successful runs, including split batches.
  const integrated = recommendations.create(1, [channel('-10033'), channel('-10044')]);
  integrated.caption = '测试'; integrated.keywords = ['可可']; recommendations.change(integrated);
  const queue = new PublicationQueue(path.join(root, 'paused.json'), { channel: 0, group: 0, globalPerMessage: 0, timeout: 1000 });
  let msg = 10;
  const tg = { getChat: async id => ({ id, type: 'channel' }), sendPhoto: async () => ({ message_id: ++msg }) };
  await queue.run(tg, '-10033', async send => { await send([item('可可')]); await send([item('可可')]); await send([item('可可', 'b')]); });
  assert.deepEqual(integrated.links['-10033']['可可'].map(g => g.messageId), [11, 13]);
  await assert.rejects(queue.run(tg, '-10044', async send => { await send([item('可可')]); throw new Error('later failure'); }));
  assert.equal(integrated.links['-10044'], undefined);

  // Wizard, append/remove, stale/foreign callbacks and preview permissions.
  database.getManagedChannels = async () => ['-10055']; database.getAllKeywords = async () => ['可可', '喜多多'];
  integrated.active = false; recommendations.change(integrated);
  const replies = [], sessions = new Map([[1, { mode: 'publish', selectedChannels: ['-10055'] }]]);
  const ctx = { from: { id: 1 }, chat: { id: 1, type: 'private' }, telegram: { ...telegram, getChat: async id => ({ id: Number(id), title: id, type: 'channel' }) },
    answerCbQuery: async () => {}, reply: async (text, extra) => { replies.push({ text, extra }); } };
  const action = async data => { ctx.callbackQuery = { data }; await Handler.action(ctx, sessions); };
  await action('recommend_new'); const wizard = recommendations.get(1);
  assert.equal(wizard.input, 'caption');
  await Handler.input(ctx, '自定义推荐文案', sessions); assert.equal(wizard.input, 'keywords');
  await Handler.input(ctx, '可可 可可', sessions); assert.deepEqual(wizard.keywords, ['可可']); assert(!wizard.input);
  await action(`rec:1:${wizard.id}:add:0`); await Handler.input(ctx, '喜多多 可可', sessions);
  assert.deepEqual(wizard.keywords, ['可可', '喜多多']);
  await action(`rec:1:${wizard.id}:remove:0`); await Handler.input(ctx, '喜多多', sessions); assert.deepEqual(wizard.keywords, ['可可']);
  await action(`rec:2:${wizard.id}:end_confirm:${wizard.revision}`); assert(wizard.active);
  await action(`rec:1:${wizard.id}:preview:0`); assert.match(replies.at(-1).text, /尚未/);
  recommendations.record('-10055', recommendations.capture('-10055'), [delivery('可可', 60)]);
  await action(`rec:1:${wizard.id}:preview:0`); assert(replies.at(-1).extra.reply_markup.inline_keyboard[0][0].callback_data.includes(':push:'));
  database.getManagedChannels = async () => [];
  await action(`rec:1:${wizard.id}:push:${wizard.revision}`); assert.match(replies.at(-1).text, /权限/);
  console.log('PASS: optional editions, wizard, append/remove, multi-group and per-channel links, restart persistence, edits instead of duplicate sends, stale preview, unknown-result guard, permissions, failed-run exclusion and old-edition isolation');
})().catch(e => { console.error(e); process.exitCode = 1; });
