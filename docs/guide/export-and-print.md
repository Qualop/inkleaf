[Guide home](README.md) · [한국어](ko/export-and-print.md)

# Exporting and printing

## Export a document

Choose a format under **File → Export**. Use **File → Export Options…** when you want to choose the format and adjust output settings together.

| Output | Useful for |
| --- | --- |
| PDF | A paginated document for reading, printing, or feedback |
| HTML | A formatted page to view in a browser |
| PNG or JPEG | A rendered image of the document |
| SVG | Browser-oriented rendered output |
| Markdown or Plain Text | Text for another editor or workflow |
| Word (DOCX) or EPUB | Further editing or reading in another app |

Additional converter formats include OpenDocument, RTF, LaTeX, reStructuredText, Textile, OPML, MediaWiki, GFM, and CommonMark. Converter-based outputs use Pandoc, included in the Mac release. A custom converter path can be set in **Settings → Export**.

## Adjust the output

In Export Options, choose the available settings for your format: title, author, contents, document theme, or dark background. Rendered outputs also offer controls such as paper, margins, width, quality, headers, and footers. Converter formats expose their relevant template and conversion options instead.

Save a named preset to reuse a setup. **Repeat Export** uses the previous export setup for the current document.

Export creates a separate output file. Keep saving the Markdown document when you want to preserve the editable source. Layout can change when a document is converted to another format.

## Print

Press **⌘P** or choose **File → Print…**. Review the native Mac print preview, choose a printer or the system PDF option, and continue from that dialog.

## Import Word and EPUB documents

Choose **File → Import Document…**. Converted files open as editable Markdown; embedded images from supported Word/EPUB imports are extracted with the draft. Save the imported document to choose its Markdown location and publish referenced images.

Keep the original when its exact formatting matters: imported Markdown is a conversion, not an in-place edit of the Word or EPUB file.

---

[← Images, equations, and diagrams](images-math-diagrams.md) · [Appearance and settings →](appearance-and-settings.md)
