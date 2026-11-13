import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {access,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.env.PLAYWRIGHT_BROWSERS_PATH=path.join(root,'.cache/ms-playwright');
const {chromium}=await import('playwright');
const runDir=path.join(root,'test-results',`video-${Date.now()}`);
await mkdir(runDir,{recursive:true});
const report={startedAt:new Date().toISOString(),runDir,checks:[],errors:[],limits:['Controlled PNG inputs and local HTTP origin; real WebCodecs encoders, muxer, demuxer, decoder and HTML video element. No Pixiv account or external save-directory grant involved.','Forced codec cases filter only VideoEncoder.isConfigSupported at the browser capability boundary; encoding and media bytes are real.']};
const check=(name,data={})=>{report.checks.push({name,...data});console.log(`PASS ${name}`);};
async function bounded(promise,label){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} exceeded 45 seconds`)),45000);})]);}
  finally{clearTimeout(timer);}
}
let context,server;

// Independently inspect MP4 sample durations as integer ticks, avoiding reliance
// solely on the muxer's own demuxer for the central timing assertion.
function mp4Timing(data){
  const children=(start,end)=>{
    const result=[];
    for(let offset=start;offset+8<=end;){
      let size=data.readUInt32BE(offset),header=8;
      if(size===1){size=Number(data.readBigUInt64BE(offset+8));header=16;}
      if(size===0)size=end-offset;
      assert.ok(size>=header&&offset+size<=end,'valid MP4 box bounds');
      result.push({type:data.toString('ascii',offset+4,offset+8),start:offset+header,end:offset+size});offset+=size;
    }
    return result;
  };
  const descend=(boxes,type)=>{const box=boxes.find(b=>b.type===type);assert.ok(box,`MP4 contains ${type}`);return box;};
  const moov=descend(children(0,data.length),'moov');
  const trak=descend(children(moov.start,moov.end),'trak');
  const mdia=descend(children(trak.start,trak.end),'mdia');
  const mdhd=descend(children(mdia.start,mdia.end),'mdhd');
  const version=data[mdhd.start],timescale=data.readUInt32BE(mdhd.start+(version===1?20:12));
  const mediaDuration=version===1?Number(data.readBigUInt64BE(mdhd.start+24)):data.readUInt32BE(mdhd.start+16);
  const minf=descend(children(mdia.start,mdia.end),'minf');
  const stbl=descend(children(minf.start,minf.end),'stbl');
  const stts=descend(children(stbl.start,stbl.end),'stts');
  const count=data.readUInt32BE(stts.start+4),durations=[];
  for(let i=0;i<count;i++){
    const samples=data.readUInt32BE(stts.start+8+8*i),duration=data.readUInt32BE(stts.start+12+8*i);
    for(let sample=0;sample<samples;sample++)durations.push(duration);
  }
  return {timescale,mediaDuration,durations};
}

try{
  const entry=`
    import {encodeVideo} from './src/video.js';
    import {Input,BufferSource,ALL_FORMATS,EncodedPacketSink} from 'mediabunny';
    const colors=['#ef301a','#16cd43','#2257e8','#eacb16'];
    async function image(width,height,index){
      const c=new OffscreenCanvas(width,height),ctx=c.getContext('2d');
      ctx.fillStyle=colors[index%colors.length];ctx.fillRect(0,0,width,height);
      return new Uint8Array(await (await c.convertToBlob({type:'image/png'})).arrayBuffer());
    }
    async function inspect(result){
      const input=new Input({source:new BufferSource(result.bytes),formats:ALL_FORMATS});
      let decoder,objectUrl;
      try{
        const track=await input.getPrimaryVideoTrack();
        if(!track)throw new Error('Video track missing');
        const config=await track.getDecoderConfig(),packets=[],decoded=[];let decoderError;
        decoder=new VideoDecoder({error:e=>decoderError=e,output:frame=>{
          try{
            const canvas=new OffscreenCanvas(frame.displayWidth,frame.displayHeight),ctx=canvas.getContext('2d');
            ctx.drawImage(frame,0,0);
            decoded.push({timestamp:frame.timestamp,duration:frame.duration,width:frame.displayWidth,height:frame.displayHeight,rgb:Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3)});
          }finally{frame.close();}
        }});
        decoder.configure(config);
        for await(const packet of new EncodedPacketSink(track).packets()){
          packets.push({timestamp:packet.timestamp,duration:packet.duration,type:packet.type,size:packet.byteLength});
          // Round to the original integer microseconds at the boundary. The
          // demuxer's convenience helper truncates floating-point products.
          decoder.decode(new EncodedVideoChunk({data:packet.data,type:packet.type,timestamp:Math.round(packet.timestamp*1e6),duration:Math.round(packet.duration*1e6)}));
        }
        await decoder.flush();if(decoderError)throw decoderError;
        const video=document.createElement('video');video.preload='auto';video.muted=true;
        objectUrl=URL.createObjectURL(new Blob([result.bytes],{type:result.mimeType}));
        const playback=await new Promise((resolve,reject)=>{
          const timeout=setTimeout(()=>reject(new Error('Video loadeddata timed out')),15000);
          video.onloadeddata=()=>{clearTimeout(timeout);resolve({duration:video.duration,width:video.videoWidth,height:video.videoHeight,readyState:video.readyState});};
          video.onerror=()=>{clearTimeout(timeout);reject(new Error('HTML video error '+video.error?.message));};
          video.src=objectUrl;
        });
        video.removeAttribute('src');video.load();
        return {mimeType:result.mimeType,extension:result.extension,codec:await track.getCodec(),configCodec:config.codec,width:await track.getDisplayWidth(),height:await track.getDisplayHeight(),audioTracks:(await input.getAudioTracks()).length,trackDuration:await track.computeDuration(),packets,decoded,playback,bytes:Array.from(result.bytes)};
      }finally{if(decoder&&decoder.state!=='closed')decoder.close();if(objectUrl)URL.revokeObjectURL(objectUrl);input.dispose();}
    }
    window.runVideo=async ({delays,width=64,height=36,codec=null})=>{
      const original=VideoEncoder.isConfigSupported.bind(VideoEncoder),attempted=[];
      VideoEncoder.isConfigSupported=async config=>{
        attempted.push(config.codec);
        if(codec&&!config.codec.startsWith(codec))return {supported:false,config};
        return original(config);
      };
      const progress=[],events=[];
      try{
        async function* frames(){for(let i=0;i<delays.length;i++){events.push('load:'+i);yield {bytes:await image(width,height,i),delay:delays[i]};}}
        const result=await encodeVideo(frames(),{onProgress:n=>{progress.push(n);events.push('encoded:'+n);}});
        return {...await inspect(result),progress,events,attempted};
      }finally{VideoEncoder.isConfigSupported=original;}
    };
    window.cancelVideo=async ()=>{
      const controller=new AbortController();let loaded=0,returned=false;const encoded=[];
      async function* frames(){try{for(let i=0;i<20;i++){loaded++;yield {bytes:await image(64,36,i),delay:30};}}finally{returned=true;}}
      try{await encodeVideo(frames(),{signal:controller.signal,onProgress:n=>{encoded.push(n);controller.abort();}});throw new Error('Cancellation resolved');}
      catch(error){return {name:error.name,message:error.message,loaded,returned,encoded};}
    };
    window.videoMismatch=async ()=>{
      async function* frames(){yield {bytes:await image(64,36,0),delay:30};yield {bytes:await image(66,36,1),delay:40};}
      try{await encodeVideo(frames());return {resolved:true};}catch(error){return {name:error.name,message:error.message};}
    };
    window.videoReady=true;
  `;
  const bundle=await build({stdin:{contents:entry,resolveDir:root,sourcefile:'video-browser-entry.js'},bundle:true,format:'esm',write:false,target:'chrome116'});
  server=createServer((req,res)=>{
    if(req.url==='/test.js'){res.writeHead(200,{'Content-Type':'application/javascript'});res.end(bundle.outputFiles[0].contents);}
    else{res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Local video verification</title><script type="module" src="/test.js"></script>');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let executablePath=process.env.PIXIV_TEST_BROWSER;
  // The Windows Chrome package includes AVC decoders absent from the bundled
  // open-source Chromium build. Always use an isolated project-local profile.
  if(!executablePath&&process.platform==='win32'){
    for(const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']){
      try{await access(candidate);executablePath=candidate;break;}catch{}
    }
  }
  context=await chromium.launchPersistentContext(path.join(runDir,'profile'),{...(executablePath?{executablePath}:{channel:'chromium'}),headless:true});
  report.browserExecutable=executablePath||'Playwright Chromium';
  const page=context.pages()[0]||await context.newPage();
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.videoReady);
  report.browser=await page.evaluate(()=>navigator.userAgent);
  report.capabilities=await page.evaluate(()=>({VideoEncoder:typeof VideoEncoder,VideoDecoder:typeof VideoDecoder,secure:isSecureContext}));
  assert.equal(report.capabilities.VideoEncoder,'function');assert.ok(report.capabilities.secure);

  async function testVideo(name,options){
    const result=await bounded(page.evaluate(options=>window.runVideo(options),options),name);
    const delays=options.delays,timestamps=[];let elapsed=0;for(const delay of delays){timestamps.push(elapsed);elapsed+=delay;}
    assert.equal(result.packets.length,delays.length,`${name}: every input has one encoded packet`);
    assert.deepEqual(result.packets.map(p=>Math.round(p.timestamp*1000)),timestamps,`${name}: exact integer-ms timestamps`);
    assert.deepEqual(result.packets.map(p=>Math.round(p.duration*1000)),delays,`${name}: exact integer-ms durations including final`);
    for(let i=0;i<delays.length;i++){
      assert.ok(Math.abs(result.packets[i].timestamp*1000-timestamps[i])<1e-7,`${name}: timestamp has no timing quantization`);
      assert.ok(Math.abs(result.packets[i].duration*1000-delays[i])<1e-7,`${name}: duration has no timing quantization`);
    }
    assert.equal(result.decoded.length,delays.length,`${name}: all packets decode`);
    assert.deepEqual(result.decoded.map(f=>f.timestamp),timestamps.map(x=>x*1000),`${name}: decoded frame timestamps`);
    const colors=[[239,48,26],[22,205,67],[34,87,232],[234,203,22]];
    for(let i=0;i<delays.length;i++)for(let channel=0;channel<3;channel++)assert.ok(Math.abs(result.decoded[i].rgb[channel]-colors[i%4][channel])<45,`${name}: preserved image sequence ${i}`);
    assert.ok(Math.abs(result.trackDuration-elapsed/1000)<1e-7,`${name}: track duration includes final frame`);
    assert.ok(Math.abs(result.playback.duration-elapsed/1000)<0.0001,`${name}: playable total duration`);
    assert.ok(result.playback.readyState>=2);
    assert.equal(result.audioTracks,0);
    assert.deepEqual(result.progress,delays.map((_,i)=>i+1));
    assert.deepEqual(result.events,delays.flatMap((_,i)=>[`load:${i}`,`encoded:${i+1}`]),`${name}: backpressure before loading next source`);
    const bytes=Buffer.from(result.bytes);delete result.bytes;
    if(result.extension==='mp4'){
      result.mp4Timing=mp4Timing(bytes);
      assert.equal(result.mp4Timing.timescale,1000);
      assert.deepEqual(result.mp4Timing.durations,delays);
      assert.equal(result.mp4Timing.mediaDuration,elapsed);
    }
    await writeFile(path.join(runDir,`${name}.${result.extension}`),bytes);
    check(name,{input:options,size:bytes.length,...result});return result;
  }

  const varied=await testVideo('variable-delays-and-long-final-frame',{delays:[7,13,1001,60000]});
  await testVideo('single-frame-duration',{delays:[1234]});
  await testVideo('equal-frame-intervals',{delays:[40,40,40,40]});
  const odd=await testVideo('small-odd-source-dimensions',{delays:[13,29],width:63,height:35});
  assert.equal(odd.width,odd.codec==='avc'?64:63);assert.equal(odd.height,odd.codec==='avc'?36:35);
  const large=await testVideo('large-source-scaling',{delays:[17,43],width:2400,height:1600});
  assert.equal(large.width,1920);assert.equal(large.height,1280);
  for(const codec of ['vp09','vp8']){
    const result=await testVideo(`forced-${codec}-variable-durations`,{delays:[7,13,1001,60000],codec});
    assert.equal(result.extension,'webm');assert.equal(result.codec,codec==='vp09'?'vp9':'vp8');
  }
  const canceled=await bounded(page.evaluate(()=>window.cancelVideo()),'cancel');
  assert.equal(canceled.name,'AbortError');assert.equal(canceled.loaded,1);assert.equal(canceled.returned,true);assert.deepEqual(canceled.encoded,[1]);
  check('cancel-after-first-frame-stops-input-and-closes-generator',{result:canceled});
  const mismatch=await bounded(page.evaluate(()=>window.videoMismatch()),'mismatch');assert.ok(!mismatch.resolved);assert.match(mismatch.message,/尺寸不一致/);
  check('different-source-dimensions-fail',{result:mismatch});
  report.preferredCodec=varied.codec;assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;console.error(error);process.exitCode=1;}
finally{
  if(context)await context.close().catch(()=>{});
  if(server)await new Promise(resolve=>server.close(resolve));
  report.finishedAt=new Date().toISOString();await writeFile(path.join(runDir,'report.json'),JSON.stringify(report,null,2));
  await writeFile(path.join(root,'test-results/video-latest.json'),JSON.stringify({runDir,status:report.status,report:path.join(runDir,'report.json')},null,2));
  console.log(`Video report: ${path.join(runDir,'report.json')}`);
}
