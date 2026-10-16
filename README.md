# Scene Finder

Describe a moment in a movie, jump to matching frames, then trim and save an MP4 clip. Scene Finder is a desktop application with cinematic dark and light themes.

## Use it

Download a beta from [GitHub Releases](https://github.com/EmmyMay/scene-finder/releases). On an Apple silicon Mac running macOS 13 or later, open the DMG and drag Scene Finder into Applications. On Windows 10 or 11 x64, run the setup EXE; it installs for your account and creates a Start menu shortcut. Intel Mac builds are not available. Linux x64 remains a portable archive.

**These beta installers are unsigned for public distribution** (ad-hoc signed and not notarized on macOS). Operating-system security prompts are expected. Do not describe them as signed releases.

1. Open **Settings** and connect your Jev API key.
2. Choose an MKV or MP4 movie. Other FFmpeg-readable formats may also work; incompatible media is prepared for playback locally.
3. Describe what is visible in the scene, then choose a match to seek there.
4. Set **IN** and **OUT**, preview the range, then export and save the clip.

Movies and exported clips stay on your device. Search sends sampled frames and your query to Jev. Results are approximate sampled matches, not exact scene boundaries or guaranteed detections. V1 searches visible content; it does not search dialogue or audio.

A Jev account, your own API key, and an internet connection are required for search. No API key or search credits are included; provider usage belongs to your Jev account. Uninstalling the app preserves imported movies and settings in your user profile.

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

The desktop process binds its local service to loopback, authenticates media/API requests with a per-launch token, and keeps the Jev key in OS-encrypted storage. If secure storage is unavailable, a validated key works for the current session with a visible warning; it is never saved unencrypted. Theme preferences survive application restarts. Imported movies are stored under the operating system's Scene Finder application-data folder.

## Validate and package

```sh
npm run typecheck
npm test
node scripts/check-media.mjs
npm run package:desktop
```

When testing, put `.data/media` on PATH so the suite uses the bundled tools. Packaging verifies executable architecture, native encoding, dependency linkage and corresponding source archives. Packages go to `release/`. The GitHub Actions workflow builds on macOS, Windows and Linux and uploads each package as a workflow artifact.

`package:desktop` creates a versioned Mac DMG using `hdiutil`, a Windows setup EXE using Inno Setup 6, or a Linux tar archive. Windows builders need Inno Setup 6 installed in its default location, or `ISCC_PATH` set to the compiler. GitHub's Windows runner includes it. Native app icons are checked in; `python3 scripts/generate-app-icons.py` regenerates them with Pillow.

Windows CI installs the EXE, verifies its payload and Start menu shortcut, launches the installed app, and uninstalls it. Mac packaging verifies the DMG. A passing build is not evidence of hands-on testing on every operating system.

The **Publish desktop downloads** workflow takes a successful **Desktop builds** run from `master` (push or manual dispatch) and a new version-matching beta tag. It verifies the expected Mac, Windows and Linux files and publishes SHA-256 checksums alongside them. PR merge-ref builds cannot be published through this workflow.

## Signing before general release

The current scripts deliberately produce unsigned beta installers. Signing credentials are not configured or bundled.

- **macOS:** an active Apple Developer Program membership, the Team ID, and a **Developer ID Application** certificate with access to its private key. For CI, use a password-protected certificate export in encrypted GitHub secrets. Notarization also needs an App Store Connect API key (key ID, issuer ID, and private `.p8` key), or an Apple ID with an app-specific password and Team ID. A Developer ID Installer certificate is not needed for our drag-and-drop DMG. Once available, configure hardened-runtime signing for the app and nested executables, sign the DMG, submit it for notarization, staple the ticket, and verify with Gatekeeper. See [Apple's Developer ID guide](https://developer.apple.com/developer-id/).
- **Windows:** the publisher's legal name and access to a public-trust Authenticode code-signing certificate/service, including its hardware or cloud key access and CI authentication. Sign the app, generated uninstaller and setup EXE with a trusted timestamp. If using Azure Artifact Signing, provide its account, certificate profile, endpoint and Entra identity permissions. Check [Microsoft's eligibility requirements](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) first: public-trust individual accounts currently require US or Canadian residency; organization eligibility also depends on country. Another public-trust provider may be required.

Provide signing access through the OS keychain, provider console, or encrypted CI secrets, not source files or chat. After signing, repeat clean-machine download/install checks and update the website's unsigned-beta notice. Windows signing does not guarantee that SmartScreen reputation prompts disappear immediately.

The movie upload limit defaults to 2 GiB and can be changed with `MAX_UPLOAD_BYTES`. A search is limited to 4,000 sampled frames (`MAX_SAMPLED_FRAMES`); at the default two-second interval, this covers about 133 minutes. Imported movies and temporary search files are local application data; V1 does not provide a library-management interface.

## Media components

FFmpeg and FFprobe are separate GPL executables. Their exact source archives, build recipe, configuration and license texts accompany the application under `resources/media` (inside `Contents/Resources` on macOS). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
