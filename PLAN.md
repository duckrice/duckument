# Duckument: next improvements

Agreed with the user on 2026-10-14. Work through the stages in order. Finish and
test each one fully (its own tests, the full `npm run smoke:shots`, a commit)
before starting the next. Nothing is published until the user says so.

Not included, by choice: "fill with my details", print, compress/OCR, password
protection, code signing (the SmartScreen warning is fine).

## Stage 1: Automatic updates
1. Add Tauri's updater plugin. Generate an update-signing key; the private key
   goes into the GitHub secret `TAURI_SIGNING_PRIVATE_KEY` (the user adds it).
2. The release workflow also publishes `latest.json` (and the signature). The
   download for people stays the single `Duckument-Setup.exe`.
3. On startup, check quietly; show "Duckument X is available – Update". Update
   downloads, installs and restarts.
4. Test: two local builds (1.1.0, 1.1.1) and a local update server: finds,
   installs, restarts as 1.1.1, keeps signatures and settings; rejects a bad
   signature.

## Stage 2: Tabs and recent files
1. One document object per open file: its pages, items, undo history.
2. Tab bar: several PDFs, Ctrl+Tab, Ctrl+W, "save changes?" per tab and on quit.
3. Single instance: a PDF opened from Explorer goes into the running window.
4. Recent files on the start screen; files that no longer exist are skipped.
5. Test: separate edits and undo per tab; close prompts; opening a second file
   from outside lands in a tab; recent list survives a restart.

## Stage 3: Page tools
1. Document model becomes a list of pages (source file, page, rotation). Items
   belong to a page and move with it.
2. Thumbnail sidebar, click to jump, Ctrl/Shift-click to select.
3. Drag to reorder; rotate; delete; insert blank page. All undoable.
4. Merge: "Add PDF…" inserts another file's pages.
5. Extract: save selected pages as a new PDF.
6. Keep fillable fields working for reorder/rotate/delete; merged-in files'
   fields are kept as filled-in text.
7. Test: page order, rotation, text and fields in saved files; items follow
   their pages; undo/redo; a 300-page file stays smooth.

## Stage 4: Search, select and copy
1. Text layer: select document text in Select mode, Ctrl+C copies it (a selected
   item still copies the item).
2. Ctrl+F: highlight all matches, Enter / Shift+Enter, "3 of 12", case-insensitive,
   handles æøå.
3. Test: copy across lines; every match found in a 50-page file; no interference
   with forms, editing or drawing.

## Stage 5: Highlight, underline, strike-through, notes
1. Markup tool on selected text, following the text lines; highlight colours.
2. Highlights blend (multiply) so text stays readable, on screen and saved.
3. Sticky notes saved as standard PDF comments (visible on purpose).
4. Test: alignment at several zooms and on rotated pages; saved file matches;
   notes readable from the file; undo/delete.

## Stage 6: Better blank detection
1. Dotted and dashed lines count as underlines; text is not mistaken for dots.
2. Shaded boxes without an outline count as fields (not with text, not photos).
3. Test: synthetic tests plus a sample with dotted, dashed and shaded fields;
   existing samples give exactly the same blanks as before.

## Stage 7: Real text removal and paragraph editing
1. Parse page content streams (and form XObjects), find the glyphs behind an
   edited run.
2. On save, remove them and keep everything else exactly in place. Paint-over
   only as a fallback, and tell the user when it was used.
3. Edit a whole paragraph: re-wraps within its width; justified stays justified.
4. Line breaks computed once and used for both screen and file.
5. Test: removed words no longer extractable; other text unmoved; wrapping
   identical on screen and in the file; all font types in the samples.

## Stage 8: Edits stay editable after saving
Decided with the user (option 1): the hidden copy of the edits is encrypted with
a key that only exists on the user's computer. Everyone else, in Duckument or
any other reader, sees a normal finished page. If the key is lost (new PC,
reinstalled Windows), old files simply stay permanent.
1. Store the item data privately and encrypted (key kept in the app's data on
   this computer) in the PDF; keep Duckument's drawing in its
   own content stream; on reopen, drop that stream and restore the items.
2. Never store text that Stage 7 removed.
3. Test: save → reopen → edit → save for every item type; other readers show a
   plain page; saving twice doesn't duplicate anything.

## Finally
Full test run with screenshots for the user. Release 1.1.0 (or later) only when
the user says so.
