import { readFileSync, existsSync } from 'fs';

/**
 * Populate process.env from a local .env file if one exists.
 *
 * MUST be imported before any module that reads env at load time (e.g. `@/lib/env`),
 * so it is the very first import in `worker/index.ts`. Real platform env vars
 * (set by Docker / systemd / pm2 / the shell) always take precedence — we only fill
 * in keys that are not already defined.
 */
if (existsSync('.env')) {
  for (const raw of readFileSync('.env', 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    if (key in process.env) continue;
    process.env[key] = line.slice(idx + 1).trim();
  }
}
