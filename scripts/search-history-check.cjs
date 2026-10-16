const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { importHistory } = require('./import-search-history.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-history-'));
const dbPath = path.join(root, 'bot.json'), logPath = path.join(root, 'bot.log');
const data = { users: [{ id: 1, username: 'tester', first_name: 'New name' },
  { id: 2, username: 'ambiguous' }, { id: 3, username: 'ambiguous' }],
  media: [{ id: 99 }], albums: { saved: true },
  searchUsage: [{ userId: 1, keyword: '甲', day: '2026-10-16', count: 2, lastAt: Date.parse('2026-10-16T09:30:00Z') }] };
fs.writeFileSync(dbPath, JSON.stringify(data));
fs.writeFileSync(logPath, [
  '[2026/10/16 16:00:00] 🔍 [搜索] Old name (@tester) -> 关键词: "甲" | 结果: 📷1',
  '[2026/10/16 16:05:00] 🔍 [搜索] Different name (@TESTER) -> 关键词: "甲" (1/2 来自「甲乙」) | 结果: 📷1',
  '[2026/10/16 16:05:01] 🔍 [搜索] Different name (@TESTER) -> 关键词: "乙" (2/2 来自「甲乙」) | 结果: 📷1',
  '[2026/10/16 16:10:00] 🔍 [搜索] No username (ID: 4) -> 关键词: "甲" | 结果: 📷1',
  '[2026/10/16 17:30:00] 🔍 [搜索] Old name (@tester) -> 关键词: "甲" | 结果: 📷1',
  '[2026/9/01 16:00:00] 🔍 [搜索] Old name (@tester) -> 关键词: "甲" | 结果: 📷1',
  '[2026/10/16 16:00:00] 🔍 [搜索] Someone (@ambiguous) -> 关键词: "甲" | 结果: 📷1',
  '[2026/10/16 16:00:00] 🔍 [搜索] Unknown -> 关键词: "甲" | 结果: 📷1'
].join('\n'));
(async () => {
  const options = { dbPath, logPath, before: Date.parse('2026-10-16T09:00:00Z'), now: Date.parse('2026-10-16T10:00:00Z') };
  const before = fs.readFileSync(dbPath, 'utf8');
  assert.equal((await importHistory(options)).imported, 4);
  assert.equal(fs.readFileSync(dbPath, 'utf8'), before);
  await assert.rejects(importHistory({ ...options, apply: true }), /bot-stopped/);
  const result = await importHistory({ ...options, apply: true, stopped: true });
  assert.equal(result.unresolved, 2);
  const after = JSON.parse(fs.readFileSync(dbPath));
  assert.equal(after.searchUsage.find(e => e.userId === 1 && e.keyword === '甲').count, 4);
  assert.equal(after.searchUsage.find(e => e.userId === 1 && e.keyword === '乙').count, 1);
  assert.deepEqual(after.media, data.media);
  assert.deepEqual(after.albums, data.albums);
  assert((await importHistory({ ...options, apply: true, stopped: true })).alreadyImported);
  assert.equal(fs.readdirSync(root).filter(p => p.endsWith('.bak')).length, 1);
  console.log('PASS historical search import: renamed users, stable IDs, ambiguous names, time window, live-count cutoff, merge, dry run, backup, idempotency, unrelated data preserved');
})().catch(e => { console.error(e); process.exitCode = 1; });
