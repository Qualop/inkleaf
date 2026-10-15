[Guide home](README.md) · [한국어](ko/troubleshooting.md)

# Troubleshooting

## macOS blocks the first launch

The community release is not Developer ID signed or Apple notarized. Verify that your download came from the [official release page](https://github.com/Qualop/inkleaf/releases/latest), then follow the Mac's message in **System Settings → Privacy & Security**. The download page includes checksums. Do not disable system-wide security settings.

## I can see Markdown symbols

Check **View → Write** versus **Markdown Source**. Write also shows the source for the block you are editing. For a read-only formatted page, use Preview.

## The document says “Draft kept”

A recovery draft has been kept locally. Press **⌘S** to save the file itself. An untitled document needs a folder and filename before auto-save can write a normal file. See [saving and recovery](files-and-recovery.md).

## An image is missing after moving the Markdown

Check whether the relative image path still points to the accompanying image file. Move the assets with the Markdown, or use Save As from the original document so referenced images can be copied to the new location. A remote image also needs network access to its server.

## Spelling suggestions do not fit the text

Check the language in **Settings → Spelling & Dictionary**. Use the personal dictionary for names and specialized terms. macOS grammar support varies by language; a marked sentence is a suggestion, not a final judgment.

## A formula or diagram shows an error

Inspect its source delimiters and syntax. Math uses `$…$` or `$$…$$`; Mermaid uses a fenced `mermaid` block. Start with the [small examples](images-math-diagrams.md) and add complexity gradually.

## A converter export fails

For Word, EPUB, or another converter format, check the Pandoc path in **Settings → Export**. The Mac release includes Pandoc; a custom path takes precedence. Remove an obsolete custom path if you want the bundled converter again. Keep the editable Markdown while resolving the output problem.

## An update cannot be checked or installed

Try **Inkleaf → Check for Updates…** when online. Run the app from Applications rather than the mounted DMG. Version 0.1.2 and older need an ordinary installation of an updater-enabled release. Update checks are disabled for custom development `--data-dir` or `--web-root` launches.

## Report a reproducible problem

[Open an issue](https://github.com/Qualop/inkleaf/issues) with your Inkleaf version, macOS version, the steps you took, and what happened. Use a short synthetic example rather than a private document. Screenshots help when the issue is visual.

---

[← Keyboard shortcuts](shortcuts.md) · [Back to guide](README.md)
