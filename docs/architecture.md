# Architecture

Inkleaf has a native macOS AppKit host. It loads the local TypeScript editor in WKWebView through a narrow request/reply bridge. The editor runs from bundled files.

## Source map

- `Sources/DocumentCore`: document bytes, disk baselines, recovery, settings, session state, workspace and theme storage.
- `Sources/ToolCore`: process execution and cancellation for external conversion tools.
- `Sources/Mori`: native windows, menus, bridge handlers, export, spelling and app icon selection. Mori is an internal module name retained for compatibility.
- `web/client`: editor interactions, global/document preferences and dialogs.
- `web/core` and `web/render`: document operations, Markdown and preview rendering.
- `resources`: the two selected app icon source images.
- `scripts`: web/native build, verified Pandoc acquisition, installers.

## Icon preference

`appIcon` is global and accepts `ink` or `leaf`. New profiles and invalid stored values use `ink`. Document-scoped overrides cannot change it. Native setting requests validate before writing. AppKit applies an NSImage loaded from the corresponding bundled ICNS; it never rewrites the signed app's resources. Thus Dock selection can persist through the settings file while the installed Finder icon remains the default.

## Storage compatibility

New native installations use `~/Library/Application Support/Inkleaf`. If an existing Mori profile directory is present, that location is reused intact. `--data-dir` overrides the default for development and isolated tests. Document contents, local drafts, settings and session files do not belong in source control or release media.

Internal protocol/CSS identifiers retain the `mori` prefix to preserve their existing contracts. The user-facing product and executable are named Inkleaf.

## Export and dependencies

HTML, image and PDF output use the local rendering pipeline. Other formats can invoke the separately licensed Pandoc executable. Official archive and binary hashes are checked by the download preparation script; source and license links accompany distribution.

External image uploaders are optional programs explicitly configured in Settings. Local editing and image insertion work without an account.
