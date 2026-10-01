import { createConfig } from './playwright.config';

/**
 * The review run: the demo seed, a frozen clock, and only the screenshots.
 *
 * A second config rather than an environment variable, so `pnpm shots` is the
 * same command on every machine.
 */
export default createConfig(true);
