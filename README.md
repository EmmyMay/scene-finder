# Scene Finder

Describe a moment in a movie, jump to matching frames, then trim and save an MP4 clip. Scene Finder is a desktop application with cinematic dark and light themes.

## Use it

1. Open **Settings** and connect your Jev API key.
2. Choose an MKV or MP4 movie. Other FFmpeg-readable formats may also work; incompatible media is prepared for playback locally.
3. Describe what is visible in the scene, then choose a match to seek there.
4. Set **IN** and **OUT**, preview the range, then export and save the clip.

Movies and exported clips stay on your device. Search sends sampled frames and your query to Jev. Results are approximate sampled matches, not exact scene boundaries or guaranteed detections. V1 searches visible content; it does not search dialogue or audio.

## Desktop development

Use Node.js 22 and a native build toolchain. Copy `.env.example` to `.env` for development, or enter the key through Settings. Local environment files and movies are excluded from Git and application packages.

```sh
npm ci
npm run media:prepare
npm run desktop
```

`media:prepare` builds pinned FFmpeg and x264 sources for the current machine. It requires:

- macOS 13 or newer: Xcode command-line tools and `brew install pkgconf nasm`.
- Windows x64: MSYS2 MINGW64 with GCC, make, pkgconf, nasm, curl, tar and xz. Run media preparation in that shell. The packaged app does not need MSYS2.
- Linux x64: a C compiler, make, pkg-config, nasm, curl, tar and xz. Omarchy support is best effort; an unlocked Secret Service password store is needed to save a key securely.

The desktop process binds its local service to loopback, authenticates media/API requests with a per-launch token, and keeps the Jev key in OS-encrypted storage. Theme preferences survive application restarts. Imported movies are stored under the operating system's Scene Finder application-data folder.

## Validate and package

```sh
npm run typecheck
npm test
node scripts/check-media.mjs
npm run package:desktop
```

When testing, put `.data/media` on PATH so the suite uses the bundled tools. Packaging verifies executable architecture, native encoding, dependency linkage and corresponding source archives. Packages go to `release/`. The GitHub Actions workflow builds on macOS, Windows and Linux and uploads each package as a workflow artifact.

These are demo builds: macOS packages use an ad-hoc signature, and Windows packages are unsigned. They are not notarized installers. A passing build is not evidence of hands-on testing on every operating system.

The movie upload limit defaults to 2 GiB and can be changed with `MAX_UPLOAD_BYTES`. A search is limited to 4,000 sampled frames (`MAX_SAMPLED_FRAMES`); at the default two-second interval, this covers about 133 minutes. Imported movies and temporary search files are local application data; V1 does not provide a library-management interface.

## Media components

FFmpeg and FFprobe are separate GPL executables. Their exact source archives, build recipe, configuration and license texts accompany the application under `resources/media` (inside `Contents/Resources` on macOS). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
