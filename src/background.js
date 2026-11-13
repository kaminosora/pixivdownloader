import {selectWorks,loadArtwork} from './core.js';
import {enqueue,recover,retryJob,prune,recordSaved} from './queue.js';
import {getDirectory,hasWritePermission} from './destination.js';

let jobs=[], destinations={}, chooserRequests={}, tail=Promise.resolve(), pumping=false;
const serial = fn => {const p=tail.then(fn);tail=p.catch(()=>{});return p;};
const persist = () => chrome.storage.local.set({jobs});
const offscreenURL=chrome.runtime.getURL('offscreen.html');
const panelURL=chrome.runtime.getURL('panel.html');
const chooserURL=chrome.runtime.getURL('choose.html');
const saveChoosers=()=>chrome.storage.session.set({chooserRequests});
async function destinationFor(windowId,required=false){
  const selected=destinations[windowId];
  const granted=!!selected&&await hasWritePermission(await getDirectory(selected.id));
  if(required&&!granted)throw new Error('请先选择保存文件夹并授权写入；下载期间保留文件夹设置页');
  return selected?{...selected,granted}:null;
}
async function offscreenExists(){return (await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[offscreenURL]})).length>0;}
async function ensureOffscreen(){if(!await offscreenExists())await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS','WORKERS'],justification:'下载原图、转换 GIF 或视频并写入用户选择的文件夹'});}
const toOffscreen = msg => chrome.runtime.sendMessage({target:'offscreen',...msg});
const ready=(async()=>{
  const saved=await chrome.storage.local.get(['jobs','destinations']);jobs=saved.jobs||[];destinations=saved.destinations||{};
  chooserRequests=(await chrome.storage.session.get('chooserRequests')).chooserRequests||{};
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:[1],addRules:[{id:1,priority:1,action:{type:'modifyHeaders',requestHeaders:[{header:'Referer',operation:'set',value:'https://www.pixiv.net/'}]},condition:{initiatorDomains:[chrome.runtime.id],requestDomains:['i.pximg.net','www.pixiv.net'],resourceTypes:['xmlhttprequest']}}]});
  let state=null;
  if(await offscreenExists())state=await toOffscreen({type:'STATE'}).catch(()=>null);
  recover(jobs,state?.jobId); await persist();
  await chrome.alarms.create('queue-watchdog',{periodInMinutes:1});
})();

async function pump(){
  await ready;
  if(pumping)return;
  pumping=true; let attempted=false;
  try {
    if(await offscreenExists()) {const live=await toOffscreen({type:'STATE'});if(live?.jobId)return;}
    const job=await serial(async()=>{
      if(jobs.some(j=>j.status==='running'))return null;
      const j=jobs.find(j=>j.status==='queued'); if(!j)return null;
      j.status='running';j.runId=crypto.randomUUID();j.phase='读取作品原图信息';await persist();return j;
    });
    if(!job)return;
    attempted=true;
    try {
      if(!job.destinationId||!await hasWritePermission(await getDirectory(job.destinationId)))throw new Error('保存文件夹未授权，请选择文件夹后重试；下载期间保留设置页');
      const plan=await loadArtwork(job.artworkId);
      await ensureOffscreen();
      await serial(async()=>{
        if(job.status!=='running')return;
        job.title=plan.title;job.total=plan.kind==='static'?plan.images.length:plan.frames.length;await persist();
        const reply=await toOffscreen({type:'RUN',jobId:job.jobId,runId:job.runId,plan,destinationId:job.destinationId});
        if(!reply?.ok)throw new Error(reply?.error||'无法启动下载处理');
      });
    }catch(e){await serial(async()=>{if(job.status==='running'){job.status='failed';job.error=e.message;job.phase='下载失败';await persist();}});}
  } finally {pumping=false; if(attempted&&!jobs.some(j=>j.status==='running')&&jobs.some(j=>j.status==='queued'))void pump();}
}

async function contextFor(sender, supplied){
  if(sender.tab){const tab=await chrome.tabs.get(sender.tab.id);return {windowId:tab.windowId,tabId:tab.id};}
  if(!Number.isInteger(supplied?.windowId))throw new Error('无法确定发起操作的窗口，请重新打开扩展');
  await chrome.windows.get(supplied.windowId);
  return {windowId:supplied.windowId,tabId:supplied.tabId};
}

async function handle(msg,sender){
  await ready;
  if(sender.id!==chrome.runtime.id)throw new Error('不允许的消息来源');
  const isOffscreen=sender.url===offscreenURL;
  const isPanel=sender.url?.split('?')[0]===panelURL;
  const isChooser=sender.url?.split('?')[0]===chooserURL;
  if(!isOffscreen&&!isPanel&&!isChooser)throw new Error('不允许的扩展页面');
  if(isChooser){
    // The new page can load before tabs.create resolves with its tab ID.
    await serial(async()=>{});
    const token=new URL(sender.url).searchParams.get('token');
    const request=chooserRequests[token];
    if(!request||request.chooserTabId!==sender.tab?.id||request.windowId!==sender.tab?.windowId)throw new Error('选择页面已失效，请从原窗口面板重新打开');
    if(msg.type==='CHOOSER_CONTEXT')return {ok:true,windowId:request.windowId,destination:await destinationFor(request.windowId)};
    if(msg.type==='SET_DESTINATION'){
      if(typeof msg.id!=='string'||!/^[a-f0-9-]{36}$/.test(msg.id))throw new Error('目录标识无效');
      const handle=await getDirectory(msg.id);if(!await hasWritePermission(handle))throw new Error('文件夹写入权限未授予');
      await serial(async()=>{destinations[request.windowId]={id:msg.id,name:handle.name};await chrome.storage.local.set({destinations});});
      // Keep this top-level extension page alive to retain the directory grant.
      if(request.sourceTabId){try{const tab=await chrome.tabs.get(request.sourceTabId);if(tab.windowId===request.windowId)await chrome.tabs.update(tab.id,{active:true});}catch{}}
      return {ok:true,name:handle.name};
    }
    throw new Error('未知目录操作');
  }
  if(isOffscreen){
    if(msg.type==='WAKE'){void pump();return {ok:true};}
    const job=jobs.find(j=>j.jobId===msg.jobId);
    if(!job)throw new Error('任务不存在');
    // A canceled attempt may finish after the user has queued a retry.
    if(typeof msg.runId!=='string'||msg.runId!==job.runId)return {ok:true};
    if(msg.type==='PROGRESS')return serial(async()=>{
      if(job.status==='running'&&msg.runId===job.runId){Object.assign(job,{phase:String(msg.phase),completed:msg.completed??job.completed});await persist();}return {ok:true};
    });
    if(msg.type==='SAVED')return serial(async()=>{recordSaved(job,msg.runId,msg.filename);await persist();return {ok:true};});
    if(msg.type==='DONE'){
      await serial(async()=>{if(job.status==='running'&&msg.runId===job.runId)Object.assign(job,{status:msg.error?(job.outputs.length?'partial':'failed'):'complete',error:msg.error||'',phase:msg.error?'处理结束，存在失败':'下载完成'});await persist();});
      return {ok:true};
    }
    throw new Error('未知处理请求');
  }
  if(msg.type==='CONTEXT'){
    const ctx=await contextFor(sender,msg.context);
    const tabs=await chrome.tabs.query({windowId:ctx.windowId});
    return {ok:true,context:ctx,works:selectWorks(tabs,ctx.windowId),current:selectWorks(tabs,ctx.windowId,ctx.tabId),destination:await destinationFor(ctx.windowId)};
  }
  if(msg.type==='OPEN_CHOOSER'){
    const ctx=await contextFor(sender,msg.context);
    return serial(async()=>{
      for(const [token,req] of Object.entries(chooserRequests))if(req.windowId===ctx.windowId){
        try{const tab=await chrome.tabs.get(req.chooserTabId);if(tab.windowId===ctx.windowId&&tab.url?.startsWith(chooserURL+'?')){req.sourceTabId=ctx.tabId;await saveChoosers();await chrome.tabs.update(tab.id,{active:true});return {ok:true};}}catch{}
        delete chooserRequests[token];
      }
      const token=crypto.randomUUID();chooserRequests[token]={windowId:ctx.windowId,sourceTabId:ctx.tabId};await saveChoosers();
      const tab=await chrome.tabs.create({windowId:ctx.windowId,url:`choose.html?token=${token}`,active:true});
      chooserRequests[token].chooserTabId=tab.id;await saveChoosers();return {ok:true};
    });
  }
  if(msg.type==='START'){
    if(!['current','window'].includes(msg.scope))throw new Error('无效下载范围');
    const ctx=await contextFor(sender,msg.context);
    const destination=await destinationFor(ctx.windowId,true);
    const works=selectWorks(await chrome.tabs.query({windowId:ctx.windowId}),ctx.windowId,msg.scope==='current'?ctx.tabId:null);
    if(!works.length)throw new Error('此范围内没有已打开的 Pixiv 作品页');
    await serial(async()=>{const live=await offscreenExists()?await toOffscreen({type:'STATE'}):null;enqueue(jobs,works,destination);jobs=prune(jobs,live?.jobId);await persist();});void pump();return {ok:true,count:works.length};
  }
  if(['CANCEL','RETRY'].includes(msg.type)){
    const ctx=await contextFor(sender,msg.context);
    const destination=msg.type==='RETRY'?await destinationFor(ctx.windowId,true):null;
    await serial(async()=>{
      const job=jobs.find(j=>j.jobId===msg.jobId&&j.windowId===ctx.windowId);if(!job)throw new Error('当前窗口中没有此任务');
      if(msg.type==='RETRY')retryJob(job,destination);
      else if(['queued','running'].includes(job.status)){
        job.status='canceled';job.phase='已取消';
        if(await offscreenExists())await toOffscreen({type:'CANCEL',jobId:job.jobId});
      }
      await persist();
    });void pump();return {ok:true};
  }
  throw new Error('未知操作');
}
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(msg?.target!=='background')return;
  handle(msg,sender).then(reply,e=>reply({ok:false,error:e.message}));return true;
});
chrome.alarms.onAlarm.addListener(()=>void (async()=>{
  await ready;
  const live=await offscreenExists()?await toOffscreen({type:'STATE'}).catch(()=>null):null;
  if(!pumping)await serial(async()=>{recover(jobs,live?.jobId);await persist();});
  void pump();
})());
ready.then(()=>pump()).catch(console.error);
