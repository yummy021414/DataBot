const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-migration-'));
Object.assign(process.env, { BOT_TOKEN: 'offline', SUPER_ADMIN_ID: '1', ADMIN_IDS: '2',
  DATABASE_PATH: path.join(root, 'bot.db'), PERSISTENT_CHANNEL_ID: '-1001', WATERMARK_ENABLED: 'true' });
const { WatermarkHandler } = require('../dist/bot/handlers/WatermarkHandler');
const { watermarkService, watermarkApi } = require('../dist/services/watermark');
const { JsonDatabase } = require('../dist/database/json-database');
const base = { file_type: 'photo', keyword: 'one', batchId: 'legacy_batch', uploaded_by: 1,
  uploaded_at: new Date().toISOString(), is_published: false };
(async () => {
  const items = [
    { ...base, id: 1, file_id: 'missing', source_chat_id: '-old', source_msg_id: 1 },
    { ...base, id: 2, file_id: 'ready', watermarked: true, watermark_version: 1 },
    { ...base, id: 3, file_id: 'raw', caption: 'caption' },
    { ...base, id: 4, file_id: 'raw2', keyword: 'two' },
    { ...base, id: 5, file_id: 'raw3', uploaded_by: 2 }
  ];
  assert.equal(WatermarkHandler.migrationGroups(items).length, 3);
  const albums = [], commits = [], forwards = [];
  watermarkService.processTelegramAlbum = async (_tg, group, chat, caption, _progress, priority) => {
    albums.push({ group, chat, caption });
    assert.equal(priority, 'migration');
    return group.map((x, i) => ({ fileId: x.ready ? x.fileId : 'wm-' + x.fileId, version: 1, sourceChatId: chat, sourceMsgId: i + 90 }));
  };
  const tg = {
    callApi: async (method, payload) => {
      if (method === 'getFile' && payload.file_id === 'missing') {
        const e = new Error('invalid file identifier'); e.response = { error_code: 400 }; throw e;
      }
      if (method === 'forwardMessage') { forwards.push(payload); throw Error('message to forward not found'); }
      return { file_size: 100, file_path: 'file.jpg' };
    }, editMessageText: async () => {}
  };
  WatermarkHandler.job = { running: true, total: 4, done: 0, failed: 0, requestedBy: 1, startedAt: new Date().toISOString() };
  await WatermarkHandler.runMigration(tg, 1, 77, items, { updateMediaWatermarkBatch: async updates => commits.push(updates) });
  assert.equal(WatermarkHandler.job.done, 3); assert.equal(WatermarkHandler.job.failed, 1);
  assert.equal(albums.length, 3); assert.equal(albums[0].group.length, 2);
  assert.equal(albums[0].group[0].ready, true);
  assert.equal(albums[0].caption, 'caption');
  assert.equal(forwards[0].chat_id, 1, 'recovery must not scatter raw messages in vault');
  const failures = fs.readFileSync(path.join(root, 'watermark-failures.jsonl'), 'utf8');
  assert(failures.includes('message to forward not found'));
  console.log('PASS legacy grouping isolation, completed member reuse, missing-original skip and durable failure report');
  const db = new JsonDatabase();
  const a = await db.saveMedia({ ...base, file_id: 'a' });
  const b = await db.saveMedia({ ...base, file_id: 'b' });
  await db.saveImmediately();
  const save = db.saveImmediately;
  db.saveImmediately = async () => { throw Error('disk failure'); };
  const updates = [{ id: a, fileId: 'wa', version: 1, sourceChatId: '-1001', sourceMsgId: 1, expectedFileId: 'a' },
    { id: b, fileId: 'wb', version: 1, sourceChatId: '-1001', sourceMsgId: 2, expectedFileId: 'b' }];
  await assert.rejects(db.updateMediaWatermarkBatch(updates), /disk failure/);
  assert.deepEqual((await db.getAllMedia()).map(x => x.file_id), ['a', 'b']);
  db.saveImmediately = save;
  await assert.rejects(db.updateMediaWatermarkBatch([{ ...updates[0] }, { ...updates[1], expectedFileId: 'stale' }]), /发生变化/);
  assert.deepEqual((await db.getAllMedia()).map(x => x.file_id), ['a', 'b']);
  await db.updateMediaWatermarkBatch(updates);
  assert.deepEqual((await new JsonDatabase().getAllMedia()).map(x => x.file_id), ['wa', 'wb']);
  console.log('PASS atomic album commit, complete rollback and prevalidated stale updates');
  let aborted = false;
  await assert.rejects(watermarkApi({ callApi: async (_m, _p, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); });
  }) }, 'getFile', {}, 10), /aborted/);
  assert(aborted);
  console.log('PASS network deadline aborts actual request');
})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
