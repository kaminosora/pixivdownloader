import {convertAnimation} from './animation.js';
import {encodeVideo} from './video.js';
import {getDirectory,hasWritePermission,writeOriginalFile} from './destination.js';
let active=null;
const LIMIT=128*1024*1024;
const IMAGE_TYPES={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',avif:'image/avif'};
const send=async msg=>{const r=await chrome.runtime.sendMessage({target:'background',...msg});if(!r?.ok)throw new Error(r?.error||'后台未响应');return r;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function bytes(url,signal,budget=LIMIT){
  const ctrl=new AbortController();const abort=()=>ctrl.abort();signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)ctrl.abort();
  const timer=setTimeout(()=>ctrl.abort(),90000);
  try {
    const res=await fetch(url,{credentials:'omit',signal:ctrl.signal,redirect:'error'});
    if(!res.ok)throw new Error(`原图下载失败 HTTP ${res.status}`);
    if(Number(res.headers.get('content-length'))>budget)throw new Error('原图超过 128 MiB 本地处理上限');
    if(!res.headers.get('content-type')?.startsWith('image/'))throw new Error('原图服务未返回图片，可能需要重新登录或稍后重试');
    const reader=res.body.getReader(),chunks=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>budget){await reader.cancel();throw new Error('原图超过 128 MiB 本地处理上限');}chunks.push(value);}
    if(!size)throw new Error('原图为空');
    const out=new Uint8Array(size);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.length;}return out;
  }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}
async function save(job,blob,filename){
  job.controller.signal.throwIfAborted();
  const actual=await writeOriginalFile(job.directory,filename,blob,job.controller.signal);
  await send({type:'SAVED',jobId:job.jobId,runId:job.runId,filename:actual});
}
async function run(job){
  const {plan,controller}=job;let completed=0,error='';
  const progress=(phase,n=completed)=>send({type:'PROGRESS',jobId:job.jobId,runId:job.runId,phase,completed:n});
  const heartbeat=setInterval(()=>void progress(job.phase||'正在处理').catch(()=>{}),20000);
  try{
    job.directory=await getDirectory(job.destinationId);
    if(!await hasWritePermission(job.directory))throw new Error('保存文件夹权限已失效，请重新选择文件夹后重试，并保留设置页');
    if(plan.kind==='static'){
      for(const img of plan.images){
        job.phase=`下载原图 ${completed+1}/${plan.images.length}`;await progress(job.phase);
        const data=await bytes(img.url,controller.signal);
        const type=IMAGE_TYPES[img.filename.split('.').pop()];
        if(!type)throw new Error('不支持的原图格式');
        await save(job,new Blob([data],{type}),img.filename);completed++;await progress('原图已保存',completed);await sleep(200);
      }
    }else{
      let fallbackReason='';
      const converted=await convertAnimation(plan.frames,{
        signal:controller.signal,encodeVideo,
        loadFrame:async(frame,index,signal)=>{
          const data=await bytes(frame.url,signal);
          await sleep(80);return data;
        },
        onProgress:event=>{
          if(event.phase==='fallback')fallbackReason=event.reason;
          const total=event.total||plan.frames.length;
          completed=event.completed;
          const step=event.phase==='download'?'下载动图原帧':event.phase==='gif'?'生成 GIF':event.phase==='video'?'生成视频':'GIF 超限，切换视频';
          job.phase=`${step} ${completed}/${total}${fallbackReason?` · ${fallbackReason}`:''}`;
          void progress(job.phase,completed).catch(()=>{});
        },
      });
      controller.signal.throwIfAborted();
      const filename=plan.gifFilename.replace(/\.gif$/,`.${converted.extension}`);
      job.phase=`保存 ${converted.extension.toUpperCase()}`;await progress(job.phase);
      await save(job,new Blob([converted.bytes],{type:converted.mimeType}),filename);
    }
  }catch(e){error=controller.signal.aborted?'任务已取消':e.message;}
  finally{
    clearInterval(heartbeat);
    // Keep identity until the result has been acknowledged after any worker restart.
    for(;;){try{await send({type:'DONE',jobId:job.jobId,runId:job.runId,error});break;}catch{await sleep(2000);}}
    if(active===job)active=null;
    // DONE may have raced the next RUN while active still existed; ask background to wake.
    void chrome.runtime.sendMessage({target:'background',type:'WAKE'}).catch(()=>{});
  }
}
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(msg?.target!=='offscreen'||sender.id!==chrome.runtime.id)return;
  if(msg.type==='STATE'){reply({jobId:active?.jobId||null});return;}
  if(msg.type==='CANCEL'){if(active?.jobId===msg.jobId)active.controller.abort();reply({ok:true});return;}
  if(msg.type==='RUN'){
    if(active){reply({ok:false,error:'另一个作品正在结束，请重试'});return;}
    active={jobId:msg.jobId,runId:msg.runId,plan:msg.plan,destinationId:msg.destinationId,controller:new AbortController()};reply({ok:true});void run(active);
  }
});
