const assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wm-selected-'));
Object.assign(process.env,{BOT_TOKEN:'offline',SUPER_ADMIN_ID:'1',ADMIN_IDS:'2',WATERMARK_ENABLED:'true',DATABASE_PATH:path.join(root,'bot.db')});
const {WatermarkHandler:H}=require('../dist/bot/handlers/WatermarkHandler');
const {UploadHandler:U}=require('../dist/bot/handlers/UploadHandler');
const {watermarkService}=require('../dist/services/watermark');
const items=[{id:1,keyword:'11',uploaded_by:1,file_type:'photo'},{id:2,keyword:'22',uploaded_by:1,file_type:'video'},
{id:3,keyword:'111',uploaded_by:1,file_type:'photo'},{id:4,keyword:'11',uploaded_by:2,file_type:'photo'}];
const replies=[];
function ctx(id=1,text='11 22',data){return {from:{id},chat:{id},message:{text},callbackQuery:data?{data}:undefined,
answerCbQuery:async()=>{},reply:async(text,extra)=>{replies.push({text,extra});return {message_id:42};}};}
const db={getAllMedia:async scope=>items.filter(x=>scope===undefined||x.uploaded_by===scope)};
(async()=>{
let captured;
watermarkService.assertReady=async()=>{};
H.runMigration=async(_t,_c,_m,rows)=>{captured=rows;H.job.running=false;};
await H.handleStart(ctx(1,'','watermark_start'),db);assert(!captured);
await H.handleConfirm(ctx(),db);
await H.handleKeywordInput(ctx(1,'11 22 11'),db);
const button=replies.at(-1).extra.reply_markup.inline_keyboard[0][0].callback_data;
items.push({id:5,keyword:'11',uploaded_by:1,file_type:'photo'});
await H.handleStart(ctx(1,'',button),db);
await new Promise(r=>setImmediate(r));
assert.deepEqual(captured.map(x=>x.id),[1,2,4]); // Superadmin sees all owners, exact preview IDs only.
captured=undefined;
await H.handleStart(ctx(1,'',button),db);assert(!captured);
await H.handleConfirm(ctx(2),db);await H.handleKeywordInput(ctx(2,'11'),db);
const childButton=replies.at(-1).extra.reply_markup.inline_keyboard[0][0].callback_data;
await H.handleStart(ctx(1,'',childButton),db);assert(!captured);
await H.handleStart(ctx(2,'',childButton),db);await new Promise(r=>setImmediate(r));
assert.deepEqual(captured.map(x=>x.id),[4]);
assert.equal(await H.handleKeywordInput(ctx(3,'11'),db),false);
console.log('PASS exact keywords, duplicate removal, immutable preview IDs, subadmin scope, token ownership/replay and legacy button rejection');
let called=false;watermarkService.processTelegramAlbum=async()=>{called=true;throw Error('unexpected watermark');};
const session={pendingMedia:[{file_id:'original',file_type:'photo'}]};
await U.prepareOriginalUploads({session,userId:1,userSessions:new Map(),db:{}});
assert(!called);assert.equal(session.pendingMedia[0].file_id,'original');
const old={pendingMedia:[{file_id:'wm',original_file_id:'raw',watermarked:true,source_chat_id:'vault',source_msg_id:9}]};
await U.prepareOriginalUploads({session:old,userId:1,userSessions:new Map(),db:{saveUserSession:async()=>{},saveImmediately:async()=>{}}});
assert.equal(old.pendingMedia[0].file_id,'raw');assert(!old.pendingMedia[0].source_msg_id);
console.log('PASS uploads always original, old upload sessions restored');
const target=path.join(root,'rollback.json');
const fixture={media:[{id:1,file_id:'wm',watermarked:true,original_file_id:'raw',source_chat_id:'wmvault',source_msg_id:7,
original_source_chat_id:'oldvault',original_source_msg_id:3,caption:'正文\n#11',keyword:'11',batchId:'b'},
{id:2,file_id:'untouched',caption:'keep'}],users:[{id:99}],userSessions:{}};
fs.writeFileSync(target,JSON.stringify(fixture));
const run=flags=>JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'rollback-watermarks.cjs'),'--db',target,...flags],{encoding:'utf8'}));
assert.equal(run([]).restored,1);assert.deepEqual(JSON.parse(fs.readFileSync(target)),fixture);
const result=run(['--apply','--bot-stopped']);assert(fs.existsSync(result.backup));
const after=JSON.parse(fs.readFileSync(target));
assert.equal(after.media[0].file_id,'raw');assert.equal(after.media[0].source_msg_id,3);
for(const k of ['caption','keyword','batchId'])assert.equal(after.media[0][k],fixture.media[0][k]);
assert.deepEqual(after.media[1],fixture.media[1]);assert.deepEqual(after.users,fixture.users);
assert.equal(run([]).restored,0);
console.log('PASS rollback dry-run, backup, originals, unrelated data preservation and idempotency');
})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
