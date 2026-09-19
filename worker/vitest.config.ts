import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);

export default defineConfig({
  resolve:{alias:{buffer:require.resolve('buffer/')}},
  plugins:[cloudflareTest({wrangler:{configPath:'./wrangler.jsonc'}})],
  test:{include:['test/**/*.test.ts'],testTimeout:20000,deps:{optimizer:{ssr:{enabled:true,include:['@solana/web3.js','bs58']}}}},
});
