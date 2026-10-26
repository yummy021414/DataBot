const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recommendations-'));
process.chdir(root);
Object.assign(process.env, { DATABASE_PATH: path.join(root, 'bot.json'), BOT_TOKEN: 'offline', SUPER_ADMIN_ID: '1', ADMIN_IDS: '2' });
const { RecommendationStore, recommendations } = require('../dist/services/recommendations');
const { PublicationQueue } = require('../dist/services/publicationQueue');
const { RecommendationHandler: Handler } = require('../dist/bot/handlers/RecommendationHandler');
const { database } = require('../dist/database');
const channel = id => ({ id, title: id });
const item = (keyword, owner = 1) => ({ id: 1, keyword, batchId: 'a', uploaded_by: owner, file_id: keyword, file_type: 'photo' });
const delivery = (keyword, id, owner = 1) => ({ items: [item(keyword, owner)], messages: [{ message_id: id }] });
(async () => {
  assert.deepEqual(Handler.parseKeywords('可可喜多多', ['可可', '喜多多']), ['可可', '喜多多']);
  const file = path.join(root, 'isolated.json'), store = new RecommendationStore(file);
  // Publications can precede the caption and its link. Each button uses today's completed publication.
  store.record('-10011', [delivery('可可', 10), delivery('喜多多', 11)]);
  const d = store.create(1); d.channels = [channel('-10011')]; d.posts['-10011'] = { messageId: 100 };
  d.keywords = ['可可', '喜多多']; store.change(d);
  assert.equal(store.render(d, '-10011').reply_markup.inline_keyboard[0][0].url, 'https://t.me/c/11/10');
  assert.equal(store.render(d, '-10011').reply_markup.inline_keyboard.flat().length, 2);
  const calls = [];
  const tg = { editMessageReplyMarkup: async (id, messageId, _, markup) => calls.push([id, messageId, markup]),
    sendMessage: async () => { throw new Error('Must not send a new caption'); } };
  await store.push(d, d.revision, tg);
  assert.deepEqual(calls.map(c => c[1]), [100]);
  await assert.rejects(store.push(d, d.revision - 1, tg), /重新预览/);
  const restored = new RecommendationStore(file);
  assert.equal(restored.find(restored.get(1), '-10011', '可可'), 10);
  store.record('-10011', [delivery('可可', 12)]);
  assert.equal(store.find(d, '-10011', '可可'), 12, 'Latest successful run wins');
  store.record('-10011', [delivery('可可', 13, 2)]);
  assert.equal(store.find(d, '-10011', '可可'), 13, 'Superadmin can see all published material');
  const admin = store.create(2); admin.channels = [channel('-10011')]; admin.posts['-10011'] = { messageId: 200 };
  admin.keywords = ['可可']; store.change(admin);
  assert.equal(store.find(admin, '-10011', '可可'), 13);
  const yesterday = JSON.parse(fs.readFileSync(path.join(root, 'recommendation-publications.json'), 'utf8'));
  yesterday.forEach(p => { p.at -= 86400000; });
  fs.writeFileSync(path.join(root, 'recommendation-publications.json'), JSON.stringify(yesterday));
  const old = new RecommendationStore(file);
  assert.equal(old.find(old.get(1), '-10011', '可可'), undefined, 'Previous day must not appear');
  assert.throws(() => old.render(old.get(1), '-10011'), /今天尚无/);

  const integrated = recommendations.create(1);
  integrated.channels = [channel('-10033')]; integrated.posts['-10033'] = { messageId: 100 }; integrated.keywords = ['可可']; recommendations.change(integrated);
  const queue = new PublicationQueue(path.join(root, 'paused.json'), { channel: 0, group: 0, globalPerMessage: 0, timeout: 1000 });
  let msg = 10;
  const transport = { getChat: async id => ({ id, type: 'channel' }), sendPhoto: async () => ({ message_id: ++msg }) };
  await queue.run(transport, '-10033', async send => { await send([item('可可')]); await send([item('可可')]); });
  assert.equal(recommendations.find(integrated, '-10033', '可可'), 11);
  const before = fs.readFileSync(path.join(root, 'recommendation-publications.json'), 'utf8');
  await assert.rejects(queue.run(transport, '-10033', async send => { await send([item('失败')]); throw new Error('later failure'); }));
  assert.equal(fs.readFileSync(path.join(root, 'recommendation-publications.json'), 'utf8'), before);

  database.getManagedChannels = async () => ['-10055']; database.getAllKeywords = async () => ['可可', '喜多多'];
  integrated.active = false; recommendations.change(integrated);
  const replies = [], sessions = new Map();
  const ctx = { from: { id: 1 }, chat: { id: 1, type: 'private' },
    telegram: { ...tg, getChat: async id => ({ id: Number(id), title: String(id), type: 'channel' }) },
    answerCbQuery: async () => {}, reply: async (text, extra) => replies.push({ text, extra }) };
  const action = async data => { ctx.callbackQuery = { data }; await Handler.action(ctx, sessions); };
  await action('recommend_link'); const manual = recommendations.get(1);
  await assert.rejects(recommendations.push(manual, manual.revision, tg), /绑定原文案/);
  await Handler.input(ctx, 'https://t.me/c/55/300', sessions);
  assert.equal(manual.posts['-10055'].messageId, 300);
  recommendations.record('-10055', [delivery('可可', 101), delivery('喜多多', 102)]);
  await action(`rec:1:${manual.id}:keywords:${manual.revision}`);
  await Handler.input(ctx, '可可喜多多', sessions);
  assert.deepEqual(manual.keywords, ['可可', '喜多多']);
  await action(`rec:1:${manual.id}:preview:${manual.revision}`);
  const confirmation = replies.at(-1).extra.reply_markup.inline_keyboard[0][0].callback_data;
  await action(confirmation);
  assert.equal(calls.at(-1)[1], 300);
  assert.match(await recommendations.push(manual, manual.revision,
    { editMessageReplyMarkup: async () => { throw new Error('message can not be edited'); } }), /无法编辑原消息/);
  console.log('PASS: manual link, same-day publication lookup regardless of message order, one button per keyword, edit only, restart, failed run and permissions');
})().catch(e => { console.error(e); process.exitCode = 1; });
