// Run against a stopped bot; defaults to a read-only preview.
const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const IMPORT_ID = 'search-log-v1';

async function importHistory({ dbPath, logPath, before, now = Date.now(), apply = false, stopped = false }) {
  if (!Number.isFinite(before)) throw Error('A valid exclusive --before timestamp is required');
  if (apply && !stopped) throw Error('--apply requires --bot-stopped');
  const raw = fs.readFileSync(dbPath, 'utf8');
  const data = JSON.parse(raw);
  if ((data.searchHistoryImports || []).includes(IMPORT_ID)) return { alreadyImported: true };
  const usernames = new Map();
  for (const user of data.users || []) {
    if (!user.username) continue;
    const key = user.username.toLowerCase();
    if (!usernames.has(key)) usernames.set(key, new Set());
    usernames.get(key).add(user.id);
  }
  const cutoff = new Date(now - 29 * 86400000).toISOString().slice(0, 10);
  const stats = { imported: 0, unresolved: 0, excluded: 0, users: 0, keywords: 0 };
  const buckets = new Map();
  const lines = readline.createInterface({ input: fs.createReadStream(logPath), crlfDelay: Infinity });
  for await (const line of lines) {
    const match = line.match(/^\[(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})\] .*?\[搜索\] (.*?) -> 关键词: "(.*?)"(?: \(| \|)/);
    if (!match) continue;
    // Production bot.log timestamps use the server's Asia/Shanghai timezone.
    const [, year, month, dayOfMonth, hour, minute, second, display, keyword] = match;
    const timestamp = Date.parse(`${year}-${month.padStart(2, '0')}-${dayOfMonth.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:${second}+08:00`);
    if (!Number.isFinite(timestamp) || timestamp >= before || timestamp > now) { stats.excluded++; continue; }
    const day = new Date(timestamp).toISOString().slice(0, 10);
    if (day < cutoff) { stats.excluded++; continue; }
    const idMatch = display.match(/\(ID: (\d+)\)$/);
    const username = display.match(/\(@([^\s()]+)\)(?: \(ID: \d+\))?$/)?.[1].toLowerCase();
    const ids = username ? usernames.get(username) : undefined;
    const userId = idMatch ? Number(idMatch[1]) : ids?.size === 1 ? [...ids][0] : undefined;
    // Display names alone are not reliable identities. Never guess the owner.
    if (!userId) { stats.unresolved++; continue; }
    const key = JSON.stringify([userId, keyword, day]);
    const entry = buckets.get(key) || { userId, keyword, day, count: 0, lastAt: 0 };
    entry.count++;
    entry.lastAt = Math.max(entry.lastAt, timestamp);
    buckets.set(key, entry);
    stats.imported++;
  }
  stats.users = new Set([...buckets.values()].map(e => e.userId)).size;
  stats.keywords = new Set([...buckets.values()].map(e => e.keyword)).size;
  if (!apply) return stats;
  // Preserve live counters: only log events before live statistics began are imported.
  data.searchUsage ||= [];
  for (const incoming of buckets.values()) {
    const entry = data.searchUsage.find(e => e.userId === incoming.userId && e.keyword === incoming.keyword && e.day === incoming.day);
    if (entry) { entry.count += incoming.count; entry.lastAt = Math.max(entry.lastAt, incoming.lastAt); }
    else data.searchUsage.push(incoming);
  }
  data.searchHistoryImports = [...(data.searchHistoryImports || []), IMPORT_ID];
  fs.copyFileSync(dbPath, dbPath + '.before-search-history-' + Date.now() + '.bak');
  const temporary = dbPath + '.search-history.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(temporary, dbPath);
  return stats;
}
module.exports = { importHistory };
if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = name => args[args.indexOf(name) + 1];
  if (!args.includes('--db') || !args.includes('--log') || !args.includes('--before')) throw Error('Required: --db path --log path --before ISO timestamp');
  importHistory({ dbPath: path.resolve(arg('--db')), logPath: path.resolve(arg('--log')),
    before: Date.parse(arg('--before')), apply: args.includes('--apply'), stopped: args.includes('--bot-stopped') })
    .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
