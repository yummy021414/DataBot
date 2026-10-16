// Run against a stopped bot. Defaults to dry-run; --apply --bot-stopped writes with backup.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const { tagCaptionForMedia } = require('../dist/utils/keywordTag');
const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const projectRoot = path.resolve(__dirname, '..');
const filename = path.resolve(projectRoot, value('--db') || process.env.DATABASE_PATH || 'data/bot.db').replace(/\.db$/i, '.json');
const apply = args.includes('--apply');
if (apply && !args.includes('--bot-stopped')) throw new Error('先停止机器人，再使用 --apply --bot-stopped，避免并发覆盖数据库');
const raw = fs.readFileSync(filename);
const data = JSON.parse(raw);
if (!Array.isArray(data.media)) throw new Error('资料库格式不正确');
const groups = new Map();
for (const item of data.media) {
  const key = JSON.stringify([item.uploaded_by, item.keyword, item.is_review, item.batchId || 'legacy']);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(item);
}
let changed = 0;
const skipped = [];
for (const items of groups.values()) {
  const hasCaption = items.some(item => String(item.caption || '').trim());
  for (const [index, item] of items.entries()) {
    try {
      const updated = tagCaptionForMedia(item, !hasCaption && index === 0);
      if (updated !== item.caption) { item.caption = updated; changed++; }
    } catch (error) { skipped.push({ id: item.id, reason: error.message }); }
  }
}
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', total: data.media.length, changed, skipped }, null, 2));
if (apply && changed) {
  if (!crypto.timingSafeEqual(crypto.createHash('sha256').update(raw).digest(),
    crypto.createHash('sha256').update(fs.readFileSync(filename)).digest())) {
    throw new Error('数据库在预览期间已变化，拒绝覆盖');
  }
  const backup = filename + '.before-keyword-tags-' + new Date().toISOString().replace(/[:.]/g, '-') + '.bak';
  fs.copyFileSync(filename, backup, fs.constants.COPYFILE_EXCL);
  const temp = filename + '.tags-' + process.pid + '.tmp';
  const stat = fs.statSync(filename);
  try {
    fs.writeFileSync(temp, JSON.stringify(data), { encoding: 'utf8', flag: 'wx', mode: stat.mode });
    fs.renameSync(temp, filename);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  console.log('Backup: ' + backup);
  console.log('Database updated; existing channel messages are not edited.');
}
