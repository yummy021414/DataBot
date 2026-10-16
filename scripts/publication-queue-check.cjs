const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-'));
Object.assign(process.env, { DATABASE_PATH: path.join(root, 'bot.json'), BOT_TOKEN: 'offline', SUPER_ADMIN_ID: '1', PERSISTENT_CHANNEL_ID: '' });
const { PublicationQueue, publicationQueue, publicationBatches, publicationChunks } = require('../dist/services/publicationQueue');
const { PublishHandler } = require('../dist/bot/handlers/PublishHandler');
const { UploadHandler } = require('../dist/bot/handlers/UploadHandler');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const timing = { channel: 2, group: 3, timeout: 2000, globalPerMessage: 0 };
const make = name => new PublicationQueue(path.join(root, name + '.json'), timing);
const media = (id, extra = {}) => ({ id, keyword: 'kw', uploaded_by: 1, batchId: 'batch', file_type: 'photo', file_id: String(id), caption: 'caption', ...extra });
let sequence = 0;
const result = () => ({ message_id: ++sequence });
(async () => {
  const source = Array.from({ length: 12 }, (_, i) => media(i, { file_type: i % 2 ? 'video' : 'photo' }));
  const chunks = publicationChunks(source);
  assert.deepEqual(chunks.map(c => c.length), [10, 2]);
  assert.deepEqual(chunks.flat().map(m => m.file_id), source.map(m => m.file_id));
  assert.equal(chunks.flat().filter(m => m.caption).length, 1);
  assert.equal(source.filter(m => m.caption).length, 12); // No mutation of database objects.
  assert.equal(publicationBatches([media(1), media(2, { uploaded_by: 2 }), media(3, { keyword: 'other' })]).length, 3);
  assert.deepEqual(publicationChunks([media(1), media(2, { file_type: 'document' }), media(3), media(4, { file_type: 'animation' })]).map(c => c.length), [1, 1, 1, 1]);

  const q = make('order');
  const calls = []; let active = 0, peak = 0;
  const tg = { getChat: async id => ({ id: id === '@alias' ? '-1' : id, type: 'channel' }),
    sendPhoto: async (chat, file) => { active++; peak = Math.max(peak, active); calls.push(chat + ':' + file); await sleep(8); active--; return result(); },
    sendMediaGroup: async (chat, items) => { calls.push(chat + ':' + items.map(m => m.media).join(',')); return items.map(result); } };
  await Promise.all([
    q.run(tg, '@alias', async send => { await send([media('a1')]); await send([media('a2')]); }),
    q.run(tg, '-1', async send => { await send([media('b1')]); await send([media('b2')]); }),
    q.run(tg, '-2', send => send([media('c')])),
    q.run(tg, '-3', send => send([media('d')]))
  ]);
  assert.deepEqual(calls.filter(c => c.startsWith('-1:')), ['-1:a1', '-1:a2', '-1:b1', '-1:b2']);
  assert.equal(peak, 2);

  let attempts = 0; const rate = make('rate'); const started = Date.now();
  await rate.run({ ...tg, sendPhoto: async () => {
    if (++attempts === 1) throw { response: { error_code: 429, parameters: { retry_after: 1 } } };
    return result();
  } }, '-4', send => send([media('retry')]));
  assert.equal(attempts, 2); assert(Date.now() - started >= 1250);

  let finish;
  const uncertain = new PublicationQueue(path.join(root, 'uncertain.json'), { ...timing, timeout: 15 });
  let sent = 0;
  const hanging = { ...tg, sendPhoto: async () => { sent++; return new Promise(r => { finish = r; }); } };
  await assert.rejects(uncertain.run(hanging, '-5', send => send([media('x')])), /已暂停/);
  await assert.rejects(uncertain.run(hanging, '-5', send => send([media('x')])), /已暂停/);
  assert.equal(sent, 1);
  await assert.rejects(uncertain.resume(tg, '-5'), /尚未结束/);
  await assert.rejects(new PublicationQueue(path.join(root, 'uncertain.json'), timing).run(tg, '-5', send => send([media('x')])), /已暂停/);
  finish(result()); await sleep(0); await uncertain.resume(tg, '-5');
  await uncertain.run(tg, '-5', send => send([media('after-check')]));

  // Real manual-publish and upload entry points share one channel lock.
  publicationQueue.timing = timing;
  const trace = [];
  const shared = { ...tg, sendMediaGroup: async (chat, items) => {
    trace.push(items.map(m => m.media)); await sleep(4); return items.map(result);
  } };
  await Promise.all([
    PublishHandler.publishToChannel({ telegram: shared }, '-6', source, 'kw'),
    UploadHandler.publishOneBatch(shared, '-6', [media('upload1'), media('upload2')], 'kw', { updateMediaSource: async () => {} })
  ]);
  assert.deepEqual(trace.map(c => c.length), [10, 2, 2]);
  assert.deepEqual(trace[2], ['upload1', 'upload2']);
  const pace = new PublicationQueue(path.join(root, 'pace.json'), { ...timing, channel: 25 });
  const starts = [];
  const pacedTg = { ...tg, sendPhoto: async () => { starts.push(Date.now()); await sleep(40); return result(); } };
  await pace.run(pacedTg, '-7', async send => { await send([media(1)]); await send([media(2)]); });
  assert(starts[1] - starts[0] < 65, 'Do not add a full interval after a slow successful request');
  console.log('PASS: owner/batch isolation, media order, 10-item split, single caption, channel FIFO/alias, two-channel concurrency, 429 exact retry, timeout pause/no duplicate, persisted pause, pending-request resume guard, shared upload/manual lock, elapsed-time pacing');
})().catch(e => { console.error(e); process.exitCode = 1; });
