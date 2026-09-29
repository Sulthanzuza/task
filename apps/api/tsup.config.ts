import { defineConfig } from 'tsup';

export default defineConfig({
  // migrate runs as a one-off container before the API starts; createUser is
  // the command that makes the first administrator.
  entry: ['src/server.ts', 'src/worker.ts', 'src/db/migrate.ts', 'src/cli/createUser.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  // Bundle the workspace package; leave real node_modules external.
  noExternal: ['@tm/shared'],
});
