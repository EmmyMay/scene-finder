const root = document.documentElement;
const themeButton = document.querySelector('.theme-toggle');
const previewButton = document.querySelector('[data-change-theme]');
function syncTheme() {
  const light = root.dataset.theme === 'light';
  themeButton.setAttribute('aria-label', `Switch to ${light ? 'dark' : 'light'} mode`);
  themeButton.title = themeButton.getAttribute('aria-label');
  previewButton.innerHTML = `See ${light ? 'dark' : 'light'} mode <span aria-hidden="true">↗</span>`;
  document.querySelector('meta[name="theme-color"]').content = light ? '#f7f7fa' : '#111217';
}
function toggleTheme() {
  root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('scene-finder-site-theme', root.dataset.theme); } catch { }
  syncTheme();
}
themeButton.hidden = previewButton.hidden = false;
themeButton.addEventListener('click', toggleTheme);
previewButton.addEventListener('click', toggleTheme);
syncTheme();

// Pick an OS, never infer Apple silicon from the browser's misleading MacIntel value.
const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const platform = navigator.userAgentData?.platform || navigator.platform || '';
const os = !mobile && (/Win/i.test(platform) ? 'windows' : /Mac/i.test(platform) ? 'mac' : null);
if (os) {
  const download = document.querySelector(`[data-installer="${os}"]`);
  document.querySelector('[data-primary-download]').href = download.href;
  document.querySelector('[data-download-label]').textContent = os === 'mac' ? 'Download for Mac' : 'Download for Windows';
  document.querySelector('[data-platform-note]').textContent = os === 'mac' ? 'Apple silicon · macOS 13+' : 'Windows 10 / 11 · x64';
  document.querySelector(`[data-os="${os}"]`).classList.add('suggested');
} else if (mobile) {
  document.querySelector('[data-download-label]').textContent = 'Get the desktop app';
}

const video = document.querySelector('video');
video.addEventListener('play', () => video.closest('.scene-screen').classList.add('is-playing'));
video.addEventListener('ended', () => video.closest('.scene-screen').classList.remove('is-playing'));
