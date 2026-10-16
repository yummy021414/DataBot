// Maintenance-only: runs inside the container. Inspector must bind to loopback.
const action = process.argv[2];
if (!['pause', 'status', 'resume', 'review-photos'].includes(action)) throw Error('pause/status/resume/review-photos required');
(async () => {
  const targets = await fetch('http://127.0.0.1:9229/json/list').then(r => r.json());
  const url = targets[0]?.webSocketDebuggerUrl;
  if (!url || !url.startsWith('ws://127.0.0.1:9229/')) throw Error('Unexpected inspector address');
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const expression = `(async () => {
    const req = process.mainModule.require.bind(process.mainModule);
    const H = req('./bot/handlers/WatermarkHandler').WatermarkHandler;
    if ('${action}' === 'review-photos') {
      if (H.starting || H.job?.running) throw Error('已有水印任务，未启动重复任务');
      H.starting = true;
      try {
        const {config} = req('./config');
        const db = req('./database').database;
        const photos = (await db.getAllMedia()).filter(m => m.is_review === true && m.file_type === 'photo');
        const pending = photos.filter(m => !H.isCurrentVersion(m));
        if (!pending.length) return {running:false,total:0,message:'好评图片已全部完成'};
        await req('./services/watermark').watermarkService.assertReady(config.persistentChannelId);
        await db.saveImmediately();
        const fs = req('fs');
        const backup = '/app/data/bot.json.before-review-watermarks-' + Date.now() + '.bak';
        fs.copyFileSync('/app/data/bot.json', backup, fs.constants.COPYFILE_EXCL);
        const telegram = new (req('telegraf').Telegram)(config.botToken,{apiRoot:process.env.TELEGRAM_API_ROOT||'https://api.telegram.org'});
        const message = await telegram.sendMessage(config.superAdminId,
          '🛡️ 好评图片批量水印已启动：' + pending.length + ' 张。只处理好评图片，普通资料和视频不变。',
          {reply_markup:{inline_keyboard:[[{text:'⏸ 安全暂停',callback_data:'watermark_stop'}]]}});
        H.job = {running:true,cancelRequested:false,requestedBy:config.superAdminId,
          total:pending.length,done:0,failed:0,startedAt:new Date().toISOString()};
        const affected = H.migrationGroups(photos).filter(group=>group.some(m=>!H.isCurrentVersion(m))).flat().map(m=>({...m}));
        setImmediate(()=>void H.runMigration(telegram,config.superAdminId,message.message_id,affected,db).catch(e=>{
          H.job.running=false;H.job.lastError=String(e.message||e);console.error('[好评水印任务]',H.job.lastError);
        }));
        return {...H.job,backup};
      } finally { H.starting=false; }
    }
    if ('${action}' === 'pause' && H.job) H.job.cancelRequested = true;
    if ('${action}' === 'resume') {
      const config = req('./config').config;
      const telegram = new (req('telegraf').Telegram)(config.botToken, {apiRoot:process.env.TELEGRAM_API_ROOT||'https://api.telegram.org'});
      await H.handleStart({from:{id:config.superAdminId},chat:{id:config.superAdminId},telegram,
        reply:(text, extra)=>telegram.sendMessage(config.superAdminId,text,extra)},req('./database').database);
    }
    return H.job ? {...H.job} : null;
  })()`;
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Inspector command timed out')), 30000);
    ws.addEventListener('message', event => {
      const data = JSON.parse(event.data);
      if (data.id === 1) { clearTimeout(timer); resolve(data); }
    });
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const result = await response;
  if (result.result?.exceptionDetails || result.error) throw Error(JSON.stringify(result));
  console.log(JSON.stringify(result.result?.result?.value));
  ws.send(JSON.stringify({id:2,method:'Runtime.evaluate',params:{expression:"setTimeout(()=>process.mainModule.require('inspector').close(),200); true"}}));
  ws.close();
})().then(()=>setTimeout(()=>process.exit(0),400), e=>{console.error(e.message);process.exit(1)});
