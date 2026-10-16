// Apply the saved appearance before the first paint; storage may be blocked.
try {
  const theme = localStorage.getItem('scene-finder-site-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { }
