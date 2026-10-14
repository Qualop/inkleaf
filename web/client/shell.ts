const icon = (paths: string) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

/** The writing surface stays quiet. Document tools live in native menus and these optional popovers. */
export const shell = `
<div class="message" role="status" aria-live="polite" hidden>
  <span data-message></span><button data-action="dismiss-message" aria-label="Dismiss message">Dismiss</button><button data-action="retry" hidden>Retry</button><button data-action="cancel-job" hidden>Cancel</button>
</div>
<div class="workspace">
  <aside id="sidebar" class="sidebar" hidden>
    <nav class="sidebar-tabs" aria-label="Sidebar"><button data-action="files" aria-pressed="true">Files</button><button data-action="outline" aria-pressed="false">Outline</button><button data-action="find" aria-pressed="false">Search</button></nav>
    <div data-panel="files">
      <div class="file-actions"><button data-action="folder">Open Folder…</button><button data-action="quick-open" aria-label="Quick Open" title="Quick Open">${icon('<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>')}</button></div>
      <p class="sidebar-section-title">Open documents</p><nav class="document-tabs" role="tablist" aria-label="Open documents"></nav>
      <p data-folder-label>Open a folder to browse files.</p>
      <details class="folder-options"><summary>Folder options</summary><button data-action="pin-folder" disabled>Pin Folder</button><label>Sort files<select data-control="file-sort" aria-label="Sort files" disabled><option value="name">Name</option><option value="modified">Recently modified</option><option value="size">Size</option></select></label></details>
      <div class="file-tree" role="tree" aria-label="Workspace files"></div>
    </div>
    <div data-panel="outline" hidden><div class="outline" aria-label="Document outline"></div></div>
    <div data-panel="search" hidden><div class="search-fields"><label>Find<input data-control="find" type="search" autocomplete="off"></label><label>Replace<input data-control="replacement" type="text"></label><div class="search-flags"><label><input data-control="caseSensitive" type="checkbox">Case</label><label><input data-control="regex" type="checkbox">Regex</label><label><input data-control="wholeWord" type="checkbox">Word</label></div><div class="search-actions"><button data-action="previous-match">Previous</button><button data-action="next-match">Next</button><button data-action="replace-one">Replace</button><button data-action="replace-all">Replace All</button><button data-action="workspace-search">Search Folder</button></div><p data-search-status role="status">Enter text to search this document.</p><div data-search-results></div></div></div>
  </aside>
  <main class="document-area" aria-label="Document"><div class="editor-host"></div><article class="reading markdown-body" hidden tabindex="0" aria-label="Reading view"></article></main>
</div>
<footer class="statusbar" aria-label="Document tools">
  <div class="writing-controls">
    <button class="icon-button" data-action="sidebar" aria-label="Sidebar" title="Sidebar" aria-expanded="false" aria-controls="sidebar">${icon('<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M9 4v16"/>')}</button>
    <button class="icon-button" data-action="source" aria-label="Markdown Source" title="Markdown Source" aria-pressed="false">${icon('<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-12-2 14"/>')}</button>
    <details class="chrome-popover command-menu">
      <summary class="icon-button" aria-label="Document menu" title="Document menu">${icon('<circle cx="5" cy="12" r=".7"/><circle cx="12" cy="12" r=".7"/><circle cx="19" cy="12" r=".7"/>')}</summary>
      <div class="popover-panel" aria-label="Document menu">
        <div class="menu-section"><button data-action="new">New</button><button data-action="open">Open…</button><button data-action="save">Save</button><button data-action="save-as">Save As…</button></div>
        <div class="menu-section">
          <details class="menu" data-menu="format"><summary>Format</summary><div class="menu-items"></div></details>
          <details class="menu" data-menu="insert"><summary>Insert</summary><div class="menu-items"></div></details>
          <details class="menu" data-menu="edit"><summary>Edit</summary><div class="menu-items"></div></details>
          <button data-action="themes">Themes…</button>
        </div>
        <div class="menu-section"><label class="mode-label">Editing mode<select data-control="mode" aria-label="Editing mode"><option value="live">Write</option><option value="source">Markdown Source</option><option value="reading">Preview</option></select></label><p class="mode-hint">Write with formatting, edit Markdown source, or preview without editing.</p><button data-action="focus" aria-pressed="false">Focus</button><button data-action="typewriter" aria-pressed="false">Typewriter</button><button data-action="outline">Outline</button><button data-action="find">Find</button></div>
        <div class="menu-section"><button data-action="export-options">Export…</button><button data-action="settings">Settings…</button></div>
      </div>
    </details>
  </div>
  <span data-save-indicator hidden></span><span data-selection></span>
  <details class="chrome-popover document-info">
    <summary data-word-count aria-label="Document statistics">0 words</summary>
    <div class="popover-panel" aria-label="Document properties">
      <p data-statistics></p><p data-save-state></p>
      <label>Encoding<select data-control="encoding" aria-label="Document encoding"><option value="utf8">UTF-8</option><option value="utf8bom">UTF-8 with BOM</option><option value="utf16le">UTF-16 LE</option><option value="utf16be">UTF-16 BE</option></select></label>
      <label>Line endings<select data-control="line-ending" aria-label="Line endings"><option value="LF">LF</option><option value="CRLF">CRLF</option></select></label>
    </div>
  </details>
</footer>`;
