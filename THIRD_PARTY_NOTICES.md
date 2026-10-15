# Third-party components

Inkleaf's original source is licensed under the MIT License. Dependencies retain their respective licenses. Generated icon artwork is distributed with the project under the same MIT terms. Icon concepts were created with OpenAI's image generation tool and selected by the project owner.

The application bundles CodeMirror, Lezer, Markdown-it and plugins, DOMPurify, Highlight.js, MathJax, Mermaid, YAML, and their transitive dependencies. Runtime component license texts are generated from the locked npm installation into `web/dist/THIRD_PARTY_NOTICES.txt` and included in the packaged app.

Pandoc is a separate executable invoked through its command-line interface. It is distributed under the GNU General Public License, version 2 or later. Its full GPL license accompanies the macOS bundle at `Contents/Resources/tools/COPYING.md`, with copyright/component notices in `PANDOC_LICENSE.txt`. Pandoc is not covered by Inkleaf's MIT License.

The bundled Pandoc version and official archive/binary checksums are recorded in `tools/pandoc-provenance.json`. Pandoc 3.12.1 corresponding source is available at:

- https://github.com/jgm/pandoc/releases/tag/3.12.1
- https://github.com/jgm/pandoc/archive/refs/tags/3.12.1.tar.gz

macOS updates use Sparkle 2.10.0, distributed under its BSD license and bundled third-party notices. The complete text is included at `Contents/Resources/SPARKLE_LICENSE.txt` and `tools/SPARKLE_LICENSE.txt`. The framework is pinned to the official release and SwiftPM binary checksum. Source and releases: https://github.com/sparkle-project/Sparkle
