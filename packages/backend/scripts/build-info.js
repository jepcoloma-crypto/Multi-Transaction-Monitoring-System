// Writes dist/build-info.json so /health can report what is actually running.
//
// Generated on every build rather than set by hand, because the value it
// replaces was `version: '1.0.0'` hardcoded in the health route — a field that
// claimed the same thing no matter which build was live. Any figure a person has
// to remember to update will eventually be wrong in exactly the way that costs
// time: "is production on the new build?" answered by inspection instead of
// guesswork.
//
// Fails soft. A checkout without git, a tarball, or a CI box that strips .git
// all still produce a build, so an unavailable commit is 'unknown' rather than a
// failed deploy.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const packageRoot = path.join(__dirname, '..');
const outFile = path.join(packageRoot, 'dist', 'build-info.json');

function git(args) {
  try {
    return execSync(`git ${args}`, {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const commit = git('rev-parse HEAD');
const branch = git('rev-parse --abbrev-ref HEAD');
const dirty = git('status --porcelain') !== '';

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      commit: commit || 'unknown',
      commitShort: commit ? commit.slice(0, 7) : 'unknown',
      branch: branch || 'unknown',
      // A dirty tree means the running code is not what the commit says it is,
      // which is worth saying out loud rather than reporting a clean SHA.
      dirty,
      builtAt: new Date().toISOString(),
      node: process.version,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `build-info: ${commit ? commit.slice(0, 7) : 'unknown'}${dirty ? ' (dirty)' : ''} @ ${branch || 'unknown'}`,
);
