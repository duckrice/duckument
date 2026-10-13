# Free PDF Editor

A small, free Windows app for the everyday PDF jobs: signing a document, filling in a form, adding text, and marking things up with shapes. Everything happens on your own computer; no account, no uploads.

## What it does

- **Sign**: draw your signature, type it, or use a photo of it. It is remembered, so the next document takes two clicks.
- **Fill in forms**: fillable fields are detected automatically. Click a field and type; Tab moves to the next one.
- **Add text**: press `T`, click anywhere and type. Works on forms that aren't fillable too.
- **Check marks and crosses** for tick boxes on flat forms.
- **Shapes**: rectangles, ellipses, lines, arrows, freehand drawing, and white-out to cover something up.
- **Pictures**: insert an image, or paste one from the clipboard.
- Undo/redo, copy/paste, and smooth zooming (Ctrl + mouse wheel).

The signature is a picture of your signature placed on the page. It is not a certificate-based digital signature.

## Install

Download the latest `.exe` from the [Releases](../../releases) page and run it.

Windows may show "Windows protected your PC" because the installer isn't code-signed. Click **More info**, then **Run anyway**.

## Good to know

- Saving asks where to put the file the first time and suggests `name-edited.pdf`, so the original isn't replaced by accident.
- What you add becomes part of the page when you save. It stays editable until you close the document.
- Editing the text that is already in a PDF isn't supported yet. Use white-out and add new text on top.
- Password-protected PDFs can be opened and filled in, but added text, shapes and signatures can't be saved into them yet.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` | Open / Save / Save as |
| `V` `T` `S` | Select, Text, Sign |
| `C` `X` | Check mark, Cross |
| `R` `O` `L` `A` `P` `W` | Rectangle, Ellipse, Line, Arrow, Draw, White-out |
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
```

`npm run dev` runs just the web part in a browser. `npm run samples` generates test PDFs; open one with `http://localhost:1420/?src=/samples/form.pdf`.

The app is built with [Tauri](https://tauri.app), [PDF.js](https://mozilla.github.io/pdf.js/) for displaying pages and [pdf-lib](https://pdf-lib.js.org) for writing them.

## Releasing

1. Set the new version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. Commit, then tag and push: `git tag v0.1.0 && git push --tags`.
3. GitHub Actions builds the installer and attaches it to a new release.
