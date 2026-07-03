import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read config.env
const configPath = resolve(__dirname, 'config.env');
const configContent = readFileSync(configPath, 'utf-8');
const env = {};
for (const line of configContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx < 0) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  const value = trimmed.slice(eqIdx + 1).trim();
  env[key] = value;
}

export default {
  apps: [{
    name: 'feishu-claude-pal',
    script: './dist/daemon.mjs',
    cwd: __dirname,
    env,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    time: true,
  }],
};
