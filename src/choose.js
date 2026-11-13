import {putDirectory} from './destination.js';
const button=document.getElementById('pick-directory'),chosen=document.getElementById('chosen-directory'),notice=document.getElementById('notice');
async function send(type,extra={}){const r=await chrome.runtime.sendMessage({target:'background',type,...extra});if(!r?.ok)throw new Error(r?.error||'扩展未响应');return r;}
button.onclick=async()=>{
  button.disabled=true;
  try{
    // Invoke synchronously within the click's transient user activation.
    const handle=await window.showDirectoryPicker({id:'pixiv-originals',mode:'readwrite'});
    const id=crypto.randomUUID();await putDirectory(id,handle);
    const result=await send('SET_DESTINATION',{id});
    chosen.textContent=`已选择：${result.name}`;notice.textContent='已授权。可以返回 Pixiv 开始下载，请在下载期间保留此设置页。';notice.className='';
  }catch(e){notice.textContent=e.name==='AbortError'?'已取消选择，原保存位置未改变':e.message;notice.className=e.name==='AbortError'?'':'error';}
  finally{button.disabled=false;}
};
async function init(){
  try{const r=await send('CHOOSER_CONTEXT');chosen.textContent=r.destination?`当前文件夹：${r.destination.name}${r.destination.granted?'':'（需要重新授权）'}`:'尚未选择文件夹';button.disabled=false;}
  catch(e){notice.textContent=e.message;notice.className='error';}
}
void init();
