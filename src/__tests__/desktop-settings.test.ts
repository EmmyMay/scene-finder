import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { expect, it } from 'vitest';

it('keeps Remove connection effective when an older Save is still validating', async () => {
  let finishValidation!: (response: { ok: boolean; status: number }) => void;
  let validationStarted!: () => void;
  const started = new Promise<void>(resolve => { validationStarted = resolve; });
  const persisted: string[] = [];
  const module = { exports: {} as any };
  const storage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (key: string) => Buffer.from(key),
  };
  vm.runInNewContext(readFileSync('desktop/settings.cjs', 'utf8'), {
    module, Buffer, AbortSignal,
    process: { platform: 'darwin', env: {} },
    require: (name: string) => {
      if (name === 'electron') return { safeStorage: storage };
      if (name === 'node:path') return path;
      if (name === 'node:fs') return { readFileSync: () => 'dark', writeFileSync: () => {}, renameSync: () => {} };
      if (name === 'node:fs/promises') return {
        mkdir: async () => {},
        readFile: async () => { throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); },
        writeFile: async (_file: string, data: Buffer) => { persisted.push(data.toString()); },
        rename: async () => {},
      };
      throw new Error(`Unexpected module ${name}`);
    },
    fetch: () => {
      validationStarted();
      return new Promise(resolve => { finishValidation = resolve; });
    },
  });
  const settings = module.exports;
  await settings.initialize('/test');
  const saving = settings.saveApiKey('dummy-test-key');
  await started;
  const removing = settings.clearApiKey();
  finishValidation({ ok: true, status: 200 });
  await Promise.all([saving, removing]);
  expect(persisted).toEqual(['dummy-test-key', '']);
  expect(settings.getSettings().configured).toBe(false);
  expect(settings.getApiKey()).toBe('');
});
