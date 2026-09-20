import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid) continue;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  }
  setTimeout(() => process.exit(code), 500);
}
for (const [folder, args] of [['worker', ['run', 'dev']], ['web', ['run', 'dev', '--', '--port', '5173']]]) {
  const child = spawn(process.execPath, [npm, ...args], {
    cwd: join(root, folder), stdio: 'inherit', windowsHide: true,
    detached: process.platform !== 'win32', env: { ...process.env, GUARD_API_ORIGIN: 'http://127.0.0.1:8787' },
  });
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code ?? 1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log('StillHere is starting. Open http://localhost:5173 when the frontend is ready.');
