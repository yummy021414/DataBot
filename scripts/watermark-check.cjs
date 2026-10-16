// Offline regression checks. Never connect to Telegram or load production data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pindaobot-watermark-check-'));
process.env.BOT_TOKEN = 'offline-test-token';
process.env.SUPER_ADMIN_ID = '1';
process.env.ADMIN_IDS = '2';
process.env.PERSISTENT_CHANNEL_ID = '-1001';
process.env.DATABASE_PATH = path.join(root, 'bot.db');
process.env.WATERMARK_ENABLED = 'true';
process.env.WATERMARK_TEXT = '测试水印 @demo %{literal}';
process.env.WATERMARK_TEMP_DIR = path.join(root, 'temp');
process.env.WATERMARK_VIDEO_PERIOD_SECONDS = '4';
require('ts-node/register');
const { WatermarkService, PrioritySerialQueue, watermarkService, watermarkError } = require('../src/services/watermark');
const { JsonDatabase } = require('../src/database/json-database');
const { WatermarkHandler } = require('../src/bot/handlers/WatermarkHandler');
const { watermarkConfig } = require('../src/config');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const results = [];
async function check(name, fn) { await fn(); results.push(name); console.log('PASS', name); }
function run(args) { return execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true }); }
function probe(file) { return JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true })); }
function frameHash(file, at) {
  return run(['-ss', String(at), '-i', file, '-frames:v', '1', '-f', 'md5', '-']).toString().trim();
}
(async () => {
  await check('queue serializes all jobs and prioritizes new uploads', async () => {
    const queue = new PrioritySerialQueue();
    let release;
    const order = [];
    const first = queue.add(() => new Promise(r => { release = () => { order.push(1); r(); }; }), 'migration');
    const old = queue.add(async () => { order.push(3); }, 'migration');
    const live = queue.add(async () => { order.push(2); }, 'interactive');
    release(); await Promise.all([first, old, live]);
    assert.deepEqual(order, [1, 2, 3]);
    await assert.rejects(queue.add(async () => { throw new Error('expected'); }, 'interactive'));
    await queue.add(async () => {}, 'interactive');
  });
  const service = new WatermarkService();
  await check('font / drawtext / libx264 preflight', () => service.assertReady('-1001'));
  const image = path.join(root, 'photo.jpg');
  const video = path.join(root, 'landscape.mp4');
  const portrait = path.join(root, 'portrait.mp4');
  run(['-f', 'lavfi', '-i', 'color=c=gray:s=640x360', '-frames:v', '1', image]);
  run(['-f', 'lavfi', '-i', 'color=c=gray:s=640x360:r=15:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', video]);
  run(['-f', 'lavfi', '-i', 'color=c=gray:s=360x640:r=15:d=2', '-c:v', 'libx264', portrait]);
  const outputImage = path.join(root, 'photo-watermarked.jpg');
  const outputVideo = path.join(root, 'video-watermarked.mp4');
  await check('photo watermark renders, preserves dimensions and changes pixels', async () => {
    await service.render(image, outputImage, 'photo');
    assert.notEqual(frameHash(image, 0), frameHash(outputImage, 0));
    const stream = probe(outputImage).streams[0];
    assert.equal(stream.width, 640); assert.equal(stream.height, 360);
    const pixels = run(['-i', outputImage, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
    assert(pixels.some(value => value > 150), 'Watermark must be visibly brighter than gray background');
  });
  await check('video moving watermark preserves audio / duration; event loop stays responsive', async () => {
    let ticks = 0;
    const interval = setInterval(() => ticks++, 10);
    try { await service.render(video, outputVideo, 'video'); } finally { clearInterval(interval); }
    const info = probe(outputVideo);
    assert(info.streams.some(s => s.codec_type === 'audio'));
    assert(Math.abs(Number(info.format.duration) - 3) < 0.2);
    assert.notEqual(frameHash(outputVideo, 0), frameHash(outputVideo, 1));
    assert(ticks > 0);
    console.log('  event-loop ticks during render:', ticks);
  });
  await check('portrait / silent video renders without audio-map errors', async () => {
    const output = path.join(root, 'portrait-watermarked.mp4');
    await service.render(portrait, output, 'video');
    const stream = probe(output).streams[0];
    assert.equal(stream.width, 360); assert.equal(stream.height, 640);
  });
  await check('durable receipt reuses encoded upload across service restart', async () => {
    let uploads = 0;
    const tg = {
      getFile: async id => ({ file_path: image, file_size: fs.statSync(image).size }),
      sendPhoto: async (_chat, _file, extra) => {
        uploads++; assert.equal(extra.caption, 'original caption');
        return { message_id: 9, photo: [{ file_id: 'watermarked-file' }] };
      }
    };
    const a = await service.processTelegramMedia(tg, 'raw-file', 'photo', '-1001', 'interactive', 'original caption');
    const b = await new WatermarkService().processTelegramMedia(tg, 'raw-file', 'photo', '-1001', 'interactive', 'original caption');
    assert.deepEqual(a, b); assert.equal(uploads, 1);
  });
  await check('real mixed album renders locally and uploads only once', async () => {
    let uploads = 0;
    const tg = {
      getFile: async id => ({ file_path: id === 'album-video' ? video : image, file_size: 100 }),
      sendPhoto: async () => { throw new Error('unexpected single upload'); },
      sendVideo: async () => { throw new Error('unexpected single upload'); },
      sendMediaGroup: async (_chat, group) => {
        uploads++;
        assert.equal(group.length, 2);
        assert.equal(group[0].caption, 'group caption'); assert(!group[1].caption);
        for (const item of group) assert(probe(item.media.source).streams.length > 0);
        return [{ message_id: 701, video: { file_id: 'new-video' } },
          { message_id: 702, photo: [{ file_id: 'new-photo' }] }];
      }
    };
    const result = await service.processTelegramAlbum(tg, [
      { fileId: 'album-video', type: 'video' }, { fileId: 'album-photo', type: 'photo' }
    ], '-1001', 'group caption');
    assert.equal(uploads, 1); assert.equal(result.length, 2);
    assert.deepEqual(fs.readdirSync(watermarkConfig.tempDir), []);
  });
  await check('oversized input fails before upload and cleanup runs', async () => {
    let uploads = 0;
    const tg = { getFile: async () => ({ file_size: 21 * 1024 * 1024 }), sendPhoto: async () => { uploads++; } };
    await assert.rejects(service.processTelegramMedia(tg, 'huge', 'photo', '-1001'), /下载上限/);
    assert.equal(uploads, 0);
    assert.deepEqual(fs.readdirSync(watermarkConfig.tempDir), []);
  });
  await check('cancelled queued migration does not download or publish', async () => {
    await assert.rejects(service.processTelegramMedia({}, 'raw', 'photo', '-1001', 'migration', '', () => true), /暂停/);
  });
  const db = new JsonDatabase();
  const original = { keyword: 'demo', file_id: 'original', file_type: 'photo',
    uploaded_by: 1, uploaded_at: new Date().toISOString(), is_published: true,
    batchId: 'album-1', caption: 'keep caption', source_chat_id: '-10', source_msg_id: 3, upload_key: 'idempotency-1' };
  let id;
  await check('save retry is idempotent', async () => {
    id = await db.saveMedia(original);
    assert.equal(await db.saveMedia(original), id);
    assert.equal((await db.getAllMedia()).length, 1);
  });
  await check('watermark commit retains metadata, old source, and survives reload', async () => {
    await db.updateMediaWatermark(id, { fileId: 'new', sourceChatId: '-20', sourceMsgId: 4, version: 1, expectedFileId: 'original' });
    const loaded = new JsonDatabase();
    const item = (await loaded.getAllMedia())[0];
    assert.equal(item.file_id, 'new'); assert.equal(item.original_file_id, 'original');
    assert.equal(item.original_source_msg_id, 3); assert.equal(item.caption, 'keep caption');
    assert.equal(item.batchId, 'album-1'); assert.equal(item.is_published, true);
  });
  await check('stale migration cannot overwrite a concurrent file update', async () => {
    await assert.rejects(db.updateMediaWatermark(id, { fileId: 'bad', sourceChatId: '-20', sourceMsgId: 5, version: 2, expectedFileId: 'stale' }), /发生变化/);
    assert.equal((await db.getAllMedia())[0].file_id, 'new');
  });
  await check('failed disk commit restores previous in-memory watermark state', async () => {
    const save = db.saveImmediately;
    db.saveImmediately = async () => { throw new Error('simulated disk failure'); };
    try {
      await assert.rejects(db.updateMediaWatermark(id, { fileId: 'bad', sourceChatId: '-20', sourceMsgId: 5, version: 2 }), /disk failure/);
      assert.equal((await db.getAllMedia())[0].file_id, 'new');
      assert.equal((await db.getAllMedia())[0].watermark_version, 1);
    } finally { db.saveImmediately = save; }
  });
  await check('upload session whitelist survives restart without Context objects', async () => {
    const context = {}; context.self = context;
    await db.saveUserSession(1, { userId: 1, mode: 'upload', step: 'selecting_channel',
      currentKeyword: 'demo', pendingMedia: [{ file_id: 'new', watermarked: true, batchId: 'album-1', ctx: context }], ctx: context });
    await db.saveImmediately();
    const restored = await new JsonDatabase().getUserSession(1);
    assert.equal(restored.pendingMedia[0].file_id, 'new');
    assert.equal(restored.ctx, undefined); assert.equal(restored.pendingMedia[0].ctx, undefined);
  });
  await check('another administrator cannot stop a task or view its details', async () => {
    WatermarkHandler.job = { running: true, requestedBy: 1, total: 2, done: 0, failed: 0 };
    const replies = [];
    await WatermarkHandler.handleStop({ from: { id: 2 }, answerCbQuery: async () => {}, reply: async x => { replies.push(x); } });
    assert.equal(WatermarkHandler.job.cancelRequested, undefined); assert(replies[0].includes('自己'));
    WatermarkHandler.job = null;
  });
  await check('error messages redact Bot API credentials', async () => {
    assert(!watermarkError(new Error('https://api.telegram.org/file/bot123:secret/file')).includes('123:secret'));
  });
  await check('migration preserves originals on failure, then retries complete albums', async () => {
    const restoreProcess = watermarkService.processTelegramAlbum;
    const restoreReady = watermarkService.assertReady;
    const items = [{ ...original, id: 81, file_id: 'first' }, { ...original, id: 82, file_id: 'second' }];
    let attempts = 0;
    watermarkService.assertReady = async () => {};
    watermarkService.processTelegramAlbum = async (_tg, group) => {
      attempts++;
      if (attempts === 1) throw new Error('simulated album failure');
      assert.equal(group.length, 2);
      return group.map((x, i) => ({ fileId: 'wm-' + x.fileId, version: 1, sourceChatId: '-1001', sourceMsgId: 91 + i }));
    };
    const stubDb = { updateMediaWatermarkBatch: async updates => {
      for (const r of updates) Object.assign(items.find(x => x.id === r.id),
        { file_id: r.fileId, watermarked: true, watermark_version: 1 });
    } };
    const tg = { callApi: async () => ({ file_path: 'photo.jpg', file_size: 100 }), editMessageText: async () => {} };
    const job = () => ({ running: true, requestedBy: 1, total: 2, done: 0, failed: 0 });
    try {
      WatermarkHandler.job = job();
      await WatermarkHandler.runMigration(tg, 1, 1, items.map(x => ({ ...x })), stubDb);
      assert.equal(WatermarkHandler.job.done, 0); assert.equal(WatermarkHandler.job.failed, 2);
      assert.equal(items[0].file_id, 'first'); assert.equal(items[1].file_id, 'second');
      WatermarkHandler.job = job();
      await WatermarkHandler.runMigration(tg, 1, 1, items.map(x => ({ ...x })), stubDb);
      assert.equal(attempts, 2); assert.equal(items[1].file_id, 'wm-second');
    } finally { watermarkService.processTelegramAlbum = restoreProcess; watermarkService.assertReady = restoreReady; WatermarkHandler.job = null; }
  });
  await check('pause finishes active album and stops before next group', async () => {
    const restoreProcess = watermarkService.processTelegramAlbum;
    let commits = 0;
    watermarkService.processTelegramAlbum = async (_tg, items) => {
      WatermarkHandler.job.cancelRequested = true;
      return items.map((_, i) => ({ fileId: 'wm', version: 1, sourceChatId: '-1001', sourceMsgId: 91 + i }));
    };
    try {
      WatermarkHandler.job = { running: true, requestedBy: 1, total: 3, done: 0, failed: 0 };
      await WatermarkHandler.runMigration({ callApi: async () => ({ file_size: 100 }), editMessageText: async () => {} },
        1, 1, [{ ...original, id: 1 }, { ...original, id: 2 }, { ...original, id: 3, batchId: 'next' }],
        { updateMediaWatermarkBatch: async updates => { commits += updates.length; } });
      assert.equal(commits, 2); assert.equal(WatermarkHandler.job.done, 2);
    } finally { watermarkService.processTelegramAlbum = restoreProcess; WatermarkHandler.job = null; }
  });
  await check('new upload returns immediately and repeated click starts only one job', async () => {
    const { UploadHandler } = require('../src/bot/handlers/UploadHandler');
    const save = UploadHandler.saveOnly;
    let count = 0; let finish;
    UploadHandler.saveOnly = async () => { count++; await new Promise(r => { finish = r; }); };
    const ctx = { from: { id: 99 }, answerCbQuery: async () => {} };
    try {
      await UploadHandler.handleSaveOnly(ctx, new Map(), {});
      await UploadHandler.handleSaveOnly(ctx, new Map(), {});
      await new Promise(r => setImmediate(r));
      assert.equal(count, 1); assert(UploadHandler.isProcessing(99));
      finish(); await new Promise(r => setImmediate(r));
      assert(!UploadHandler.isProcessing(99));
    } finally { UploadHandler.saveOnly = save; }
  });
  await check('search reclaims migrated ids and reconstructs an album after token rotation', async () => {
    const { SearchHandler } = require('../src/bot/handlers/SearchHandler');
    let sends = 0;
    const ctx = {
      chat: { id: 1 },
      telegram: {
        forwardMessage: async () => ({ message_id: 100, photo: [{ file_id: 'reclaimed' }] }),
        deleteMessage: async () => {}
      },
      replyWithMediaGroup: async group => {
        sends++;
        if (sends === 1) throw new Error('invalid old file_id');
        assert.equal(group.length, 2); assert.equal(group[0].media, 'reclaimed');
        assert.equal(group[0].caption, 'album caption');
      }
    };
    await SearchHandler.sendCompatibleMediaGroup(ctx, [
      { ...original, id: 101, watermarked: true }, { ...original, id: 102, watermarked: true }
    ], 'album caption');
    assert.equal(sends, 2);
  });
  await db.saveImmediately();
  console.log(JSON.stringify({ passed: results.length, artifacts: root }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
