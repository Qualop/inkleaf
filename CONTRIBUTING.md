# Contributing

Use Node.js 24. For native work, use a Swift 6.4 toolchain with the macOS SDK.

```sh
npm ci
npm test
npx tsc --noEmit
npm run test:native
```

Use `--data-dir` with an isolated temporary directory for app testing. Never use personal documents as fixtures. Preserve Unicode source, undo history, disk conflict checks, recovery data and the distinction between saving to a file and keeping a local draft.

Keep patches focused and include meaningful regression tests for behavior changes. Changes to icon packaging must preserve the default Black Ink icon and include both ICNS resources, without modifying signed bundles at runtime. Original contributions are licensed under MIT.
