// Minimal zero-dependency .env loader, used when the process was not started with --env-file.
// Existing environment variables always win, so container/CI env still overrides the file.
import fs from 'node:fs';
import path from 'node:path';

export function loadEnvFile(file = '.env') {
  const target = path.resolve(process.cwd(), file);
  if (!fs.existsSync(target)) return false;
  const text = fs.readFileSync(target, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}
