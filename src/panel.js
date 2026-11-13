let context=null, busy=false;
const $=id=>document.getElementById(id);
const notice=(text,error=false)=>{$('notice').textContent=text;$('notice').className=error?'error':'';};
async function send(type,extra={}){const r=await chrome.runtime.sendMessage({target:'background',type,context,...extra});if(!r?.ok)throw new Error(r?.error||'扩展未响应，请重新加载扩展');return r;}
async function refresh(){
  try{
    if(!context&&!new URLSearchParams(location.search).has('embedded')){
      const win=await chrome.windows.getCurrent();const [tab]=await chrome.tabs.query({windowId:win.id,active:true});context={windowId:win.id,tabId:tab?.id};
    }
    const r=await send('CONTEXT');context=r.context;
    $('context').textContent=`本窗口有 ${r.works.length} 个已打开作品${r.current.length?' · 当前页为作品页':''}`;
    $('destination').textContent=r.destination?`${r.destination.name}${r.destination.granted?'':'（请重新授权）'}`:'尚未选择保存文件夹';
    $('choose').textContent=r.destination?'更换 / 重新授权文件夹':'选择保存文件夹';
    $('current').disabled=!r.current.length||!r.destination?.granted||busy;$('window').disabled=!r.works.length||!r.destination?.granted||busy;
    await render();
  }catch(e){notice(e.message,true);}
}
const labels={queued:'等待中',running:'处理中',complete:'已完成',failed:'失败',partial:'部分完成',canceled:'已取消',interrupted:'已中断'};
async function render(){
  const {jobs=[]}=await chrome.storage.local.get('jobs');const shown=jobs.filter(j=>j.windowId===context?.windowId).slice().reverse();
  $('jobs').replaceChildren();
  if(!shown.length){const e=document.createElement('div');e.className='empty';e.textContent='还没有下载任务';$('jobs').append(e);return;}
  for(const j of shown){
    const box=document.createElement('article');box.className='job';
    const row=document.createElement('div');row.className='job-top';
    const title=document.createElement('span');title.className='job-title';title.textContent=j.title;title.title=j.title;
    const badge=document.createElement('span');badge.className='badge';badge.textContent=labels[j.status]||j.status;row.append(title,badge);box.append(row);
    const p=document.createElement('p');p.textContent=`#${j.artworkId} · ${j.phase}`;box.append(p);
    if(j.destinationName){const folder=document.createElement('p');folder.textContent=`保存到：${j.destinationName}`;box.append(folder);}
    if(j.status==='running'){const progress=document.createElement('progress');progress.max=j.total||1;progress.value=j.completed||0;box.append(progress);}
    if(j.outputs?.length){const out=document.createElement('p');out.className='outputs';out.textContent=`已保存 ${j.outputs.length} 个文件：${j.outputs.join('、')}`;out.title=j.outputs.join('\n');box.append(out);}
    if(j.error){const e=document.createElement('p');e.className='error-text';e.textContent=j.error;box.append(e);}
    if(j.status!=='complete'){
      const running=['running','queued'].includes(j.status),btn=document.createElement('button');btn.textContent=running?'取消':'重试整个作品';
      btn.onclick=async()=>{btn.disabled=true;try{await send(running?'CANCEL':'RETRY',{jobId:j.jobId});notice(running?'已取消，已保存的文件保留':'重试整个作品；已存在的文件会自动另存副本');}catch(e){notice(e.message,true);}await render();};box.append(btn);
    }
    $('jobs').append(box);
  }
}
for(const scope of ['current','window'])$(scope).onclick=async()=>{
  busy=true;$('current').disabled=true;$('window').disabled=true;
  try{const r=await send('START',{scope});notice(`已加入 ${r.count} 个作品；本窗口已有的等待/进行中任务自动去重。`);}catch(e){notice(e.message,true);}finally{busy=false;await refresh();}
};
$('refresh').onclick=refresh;
$('choose').onclick=async()=>{try{await send('OPEN_CHOOSER');}catch(e){notice(e.message,true);}};
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'){if(changes.destinations)void refresh();else if(changes.jobs)void render();}});
window.addEventListener('focus',()=>void refresh());
void refresh();
