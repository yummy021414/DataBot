const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-album-'));
Object.assign(process.env, { BOT_TOKEN: 'offline', SUPER_ADMIN_ID: '1', DATABASE_PATH: path.join(root, 'bot.db'),
  PERSISTENT_CHANNEL_ID: '-1001', WATERMARK_ENABLED: 'true', WATERMARK_TEXT: 'test' });
const { WatermarkService, watermarkService } = require('../dist/services/watermark');
const { UploadHandler } = require('../dist/bot/handlers/UploadHandler');
const { PublishHandler } = require('../dist/bot/handlers/PublishHandler');
const dirs = [];
function prepare(service) {
  service.assertReady = async () => {};
  service.setupDirectory = async () => { const d = fs.mkdtempSync(path.join(root, 'files-')); dirs.push(d); return d; };
  service.render = async (_in, out) => { fs.writeFileSync(out, 'test-encoded'); };
}
const input = path.join(root, 'input.jpg'); fs.writeFileSync(input, 'original');
let groups = [], singles = 0;
const tg = {
  getFile: async () => ({ file_path: input, file_size: 8 }),
  sendPhoto: async () => { singles++; throw Error('unexpected staging photo'); },
  sendVideo: async () => { singles++; throw Error('unexpected staging video'); },
  sendMediaGroup: async (chat, items) => {
    groups.push({ chat, items });
    return items.map((m, i) => ({ message_id: 10 + i, [m.type]: m.type === 'photo' ? [{ file_id: 'wm-' + i }] : { file_id: 'wm-' + i } }));
  },
  editMessageText: async () => {}
};
(async () => {
  const service = new WatermarkService(); prepare(service);
  const inputs = [{ fileId: 'a', type: 'video' }, { fileId: 'b', type: 'photo' }];
  const result = await service.processTelegramAlbum(tg, inputs, '-1001', 'caption');
  assert.equal(groups.length, 1); assert.equal(singles, 0);
  assert.deepEqual(groups[0].items.map(m => m.type), ['video', 'photo']);
  assert.equal(groups[0].items.filter(m => m.caption).length, 1);
  assert(dirs.every(d => !fs.existsSync(d)));
  assert.deepEqual(await service.processTelegramAlbum(tg, inputs, '-1001', 'caption'), result);
  assert.equal(groups.length, 1);
  service.render = async () => { throw Error('encode failed'); };
  await assert.rejects(service.processTelegramAlbum(tg, [{ fileId: 'fail', type: 'photo' }], '-1001', ''), /encode failed/);
  assert.equal(groups.length, 1); assert(dirs.every(d => !fs.existsSync(d)));
  console.log('PASS album upload once, order, caption, cache retry, failure cleanup');
  const db = { updateMediaSource: async () => {} };
  const items = [
    { id: 1, batchId: 'batch', file_id: 'original-video', file_type: 'video', caption: '正文\n#11' },
    { id: 2, batchId: 'batch', file_id: 'original-photo', file_type: 'photo' }
  ];
  groups = [];
  await UploadHandler.publishOneBatch(tg, '-2002', items, '11', db, {});
  assert.equal(groups.length, 1); assert.equal(groups[0].chat, '-2002');
  assert.deepEqual(groups[0].items.map(m => m.type), ['video', 'photo']);
  const failTg = { ...tg, sendMediaGroup: async () => { throw Error('simulated timeout'); } };
  const fail = await UploadHandler.publishOneBatch(failTg, '-2002', items, '11', db, {});
  assert.equal(fail.failed, 2); assert.equal(singles, 0);
  await assert.rejects(PublishHandler.sendCompatibleMediaGroup({ telegram: failTg }, '-2002', items, 'caption'));
  assert.equal(singles, 0);
  await assert.rejects(UploadHandler.publishOneBatch(tg, '-2002', items, '11',
    { updateMediaSource: async () => { throw Error('disk failed'); } }, {}), /disk failed/);
  assert.equal(singles, 0);
  console.log('PASS target album order, no single-message fallback on timeout or persistence error');
})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
