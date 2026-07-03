import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';

export interface LoadEnvOptions {
  /** Directory to start searching from. Defaults to `process.cwd()`. */
  cwd?: string;
}

/** Load the first `.env` found walking up from `cwd`. Does not override existing env vars. */
export function loadEnv(options: LoadEnvOptions = {}): void {
  let dir = options.cwd ?? process.cwd();
  for (;;) {
    const path = join(dir, '.env');
    if (existsSync(path)) {
      config({ path });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return;
    }
    dir = parent;
  }
}
