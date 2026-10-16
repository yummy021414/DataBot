// Offline rollback: bot must be stopped. No Telegram messages are deleted.
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const index = args.indexOf('--db');
if (index < 0 || !args[index + 1]) throw Error('--db is required');
const target = path.resolve(args[index + 1]);
const apply = args.includes('--apply');
if (apply && !args.includes('--bot-stopped')) throw Error('Stop the bot first');
const raw = fs.readFileSync(target, 'utf8');
const data = JSON.parse(raw);
if (!Array.isArray(data.media)) throw Error('Invalid database');
const keys = ['watermarked','watermark_version','watermarked_at','watermark_album_saved','watermark_album_caption',
  'original_file_id','original_source_chat_id','original_source_msg_id'];
function restore(item) {
  if (!item.watermarked) return false;
  if (!item.original_file_id) throw Error('Missing original for #' + item.id);
  item.file_id = item.original_file_id;
  if (item.original_source_chat_id && item.original_source_msg_id) {
    item.source_chat_id = item.original_source_chat_id; item.source_msg_id = item.original_source_msg_id;
  } else { delete item.source_chat_id; delete item.source_msg_id; }
  for (const key of keys) delete item[key];
  return true;
}
const restored = data.media.filter(restore).length;
let restoredSessionItems = 0;
for (const s of Object.values(data.userSessions || {}))
  for (const m of s.pendingMedia || []) if (restore(m)) restoredSessionItems++;
let backup;
if (apply && (restored || restoredSessionItems)) {
  if (fs.readFileSync(target, 'utf8') !== raw) throw Error('Database changed');
  backup = target + '.before-watermark-rollback-' + Date.now() + '.bak';
  fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
  const temporary = target + '.rollback-' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { flag: 'wx' });
  fs.renameSync(temporary, target);
}
console.log(JSON.stringify({applied:apply,restored,restoredSessionItems,totalRecords:data.media.length,backup}));
