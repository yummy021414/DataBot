require('ts-node/register/transpile-only');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const original = Module._load;
let sends = 0;
Module._load = function(name, parent, ...rest) {
  if (parent?.filename.endsWith('scheduledPublish.ts')) {
    if (name === '../config') return { config: {}, isAdminUser: id => id === 1, isSuperAdmin: () => true,
      hasAdminChannelMap: () => false, getAdminChannelIds: () => [] };
    if (name === '../database') return { database: {
      getManagedChannels: async () => ['a', 'b', 'c'],
      getMediaByKeyword: async keyword => [{ id: 1, file_id: 'photo', file_type: 'photo', keyword, uploaded_by: 1 }],
      updateMediaPublished: async () => {}
    } };
  }
  return original.call(this, name, parent, ...rest);
};
const { ScheduledPublishQueue, parsePublishTime } = require('../src/services/scheduledPublish');
Module._load = original;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-tests-'));
(async () => {
  const now = Date.parse('2026-09-23T14:00:00+08:00');
  assert.equal(parsePublishTime('18:00', now), Date.parse('2026-09-23T18:00:00+08:00'));
  assert.equal(parsePublishTime('13:00', now), Date.parse('2026-09-24T13:00:00+08:00'));
  assert.throws(() => parsePublishTime('2026-02-30 12:00', now));
  assert.throws(() => parsePublishTime('25:00', now));
  const file = path.join(dir, 'queue.json');
  let q = new ScheduledPublishQueue(file);
  const a = await q.add(1, Date.now() + 60000, ['a', 'b', 'c'], ['one']);
  const b = await q.add(1, Date.now() + 120000, ['b', 'c'], ['two']);
  q = new ScheduledPublishQueue(file);
  assert.equal(q.list(1).length, 2);
  assert.deepEqual(q.list(1).find(x => x.id === a.id).channels, ['a', 'b', 'c']);
  assert.equal(q.cancel(2, a.id), false);
  assert.equal(q.cancel(1, b.id), true);
  await assert.rejects(() => q.add(2, Date.now() + 60000, ['a'], ['one']));
  await assert.rejects(() => q.add(1, Date.now() + 60000, ['unauthorized'], ['one']));
  // Simulate a restart mid-request: do not resend an uncertain unit.
  let rows = JSON.parse(fs.readFileSync(file)); rows[0].status = 'running'; fs.writeFileSync(file, JSON.stringify(rows));
  q = new ScheduledPublishQueue(file);
  assert.equal(q.list(1).find(x => x.id === a.id).status, 'attention');
  const c = await q.add(1, Date.now() + 60000, ['a'], ['three']);
  rows = JSON.parse(fs.readFileSync(file)); rows.find(x => x.id === c.id).at = Date.now() - 1000; fs.writeFileSync(file, JSON.stringify(rows));
  q = new ScheduledPublishQueue(file);
  const bot = { telegram: { sendMessage: async () => {}, sendPhoto: async () => { sends++; } } };
  await q.tick(bot); await q.tick(bot);
  assert.equal(sends, 1); assert.equal(q.list(1).find(x => x.id === c.id).status, 'complete');
  const d = await q.add(1, Date.now() + 60000, ['a'], ['four']);
  rows = JSON.parse(fs.readFileSync(file)); rows.find(x => x.id === d.id).at = 1; fs.writeFileSync(file, JSON.stringify(rows));
  q = new ScheduledPublishQueue(file);
  await q.tick({ telegram: { sendMessage: async () => {}, sendPhoto: async () => { throw Error('uncertain network result'); } } });
  assert.equal(q.list(1).find(x => x.id === d.id).status, 'attention');
  console.log('PASS: time validation, independent queues, permissions, cancellation, restart safety, send-once, uncertain failure');
})().finally(() => fs.rmSync(dir, { recursive: true, force: true })).catch(e => { console.error(e); process.exitCode = 1; });
