import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { expect, it } from 'vitest';

it('opens only OS-backed File objects through preload and does not expose IPC events', async () => {
  type Bridge = {
    openMovie: (file: unknown, requestId: string) => Promise<unknown>;
    onMovieProgress: (callback: (progress: unknown) => void) => () => void;
  };
  let bridge!: Bridge;
  let listener!: (event: unknown, progress: unknown) => void;
  const calls: unknown[][] = [];
  const selectedFile = {};
  vm.runInNewContext(readFileSync('desktop/preload.cjs', 'utf8'), {
    require: (name: string) => {
      if (name !== 'electron') throw new Error(`Unexpected module ${name}`);
      return {
        contextBridge: { exposeInMainWorld: (_name: string, api: Bridge) => { bridge = api; } },
        webUtils: { getPathForFile: (file: unknown) => {
          if (typeof file === 'string') throw new TypeError('Expected File');
          return file === selectedFile ? '/selected/movie.mp4' : '';
        } },
        ipcRenderer: {
          invoke: async (...args: unknown[]) => { calls.push(args); return { movie: { id: 'movie' } }; },
          on: (_channel: string, callback: typeof listener) => { listener = callback; },
          removeListener: (...args: unknown[]) => { calls.push(args); },
        },
      };
    },
  });
  expect(() => bridge.openMovie('/unselected/private.mp4', '1')).toThrow();
  expect(() => bridge.openMovie({ path: '/unselected/private.mp4' }, '2')).toThrow();
  expect(calls).toHaveLength(0);
  await expect(bridge.openMovie(selectedFile, '3')).resolves.toEqual({ movie: { id: 'movie' } });
  expect(calls).toEqual([['movies:open', '/selected/movie.mp4', '3']]);
  const received: unknown[] = [];
  const unsubscribe = bridge.onMovieProgress(value => received.push(value));
  const progress = { requestId: '3', percent: 45 };
  listener({ sender: 'privileged IPC event' }, progress);
  expect(received).toEqual([progress]);
  unsubscribe();
  expect(calls[1]).toEqual(['movies:progress', listener]);
});

it('serializes connection changes and safely uses a session key when secure storage is unavailable', async () => {
  let finishValidation!: (response: { ok: boolean; status: number }) => void;
  let validationStarted!: () => void;
  const started = new Promise<void>(resolve => { validationStarted = resolve; });
  const persisted: string[] = [];
  let savedKeyReads = 0;
  let stored: Buffer | undefined;
  let storageAvailable = true;
  let immediateValidation = false;
  const module = { exports: {} as any };
  const storage = {
    isAsyncEncryptionAvailable: async () => storageAvailable,
    encryptStringAsync: async (key: string) => Buffer.from(key),
  };
  vm.runInNewContext(readFileSync('desktop/settings.cjs', 'utf8'), {
    module, Buffer, AbortSignal, setTimeout, clearTimeout,
    process: { platform: 'darwin', env: {} },
    require: (name: string) => {
      if (name === 'electron') return { safeStorage: storage };
      if (name === 'node:path') return path;
      if (name === 'node:fs') return { readFileSync: () => 'dark', writeFileSync: () => {}, renameSync: () => {} };
      if (name === 'node:fs/promises') return {
        mkdir: async () => {},
        readFile: async () => { savedKeyReads++; if (stored) return stored; throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); },
        writeFile: async (_file: string, data: Buffer) => { stored = data; persisted.push(data.toString()); },
        rename: async () => {},
      };
      throw new Error(`Unexpected module ${name}`);
    },
    fetch: () => {
      if (immediateValidation) return Promise.resolve({ ok: true, status: 200 });
      validationStarted();
      return new Promise(resolve => { finishValidation = resolve; });
    },
  });
  const settings = module.exports;
  await settings.initialize('/test');
  expect(savedKeyReads).toBe(0); // Preparing a window must not wait for OS keychain access.
  expect(settings.getSettings().loading).toBe(true);
  await settings.unlockSavedKey();
  expect(settings.getSettings().loading).toBe(false);
  const saving = settings.saveApiKey('dummy-test-key');
  await started;
  const removing = settings.clearApiKey();
  finishValidation({ ok: true, status: 200 });
  await Promise.all([saving, removing]);
  expect(persisted).toEqual(['dummy-test-key', '']);
  expect(settings.getSettings().configured).toBe(false);
  expect(settings.getApiKey()).toBe('');
  storageAvailable = false;
  immediateValidation = true;
  const sessionConnection = await settings.saveApiKey('session-only-test-key');
  expect(sessionConnection.configured).toBe(true);
  expect(sessionConnection.error).toContain('Connected for this session');
  expect(settings.getApiKey()).toBe('session-only-test-key');
  expect(persisted).toEqual(['dummy-test-key', '']); // Never write an unencrypted fallback key.
  await settings.clearApiKey();
  expect(settings.getApiKey()).toBe('');
  expect(settings.getSettings().error).toBe('');
  await settings.unlockSavedKey(); // The empty removal marker does not require an OS keychain.
  expect(settings.getSettings().configured).toBe(false);
  expect(settings.getSettings().error).toBe('');
});
