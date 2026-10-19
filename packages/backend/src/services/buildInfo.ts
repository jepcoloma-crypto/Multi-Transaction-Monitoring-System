import fs from 'fs';
import path from 'path';

// What is actually running, read from the file `scripts/build-info.js` writes on
// every build.
//
// Loaded once and cached: /health is polled, and the answer cannot change
// without a restart, so re-reading the file would only turn a disk access into a
// syscall per health check. It fails soft and loudly-but-safely — a build made
// without the script (the test build, a hand-rolled `tsc`) reports 'unknown'
// rather than throwing, because a health endpoint that 500s is worse than one
// that is vague.
export interface BuildInfo {
  commit: string;
  commitShort: string;
  branch: string;
  dirty: boolean;
  builtAt: string;
  node: string;
}

const UNKNOWN: BuildInfo = {
  commit: 'unknown',
  commitShort: 'unknown',
  branch: 'unknown',
  dirty: false,
  builtAt: 'unknown',
  node: process.version,
};

let cached: BuildInfo | null = null;

export function buildInfo(): BuildInfo {
  if (cached) return cached;
  try {
    // `__dirname` is dist/services, so the generated file sits one level up.
    const file = path.join(__dirname, '..', 'build-info.json');
    cached = { ...UNKNOWN, ...(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BuildInfo>) };
  } catch {
    cached = UNKNOWN;
  }
  return cached;
}

/** For tests, which must not inherit one case's cached read. */
export function resetBuildInfoCache(): void {
  cached = null;
}
