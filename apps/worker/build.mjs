// Bundles the Worker with esbuild. The shared services in apps/server import
// ../db/database.ts, ../lib/util.ts, ../realtime/hub.ts and ../config.ts; this plugin
// swaps those Node implementations for the Cloudflare adapters in src/platform.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.resolve(here, '../server/src');
const platform = path.resolve(here, 'src/platform');
const swaps = new Map([
  [path.join(serverSrc, 'db/database.ts'), path.join(platform, 'database.ts')],
  [path.join(serverSrc, 'lib/util.ts'), path.join(platform, 'util.ts')],
  [path.join(serverSrc, 'realtime/hub.ts'), path.join(platform, 'hub.ts')],
  [path.join(serverSrc, 'config.ts'), path.join(platform, 'config.ts')],
]);

const swapPlugin = {
  name: 'friendstar-platform-swap',
  setup(build) {
    build.onResolve({ filter: /^bcryptjs$/ }, (args) =>
      args.importer === path.join(platform, 'bcrypt.ts') ? null : { path: path.join(platform, 'bcrypt.ts') },
    );
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      // Type-only re-exports from platform/database.ts must still reach the real server file.
      if (args.importer === path.join(platform, 'database.ts')) return null;
      const target = path.resolve(args.resolveDir, args.path);
      const swapped = swaps.get(target);
      return swapped ? { path: swapped } : null;
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(here, 'src/index.ts')],
  outfile: path.join(here, 'dist/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  conditions: ['workerd', 'worker', 'browser'],
  mainFields: ['module', 'main'],
  external: ['cloudflare:*', 'node:*', 'crypto'],
  plugins: [swapPlugin],
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});
