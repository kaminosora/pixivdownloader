import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, recover, retryJob, prune, recordSaved } from '../src/queue.js';
const destination = {id:'folder-a',name:'Pictures'};
const work = { id:'123',tabId:1,windowId:2,url:'https://www.pixiv.net/artworks/123' };
test('late commit from a canceled attempt cannot contaminate retry in a different folder',()=>{
 const jobs=[];enqueue(jobs,[work],destination);const job=jobs[0];job.runId='old-run';job.status='canceled';
 retryJob(job,{id:'folder-b',name:'B'});
 assert.equal(recordSaved(job,'old-run','123 (1).png'),false);assert.deepEqual(job.outputs,[]);
 job.runId='new-run';job.status='running';
 assert.equal(recordSaved(job,'old-run','123 (1).png'),false);
 assert.equal(recordSaved(job,'new-run','123.png'),true);assert.deepEqual(job.outputs,['123.png']);
});
test('a file committed just as cancellation happens is still recorded for its own attempt',()=>{
 const jobs=[];enqueue(jobs,[work],destination);const job=jobs[0];job.runId='same-run';job.status='canceled';
 assert.equal(recordSaved(job,'same-run','123.png'),true);assert.deepEqual(job.outputs,['123.png']);
});
test('each queued job captures its selected folder even when the later selection changes',()=>{
 const jobs=[],folder={id:'one',name:'First'}; enqueue(jobs,[work],folder); folder.id='two';folder.name='Second';
 enqueue(jobs,[{...work,id:'456'}],folder);
 assert.deepEqual(jobs.map(j=>[j.destinationId,j.destinationName]),[['one','First'],['two','Second']]);
});
test('starting without a destination is rejected and retry captures newly selected destination',()=>{
 const jobs=[];assert.throws(()=>enqueue(jobs,[work]));assert.equal(jobs.length,0);
 enqueue(jobs,[work],destination);jobs[0].status='failed';retryJob(jobs[0],{id:'new',name:'New'});
 assert.equal(jobs[0].destinationId,'new');assert.equal(jobs[0].destinationName,'New');
});
test('same artwork in another window is a distinct job; same window pending job is deduplicated',()=>{
 const jobs=[]; enqueue(jobs,[work],destination); enqueue(jobs,[work,{...work,windowId:3}],destination);
 assert.equal(jobs.length,2); assert.deepEqual(jobs.map(j=>j.windowId),[2,3]);
});
test('recovery does not declare abandoned running work successful or automatically repeat it',()=>{
 const jobs=[]; enqueue(jobs,[work],destination); jobs[0].status='running'; jobs[0].outputs=['file.png'];
 recover(jobs,null); assert.equal(jobs[0].status,'interrupted'); assert.deepEqual(jobs[0].outputs,['file.png']);
});
test('live offscreen job remains running after worker restart',()=>{
 const jobs=[]; enqueue(jobs,[work],destination); jobs[0].status='running'; recover(jobs,jobs[0].jobId); assert.equal(jobs[0].status,'running');
});
test('retry is explicit and resets progress without changing artwork identity',()=>{
 const jobs=[]; enqueue(jobs,[work],destination); const j=jobs[0]; j.status='partial'; j.outputs=['zip']; j.error='GIF failed';
 retryJob(j,destination); assert.equal(j.status,'queued'); assert.equal(j.artworkId,'123'); assert.deepEqual(j.outputs,[]); assert.equal(j.error,'');
 assert.throws(()=>retryJob(j,destination));
});
test('pruning retains active jobs even with many completed entries',()=>{
 const jobs=Array.from({length:210},(_,i)=>({jobId:String(i),status:i===0?'running':'complete'}));
 const result=prune(jobs); assert.equal(result.length,200); assert.equal(result[0].jobId,'0');
});
test('pruning protects canceled work still owned by offscreen until teardown acknowledgement',()=>{
 const jobs=Array.from({length:210},(_,i)=>({jobId:String(i),status:i===0?'canceled':'complete'}));
 const result=prune(jobs,'0'); assert.equal(result.length,200); assert.equal(result[0].jobId,'0');
});
