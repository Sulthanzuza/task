/**
 * The same suite against the Render launch configuration: RUN_MODE=all, one
 * process on one port serving the web app, the API, Socket.IO and the job
 * worker, and MAIL_TRANSPORT=none.
 *
 * The flag is set before the shared config is loaded, because that module
 * decides its ports when it is first imported. Playwright's workers inherit
 * the environment from this process, so they see the same ports.
 */
process.env.E2E_RUN_MODE = 'all';
// And without email, as the Render launch runs: invitation and reset links
// are copied from Admin → People, and mailbox tests skip themselves.
process.env.E2E_EMAIL = 'off';

const { createConfig } = await import('./playwright.config');

export default createConfig(false);
