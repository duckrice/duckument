// Drives the built desktop app over the DevTools protocol (WebView2 remote
// debugging) and checks the things unit tests can't: that a file opens and
// renders, forms, adding and moving items, blank detection, editing existing
// text, the native file commands, and what ends up in a saved PDF.
//
//   npm run samples && npm run tauri build -- --no-bundle && npm run smoke
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = join(root, "src-tauri", "target", "release", "freepdfeditor.exe");
const sample = (name) => join(root, "samples", name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`);
}

/** Starts the app with `file` open and hands `run` helpers for driving it. */
async function session(file, port, run) {
  const child = spawn(exe, [file], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: "ignore",
  });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
    } catch {
      // Not listening yet.
    }
  }
  if (!target) {
    child.kill();
    throw new Error("The app did not start, or remote debugging is unavailable");
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let nextId = 1;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const details = msg.params.exceptionDetails;
      errors.push(details.exception?.description ?? details.text);
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      errors.push(msg.params.args.map((arg) => arg.value ?? arg.description).join(" "));
    } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      errors.push(msg.params.entry.text);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const app = {
    errors,
    async evaluate(expression) {
      const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
      return result.result.value;
    },
    mouse: (type, x, y, extra = {}) =>
      send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra }),
    async click(x, y) {
      await app.mouse("mouseMoved", x, y, { buttons: 0 });
      await app.mouse("mousePressed", x, y);
      await app.mouse("mouseReleased", x, y);
    },
    async drag(x1, y1, x2, y2) {
      await app.mouse("mouseMoved", x1, y1, { buttons: 0 });
      await app.mouse("mousePressed", x1, y1);
      for (let i = 1; i <= 8; i++) await app.mouse("mouseMoved", x1 + ((x2 - x1) * i) / 8, y1 + ((y2 - y1) * i) / 8);
      await app.mouse("mouseReleased", x2, y2);
    },
    wheel: (x, y, deltaY, modifiers = 0) => send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers }),
    /** `modifiers`: 2 is Ctrl. */
    async key(name, code, modifiers = 0) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: code, modifiers });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code, modifiers });
    },
    type: (text) => send("Input.insertText", { text }),
    /** The centre of the index-th element matching `selector`, scrolled into view. */
    center: (selector, index = 0) =>
      app.evaluate(`(() => {
        const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height];
      })()`),
    async clickOn(selector, index = 0) {
      const at = await app.center(selector, index);
      if (!at) throw new Error(`Nothing matches ${selector} [${index}]`);
      await app.click(at[0], at[1]);
    },
    tool: (title) => app.clickOn(`.tb[title^="${title}"]`),
    count: (selector) => app.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`),
    async waitFor(expression, ms = 10000) {
      for (let t = 0; t < ms; t += 200) {
        if (await app.evaluate(expression)) return true;
        await sleep(200);
      }
      return false;
    },
    invoke: (command, args) => app.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args ?? {})})`),
  };
  await send("Runtime.enable");
  await send("Log.enable");
  try {
    await app.waitFor(`!!document.querySelector(".page canvas")`);
    await sleep(800);
    await run(app);
  } finally {
    ws.close();
    child.kill();
    await sleep(500);
  }
}

const ESC = ["Escape", 27];
const TAB = ["Tab", 9];
const CTRL = 2;

// ---- a fillable form: the basics --------------------------------------------

await session(sample("form.pdf"), 9333, async (app) => {
  check("opens the file given on the command line", (await app.evaluate("document.title")).startsWith("form.pdf"));
  check("startup_file reports that file", (await app.invoke("startup_file"))?.endsWith("form.pdf"));
  check(
    "renders the page",
    await app.evaluate(`(() => {
      const canvas = document.querySelector(".page canvas");
      const d = canvas.getContext("2d").getImageData(0, 0, canvas.width, Math.min(canvas.height, 600)).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 100) return true;
      return false;
    })()`),
  );
  check("shows fillable fields", (await app.count(".annotationLayer :is(input, textarea, select)")) === 7);

  await app.clickOn(".annotationLayer input[type=text]");
  await app.type("Kari Nordmann");
  check("types into a field", (await app.evaluate(`document.querySelector(".annotationLayer input[type=text]").value`)) === "Kari Nordmann");

  const [left, top, width] = await app.evaluate(`(() => { const r = document.querySelector(".page").getBoundingClientRect(); return [r.left, r.top, r.width]; })()`);
  await app.tool("Add text");
  await app.click(left + width * 0.75, top + 120);
  await app.type("Hei på deg");
  await app.key(...ESC);
  check("adds text", (await app.evaluate(`document.querySelector(".item.text")?.textContent`)) === "Hei på deg");

  await app.tool("Rectangle");
  await app.drag(left + width * 0.7, top + 200, left + width * 0.9, top + 280);
  check("draws a rectangle", (await app.count(".item.shape")) === 1);
  await app.tool("Undo");
  check("undoes it", (await app.count(".item.shape")) === 0);
  await app.tool("Redo");
  check("redoes it", (await app.count(".item.shape")) === 1);

  await app.tool("Select");
  const before = await app.evaluate(`document.querySelector(".item.shape path").getAttribute("d")`);
  await app.drag(left + width * 0.7, top + 240, left + width * 0.6, top + 300);
  check("moves it by dragging", before !== (await app.evaluate(`document.querySelector(".item.shape path").getAttribute("d")`)));

  const scrolled = await app.evaluate(`document.querySelector(".viewer").scrollTop`);
  await app.wheel(left + 50, top + 300, 240);
  await sleep(500);
  check("scrolls with the wheel", (await app.evaluate(`document.querySelector(".viewer").scrollTop`)) > scrolled);
  const zoom = await app.evaluate(`document.querySelector(".tb.zoom").textContent`);
  await app.wheel(left + 50, top + 300, -200, CTRL);
  await sleep(900);
  check("zooms with Ctrl + wheel", (await app.evaluate(`document.querySelector(".tb.zoom").textContent`)) !== zoom);

  const scratch = join(tmpdir(), "freepdfeditor smoke æøå.bin");
  const roundTrip = await app.evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const path = ${JSON.stringify(scratch)};
    const bytes = new Uint8Array(300000).map((_, i) => i % 251);
    await invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(path) } });
    const back = new Uint8Array(await invoke("read_file", { path }));
    return back.length === bytes.length && back.every((v, i) => v === bytes[i]);
  })()`);
  rmSync(scratch, { force: true });
  check("writes and reads files natively", roundTrip);
  check(
    "refuses font paths outside the Fonts folder",
    await app.evaluate(`window.__TAURI_INTERNALS__.invoke("read_system_font", { file: "..\\\\win.ini" }).then(() => false, () => true)`),
  );
  check("no errors in the app", app.errors.length === 0, app.errors.join("; "));
});

// ---- a flat form: blanks, editing text, and the saved file ------------------

const saved = join(tmpdir(), "freepdfeditor-smoke-saved.pdf");
rmSync(saved, { force: true });

await session(sample("letter.pdf"), 9334, async (app) => {
  // The build-and-save entry point is only exposed with this flag set.
  await app.evaluate(`localStorage.setItem("freepdfeditor.debug", "1")`);
  await app.evaluate("location.reload()");
  await sleep(1500);
  await app.waitFor(`!!document.querySelector(".page canvas") && !!window.__fpe`);
  await sleep(800);

  await app.tool("Add text");
  await app.waitFor(`document.querySelectorAll(".blank").length > 0`);
  await sleep(300);
  const kinds = await app.evaluate(`(() => { const o = {}; for (const el of document.querySelectorAll(".blank")) o[el.classList[1]] = (o[el.classList[1]] ?? 0) + 1; return o; })()`);
  check("finds the underlines, boxes and tick boxes", kinds.line === 6 && kinds.box === 10 && kinds.checkbox === 3, JSON.stringify(kinds));

  await app.clickOn(".blank.line", 0);
  await app.type("Kari");
  await app.key(...TAB);
  await app.type("Nordmann");
  await app.key(...ESC);
  await app.clickOn(".blank.checkbox", 1);
  await app.clickOn(".blank.box", 0);
  await app.type("Ola Nordmann");
  await app.key(...TAB);
  await app.type("Brother");
  await app.key(...ESC);
  const texts = () => app.evaluate(`window.__fpe.store.items.filter((i) => i.type === "text").map((i) => i.text)`);
  check("fills blanks, moving on with Tab", JSON.stringify(await texts()) === JSON.stringify(["Kari", "Nordmann", "Ola Nordmann", "Brother"]), JSON.stringify(await texts()));
  check("ticks a detected tick box", (await app.evaluate(`window.__fpe.store.items.filter((i) => i.type === "check").length`)) === 1);
  await app.clickOn(".blank.checkbox", 1);
  check("and unticks it again", (await app.evaluate(`window.__fpe.store.items.filter((i) => i.type === "check").length`)) === 0);

  await app.tool("Edit text");
  await app.waitFor(`document.querySelectorAll(".run").length > 0`);
  const clickRunEnd = async (index) => {
    const [x, y, w] = await app.center(".run", index);
    await app.click(x + w / 2 - 2, y);
  };
  // Run 0 is the white heading on a blue band, run 1 the line below it, run 2 a grey note.
  await clickRunEnd(1);
  check("opens existing text for editing", (await app.evaluate(`document.querySelector(".text-editor")?.value`)) === "Riverside Tennis Club, founded 1987");
  for (let i = 0; i < 4; i++) await app.key("Backspace", 8);
  await app.type("1992 in Bergen");
  await app.key(...ESC);
  await clickRunEnd(0);
  await app.key("a", 65, CTRL);
  await app.type("Søknad om medlemskap");
  await app.key(...ESC);
  await clickRunEnd(2);
  await app.key(...ESC);
  await app.key(...ESC);

  const edits = await app.evaluate(`window.__fpe.store.items.filter((i) => i.cover).map((i) => ({ text: i.text, font: i.font, size: i.size, bold: i.bold, color: i.color, cover: i.cover.color }))`);
  check("leaves text alone when it was opened but not changed", edits.length === 2, `${edits.length} replacements`);
  check("keeps the size, weight and font of edited text", edits[0]?.font === "calibri" && edits[0]?.size === 12 && !edits[0]?.bold && edits[1]?.size === 24 && edits[1]?.bold, JSON.stringify(edits));
  check("picks up the text and background colours", edits[0]?.color === "#000000" && edits[0]?.cover === "#ffffff" && edits[1]?.color === "#ffffff" && edits[1]?.cover !== "#ffffff", JSON.stringify(edits));

  await app.evaluate(`(async () => {
    const bytes = await window.__fpe.build();
    await window.__TAURI_INTERNALS__.invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(${JSON.stringify(saved)}) } });
  })()`);
  await app.evaluate(`localStorage.removeItem("freepdfeditor.debug")`);
  check("no errors in the app", app.errors.length === 0, app.errors.join("; "));
});

{
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(saved)), fontExtraProperties: true, verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  await page.getOperatorList();
  const fontOf = (text) => {
    const item = content.items.find((i) => i.str === text);
    return item && page.commonObjs.has(item.fontName) ? page.commonObjs.get(item.fontName).name : null;
  };
  check("saved file has the filled-in text", ["Kari", "Nordmann", "Ola Nordmann", "Brother"].every((text) => fontOf(text) === "Helvetica"));
  check("saved file has the edited text in the document's font", /^Calibri-\d+$/.test(fontOf("Riverside Tennis Club, founded 1992 in Bergen") ?? ""), String(fontOf("Riverside Tennis Club, founded 1992 in Bergen")));
  check("including the bold heading", /^Calibri-Bold-\d+$/.test(fontOf("Søknad om medlemskap") ?? ""), String(fontOf("Søknad om medlemskap")));
  const grew = readFileSync(saved).length - readFileSync(sample("letter.pdf")).length;
  check("embeds only the letters used, not whole fonts", grew < 80_000, `${grew} bytes added`);
}

await session(saved, 9335, async (app) => {
  check("the saved file opens again", (await app.evaluate("document.title")).startsWith("freepdfeditor-smoke-saved.pdf"));
  check("no errors opening it", app.errors.length === 0, app.errors.join("; "));
});
rmSync(saved, { force: true });

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
