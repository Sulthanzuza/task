/**
 * The same suite against RUN_MODE=all: one process on one port serving the
 * web app, the API, Socket.IO and the job worker, as Render runs it.
 *
 * The flag is set before the shared config is loaded, because that module
 * decides its ports when it is first imported. Playwright's workers inherit
 * the environment from this process, so they see the same ports.
 */
process.env.E2E_RUN_MODE = 'all';

const { createConfig } = await import('./playwright.config');

export default createConfig(false);
