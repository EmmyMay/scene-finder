import { packager } from '@electron/packager';
import { listPackage } from '@electron/asar';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import('./check-media.mjs');
if (!['darwin', 'win32', 'linux'].includes(process.platform)) throw new Error('Unsupported desktop platform.');
// Allow only application files into the bundle. Local keys and movies are never packaged.
const allowed = new Set(['dist', 'public', 'desktop', 'node_modules', 'package.json', 'THIRD_PARTY_NOTICES.md']);
const ignore = (file) => {
  const segments = file.replaceAll('\\', '/').replace(/^\//, '').split('/');
  if (!segments[0]) return false;
  return !allowed.has(segments[0]) || (segments[0] === 'dist' && segments.includes('__tests__'));
};
const outputs = await packager({
  dir: root,
  out: path.join(root, 'release'),
  name: 'Scene Finder',
  executableName: 'Scene Finder',
  appBundleId: 'com.emmymay.scenefinder',
  appCategoryType: 'public.app-category.video',
  platform: process.platform,
  arch: process.arch,
  asar: true,
  overwrite: true,
  prune: true,
  ignore,
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
  console.log(`Built ${application}`);
}
