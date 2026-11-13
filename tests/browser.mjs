import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, '.cache/ms-playwright');
const { chromium } = await import('playwright');
const runDir = path.join(root, 'test-results', `browser-${Date.now()}`);
const profile = path.join(runDir, 'profile');
await mkdir(profile, {recursive:true});
const report = { startedAt:new Date().toISOString(), runDir, networkMode:'Pixiv HTML routed by Playwright; real service-worker API and offscreen CDN fetches fulfilled through CDP Fetch.', directoryMode:'Only window.showDirectoryPicker is stubbed on choose.html, returning a real OPFS FileSystemDirectoryHandle. Real extension IndexedDB, permissions, cross-context handles, file creation and writes are exercised. The OS directory dialog and external filesystem permission lifetime are not tested in headless Chromium.', checks:[], errors:[], apiRequests:[], resourceRequests:[] };
const check = (name, data = {}) => { report.checks.push({name, ...data}); console.log(`PASS ${name}`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout=20000) {
  const start=Date.now();
  while(Date.now()-start<timeout) { const value=await fn(); if(value)return value; await wait(100); }
  throw new Error(`Timeout: ${label}`);
}
const extensionPath=path.join(root,'dist');
let context, worker, setup;
let releaseSlow;
try {
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:1200,height:900},args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`]});
  await context.addInitScript(()=>{
    if(location.protocol!=='chrome-extension:'||location.pathname!=='/choose.html')return;
    window.__pickerCalls=[];
    window.showDirectoryPicker=async options=>{
      window.__pickerCalls.push(structuredClone(options));
      return (await navigator.storage.getDirectory()).getDirectoryHandle('chosen-A',{create:true});
    };
  });
  context.on('weberror',e=>report.errors.push(String(e.error())));
  worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const extensionId=new URL(worker.url()).hostname;
  report.extensionId=extensionId;
  setup=context.pages()[0]||await context.newPage();
  await setup.goto(`chrome-extension://${extensionId}/panel.html`);
  await wait(500);
  worker=context.serviceWorkers().find(w=>w.url().startsWith(`chrome-extension://${extensionId}/`))||await context.waitForEvent('serviceworker');
  worker.on('console',message=>report.errors.push(`worker ${message.type()}: ${message.text()}`));
  report.workerEnvironment=await worker.evaluate(()=>({url:location.href,chromeKeys:Object.keys(chrome),id:chrome.runtime?.id,manifest:chrome.runtime?.getManifest?.()}));
  assert.ok(!report.workerEnvironment.manifest.permissions.includes('downloads'));
  assert.equal(await worker.evaluate(()=>typeof chrome.downloads),'undefined');
  check('extension has no downloads permission or downloads API');
  const cdp=await context.newCDPSession(setup);
  const fixture=await setup.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=4;canvas.height=4;const ctx=canvas.getContext('2d');
    ctx.fillStyle='#f0314b';ctx.fillRect(0,0,4,4);const red=canvas.toDataURL('image/png');
    ctx.fillStyle='#167ac6';ctx.fillRect(0,0,4,4);const blue=canvas.toDataURL('image/png'),jpg=canvas.toDataURL('image/jpeg',0.95);
    canvas.width=8;ctx.fillStyle='#b46d0a';ctx.fillRect(0,0,8,4);return {red,blue,jpg,large:canvas.toDataURL('image/png')};
  });
  const bytes=Object.fromEntries(Object.entries(fixture).map(([key,value])=>[key,Buffer.from(value.split(',')[1],'base64')]));
  const cdn='https://i.pximg.net/img-original/img/2026/10/29/01/02/03/';
  const slow=new Promise(resolve=>{releaseSlow=resolve;});
  let slowOnce=true;
  await context.route('https://www.pixiv.net/**',async route=>{
    await route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><html><head><title>受控 Pixiv 测试</title></head><body><h1>本地网络夹具</h1><a id="recommendation" href="https://www.pixiv.net/artworks/999"><img alt="推荐作品，禁止扫描" src="${fixture.red}" data-original="${cdn}999_p0.png"></a></body></html>`});
  });
  await context.route('https://i.pximg.net/**',async route=>{
    const url=route.request().url();report.resourceRequests.push({url,headers:await route.request().allHeaders()});
    if(url===`${cdn}333_p0.png`&&slowOnce){slowOnce=false;await slow;}
    const data=url.endsWith('.jpg')?bytes.jpg:url.includes('ugoira1')?bytes.blue:bytes.red;
    await route.fulfill({status:200,contentType:url.endsWith('.jpg')?'image/jpeg':'image/png',body:data}).catch(()=>{});
  });
  const artwork=(id,extra={})=>({id,title:`测试作品 ${id}`,userName:'测试作者',userId:'456',pageCount:1,illustType:0,urls:{original:`${cdn}${id}_p0.png`},...extra});
  const responses={
    '111':artwork('111',{pageCount:2}),
    '111/pages':[{urls:{original:`${cdn}111-757d4d64b92a41c496c04aa34ae56855_p0.png`}},{urls:{original:`${cdn}111-0123456789abcdef0123456789abcdef_p1.jpg`}}],
    '222':artwork('222',{illustType:2,urls:{original:`${cdn}222_ugoira0.png`}}),
    '222/ugoira_meta':{originalSrc:'https://i.pximg.net/img-zip-ugoira/222_playback.zip',frames:[{file:'000000.jpg',delay:65},{file:'000001.jpg',delay:125}]},
    '333':artwork('333'),'333/pages':[{urls:{original:`${cdn}333_p0.png`}}],
    '444':artwork('444',{illustType:2,urls:{original:`${cdn}444_ugoira0.png`}}),
    '444/ugoira_meta':{frames:[{file:'000000.png',delay:80},{file:'000001.png',delay:120}]},
    '555':artwork('555',{illustType:2,urls:{original:`${cdn}555-757d4d64b92a41c496c04aa34ae56855_ugoira0.png`}}),
    '555/ugoira_meta':{frames:[7,13,1001,660000].map((delay,i)=>({file:`${String(i).padStart(6,'0')}.png`,delay}))},
  };
  async function interceptTarget(targetId, patterns, onRequest) {
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:false});
  let commandId=0;
  const pending=new Map();
  const targetCommand=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++commandId;pending.set(id,{resolve,reject});
    cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(reject);
  });
  cdp.on('Target.receivedMessageFromTarget',async event=>{
    if(event.sessionId!==sessionId)return;const data=JSON.parse(event.message);
    if(data.id){const callback=pending.get(data.id);pending.delete(data.id);if(data.error)callback?.reject(new Error(data.error.message));else callback?.resolve(data.result);return;}
    if(data.method==='Fetch.requestPaused'){
      const {requestId,request}=data.params;
      const response=await onRequest(request);
      await targetCommand('Fetch.fulfillRequest',{requestId,...response}).catch(()=>{});
    }
  });
  await targetCommand('Fetch.enable',{patterns});
  return targetCommand;
  }
  const workerTarget=(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.url===worker.url());
  await interceptTarget(workerTarget.targetId,[{urlPattern:'https://www.pixiv.net/*',requestStage:'Request'}],async request=>{
    report.apiRequests.push({url:request.url,headers:request.headers});
    const key=request.url.replace('https://www.pixiv.net/ajax/illust/','');
    const exists=Object.hasOwn(responses,key);
    return {responseCode:exists?200:404,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(exists?{error:false,body:responses[key]}:{error:true,message:'Unexpected fixture API request'})).toString('base64')};
  });
  // Offscreen documents are CDP "other" targets, outside Playwright page routing.
  // Attach before queueing work and intercept only their network at the protocol boundary.
  await setup.evaluate(()=>chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS','WORKERS'],justification:'受控浏览器测试网络夹具'}));
  const offscreenTarget=await until(async()=> (await cdp.send('Target.getTargets')).targetInfos.find(t=>t.url===`chrome-extension://${extensionId}/offscreen.html`),'offscreen target');
  await interceptTarget(offscreenTarget.targetId,[{urlPattern:'https://i.pximg.net/*',requestStage:'Request'}],async request=>{
    const url=request.url;report.resourceRequests.push({url,headers:request.headers,source:'offscreen CDP Fetch'});
    if(url===`${cdn}333_p0.png`&&slowOnce){slowOnce=false;await slow;}
    const body=url.endsWith('.jpg')?bytes.jpg:url.endsWith('444_ugoira1.png')?bytes.large:url.includes('ugoira1')?bytes.blue:bytes.red;
    return {responseCode:200,responseHeaders:[{name:'Content-Type',value:url.endsWith('.jpg')?'image/jpeg':'image/png'}],body:body.toString('base64')};
  });
  for(const url of ['https://www.pixiv.net/artworks/111','https://www.pixiv.net/en/artworks/222','https://www.pixiv.net/artworks/111','https://www.pixiv.net/artworks/999']) {const page=await context.newPage();await page.goto(url);}
  const windows=await setup.evaluate(async()=>{
    const tabs=await chrome.tabs.query({});const first=tabs.find(t=>t.url==='https://www.pixiv.net/artworks/111'),excluded=tabs.find(t=>t.url==='https://www.pixiv.net/artworks/999');
    const other=await chrome.windows.create({tabId:excluded.id,focused:false});return {target:first.windowId,other:other.id};
  });
  const artworkPage=await until(()=>context.pages().find(p=>p.url()==='https://www.pixiv.net/artworks/111'),'fixture artwork tab');
  await artworkPage.waitForLoadState('domcontentloaded');
  const host=artworkPage.locator('#pixiv-original-downloader');await host.waitFor();
  const box=await host.boundingBox();assert.ok(box);await artworkPage.mouse.click(box.x+box.width/2,box.y+box.height/2);
  const panel=await until(()=>artworkPage.frames().find(frame=>frame.url().includes('panel.html?embedded=1')),'embedded panel');
  await panel.locator('#window').waitFor();
  await until(async()=>(await panel.locator('#context').innerText()).includes('本窗口有 2 个'),'embedded artwork context');
  assert.ok(await panel.locator('#window').isDisabled());
  assert.ok(await panel.locator('#current').isDisabled());
  assert.match(await panel.locator('#destination').innerText(),/尚未选择/);
  check('embedded panel discovers exactly two unique artwork IDs in its own window');
  const storage=()=>setup.evaluate(async()=> (await chrome.storage.local.get('jobs')).jobs||[]);
  const readFolder=()=>setup.evaluate(async()=>{
    const directory=await (await navigator.storage.getDirectory()).getDirectoryHandle('chosen-A');
    const entries=[];
    for await(const [name,handle] of directory.entries()){
      entries.push({name,kind:handle.kind,bytes:handle.kind==='file'?Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer())):null});
    }
    return entries.sort((a,b)=>a.name.localeCompare(b.name));
  });
  const sourceContext=await panel.evaluate(()=>chrome.runtime.sendMessage({target:'background',type:'CONTEXT'}));
  assert.equal(sourceContext.context.windowId,windows.target);
  const chooserEvent=context.waitForEvent('page');
  await panel.locator('#choose').click();
  const chooser=await chooserEvent;
  await chooser.waitForURL(`chrome-extension://${extensionId}/choose.html?token=*`);
  await until(async()=>!(await chooser.locator('#pick-directory').isDisabled()),'authorized top-level directory chooser');
  const chooserContext=await chooser.evaluate(()=>chrome.runtime.sendMessage({target:'background',type:'CHOOSER_CONTEXT'}));
  assert.equal(chooserContext.windowId,windows.target);
  assert.equal(chooserContext.destination,null);
  await chooser.locator('#pick-directory').click();
  await until(async()=>(await chooser.locator('#chosen-directory').innerText()).includes('已选择：chosen-A'),'selected directory persisted');
  assert.deepEqual(await chooser.evaluate(()=>window.__pickerCalls),[{id:'pixiv-originals',mode:'readwrite'}]);
  const selected=await setup.evaluate(async windowId=>{
    const {destinations}=await chrome.storage.local.get('destinations');
    const [active]=await chrome.tabs.query({windowId,active:true});
    return {destinations,activeTabId:active.id};
  },windows.target);
  assert.deepEqual(Object.keys(selected.destinations),[String(windows.target)]);
  assert.equal(selected.destinations[windows.target].name,'chosen-A');
  assert.equal(selected.activeTabId,sourceContext.context.tabId);
  await until(async()=>!(await panel.locator('#window').isDisabled()),'embedded window action ready after directory selection');
  assert.match(await panel.locator('#destination').innerText(),/^chosen-A$/);
  check('directory required before downloading; real chooser binds OPFS handle through IDB and returns to source tab',{windowId:windows.target,sourceTabId:sourceContext.context.tabId,pickerCalls:1});
  await panel.locator('#window').click();
  await until(async()=>{const jobs=await storage();const failed=jobs.find(j=>['failed','partial','interrupted'].includes(j.status));if(failed)throw new Error(JSON.stringify(failed));return jobs.length===2&&jobs.every(j=>j.status==='complete')&&jobs;},'static and GIF files written',45000);
  let jobs=await storage();assert.deepEqual(jobs.map(j=>j.artworkId),['111','222']);assert.ok(jobs.every(j=>j.windowId===windows.target));
  assert.ok(jobs.every(j=>j.destinationId===selected.destinations[windows.target].id&&j.destinationName==='chosen-A'));
  check('window action snapshots own window and deduplicates duplicate 111 tabs', {jobs:jobs.map(j=>({artworkId:j.artworkId,windowId:j.windowId,status:j.status}))});
  let files=await readFolder();
  const originalNames=['111-757d4d64b92a41c496c04aa34ae56855_p0.png','111-0123456789abcdef0123456789abcdef_p1.jpg'];
  assert.deepEqual(files.map(f=>f.name).sort(),[...originalNames,'222_ugoira.gif'].sort());
  assert.ok(files.every(f=>f.kind==='file'));
  const savedBytes=name=>{const file=files.find(f=>f.name===name);assert.ok(file,`Missing saved file ${name}`);return Buffer.from(file.bytes);};
  assert.deepEqual(savedBytes(originalNames[0]),bytes.red);
  assert.deepEqual(savedBytes(originalNames[1]),bytes.jpg);
  assert.deepEqual(jobs.find(j=>j.artworkId==='111').outputs,originalNames);
  assert.deepEqual(jobs.find(j=>j.artworkId==='222').outputs,['222_ugoira.gif']);
  assert.ok(report.resourceRequests.some(r=>r.url===`${cdn}111-757d4d64b92a41c496c04aa34ae56855_p0.png`));
  assert.ok(report.resourceRequests.some(r=>r.url===`${cdn}111-0123456789abcdef0123456789abcdef_p1.jpg`));
  assert.ok(report.resourceRequests.every(r=>!r.url.endsWith('/111_p0.png')&&!r.url.endsWith('/111_p1.jpg')));
  check('offscreen writes exact hashed PNG/JPG bytes and GIF-only output into selected directory',{files:files.map(({name,bytes})=>({name,size:bytes.length}))});
  const gif=savedBytes('222_ugoira.gif');
  const decoded=await setup.evaluate(async data=>{
    const decoder=new ImageDecoder({data:new Uint8Array(data),type:'image/gif'});await decoder.tracks.ready;const track=decoder.tracks.selectedTrack;
    const frames=[];for(let i=0;i<track.frameCount;i++){const {image}=await decoder.decode({frameIndex:i});frames.push({duration:image.duration,width:image.displayWidth,height:image.displayHeight});image.close();}decoder.close();return frames;
  },Array.from(gif));
  assert.equal(decoded.length,2);assert.deepEqual(decoded.map(f=>f.duration),[70000,120000]);assert.ok(decoded.every(f=>f.width===4&&f.height===4));
  check('actual generated GIF decodes with two frames and cumulative rounded timing',{decoded});
  await panel.locator('#current').click();
  await until(async()=>{const saved=await storage();return saved.length===3&&saved.every(j=>j.status==='complete');},'same-name repeated current artwork saved',30000);
  jobs=await storage();files=await readFolder();
  const copiedNames=['111-757d4d64b92a41c496c04aa34ae56855_p0 (1).png','111-0123456789abcdef0123456789abcdef_p1 (1).jpg'];
  assert.deepEqual(jobs.at(-1).outputs,copiedNames);
  assert.deepEqual(files.map(f=>f.name).sort(),[...originalNames,...copiedNames,'222_ugoira.gif'].sort());
  for(const name of [originalNames[0],copiedNames[0]])assert.deepEqual(savedBytes(name),bytes.red);
  for(const name of [originalNames[1],copiedNames[1]])assert.deepEqual(savedBytes(name),bytes.jpg);
  assert.equal((await chooser.evaluate(()=>window.__pickerCalls)).length,1);
  check('repeat saves add (1) without changing existing bytes or requesting another directory',{outputs:copiedNames});
  assert.ok(report.apiRequests.every(r=>!r.url.includes('/999')));
  assert.ok(report.resourceRequests.every(r=>!r.url.includes('999')&&!r.url.includes('playback')));
  check('other-window artwork, recommendation original and playback ZIP were never requested');
  const rules=await worker.evaluate(()=>chrome.declarativeNetRequest.getDynamicRules());
  assert.equal(rules[0].condition.initiatorDomains[0],extensionId);assert.ok(rules[0].condition.requestDomains.includes('i.pximg.net'));
  check('DNR Referer rule is scoped to extension initiator and Pixiv hosts',{rules});

  const cancelPage=await context.newPage();await cancelPage.goto('https://www.pixiv.net/artworks/333');
  const tab333=await setup.evaluate(async windowId=>{const [tab]=await chrome.tabs.query({url:'https://www.pixiv.net/artworks/333'});await chrome.tabs.move(tab.id,{windowId,index:-1});return tab;},windows.target);
  const cancelHost=cancelPage.locator('#pixiv-original-downloader');await cancelHost.waitFor();const cancelBox=await cancelHost.boundingBox();await cancelPage.mouse.click(cancelBox.x+cancelBox.width/2,cancelBox.y+cancelBox.height/2);
  const cancelPanel=await until(()=>cancelPage.frames().find(frame=>frame.url().includes('embedded=1')),'cancel embedded panel');
  await until(async()=>!(await cancelPanel.locator('#current').isDisabled()),'current action ready');await cancelPanel.locator('#current').click();
  await until(()=>report.resourceRequests.some(r=>r.url.endsWith('333_p0.png')),'slow original fetch started');
  const cancelJob=cancelPanel.locator('article.job').filter({hasText:'#333'});
  await cancelJob.getByRole('button',{name:'取消',exact:true}).click();
  await until(async()=>(await storage()).find(j=>j.artworkId==='333')?.status==='canceled','canceled state');
  releaseSlow();await wait(700);
  assert.equal((await storage()).find(j=>j.artworkId==='333').outputs.length,0);
  assert.ok((await readFolder()).every(f=>!f.name.startsWith('333')));
  await cancelJob.getByRole('button',{name:'重试整个作品',exact:true}).click();
  await until(async()=>(await storage()).find(j=>j.artworkId==='333')?.status==='complete','explicit retry complete',30000);
  files=await readFolder();
  const saved333=files.filter(f=>f.name.startsWith('333'));assert.equal(saved333.length,1);assert.equal(saved333[0].name,'333_p0.png');assert.deepEqual(Buffer.from(saved333[0].bytes),bytes.red);
  check('current iframe action cancels in-flight fetch; explicit retry saves one complete original',{tabId:tab333.id});

  const failedPage=await context.newPage();await failedPage.goto('https://www.pixiv.net/artworks/444');
  await setup.evaluate(async windowId=>{const [tab]=await chrome.tabs.query({url:'https://www.pixiv.net/artworks/444'});await chrome.tabs.move(tab.id,{windowId,index:-1});},windows.target);
  const failedHost=failedPage.locator('#pixiv-original-downloader');await failedHost.waitFor();const failedBox=await failedHost.boundingBox();await failedPage.mouse.click(failedBox.x+failedBox.width/2,failedBox.y+failedBox.height/2);
  const failedPanel=await until(()=>failedPage.frames().find(frame=>frame.url().includes('embedded=1')),'failure embedded panel');
  await until(async()=>!(await failedPanel.locator('#current').isDisabled()),'failure current action ready');await failedPanel.locator('#current').click();
  const failedJob=await until(async()=>{const job=(await storage()).find(j=>j.artworkId==='444');return job?.status==='failed'&&job;},'GIF failure with no saved output',30000);
  assert.deepEqual(failedJob.outputs,[]);assert.match(failedJob.error,/尺寸不一致/);assert.doesNotMatch(failedJob.error,/ZIP/i);
  files=await readFolder();assert.ok(files.every(f=>!f.name.startsWith('444')&&!f.name.endsWith('.zip')));
  check('GIF conversion failure reports failed with no GIF, frame files or ZIP saved',{error:failedJob.error});

  // Open the actual toolbar action where supported by this Chromium build.
  const popupEvent=context.waitForEvent('page',{timeout:4000}).catch(()=>null);
  const popupResult=await setup.evaluate(async windowId=>{
    try {const tabs=await chrome.tabs.query({windowId,url:'https://www.pixiv.net/artworks/111'});await chrome.windows.update(windowId,{focused:true});await chrome.tabs.update(tabs[0].id,{active:true});await chrome.action.openPopup({windowId});return {ok:true};}
    catch(error){return {ok:false,error:error.message};}
  },windows.target);
  let popup=await popupEvent;
  const actualPopup=Boolean(popup&&popupResult.ok);
  if(!actualPopup){popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId}/panel.html`);}
  await popup.locator('#refresh').waitFor();await popup.locator('#refresh').click();
  await until(async()=>(await popup.locator('#context').innerText()).includes('本窗口有 4 个'),'toolbar panel window context');
  assert.equal(await popup.locator('article.job').count(),5);
  assert.equal(await popup.locator('#current').isDisabled(),!actualPopup);
  check('toolbar panel shows own-window jobs and four unique open artworks',{actualPopup,popupResult,...(!actualPopup?{limitation:'Panel document opened in extension tab; toolbar popup unavailable in headless Chromium.'}:{})});
  await popup.screenshot({path:path.join(runDir,'panel.png'),fullPage:true});
  // Restart the actual service worker after successful saves, preserving storage
  // and the idle offscreen page. Completed jobs must not produce duplicate files.
  const versions=[];cdp.on('ServiceWorker.workerVersionUpdated',event=>versions.push(...event.versions));
  await cdp.send('ServiceWorker.enable');
  // Chrome already emits existing versions on enable; collect by requesting start.
  await cdp.send('ServiceWorker.startWorker',{scopeURL:`chrome-extension://${extensionId}/`});
  const version=await until(()=>versions.find(v=>v.scriptURL===`chrome-extension://${extensionId}/background.js`&&v.runningStatus==='running'),'running worker version',5000);
  await cdp.send('ServiceWorker.stopWorker',{versionId:version.versionId});
  await setup.locator('#refresh').click();
  await until(async()=>{const saved=await storage();return saved.length===5&&saved.filter(j=>j.status==='complete').length===4&&saved.find(j=>j.artworkId==='444')?.status==='failed';},'terminal jobs retained across worker restart');
  await wait(500);
  const resumed=await setup.evaluate(async windowId=>chrome.runtime.sendMessage({target:'background',type:'CONTEXT',context:{windowId}}),windows.target);assert.ok(resumed.ok);
  const resumedFiles=await readFolder();assert.deepEqual(resumedFiles,files);
  assert.equal(resumedFiles.length,6);
  assert.equal(resumed.destination?.name,'chosen-A');assert.equal(resumed.destination?.granted,true);
  assert.equal((await chooser.evaluate(()=>window.__pickerCalls)).length,1);
  check('actual service worker restart retains complete and failed jobs, directory handle and unchanged saved files');

  const videoPage=await context.newPage();await videoPage.goto('https://www.pixiv.net/artworks/555');
  await setup.evaluate(async windowId=>{const [tab]=await chrome.tabs.query({url:'https://www.pixiv.net/artworks/555'});await chrome.tabs.move(tab.id,{windowId,index:-1});},windows.target);
  // A restarted worker has a new CDP target; install the same API fixture there.
  worker=context.serviceWorkers().find(w=>w.url().startsWith(`chrome-extension://${extensionId}/`));
  const newWorkerTarget=await until(async()=>(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.url===worker.url()),'restarted worker target');
  await interceptTarget(newWorkerTarget.targetId,[{urlPattern:'https://www.pixiv.net/*',requestStage:'Request'}],async request=>{
    report.apiRequests.push({url:request.url,headers:request.headers});
    const key=request.url.replace('https://www.pixiv.net/ajax/illust/','');
    assert.ok(Object.hasOwn(responses,key));
    return {responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({error:false,body:responses[key]})).toString('base64')};
  });
  const videoHost=videoPage.locator('#pixiv-original-downloader');await videoHost.waitFor();const videoBox=await videoHost.boundingBox();await videoPage.mouse.click(videoBox.x+videoBox.width/2,videoBox.y+videoBox.height/2);
  const videoPanel=await until(()=>videoPage.frames().find(frame=>frame.url().includes('embedded=1')),'video embedded panel');
  await until(async()=>!(await videoPanel.locator('#current').isDisabled()),'video current action ready');await videoPanel.locator('#current').click();
  const videoJob=await until(async()=>{const job=(await storage()).find(j=>j.artworkId==='555');if(job?.status==='failed')throw new Error(JSON.stringify(job));return job?.status==='complete'&&job;},'GIF limit automatic video file',45000);
  assert.equal(videoJob.outputs.length,1);
  assert.match(videoJob.outputs[0],/^555-757d4d64b92a41c496c04aa34ae56855_ugoira\.(mp4|webm)$/);
  const finalFiles=await readFolder(),videoFile=finalFiles.find(f=>f.name===videoJob.outputs[0]);assert.ok(videoFile);
  assert.equal(finalFiles.length,7);
  assert.ok(finalFiles.every(f=>!f.name.endsWith('.zip')&&!f.name.startsWith('555')||f.name===videoJob.outputs[0]));
  const videoInfo=await setup.evaluate(async file=>{
    const type=file.name.endsWith('.mp4')?'video/mp4':'video/webm';
    const url=URL.createObjectURL(new Blob([new Uint8Array(file.bytes)],{type}));const video=document.createElement('video');
    try{
      video.src=url;await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error('Saved video is not playable'));});
      return {duration:video.duration,width:video.videoWidth,height:video.videoHeight,type};
    }finally{video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
  },videoFile);
  assert.ok(Math.abs(videoInfo.duration-661.021)<0.001,JSON.stringify(videoInfo));
  assert.equal((await chooser.evaluate(()=>window.__pickerCalls)).length,1);
  check('GIF time limit automatically saves one playable video with source filename and exact total timing, without another picker',{output:videoFile.name,size:videoFile.bytes.length,...videoInfo});
  await videoPanel.locator('#jobs').screenshot({path:path.join(runDir,'video-task.png')});
  report.jobs=await storage();report.files=finalFiles.map(({name,kind,bytes})=>({name,kind,size:bytes.length}));
  const artifacts=path.join(runDir,'saved-files');await mkdir(artifacts,{recursive:true});
  for(const file of finalFiles)await writeFile(path.join(artifacts,file.name),Buffer.from(file.bytes));
  report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;console.error(error);process.exitCode=1;
  if(setup){report.jobs=await setup.evaluate(async()=> (await chrome.storage.local.get('jobs')).jobs||[]).catch(()=>[]);}
}
finally{
  releaseSlow?.();
  if(context)await context.close().catch(()=>{});
  report.finishedAt=new Date().toISOString();
  await writeFile(path.join(runDir,'report.json'),JSON.stringify(report,null,2));
  await writeFile(path.join(root,'test-results/browser-latest.json'),JSON.stringify({runDir,status:report.status,report:path.join(runDir,'report.json')},null,2));
  console.log(`Browser report: ${path.join(runDir,'report.json')}`);
}
