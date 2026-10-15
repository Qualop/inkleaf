# Mac updates

Inkleaf 0.1.3 introduces Sparkle-based updates. Use **Inkleaf > Check for Updates…** (업데이트 확인…). **Automatically Check for Updates** (자동으로 업데이트 확인) controls scheduled checks and retains the user's choice across launches. Automatic checks are enabled initially; silent installation and system profiling are disabled. The standard Mac update window provides installation, cancellation, skip and later choices.

Version 0.1.2 and older have no updater and need one ordinary installation of 0.1.3 or later. Subsequent versions use the in-app path.

## Implementation

Sparkle 2.10.0 is pinned as an official SwiftPM binary artifact with SHA-256 verification. `AppUpdateController` starts after session restoration and delegates download, validation, installation and restart to Sparkle's standard controller. Native menus read its current check availability and persisted automatic-check preference. Unconfigured command-line/development bundles do not start a network updater. Launches with custom `--data-dir` or `--web-root` also disable it: Sparkle relaunches the ordinary app, so these development profiles require a manual update.

The app embeds `resources/update-public-key.txt`. Archives are verified before extraction. The HTTPS feed and its embedded release notes are also signed; unsigned-feed fallback is disabled. Downloads come from the existing GitHub releases. The feed URL is:

https://raw.githubusercontent.com/Qualop/inkleaf/main/updates/appcast.xml

The normal application termination approval remains responsible for checkpointing every window and preserving recovery. Pending encoding, composition, failed checkpoints and user cancellation can keep the app open. User documents and profile data live outside the replaceable application bundle.

## Build and publish

1. `npm run build` creates the app with Sparkle's framework and helpers, public key, update settings and license. Building source does not need a private signing key.
2. `npm run package:mac` creates DMG/PKG, then prepares signed update metadata. The official `generate_appcast` and `sign_update` tools are fetched from the pinned, checksum-verified archive by `prepare-sparkle.mjs`.
3. Signing uses the per-app Keychain account `dev.inkleaf.editor.updates`. `prepare-update.mjs` checks its public key against the bundled key, signs the actual DMG and signed feed, and writes `dist/appcast.xml` plus `update-manifest.json`. The private key remains in the login Keychain. It must never enter Git, logs or release assets.
4. `node scripts/verify-update.mjs` independently verifies the DMG against the embedded public key with CryptoKit, rejects a modified archive and signed feed, verifies update metadata and checks nested app signatures.
5. Publish the release installers, checksums and update metadata. Confirm remote sizes/digests. **Only then** copy `dist/appcast.xml` verbatim to `updates/appcast.xml` and publish that feed commit. A signed feed must not be reformatted; `.gitattributes` disables text transformations for it.

Contributors without the release Keychain account can use `node scripts/package-mac.mjs --skip-update-feed` for a local installer. A fork must use its own signing account, public key and feed URL before distributing automatic updates. Keep signing keys backed up securely; the current ad-hoc app cannot rely on Developer ID key rotation.

Mac release checks include `npm test`, `npm run test:native`, `node scripts/verify-mac-app.mjs`, strict code-signature checks, and actual updater UI/install testing. The app remains ad-hoc signed rather than Developer ID signed/notarized.

Official references: [integration](https://sparkle-project.org/documentation/programmatic-setup/), [security and signing](https://sparkle-project.org/documentation/), [configuration](https://sparkle-project.org/documentation/customization/).
