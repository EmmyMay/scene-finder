import { execFileSync } from 'node:child_process';
import { access, copyFile, cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const release = path.join(root, 'release');
const application = path.join(release, `Scene Finder-${process.platform}-${process.arch}`);
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });

if (process.platform === 'darwin') {
  const staging = await mkdtemp(path.join(os.tmpdir(), 'scene-installer-'));
  try {
    const stagedApp = path.join(staging, 'Scene Finder.app');
    // Framework links must stay relative; Node's default copy rewrites them to the source path.
    await cp(path.join(application, 'Scene Finder.app'), stagedApp, { recursive: true, verbatimSymlinks: true });
    run('codesign', ['--verify', '--deep', '--strict', stagedApp]);
    await symlink('/Applications', path.join(staging, 'Applications'));
    await writeFile(path.join(staging, 'Install Scene Finder.txt'),
      'Drag Scene Finder into Applications, then open it from Applications.\n\n' +
      'Connect your own Jev API key in Settings, then choose an MP4 or MKV movie.\n' +
      'Search requires an internet connection. Sampled movie frames and your query go to Jev.\n\n' +
      'This beta is ad-hoc signed, not Developer ID signed or notarized.\n' +
      'Download and release information: https://github.com/EmmyMay/scene-finder/releases\n');
    await copyFile(path.join(root, 'desktop/assets/icon.icns'), path.join(staging, '.VolumeIcon.icns'));
    const destination = path.join(release, `Scene-Finder-${version}-mac-${process.arch}.dmg`);
    run('hdiutil', ['create', '-ov', '-volname', 'Scene Finder', '-fs', 'HFS+', '-format', 'UDZO', '-srcfolder', staging, destination]);
    run('hdiutil', ['verify', destination]);
    console.log(`Mac installer: ${destination}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
} else if (process.platform === 'win32') {
  if (process.arch !== 'x64') throw new Error('The Windows installer currently supports x64 builds.');
  const compiler = process.env.ISCC_PATH || path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe');
  await access(compiler).catch(() => { throw new Error('Install Inno Setup 6, or set ISCC_PATH to ISCC.exe.'); });
  run(compiler, [`/DAppVersion=${version}`, `/DAppSource=${application}`, `/DOutputDirectory=${release}`, path.join(root, 'desktop/installer.iss')]);
} else if (process.platform !== 'linux') {
  throw new Error('Unsupported installer platform.');
}
