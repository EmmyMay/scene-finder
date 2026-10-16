import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const directory = path.resolve('.data/media');
const suffix = process.platform === 'win32' ? '.exe' : '';
const ffmpeg = path.join(directory, `ffmpeg${suffix}`);
const ffprobe = path.join(directory, `ffprobe${suffix}`);
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
for (const binary of [ffmpeg, ffprobe]) {
  const data = await readFile(binary);
  let architecture;
  if (process.platform === 'darwin') architecture = ({ 0x1000007: 'x64', 0x100000c: 'arm64' })[data.readUInt32LE(4)];
  if (process.platform === 'win32') architecture = ({ 0x8664: 'x64', 0xaa64: 'arm64' })[data.readUInt16LE(data.readUInt32LE(0x3c) + 4)];
  if (process.platform === 'linux') architecture = ({ 62: 'x64', 183: 'arm64' })[data.readUInt16LE(18)];
  if (architecture !== process.arch) throw new Error('Media executable architecture does not match this package.');
}
for (const [name, expected] of Object.entries({
  'ffmpeg-8.0.1.tar.xz': '05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41',
  'x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz': 'cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9',
})) {
  const actual = createHash('sha256').update(await readFile(path.join(directory, 'sources', name))).digest('hex');
  if (actual !== expected) throw new Error(`Missing or changed source archive: ${name}`);
}
for (const name of ['COPYING.GPLv2', 'COPYING.x264', 'BUILD_CONFIGURATION.txt', 'sources/prepare-media.sh']) {
  if (!(await readFile(path.join(directory, name))).length) throw new Error(`Missing media notice: ${name}`);
}
const license = run(ffmpeg, ['-L']);
if (!license.includes('GNU General Public License') || /nonfree|unredistributable/.test(license)) throw new Error('Unexpected FFmpeg license.');
run(ffprobe, ['-version']);
if (process.platform === 'darwin') {
  for (const binary of [ffmpeg, ffprobe]) {
    const dependencies = run('otool', ['-L', binary]).trim().split('\n').slice(1);
    if (dependencies.some(line => !/^\s+\/(?:usr\/lib\/|System\/Library\/)/.test(line))) throw new Error('Media tool depends on a non-system library.');
    const minimum = run('otool', ['-l', binary]).match(/\bminos (\d+(?:\.\d+)*)/);
    if (!minimum || Number(minimum[1].split('.')[0]) > 13) throw new Error('Media tool requires a newer macOS than the app supports.');
  }
}
if (process.platform === 'win32') {
  for (const binary of [ffmpeg, ffprobe]) {
    const imports = run('objdump', ['-p', binary]);
    if (/DLL Name:.*(?:libgcc|libstdc\+\+|libwinpthread|libx264)/i.test(imports)) throw new Error('Media tool has an unbundled compiler runtime.');
  }
}
const temp = await mkdtemp(path.join(os.tmpdir(), 'scene-media-check-'));
try {
  const clip = path.join(temp, 'clip.mp4');
  run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
  const probe = JSON.parse(run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', clip]));
  if (!probe.streams.some(s => s.codec_name === 'h264') || !probe.streams.some(s => s.codec_name === 'aac') || Number(probe.format.duration) < 1) throw new Error('Native encode/probe check failed.');
  console.log(`Native media tools verified: ${process.platform}/${process.arch}, H264 + AAC encode and probe.`);
} finally { await rm(temp, { recursive: true, force: true }); }
