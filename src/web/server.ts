import express from 'express';
import path from 'path';
import fs from 'fs';
import { database } from '../database';
import { Telegraf } from 'telegraf';
import axios from 'axios';
import https from 'https';

// 安全转义函数
function escapeHtmlAttribute(str: string): string {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '&#92;');
}

export function startWebServer(bot: Telegraf) {
  const app = express();
  const PORT = process.env.PORT || 3000;
  const albumsDir = path.join(process.cwd(), 'data/public/albums');

  const httpsAgent = new https.Agent();

  if (!fs.existsSync(albumsDir)) fs.mkdirSync(albumsDir, { recursive: true });
  app.use('/media', express.static(albumsDir));

  // 健康检查 / 首页（避免域名打开只看到空白 404）
  app.get('/', (_req, res) => {
    res.status(200).type('html').send(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>相册服务</title></head>' +
      '<body style="font-family:sans-serif;padding:40px;">' +
      '<h1>相册服务运行中</h1>' +
      '<p>请使用机器人生成的完整链接访问，例如：<code>/v/album_xxxx</code></p>' +
      '</body></html>'
    );
  });
  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, service: 'album-web' });
  });

  app.get('/proxy/:fileId', async (req, res) => {
    const { fileId } = req.params;
    try {
      const fileLink = await bot.telegram.getFileLink(fileId);
      
      // 🚀 核心加速：如果配置了中转代理，将官方链接替换为加速地址
      let downloadUrl = fileLink.href;
      const apiRoot = process.env.TELEGRAM_API_ROOT;
      if (apiRoot && apiRoot !== 'https://api.telegram.org') {
        downloadUrl = downloadUrl.replace('https://api.telegram.org', apiRoot);
        console.log(`[图片加速] 正在通过中转下载: ${fileId}`);
      }

      const response = await axios({ 
        method: 'get', 
        url: downloadUrl, 
        responseType: 'stream', 
        timeout: 40000, 
        httpsAgent: httpsAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 增加缓存时间到 24 小时
      response.data.pipe(res);
      req.on('close', () => { if (response.data) response.data.destroy(); });
    } catch (error: any) {
      console.error(`[代理错误] 文件ID: ${fileId} | 错误:`, error.message);
      if (!res.headersSent) res.status(404).send('Image unavailable');
    }
  });

  app.get('/favicon.ico', (req, res) => res.status(204).end());

  app.get('/v/:id', async (req, res) => {
    const albumId = req.params.id;
    const albumData = await database.getAlbum(albumId);

    if (!albumData) {
      return res.status(404).send('<h1>相册不存在</h1>');
    }

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const { groups, name } = albumData;
    const safeAlbumName = escapeHtmlAttribute(name || '相册');

    const menuHtml = groups.map((g: any, index: number) => {
      const safeId = escapeHtmlAttribute(g.id);
      return `<div class="menu-item ${index === 0 ? 'active' : ''}" id="menu-${safeId}" onclick="switchGroup('${safeId}',this)"><span>第 ${index + 1} 组</span><span class="badge">${g.files.length}P</span></div>`;
    }).join('');

    const contentHtml = groups.map((g: any, groupIndex: number) => {
      const safeId = escapeHtmlAttribute(g.id);
      const safeCaption = escapeHtmlAttribute(g.caption || '精选资料');
      
      const galleryHtml = (Array.isArray(g.files) ? g.files : []).map((file: any, idx: number) => {
        const fileId = typeof file === 'string' ? file : file.id;
        const isVideo = file.type === 'video';
        // 本地路径（含 /）走静态目录；旧相册照片仍走 Telegram 代理
        const isLocalPath = typeof fileId === 'string' && fileId.includes('/');
        const url = (isVideo || isLocalPath) ? `/media/${albumId}/${fileId}` : `/proxy/${fileId}`;
        const uniqueVideoId = `video_${groupIndex}_${idx}`;
        
        if (isVideo) {
          // 初始不设置 src，避免手机端崩溃；点击后可暂停/播放
          return `<div class="item video-item" data-src="${url}" data-vid="${uniqueVideoId}">
                    <video id="${uniqueVideoId}" muted loop playsinline webkit-playsinline></video>
                    <div class="video-overlay" onclick="toggleVideo('${uniqueVideoId}',this)">
                        <div class="play-icon"></div>
                    </div>
                    <button type="button" class="video-ctrl-btn" onclick="event.stopPropagation(); toggleVideo('${uniqueVideoId}', this.parentElement.querySelector('.video-overlay'))" aria-label="播放/暂停">⏸</button>
                  </div>`;
        } else {
          // 🚀 增加图片错误处理和加载状态
          return `<div class="item img-item" onclick="openLightbox('${url}',false)">
                    <img src="${url}" loading="lazy" onload="this.parentElement.classList.add('loaded')" onerror="handleImgError(this)">
                    <div class="img-placeholder">⌛ 加载中...</div>
                  </div>`;
        }
      }).join('');

      const nextBtn = groupIndex < groups.length - 1 ? `<button class="next-group-btn" onclick="goToNextGroup(${groupIndex + 1})">探索下一组资料</button>` : '';
      return `<section class="group-container ${groupIndex === 0 ? 'active' : ''}" id="container-${safeId}"><div class="group-caption">${safeCaption}</div><div class="gallery">${galleryHtml}</div>${nextBtn}</section>`;
    }).join('');

    res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>${safeAlbumName}</title>
<style>
:root{--primary:#667eea;--secondary:#764ba2;--bg:#f8faff;--text:#2d3436;--glass:rgba(255,255,255,0.75);--card:#fff;--transition:all 0.4s cubic-bezier(0.23,1,0.32,1);}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
body{background:linear-gradient(135deg,#fafaff 0%,#f5f7ff 50%,#fef5ff 100%);color:var(--text);font-family:-apple-system,"PingFang SC",sans-serif;display:flex;height:100vh;overflow:hidden;}
.sidebar{width:300px;margin:25px;background:var(--glass);backdrop-filter:blur(30px);border-radius:35px;display:flex;flex-direction:column;border:1px solid rgba(255,255,255,0.6);box-shadow:0 20px 60px rgba(0,0,0,0.03);flex-shrink:0;}
.sidebar-header{padding:40px 25px 20px;text-align:center;border-bottom:1px solid rgba(0,0,0,0.04);}
.sidebar-header h2{font-size:1.6rem;font-weight:900;background:linear-gradient(135deg,var(--primary),var(--secondary));-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-1.5px;}
.sidebar-menu{flex:1;overflow-y:auto;padding:15px 20px;}
.menu-item{padding:18px 25px;margin-bottom:10px;border-radius:20px;cursor:pointer;transition:0.3s;color:#718096;font-weight:600;display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,0.3);}
.menu-item.active{background:white;color:var(--primary);box-shadow:0 10px 25px rgba(110,142,251,0.12);}
.main-content{flex:1;overflow-y:auto;padding:20px 45px 50px 15px;scroll-behavior:smooth;}
.group-container{display:none;max-width:1400px;margin:0 auto;}
.group-container.active{display:block;}
.group-caption{font-size:1.2rem;line-height:1.8;color:#4a5568;background:white;padding:35px;border-radius:30px;border:1px solid rgba(255,255,255,0.8);margin-bottom:40px;position:relative;border-left:8px solid var(--primary);}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(450px,1fr));grid-gap:30px;}
.item{border-radius:28px;overflow:hidden;background:#f0f2f5;transition:var(--transition);border:1px solid rgba(255,255,255,0.8);box-shadow:0 10px 30px rgba(0,0,0,0.02);position:relative;min-height:250px;display:flex;align-items:center;justify-content:center;}
.item.img-item img{opacity:0;transition:opacity 0.5s ease-in-out;}
.item.img-item.loaded img{opacity:1;}
.item.img-item.loaded .img-placeholder{display:none;}
.img-placeholder{position:absolute;color:#a0aec0;font-size:0.9rem;font-weight:600;}
.item:hover{transform:translateY(-10px);box-shadow:0 30px 60px rgba(110,142,251,0.15);}
.item img,.item video{width:100%;height:auto;display:block;object-fit:cover;}
.video-item video{cursor:pointer;}
.video-overlay{position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.05);display:flex;justify-content:center;align-items:center;cursor:pointer;z-index:5;transition:background .2s;}
.video-overlay.playing{background:transparent;pointer-events:none;}
.play-icon{width:80px;height:80px;background:rgba(255,255,255,0.95);border-radius:50%;display:flex;justify-content:center;align-items:center;box-shadow:0 10px 30px rgba(0,0,0,0.2);transition:opacity .2s,transform .2s;}
.play-icon::before{content:'';border-left:25px solid var(--primary);border-top:15px solid transparent;border-bottom:15px solid transparent;margin-left:8px;}
.video-overlay.paused .play-icon::before,.video-overlay:not(.playing) .play-icon::before{border-left:25px solid var(--primary);border-top:15px solid transparent;border-bottom:15px solid transparent;width:auto;height:auto;box-shadow:none;margin-left:8px;}
.video-overlay.playing .play-icon{opacity:0;transform:scale(.9);}
.video-ctrl-btn{position:absolute;right:14px;bottom:14px;z-index:8;width:48px;height:48px;border:none;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:20px;cursor:pointer;display:none;align-items:center;justify-content:center;backdrop-filter:blur(6px);}
.video-item.is-playing .video-ctrl-btn{display:flex;}
.video-item.is-playing .video-ctrl-btn::after{content:'';display:none;}
.next-group-btn{display:block;width:fit-content;margin:80px auto 20px;padding:20px 60px;background:linear-gradient(135deg,var(--primary),var(--secondary));color:white;border-radius:100px;font-size:1.1rem;font-weight:800;border:none;cursor:pointer;box-shadow:0 15px 35px rgba(110,142,251,0.3);}
@media (max-width:768px){body{flex-direction:column;}.sidebar{width:calc(100% - 30px);margin:15px;height:auto;position:sticky;top:0;z-index:100;}.sidebar-header{display:none;}.sidebar-menu{display:flex;overflow-x:auto;padding:10px;}.menu-item{white-space:nowrap;margin:0 5px;}.gallery{grid-template-columns:1fr;}.video-ctrl-btn{width:56px;height:56px;font-size:22px;}}
#lightbox{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.98);display:none;z-index:1000;justify-content:center;align-items:center;backdrop-filter:blur(15px);}
#lightbox.active{display:flex;}
#lightbox img,#lightbox video{max-width:95%;max-height:85vh;border-radius:20px;}
.nav-btn{position:absolute;bottom:40px;width:55px;height:55px;background:rgba(255,255,255,0.15);color:white;font-size:25px;border-radius:50%;display:flex;justify-content:center;align-items:center;cursor:pointer;}
</style>
</head>
<body>
<aside class="sidebar"><div class="sidebar-header"><h2>精选相册</h2></div><nav class="sidebar-menu">${menuHtml}</nav></aside>
<main class="main-content">${contentHtml}</main>
<div id="lightbox"><span style="position:absolute;top:20px;right:20px;font-size:40px;color:#fff;cursor:pointer;" onclick="closeLightbox()">&times;</span><div class="nav-btn" style="left:20%" onclick="prevMedia()">&#10094;</div><div id="lightbox-content"></div><div class="nav-btn" style="right:20%" onclick="nextMedia()">&#10095;</div></div>
<script>
const groupIds = ${JSON.stringify(groups.map((g: any) => g.id))};
let currentGroupFiles=[];let currentIndex=0;

function initVideos(container){
    // 1. 先卸载所有视频，释放资源，防止内存占用过高
    document.querySelectorAll('video').forEach(v => { 
        v.pause(); 
        v.src = ""; 
        v.removeAttribute('src'); // 彻底移除src
        v.load(); 
    });
    // 2. 仅激活当前组的视频
    container.querySelectorAll('.video-item').forEach(item => {
        const v = item.querySelector('video');
        v.src = item.dataset.src;
        v.preload = "auto";
        v.load();
        // 尝试静音播放一帧以触发预览
        v.play().then(() => {
            setTimeout(() => { if(v.paused === false && v.muted) v.pause(); }, 150);
        }).catch(()=>{});
    });
}

function switchGroup(groupId, element){
    document.querySelectorAll('.menu-item').forEach(el=>el.classList.remove('active'));
    if(element) element.classList.add('active');
    document.querySelectorAll('.group-container').forEach(el=>el.classList.remove('active'));
    const target = document.getElementById('container-'+groupId);
    target.classList.add('active');
    document.querySelector('.main-content').scrollTop = 0;
    initVideos(target);
    if(window.innerWidth<=768 && element) element.scrollIntoView({behavior:'smooth',inline:'center'});
}

function goToNextGroup(idx){ const gid=groupIds[idx]; switchGroup(gid, document.getElementById('menu-'+gid)); }

function setVideoUi(v, playing){
    const item = v.parentElement;
    const overlay = item.querySelector('.video-overlay');
    const btn = item.querySelector('.video-ctrl-btn');
    if(!overlay) return;
    if(playing){
        item.classList.add('is-playing');
        overlay.classList.add('playing');
        overlay.classList.remove('paused');
        overlay.style.display = 'flex';
        if(btn) btn.textContent = '⏸';
        // 播放时启用原生控件，便于拖进度/暂停
        v.setAttribute('controls','controls');
    } else {
        item.classList.remove('is-playing');
        overlay.classList.remove('playing');
        overlay.classList.add('paused');
        overlay.style.display = 'flex';
        if(btn) btn.textContent = '▶';
        v.removeAttribute('controls');
    }
}

function toggleVideo(vid, overlay){
    const v = document.getElementById(vid);
    if(!v) return;
    if(!overlay) overlay = v.parentElement.querySelector('.video-overlay');

    if(v.paused || v.muted){
        // 停止其他正在播放的视频
        document.querySelectorAll('video').forEach(other => {
            if(other.id !== vid){
                other.pause();
                other.muted = true;
                setVideoUi(other, false);
            }
        });
        v.muted = false;
        v.play().then(() => setVideoUi(v, true)).catch(() => setVideoUi(v, false));
    } else {
        v.pause();
        setVideoUi(v, false);
    }
}

// 原生控件暂停/播放时同步按钮状态
document.addEventListener('play', (e) => {
    if(e.target && e.target.tagName === 'VIDEO') setVideoUi(e.target, true);
}, true);
document.addEventListener('pause', (e) => {
    if(e.target && e.target.tagName === 'VIDEO') setVideoUi(e.target, false);
}, true);

function handleImgError(img){
    img.src = img.src.split('?')[0] + '?t=' + Date.now(); // 尝试添加随机参数重试一次
    img.onerror = () => {
        img.parentElement.innerHTML = '<div style="color:#e53e3e;font-size:0.8rem;text-align:center;padding:20px;">🖼️ 暂不可用<br><small>请刷新页面或检查网络</small></div>';
    };
}

function openLightbox(src,isVideo){
    const container=document.querySelector('.group-container.active');
    const items=container.querySelectorAll('.item img, .group-container.active .video-item video');
    currentGroupFiles=Array.from(items).map(item=>({src:item.src || item.parentElement.dataset.src, isVideo:item.tagName==='VIDEO'}));
    currentIndex=currentGroupFiles.findIndex(f=>f.src.includes(src));
    updateLightbox(); document.getElementById('lightbox').classList.add('active');
}

function updateLightbox(){
    const content=document.getElementById('lightbox-content'); const media=currentGroupFiles[currentIndex];
    content.innerHTML=media.isVideo?'<video src="'+media.src+'" controls autoplay playsinline webkit-playsinline style="max-width:92%;max-height:85vh;"></video>':'<img src="'+media.src+'" style="max-width:92%;max-height:82vh;border-radius:20px;">';
}

function closeLightbox(){ document.getElementById('lightbox').classList.remove('active'); document.getElementById('lightbox-content').innerHTML=''; }
function nextMedia(){ currentIndex=(currentIndex+1)%currentGroupFiles.length; updateLightbox(); }
function prevMedia(){ currentIndex=(currentIndex-1+currentGroupFiles.length)%currentGroupFiles.length; updateLightbox(); }

document.addEventListener('DOMContentLoaded', () => { 
    const firstGroup = document.querySelector('.group-container.active');
    if(firstGroup) initVideos(firstGroup);
});
</script>
</body>
</html>`);
  });

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`🌐 网页服务器已启动: http://0.0.0.0:${PORT}`);
  });
}
