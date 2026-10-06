import { join, resolve } from 'node:path';
import express, { type Express, type Response } from 'express';
import { isProduction } from './config/env';

/**
 * The built web app, served by the API itself when RUN_MODE=all.
 *
 * On Render's free tier there is one process and no Nginx, so this does what
 * docker/nginx.conf.template does for the static files: the same headers, the
 * same caching, and every other path handed to the client-side router. The
 * app and the API stay on one origin, so the session cookie is first-party and
 * there is no CORS.
 *
 * Mounted before the API's own middleware, deliberately: the API's content
 * security policy is default-src 'none', which is right for JSON and would
 * leave the app a blank page.
 */

const YEAR_SECONDS = 365 * 24 * 60 * 60;
const MONTH_SECONDS = 30 * 24 * 60 * 60;

function securityHeaders(res: Response): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

/** Paths that belong to the server, never to the client-side router. */
function isServerPath(path: string): boolean {
  return path.startsWith('/api/') || path === '/api' || path.startsWith('/socket.io');
}

export function serveWebApp(app: Express, distDir: string): void {
  const root = resolve(distDir);
  const indexHtml = join(root, 'index.html');

  app.use(
    express.static(root, {
      // index.html goes through the fallback below, so it always gets no-store.
      index: false,
      // A missing /assets/x.js must be a 404, not the app's HTML with a 200.
      fallthrough: true,
      setHeaders(res, path) {
        securityHeaders(res);
        const rel = path.slice(root.length).replace(/\\/g, '/');
        if (rel.startsWith('/assets/')) {
          // Hashed file names never change, so they can be cached for good.
          res.setHeader('Cache-Control', 'public, max-age=' + YEAR_SECONDS + ', immutable');
        } else if (rel.startsWith('/fonts/')) {
          // Not hashed: a month, so a replaced file still reaches people.
          res.setHeader('Cache-Control', 'public, max-age=' + MONTH_SECONDS);
        }
      },
    }),
  );

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (isServerPath(req.path)) return next();
    // A request for a file that does not exist is a 404, not a route.
    if (req.path.startsWith('/assets/') || req.path.startsWith('/fonts/')) return next();

    securityHeaders(res);
    // Never cached, or a deploy leaves people on the old app asking for asset
    // files that no longer exist.
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(indexHtml);
  });
}
