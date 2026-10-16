const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { appendKeywordTag, tagCaptionForMedia } = require('../dist/utils/keywordTag');
assert.equal(appendKeywordTag('原始文案', '11'), '原始文案\n#11');
assert.equal(appendKeywordTag('原始文案\n#22\n#22', '22'), '原始文案\n#22');
assert.equal(appendKeywordTag('', '中文 关键词'), '#中文_关键词');
assert.equal(tagCaptionForMedia({keyword: '11'}, false), undefined);
assert.equal(tagCaptionForMedia({keyword: '11'}, true), '#11');
assert.throws(() => appendKeywordTag('字'.repeat(1024), '11'), /1024/);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyword-tags-check-'));
const file = path.join(dir, 'fixture.json');
const media = [
  {id:1, keyword:'11', uploaded_by:1, batchId:'a', caption:'介绍', file_id:'keep'},
  {id:2, keyword:'11', uploaded_by:1, batchId:'a'},
  {id:3, keyword:'22', uploaded_by:1, batchId:'b'},
  {id:4, keyword:'22', uploaded_by:1, batchId:'b'},
  {id:5, keyword:'33', uploaded_by:1, batchId:'c', caption:'字'.repeat(1024)}
];
fs.writeFileSync(file, JSON.stringify({media, users:[{id:1}]}));
const args = [path.join(__dirname, 'migrate-keyword-tags.cjs'), '--db', file];
const before = fs.readFileSync(file, 'utf8');
execFileSync(process.execPath, args);
assert.equal(fs.readFileSync(file, 'utf8'), before);
execFileSync(process.execPath, [...args,'--apply','--bot-stopped']);
const after = fs.readFileSync(file,'utf8');
const result = JSON.parse(after);
assert.equal(result.media[0].caption,'介绍\n#11');
assert.equal(result.media[1].caption,undefined);
assert.equal(result.media[2].caption,'#22');
assert.equal(result.media[3].caption,undefined);
assert.equal(result.media[4].caption,media[4].caption);
assert.equal(result.media[0].file_id,'keep');
assert.deepEqual(result.users,[{id:1}]);
execFileSync(process.execPath, [...args,'--apply','--bot-stopped']);
assert.equal(fs.readFileSync(file,'utf8'),after);
assert.equal(fs.readdirSync(dir).filter(f=>f.endsWith('.bak')).length,1);
console.log('PASS keyword tags: append, idempotency, empty albums, length guard, dry-run, backup, migration, unchanged media metadata');
