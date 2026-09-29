import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

/** The monorepo root, where the single .env lives. */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  // An empty prefix loads every key, not just VITE_*, so the dev server can read
  // WEB_PORT and API_URL from the same .env the API uses. Real environment
  // variables still win, which is what CI and the e2e runner rely on.
  const env = { ...loadEnv(mode, repoRoot, ''), ...process.env };

  const port = Number(env.WEB_PORT ?? 5174);
  const apiUrl = env.API_URL ?? 'http://localhost:4000';

  return {
    plugins: [react(), tailwindcss()],

    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },

    server: {
      port,
      // Fail loudly rather than silently moving to another port: a moved port
      // breaks the cookie origin and sends people to someone else's dev server.
      strictPort: true,
      // Dev is same-origin, exactly like production behind Nginx. The browser only
      // ever talks to this port, so there is no CORS and no third-party cookie.
      proxy: {
        '/api': { target: apiUrl, changeOrigin: true },
        '/socket.io': { target: apiUrl, changeOrigin: true, ws: true },
      },
    },

    // The e2e suite serves the built app through preview, so it needs the same
    // same-origin proxy the dev server has. Testing the real bundle also avoids
    // running a file watcher that nothing in a test run needs.
    preview: {
      port,
      strictPort: true,
      proxy: {
        '/api': { target: apiUrl, changeOrigin: true },
        '/socket.io': { target: apiUrl, changeOrigin: true, ws: true },
      },
    },

    build: { outDir: 'dist', sourcemap: true },
  };
});
