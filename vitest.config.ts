import { existsSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Test sources import sibling modules with explicit `.js` extensions
// (e.g. `import { foo } from './foo.js'`) because that matches Chrome's
// ESM resolution at runtime + esbuild's bundle resolution. During the
// v0.9 TS migration the actual source files become `.ts`. Vitest/vite's
// resolver doesn't auto-substitute, so we wire a tiny plugin that:
//
//   - if `./foo.js` is requested AND `./foo.js` exists → leave alone
//   - if `./foo.js` is requested AND `./foo.ts` exists → resolve to .ts
//
// This works while the tree is mid-migration; once every module is .ts
// the second branch is the only one that fires.
export default defineConfig({
  plugins: [
    {
      name: 'js-to-ts-conditional',
      enforce: 'pre',
      resolveId(source: string, importer: string | undefined) {
        if (!importer || !source.startsWith('.')) return null;
        if (!source.endsWith('.js')) return null;
        const importerDir = dirname(importer);
        const jsPath = pathResolve(importerDir, source);
        if (existsSync(jsPath)) return null;
        const tsPath = jsPath.replace(/\.js$/, '.ts');
        if (existsSync(tsPath)) return tsPath;
        return null;
      },
    },
  ],
  test: {
    environment: 'node',
  },
});
