const active = new Set(['queued', 'running']);
export function recordSaved(job,runId,filename){
  if(typeof runId!=='string'||runId!==job.runId)return false;
  if(!job.outputs.includes(filename))job.outputs.push(filename);
  return true;
}
function destinationFields(destination) {
  if(!destination||typeof destination.id!=='string'||!destination.id||typeof destination.name!=='string')throw new Error('请先选择保存文件夹');
  return {destinationId:destination.id,destinationName:destination.name};
}
export function enqueue(jobs, works, destination) {
  const fields=destinationFields(destination);
  for (const work of works) {
    if (jobs.some(j => active.has(j.status) && j.windowId === work.windowId && j.artworkId === work.id)) continue;
    jobs.push({jobId:crypto.randomUUID(), artworkId:work.id, windowId:work.windowId, tabId:work.tabId,
      ...fields,url:work.url, title:work.id, status:'queued', phase:'等待下载', completed:0,total:0, outputs:[],error:'',createdAt:Date.now()});
  }
}
export function recover(jobs, liveJobId) {
  for (const j of jobs) if (j.status === 'running' && j.jobId !== liveJobId) {
    j.status='interrupted'; j.phase='任务中断'; j.error='浏览器或扩展已重启，请重试。此前保存的文件会保留，重试可能生成重名副本。';
  }
}
export function retryJob(job, destination) {
  if (!['failed','partial','interrupted','canceled'].includes(job.status)) throw new Error('此任务当前不能重试');
  Object.assign(job,destinationFields(destination),{runId:null,status:'queued',phase:'等待重试',completed:0,total:0,outputs:[],error:''});
}
export function prune(jobs, liveJobId=null) {
  let remove = Math.max(0,jobs.length-200);
  return jobs.filter(j => {if(remove && j.jobId!==liveJobId && !active.has(j.status)){remove--;return false;} return true;});
}
