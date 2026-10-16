import { spawn } from 'node:child_process';
import electron from 'electron';

try { process.loadEnvFile('.env'); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env: environment });
child.on('error', () => { console.error('Scene Finder could not start. Reinstall dependencies and try again.'); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
