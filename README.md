# Duckument

A small, free Windows app for the everyday PDF jobs: signing a document, filling in a form, adding text, and marking things up with shapes. Everything happens on your own computer; no account, no uploads.

## What it does

- **Sign**: draw your signature, type it, or use a photo of it. It is remembered, so the next document takes two clicks.
- **Fill in forms**: fillable fields are detected automatically. Click a field and type; Tab moves to the next one.
- **Fill in forms that aren't fillable**: press `T` and the empty lines, boxes, table cells and tick boxes on the page light up. Click one to type in it, sized and placed to fit; Tab moves to the next. Click a tick box to tick it.
- **Edit text in the document**: press `E` and click any text to change it. It keeps its size and colour, and its font when that is one that comes with Windows (Arial, Calibri, Times New Roman, Verdana and others).
- **Add text**: press `T`, click anywhere and type.
- **Check marks and crosses** for tick boxes.
- **Shapes**: rectangles, ellipses, lines, arrows, freehand drawing, and white-out to cover something up.
- **Redact**: press `B` and draw over what must go. When you save, the page becomes a picture of itself with the boxes black, so the text, pictures and links underneath are really gone from the file (unlike white-out, which only covers them). The rest of that page can then no longer be selected as text.
- **Page numbers, headers, footers and watermarks**: page numbers or your own text ({n}, {total}, {date}) at the top or bottom, and watermarks, on every page, as ordinary text you can still move or change; Undo takes them all off.
- **Pictures**: insert an image, or paste one from the clipboard.
- Undo/redo, copy/paste, and smooth zooming (Ctrl + mouse wheel).
- Updates itself: when a new version is out, Duckument offers to install it.

The signature is a picture of your signature placed on the page. It is not a certificate-based digital signature.

## Install

**[Download Duckument-Setup.exe](https://github.com/duckrice/duckument/releases/latest/download/Duckument-Setup.exe)** and run it. That one file is all you need; it works on Windows 10 and 11.

Windows may show "Windows protected your PC" because the installer isn't code-signed. Click **More info**, then **Run anyway**.

Afterwards the app is in the Start menu, and in the **Open with** list when you right-click a PDF.

## Good to know

- Saving asks where to put the file the first time and suggests `name-edited.pdf`, so the original isn't replaced by accident.
- What you add becomes part of the page when you save. It stays editable until you close the document.
- Editing text works a line at a time: the original is painted over and your version is put on top. Other text doesn't move to make room, a font that isn't installed is swapped for a similar one, and text that is sideways or part of a scanned picture can't be edited.
- Because edited text is painted over, the original words are still inside the saved file, hidden. Don't rely on it to remove confidential information.
- Blank detection looks for a line or a frame with empty space on it. Dotted lines and shaded areas without an outline aren't recognised; you can still click there and type.
- Password-protected PDFs can be opened and filled in, but added text, shapes and signatures can't be saved into them yet.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` | Open / Save / Save as |
| `V` `T` `E` `S` | Select, Text (and fill in blanks), Edit text, Sign |
| `Tab` / `Shift+Tab` while typing | Next / previous blank |
| `C` `X` | Check mark, Cross |
| `R` `O` `L` `A` `P` `W` `B` | Rectangle, Ellipse, Line, Arrow, Draw, White-out, Redact |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+C` `Ctrl+V` `Ctrl+D` | Copy, Paste, Duplicate |
| `Del` | Delete the selected item |
| Arrow keys | Nudge the selected item (Shift for bigger steps) |
| `Ctrl` + wheel, `Ctrl` `+` / `-` / `0` | Zoom in, out, fit width |

## Development

Requires [Node.js](https://nodejs.org), [Rust](https://rustup.rs) and the Microsoft C++ Build Tools.

```bash
npm install
npm run tauri dev     # run the desktop app with live reload
npm test              # tests for the PDF writing code
npm run tauri build   # build the installer into src-tauri/target/release/bundle/nsis
npm run smoke         # drive the built app through a quick end-to-end check
npm run test:update   # install a real update end to end (about 15 minutes)
```

Updates are signed. Building the installer needs the private update-signing key:
set `TAURI_SIGNING_PRIVATE_KEY` to the contents of `~/.tauri/duckument.key` (and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to an empty string). For local testing,
`npm run tauri build -- --no-bundle` builds just the app and needs no key.

`npm run dev` runs just the web part in a browser. `npm run samples` generates test PDFs; open one with `http://localhost:1420/?src=/samples/form.pdf`.

The app is built with [Tauri](https://tauri.app), [PDF.js](https://mozilla.github.io/pdf.js/) for displaying pages and [pdf-lib](https://pdf-lib.js.org) for writing them.

## Releasing

1. Set the new version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. Commit and push, then tag and push the tag: `git tag v1.0.1 && git push origin v1.0.1`.
3. GitHub Actions builds the installer and publishes it as a new release. The download link above always points at the newest one. Installed copies find it through `latest.json` and offer to update.

The release workflow signs updates with the repository secret `TAURI_SIGNING_PRIVATE_KEY`. Keep a backup of the key: without it, installed copies can never be updated again.
