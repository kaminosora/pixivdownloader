// An isolated extension frame prevents site styles and scripts from controlling the panel.
const host=document.createElement('div');host.id='pixiv-original-downloader';
host.style.cssText='position:fixed;right:20px;bottom:24px;z-index:2147483647;';
const shadow=host.attachShadow({mode:'closed'}),toggle=document.createElement('button');
toggle.textContent='↓ 原图下载';toggle.style.cssText='font:600 13px system-ui;background:#008df0;color:white;border:0;border-radius:24px;padding:12px 18px;cursor:pointer;box-shadow:0 4px 20px #003b6c30;';
toggle.setAttribute('aria-expanded','false');shadow.append(toggle);let frame=null;
toggle.onclick=()=>{
  if(frame){frame.remove();frame=null;toggle.setAttribute('aria-expanded','false');return;}
  frame=document.createElement('iframe');frame.src=chrome.runtime.getURL('panel.html?embedded=1');frame.title='Pixiv 原图下载器';
  frame.style.cssText='display:block;width:min(400px,calc(100vw - 40px));height:min(650px,calc(100vh - 110px));border:1px solid #dce6f0;border-radius:16px;margin-bottom:12px;box-shadow:0 10px 50px #14345130;background:#f5f8fc;';shadow.prepend(frame);toggle.setAttribute('aria-expanded','true');
};
document.documentElement.append(host);
function update(){const valid=/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?artworks\/[1-9]\d*\/?$/.test(location.pathname);host.style.display=valid?'block':'none';}
update();setInterval(update,1000);
