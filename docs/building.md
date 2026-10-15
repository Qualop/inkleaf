# Build Inkleaf on macOS

[App overview](../README.md) · [User guide](guide/README.md) · [Contributing](../CONTRIBUTING.md)

## Requirements

- A Mac with the macOS SDK and a Swift 6.4 toolchain. The build scripts select `/Applications/Xcode.app` when available.
- Node.js 24 and npm.
- Network access for the initial npm installation and the pinned Sparkle binary artifact.

## Build and test

```sh
npm ci
npm run prepare:pandoc
npm test
npm run test:native
npx tsc --noEmit
npm run build
```

The app is written to `build/Inkleaf.app`. `prepare:pandoc` downloads the pinned official converter and checks its archive and executable hashes. You can omit that step for a build that uses a separately configured local Pandoc.

Open the built app with an isolated development profile:

```sh
open -na build/Inkleaf.app --args --data-dir "$PWD/.state"
```

Keep personal documents out of test fixtures. Custom development data/web roots disable bundle updates so a normal relaunch cannot switch the profile unexpectedly.

## Make a local installer

```sh
node scripts/package-mac.mjs --skip-build --skip-update-feed
```

This creates the DMG, PKG, and checksums in `dist/`. It does not create an official signed update feed. Building the application and a local installer needs no update private key.

Official releases use the maintainer's per-app Keychain signing account. Read [update publishing](updates.md) before preparing a distributable update. A fork must use its own feed, public key, and signing account.

## Native integration checks

```sh
node scripts/verify-mac-app.mjs
node scripts/verify-enter-webkit.mjs --width 1080
node scripts/verify-enter-webkit.mjs --width 620
```

The first command runs the real WKWebView application against temporary files and an isolated profile. The latter commands check editor source/caret/layout behavior at different widths. These checks do not replace testing a physical input method or actual print device.

The native module retains the internal name `Mori`; the app and executable are Inkleaf. Source layout and storage details are in [Architecture](architecture.md).

## Documentation

The main README is English; `README.ko.md` is its Korean counterpart. User-guide pages live in `docs/guide/` and `docs/guide/ko/`. Each topic links to its translation and neighboring topics. Screenshots use the included synthetic examples, not personal documents.
