# Third-party components

Scene Finder uses Electron (MIT) and the dependencies listed in package-lock.json. Electron distributions retain their LICENSE and LICENSES.chromium.html notices; bundled dependencies retain their own license files.

Movie preparation, frame extraction and clip export invoke the separate FFmpeg and FFprobe executables. These builds use FFmpeg 8.0.1 with x264 commit b35605ace3ddf7c1a5d67a2eb553f034aef41d55, under GPL version 2 or later. No nonfree components are enabled. Copyright belongs to the FFmpeg developers and x264 authors.

The application resources/media directory contains COPYING.GPLv2, COPYING.x264, BUILD_CONFIGURATION.txt, and sources/ with the exact unmodified source archives and build recipe. The recipe downloads only pinned inputs and verifies SHA-256 checksums. No FFmpeg library is linked into the application process.

Upstream projects:
- https://ffmpeg.org/
- https://code.videolan.org/videolan/x264
- https://www.electronjs.org/

Development screenshots may show Big Buck Bunny, copyright Blender Foundation, licensed CC BY 3.0: https://peach.blender.org/about/ . That movie is not included in the application package.
