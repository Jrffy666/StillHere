import { readFile, writeFile } from 'node:fs/promises';
for (const [sourceName, targetName] of [['index.ts', 'chain-client.ts'], ['v2.ts', 'chain-v2.ts']]) {
  const source = new URL(`../chain/src/${sourceName}`, import.meta.url);
  const target = new URL(`../web/lib/${targetName}`, import.meta.url);
  await writeFile(target, `// Generated from chain/src/${sourceName} by npm run sync:chain. Do not edit this copy.\n` + await readFile(source, 'utf8'));
}
console.log('Synced the tested V1 and V2 chain clients into the standalone web checkout.');
