import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import { viteFlavorFromEnvironment } from './scripts/build-flavor.mjs';

const buildFlavor = viteFlavorFromEnvironment();
const compileTimeFlavor = { __PARADIGMEVE_BUILD_FLAVOR__: JSON.stringify(buildFlavor) };

export default defineConfig({
  main: {
    // Keep node_modules external so the MCP SDK ships as real files in the asar
    // rather than being inlined by the bundler.
    plugins: [externalizeDepsPlugin()],
    define: compileTimeFlavor,
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define: compileTimeFlavor,
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // The desktop pet overlay's own narrow bridge (see src/main/pet-overlay.ts).
          'pet-overlay': resolve(__dirname, 'src/preload/pet-overlay.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    define: compileTimeFlavor,
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          'pet-overlay': resolve(__dirname, 'src/renderer/pet-overlay.html')
        }
      }
    }
  }
});
