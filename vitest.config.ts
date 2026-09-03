import { defineConfig, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config.ts'

// The unit suite covers the pure host-side logic: tool parsing, srcdoc assembly, the virtual
// filesystem, the model catalog and the agent loop against a scripted engine. It runs in
// happy-dom because fs.ts and runtime.ts touch localStorage and window at import time.
// Anything that needs WebGPU or a real sandbox iframe belongs to `pnpm cdp:agent` instead.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'happy-dom',
      setupFiles: ['./src/test-setup.ts'],
      include: ['src/**/*.test.ts'],
      restoreMocks: true,
    },
  }),
)
