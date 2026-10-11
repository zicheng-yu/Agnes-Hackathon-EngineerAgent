import { spawn } from 'node:child_process';
// Graceful cancellation uses IPC on every OS. Escalation targets only this child tree.
export function stopProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const kill = spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
    kill.on('error',()=>child.kill());
  } else {
    try { process.kill(-child.pid,'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
