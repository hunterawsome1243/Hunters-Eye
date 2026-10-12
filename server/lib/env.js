import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load .env from the project root if it exists. Real environment variables win.
const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

export function intervalFromEnv(name, fallbackMs) {
  const sec = Number(process.env[name]);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : fallbackMs;
}
