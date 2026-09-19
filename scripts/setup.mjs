import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
for (const folder of ['worker', 'chain', 'web']) {
  console.log(`\nInstalling ${folder} dependencies...`);
  const result = spawnSync(process.execPath, [npm, 'install'], {
    cwd: join(root, folder), stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('\nReady. Run npm run dev, then open http://localhost:5173.');
