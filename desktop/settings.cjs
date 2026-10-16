const { safeStorage } = require('electron');
const { mkdir, readFile, writeFile, rename } = require('node:fs/promises');
const { readFileSync, writeFileSync, renameSync } = require('node:fs');
const path = require('node:path');

let currentKey = '';
let keyFile;
let appearanceFile;
let appearance = 'dark';
let mutationQueue = Promise.resolve();
const model = process.env.JEV_MODEL || 'jev-preview';

async function persistKey(key) {
  if (!await safeStorage.isAsyncEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('Secure storage is unavailable. Unlock your system keychain or password wallet and try again.');
  }
  const encrypted = await safeStorage.encryptStringAsync(key);
  const temporary = `${keyFile}.tmp`;
  await writeFile(temporary, encrypted, { mode: 0o600 });
  await rename(temporary, keyFile);
}

async function initialize(userData) {
  await mkdir(userData, { recursive: true });
  keyFile = path.join(userData, 'jev-key.encrypted');
  appearanceFile = path.join(userData, 'appearance');
  try { if (readFileSync(appearanceFile, 'utf8') === 'light') appearance = 'light'; } catch {}
  try {
    const encrypted = await readFile(keyFile);
    const decrypted = await safeStorage.decryptStringAsync(encrypted);
    currentKey = decrypted.result;
    if (decrypted.shouldReEncrypt) await persistKey(currentKey);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Keep an unreadable saved key intact; reconnecting in Settings can replace it.
      currentKey = '';
      return;
    }
    currentKey = process.env.TYPESAFE_API_KEY?.trim() || '';
    if (currentKey) await persistKey(currentKey);
  }
}

function getSettings() {
  return { configured: Boolean(currentKey), model };
}

function setAppearance(value) {
  if (value !== 'light' && value !== 'dark') throw new Error('Choose Light or Dark.');
  writeFileSync(`${appearanceFile}.tmp`, value, { mode: 0o600 });
  renameSync(`${appearanceFile}.tmp`, appearanceFile);
  appearance = value;
  return appearance;
}

function saveApiKey(value) {
  return mutateKey(() => validateAndSaveApiKey(value));
}

function mutateKey(operation) {
  const result = mutationQueue.then(operation);
  mutationQueue = result.catch(() => {});
  return result;
}

async function validateAndSaveApiKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /\s/.test(value.trim())) {
    throw new Error('Enter a valid Jev API key.');
  }
  const key = value.trim();
  let response;
  try {
    response = await fetch('https://api.typesafe.ai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error('Could not connect to Jev. Check your internet connection and try again.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('Jev did not accept this key. Check the key and try again.');
  }
  if (!response.ok) throw new Error('Jev is unavailable right now. Try again shortly.');
  await persistKey(key);
  currentKey = key;
  return { configured: true };
}

function clearApiKey() {
  return mutateKey(async () => {
    // Persist an empty value so a development environment key is not restored on restart.
    await persistKey('');
    currentKey = '';
    return { configured: false };
  });
}

module.exports = { initialize, getSettings, saveApiKey, clearApiKey, getApiKey: () => currentKey, getAppearance: () => appearance, setAppearance };
