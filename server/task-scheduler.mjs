/** Local admission control; cancelling a running job waits for its executor to settle. */
export class TaskScheduler {
  constructor({concurrency = 1, capacity = 10} = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('任务并发数须为 1–4');
    this.concurrency = concurrency; this.capacity = capacity; this.entries = new Map(); this.active = 0; this.stopping = false;
  }
  get available() { return !this.stopping && this.entries.size < this.capacity; }
  submit(id, execute, onCancelled) {
    if (!this.available || this.entries.has(id)) throw new Error('任务队列已满，请稍后重试。');
    let done;
    const entry = {id, execute, onCancelled, controller:new AbortController(), started:false, settled:new Promise(resolve=>{done=resolve;}), done:()=>done()};
    this.entries.set(id,entry); queueMicrotask(()=>this.pump()); return entry.settled;
  }
  pump() {
    for (const entry of this.entries.values()) {
      if (this.stopping || this.active >= this.concurrency) break;
      if (entry.started || entry.controller.signal.aborted) continue;
      entry.started=true; this.active++;
      Promise.resolve().then(()=>entry.execute(entry.controller.signal)).catch(()=>{}).finally(()=>{this.active--;this.entries.delete(entry.id);entry.done();this.pump();});
    }
  }
  async cancel(id, reason = 'user') {
    const entry=this.entries.get(id); if(!entry)return false;
    if(entry.controller.signal.aborted)return true;
    entry.controller.abort(reason);
    if(!entry.started) { try { await entry.onCancelled(reason); } finally { this.entries.delete(id); entry.done(); this.pump(); } }
    return true;
  }
  async stop() {
    this.stopping=true;
    const entries=[...this.entries.values()];
    await Promise.all(entries.map(entry=>this.cancel(entry.id,'shutdown')));
    await Promise.all(entries.map(entry=>entry.settled));
  }
}
