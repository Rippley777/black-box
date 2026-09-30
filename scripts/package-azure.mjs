import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const stage = join(tmpdir(), 'black-box-azure-package');
const archive = '/tmp/black-box-azure.zip';
rmSync(stage, { recursive: true, force: true });
rmSync(archive, { force: true });
mkdirSync(join(stage, 'dist'), { recursive: true });
mkdirSync(join(stage, 'apps/dashboard'), { recursive: true });
execFileSync(
  join(root, 'node_modules/.bin/esbuild'),
  [
    join(root, 'apps/daemon/src/cli.ts'),
    '--bundle', '--platform=node', '--format=esm',
    '--external:better-sqlite3', '--external:mssql', '--external:ws',
    `--outfile=${join(stage, 'dist/daemon.js')}`,
  ],
  { stdio: 'inherit' },
);
cpSync(join(root, 'apps/dashboard/dist'), join(stage, 'apps/dashboard/dist'), {
  recursive: true,
});
const version = (name) =>
  JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify({
    name: 'black-box-azure', private: true, version: '0.1.0', type: 'module',
    engines: { node: '>=20' }, scripts: { start: 'node dist/daemon.js' },
    dependencies: {
      'better-sqlite3': version('better-sqlite3'),
      mssql: version('mssql'),
      ws: version('ws'),
    },
  }, null, 2),
);
execFileSync('npm', ['install', '--package-lock-only', '--omit=dev'], { cwd: stage, stdio: 'inherit' });
execFileSync('zip', ['-qr', archive, '.'], { cwd: stage, stdio: 'inherit' });
console.log(archive);
