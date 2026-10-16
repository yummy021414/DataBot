const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'review-watermark-'));
Object.assign(process.env,{BOT_TOKEN:'offline',SUPER_ADMIN_ID:'1',PERSISTENT_CHANNEL_ID:'-1001',WATERMARK_ENABLED:'true',DATABASE_PATH:path.join(root,'bot.db')});
const {UploadHandler:U}=require('../dist/bot/handlers/UploadHandler');
const {BotMode}=require('../dist/types');
const {watermarkService:wm}=require('../dist/services/watermark');
let calls=[],saved=[],failNext=false,broadcasts=0;
wm.assertReady=async()=>{};
wm.processTelegramAlbum=async(_tg,items,chat,caption)=>{
  if(failNext){failNext=false;throw Error('simulated download failure');}
  calls.push({items,chat,caption});
  return items.map((m,i)=>({fileId:m.ready?m.fileId:'wm-'+m.fileId,sourceChatId:chat,sourceMsgId:100+i,version:1}));
};
U.broadcastReviewUpdate=async()=>{broadcasts++;};
const make=()=>({mode:BotMode.AddReview,step:'confirming',currentKeyword:'11',pendingText:'is_review_mode',selectedChannels:['-200'],
pendingMedia:[{batchId:'a',file_id:'p1',file_type:'photo',caption:'反馈'},
{batchId:'a',file_id:'v1',file_type:'video'},
{batchId:'a',file_id:'p2',file_type:'photo'}]});
const db={saveUserSession:async()=>{},saveImmediately:async()=>{},clearUserSession:async()=>{},
saveMedia:async m=>{saved.push(m);return saved.length;}};
const ctx={from:{id:1},chat:{id:1},telegram:{editMessageText:async()=>{}},answerCbQuery:async()=>{},
reply:async text=>{assert(!text.startsWith('❌'),text);return {message_id:9};}};
async function prepare(session){return U.prepareOriginalUploads({telegram:ctx.telegram,userId:1,session,userSessions:new Map([[1,session]]),db});}
(async()=>{
const ordinary={...make(),mode:BotMode.Upload,pendingText:undefined};await prepare(ordinary);
assert.equal(calls.length,0);assert.equal(ordinary.pendingMedia[0].file_id,'p1');
const videoOnly={...make(),pendingMedia:[{file_type:'video',file_id:'video'}]};await prepare(videoOnly);
assert.equal(calls.length,0);
const session=make();await prepare(session);
assert.equal(calls.length,1);assert.deepEqual(calls[0].items.map(x=>x.ready),[false,true,false]);
assert.equal(calls[0].caption,'反馈\n#11');
assert.equal(session.pendingMedia[0].original_file_id,'p1');assert.equal(session.pendingMedia[1].file_id,'v1');
assert(!session.pendingMedia[1].watermarked);assert.equal(session.pendingMedia.filter(x=>x.watermarked).length,2);
await prepare(session);assert.equal(calls.length,1,'retry must not upload again');
await U.saveOnly(ctx,new Map([[1,session]]),db);
assert.equal(calls.length,1,'save must not duplicate the vault album');
assert.equal(saved.length,3);assert(saved.every(x=>x.is_review));
assert.equal(saved.filter(x=>x.caption).length,1);assert.equal(broadcasts,1);
console.log('PASS review photos only, original videos/ordinary uploads, caption, retained originals, no duplicate vault album');
const second=make();failNext=true;
await assert.rejects(prepare(second),/simulated/);assert.equal(second.pendingMedia[0].file_id,'p1');
assert(!second.pendingMedia[0].watermarked);await prepare(second);assert(second.pendingMedia[0].watermarked);
const source=make();let published;
U.runSaveAndPublishJob=async options=>{published=options.sessionSnap;};
await U.saveAndPublish(ctx,new Map([[1,source]]),db,{telegram:ctx.telegram});
assert(published.pendingMedia[0].watermarked);assert(!published.pendingMedia[1].watermarked);
assert.equal(published.pendingText,'is_review_mode');
console.log('PASS failure preserves source, retry works, save-and-publish prepares review watermarks');
})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
