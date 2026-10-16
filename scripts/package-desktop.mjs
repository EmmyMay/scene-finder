import { packager } from '@electron/packager';
import { listPackage } from '@electron/asar';
import { execFileSync } from 'node:child_process';
import { readFile, cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import('./check-media.mjs');
if (!['darwin', 'win32', 'linux'].includes(process.platform)) throw new Error('Unsupported desktop platform.');
// Stage only app files, then install production dependencies outside cloud-synced workspaces.
const staging = await mkdtemp(path.join(os.tmpdir(), 'scene-desktop-'));
try {
for (const name of ['dist', 'public', 'desktop', 'package.json', 'package-lock.json', 'THIRD_PARTY_NOTICES.md']) {
  await cp(path.join(root, name), path.join(staging, name), { recursive: true, filter: file => !file.split(path.sep).includes('__tests__') });
}
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: staging, stdio: 'pipe', shell: process.platform === 'win32',
});
const electronVersion = JSON.parse(await readFile(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version;
const outputs = await packager({
  dir: staging,
  out: path.join(root, 'release'),
  name: 'Scene Finder',
  executableName: 'Scene Finder',
  appBundleId: 'com.emmymay.scenefinder',
  appCategoryType: 'public.app-category.video',
  platform: process.platform,
  arch: process.arch,
  electronVersion,
  asar: true,
  overwrite: true,
  prune: false,
  extraResource: [path.join(root, '.data/media')],
});
for (const output of outputs) {
  const application = process.platform === 'darwin' ? path.join(output, 'Scene Finder.app') : output;
  const resources = process.platform === 'darwin' ? path.join(application, 'Contents/Resources') : path.join(output, 'resources');
  const archive = path.join(resources, 'app.asar');
  const entries = listPackage(archive);
  if (entries.some(entry => /^\/(?:\.env(?:\.|$)|\.data(?:\/|$)|release(?:\/|$)|\.git(?:\/|$))/.test(entry))) {
    throw new Error('Package contains a local-only file. Refusing to finish.');
  }
  try {
    const localEnv = await readFile(path.join(root, '.env'), 'utf8');
    const key = localEnv.match(/^TYPESAFE_API_KEY=(.+)$/m)?.[1]?.trim();
    if (key && (await readFile(archive)).includes(Buffer.from(key))) {
      throw new Error('A local credential was found in the package. Refusing to finish.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // An ad-hoc signature is sufficient for this local demo; no signing identity is used.
  if (process.platform === 'darwin') execFileSync('codesign', ['--force', '--deep', '--sign', '-', application], { stdio: 'pipe' });
  const download = path.join(root, 'release', `Scene-Finder-${process.platform}-${process.arch}.tar.gz`);
  execFileSync('tar', ['-czf', download, '-C', path.dirname(output), path.basename(output)], { stdio: 'pipe' });
  console.log(`Built ${application}`);
  console.log(`Download archive: ${download}`);
}
} finally { await rm(staging, { recursive: true, force: true }); }
