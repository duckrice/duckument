// Drives the built desktop app over the DevTools protocol (WebView2 remote
// debugging) and checks the things unit tests can't: that a file opens and
// renders, forms, adding and moving items, blank detection, editing existing
// text, the native file commands, and what ends up in a saved PDF.
//
//   npm run samples && npm run tauri build -- --no-bundle && npm run smoke
//
// Add `-- --screenshots` to also save pictures of the app along the way, into
// test-screenshots/ (or `-- --screenshots=some/folder`).
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import JSZip from "jszip";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = join(root, "src-tauri", "target", "release", "duckument.exe");
const sample = (name) => join(root, "samples", name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Its own browser profile: the test then works while the app is open for real
// use, and doesn't touch the signatures and settings saved there.
const profile = mkdtempSync(join(tmpdir(), "freepdfeditor-smoke-"));

const shotsFlag = process.argv.find((arg) => arg === "--screenshots" || arg.startsWith("--screenshots="));
const shotsDir = shotsFlag ? (shotsFlag.split("=")[1] ?? join(root, "test-screenshots")) : null;
let shots = 0;
if (shotsDir) {
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
}

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`);
}

/** The test's environment for a copy of the app. */
const appEnv = (port, singleInstance, profileDir = profile) => ({
  ...process.env,
  // Off-screen, so the test doesn't take over the screen. WebView2 would stop
  // drawing a window it thinks nobody can see; the flags keep it drawing.
  DUCKUMENT_TEST_OFFSCREEN: "1",
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`,
  WEBVIEW2_USER_DATA_FOLDER: profileDir,
  // Normally each test copy stands alone, so it can't hand files to a Duckument
  // that is open for real use.
  ...(singleInstance ? {} : { DUCKUMENT_MULTI_INSTANCE: "1" }),
});

/** Copies of Duckument currently running, by process id. */
const runningCopies = () =>
  execFileSync("powershell", ["-NoProfile", "-Command", "Get-Process -Name duckument -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }; exit 0"], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .map(Number);

/** Asks a program's window to close, as clicking its X does. */
const requestClose = (pid) =>
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'; [void][U.W]::PostMessage((Get-Process -Id ${pid}).MainWindowHandle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)`,
  ]);

/** Starts the app with `files` open and hands `run` helpers for driving it. */
async function session(files, port, run, { singleInstance = false, profileDir = profile } = {}) {
  files = [files].flat().filter(Boolean);
  const child = spawn(exe, files, { env: appEnv(port, singleInstance, profileDir), stdio: "ignore" });
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
  // Calls into the Rust side (Tauri sends them as requests to ipc.localhost).
  const ipc = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Network.requestWillBeSent" && msg.params.request.url.includes("ipc.localhost")) {
      ipc.push(msg.params.request);
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
    ipc,
    pid: child.pid,
    exited: () => child.exitCode !== null,
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
    /** Presses at the first point and moves through the rest, like drawing with a pen. */
    async stroke(points) {
      await app.mouse("mouseMoved", points[0][0], points[0][1], { buttons: 0 });
      await app.mouse("mousePressed", points[0][0], points[0][1]);
      for (const [x, y] of points.slice(1)) await app.mouse("mouseMoved", x, y);
      await app.mouse("mouseReleased", ...points[points.length - 1]);
    },
    /** Saves a picture of the window when screenshots were asked for. */
    async shoot(name) {
      if (!shotsDir) return;
      await sleep(350);
      const { result } = await send("Page.captureScreenshot", { format: "png" });
      const file = `${String(++shots).padStart(2, "0")}-${name}.png`;
      writeFileSync(join(shotsDir, file), Buffer.from(result.data, "base64"));
    },
    scrollTo: (top) => app.evaluate(`document.querySelector(".viewer").scrollTo(0, ${top})`),
    pageBox: () => app.evaluate(`(() => { const r = document.querySelector(".page").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`),
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
    /** Makes `window.__fpe` (the store, the viewer, and the bytes Save would write) available. */
    async debugHandle() {
      await app.evaluate(`localStorage.setItem("freepdfeditor.debug", "1")`);
      await app.evaluate("location.reload()");
      await sleep(1500);
      await app.waitFor(`!!document.querySelector(".page canvas") && !!window.__fpe`);
      await sleep(800);
    },
    invoke: (command, args) => app.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args ?? {})})`),
  };
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Network.enable");
  try {
    if (files.length) await app.waitFor(`!!document.querySelector(".page canvas")`);
    else await app.waitFor(`!!document.querySelector(".welcome")`);
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
  check("startup_files reports that file", (await app.invoke("startup_files"))?.[0]?.endsWith("form.pdf"));
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
  await app.shoot("fillable-form-opened");

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

  await app.tool("Arrow");
  await app.drag(left + width * 0.93, top + 470, left + width * 0.8, top + 400);
  await app.tool("Ellipse");
  await app.drag(left + width * 0.7, top + 520, left + width * 0.9, top + 580);
  await app.tool("Check mark");
  await app.clickOn(".annotationLayer input[type=checkbox]");
  check("adds an arrow, an ellipse and a check mark", (await app.count(".item.shape")) === 4);
  await app.key(...ESC);
  await app.shoot("field-text-and-shapes-added");

  // ---- signing: drawn, remembered, and typed ----
  await app.tool("Sign");
  check("opens the signature dialog", await app.waitFor(`!!document.querySelector("dialog.sig-dialog[open]")`, 3000));
  const [padX, padY, padW, padH] = await app.center(".sig-pad");
  const onPad = (fx, fy) => [padX + padW * (fx - 0.5), padY + padH * (fy - 0.5)];
  const loops = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    loops.push(onPad(0.15 + t * 0.6 + 0.05 * Math.sin(t * 18), 0.6 - 0.3 * Math.sin(t * 9) * (1 - t * 0.5)));
  }
  await app.stroke(loops);
  await app.stroke([onPad(0.2, 0.8), onPad(0.5, 0.78), onPad(0.8, 0.82)]);
  await app.shoot("signature-drawn");
  await app.clickOn(".sig-dialog .btn.primary");
  check("goes on to placing the signature", (await app.evaluate(`document.querySelector(".viewer").dataset.tool`)) === "place");

  // The sample's signature line is 246 points above the bottom of an 842-point page.
  const placeAtLine = async (lineFromBottom, across) => {
    await app.scrollTo(100000);
    await sleep(900);
    const [pl, pt, pw, ph] = await app.pageBox();
    await app.click(pl + pw * across, pt + ph * (1 - (lineFromBottom + 16) / 842));
  };
  await placeAtLine(246, 0.42);
  check("places the signature on the page", (await app.count(".item.image")) === 1);
  check("remembers it for next time", (await app.evaluate(`JSON.parse(localStorage.getItem("freepdfeditor.signatures") ?? "[]").length`)) === 1);

  await app.tool("Sign");
  check("offers the remembered signature", (await app.count(".sign-menu:not([hidden]) .sign-pick")) === 1);
  await app.shoot("remembered-signature-menu");
  await app.clickOn(".sign-menu .menu-item");
  await app.waitFor(`!!document.querySelector("dialog.sig-dialog[open]")`, 3000);
  await app.clickOn(".sig-dialog .tab", 1);
  await app.clickOn(".sig-name");
  await app.type("Kari Nordmann");
  await app.clickOn(".sig-font", 1);
  await app.shoot("signature-typed");
  await app.clickOn(".sig-dialog .btn.primary");
  await placeAtLine(196, 0.38);
  check("places a typed signature too", (await app.count(".item.image")) === 2);
  await app.key(...ESC);
  await app.shoot("signed");
  await app.scrollTo(0);
  await sleep(600);

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

// ---- tabs, opening files into the running window, recent files ------------

if (runningCopies().length) {
  console.log("skip  tabs and single-window opening: another copy of Duckument is running, and files would go to it");
} else {
  const temporary = join(tmpdir(), "duckument-smoke-temporary.pdf");
  copyFileSync(sample("flat.pdf"), temporary);
  await session(sample("form.pdf"), 9338, async (app) => {
    await app.debugHandle();
    const tabs = () => app.evaluate("window.__fpe.tabs");
    check("starts with one tab", (await tabs()).length === 1);

    // Opening files from Explorer while Duckument runs: the new copy hands them over and quits.
    const handOver = async (...files) => {
      const before = (await tabs()).length;
      const second = spawn(exe, files, { env: appEnv(9339, true), stdio: "ignore" });
      const exited = await new Promise((resolve) => {
        second.on("exit", () => resolve(true));
        setTimeout(() => resolve(false), 15000);
      });
      await app.waitFor(`window.__fpe.tabs.length !== ${before}`, 8000);
      return exited;
    };
    check("a second launch hands its file over and quits", await handOver(sample("letter.pdf")));
    check("the file opens in a new tab", (await tabs()).length === 2 && (await tabs())[1].active);
    await handOver(sample("fonts.pdf"), temporary);
    await app.waitFor("window.__fpe.tabs.length === 4", 8000);
    check("several files at once open in several tabs", (await tabs()).map((t) => t.name).join(",") === "form.pdf,letter.pdf,fonts.pdf,duckument-smoke-temporary.pdf");
    check("still only one copy of Duckument running", runningCopies().length === 1);
    await handOver(sample("letter.pdf"));
    const afterReopen = await tabs();
    check("opening a file that is already open switches to its tab", afterReopen.length === 4 && afterReopen[1].active);

    // Each tab keeps its own edits and undo history.
    await app.key("Tab", 9, CTRL);
    await app.key("Tab", 9, CTRL * 1 + 8); // Ctrl+Shift+Tab goes back
    check("Ctrl+Tab and Ctrl+Shift+Tab move between tabs", (await tabs())[1].active);
    await app.evaluate("window.__fpe.activate(0)");
    await app.tool("Rectangle");
    const [l, t, w] = await app.pageBox();
    await app.drag(l + w * 0.6, t + 150, l + w * 0.8, t + 220);
    await app.evaluate("window.__fpe.activate(1)");
    await app.tool("Ellipse");
    const [l2, t2, w2] = await app.pageBox();
    await app.drag(l2 + w2 * 0.6, t2 + 150, l2 + w2 * 0.8, t2 + 220);
    await app.key("z", 90, CTRL);
    check("undo only affects the tab you're in", (await app.evaluate("window.__fpe.store.items.length")) === 0);
    await app.evaluate("window.__fpe.activate(0)");
    check("the other tab keeps its edits", (await app.evaluate("window.__fpe.store.items.length")) === 1);
    check("a tab with changes is marked", (await tabs())[0].dirty && (await app.count(".doc-tab.dirty")) === 1);
    await app.shoot("tabs");

    // Closing.
    await app.evaluate("window.__fpe.activate(3)");
    await app.key("w", 87, CTRL);
    check("closing a tab without changes doesn't ask", (await tabs()).length === 3 && !(await app.count("dialog[open]")));
    rmSync(temporary, { force: true });
    await app.evaluate("window.__fpe.activate(0)");
    await app.key("w", 87, CTRL);
    check("closing a tab with changes asks first", await app.waitFor(`!!document.querySelector("dialog[open]")`, 3000));
    await app.shoot("close-asks-to-save");
    await app.clickOn("dialog[open] .btn"); // Cancel
    await sleep(300);
    check("Cancel keeps it open", (await tabs()).length === 3);
    await app.key("w", 87, CTRL);
    await app.waitFor(`!!document.querySelector("dialog[open]")`, 3000);
    await app.clickOn("dialog[open] .btn", 1); // Don't save
    check("Don't save closes it", await app.waitFor("window.__fpe.tabs.length === 2", 3000));
    await app.key("w", 87, CTRL);
    await app.key("w", 87, CTRL);
    check("closing the last tab shows the start screen", await app.waitFor(`!document.querySelector(".welcome").hidden`, 3000));
    await app.waitFor(`document.querySelectorAll(".recent-file").length > 0`, 3000);
    const recent = await app.evaluate(`[...document.querySelectorAll(".recent-name")].map((el) => el.textContent)`);
    check("recent files are listed, newest first, without the deleted one", recent.join(",") === "fonts.pdf,letter.pdf,form.pdf", recent.join(","));
    await app.shoot("recent-files");
    await app.clickOn(".recent-file", 1);
    check("a recent file opens with one click", await app.waitFor(`window.__fpe.tabs.length === 1 && window.__fpe.tabs[0].name === "letter.pdf"`, 8000));
    check("no errors in the app", app.errors.length === 0, app.errors.join("; "));

    // Closing the window with unsaved changes.
    await app.tool("Rectangle");
    const [l3, t3, w3] = await app.pageBox();
    await app.drag(l3 + w3 * 0.6, t3 + 150, l3 + w3 * 0.8, t3 + 220);
    requestClose(app.pid);
    check("closing the window with unsaved changes asks first", await app.waitFor(`!!document.querySelector("dialog[open]")`, 5000));
    await app.clickOn("dialog[open] .btn"); // Cancel
    await sleep(1500);
    check("Cancel keeps the window open", !app.exited() && runningCopies().length === 1);
    requestClose(app.pid);
    await app.waitFor(`!!document.querySelector("dialog[open]")`, 5000);
    app.clickOn("dialog[open] .btn", 1).catch(() => {}); // Don't save; the window goes away mid-call
    let closed = false;
    for (let t = 0; t < 20 && !closed; t++) {
      await sleep(250);
      closed = app.exited();
    }
    check("Don't save closes the window", closed);
  }, { singleInstance: true });

  await session(null, 9340, async (app) => {
    const recent = await app.evaluate(`[...document.querySelectorAll(".recent-name")].map((el) => el.textContent)`);
    check("the recent list survives a restart", recent.join(",") === "letter.pdf,fonts.pdf,form.pdf", recent.join(","));
  });
}

// ---- page tools -------------------------------------------------------------

await session(sample("flat.pdf"), 9341, async (app) => {
  await app.debugHandle();
  const pages = () => app.evaluate(`window.__fpe.store.pages.map((p) => (p.blank ? "blank" : \`\${p.source}:\${p.index + 1}\`) + (p.rotation ? "@" + p.rotation : ""))`);
  check("the page sidebar shows every page", (await app.count(".thumb")) === 12);
  await app.waitFor(`document.querySelectorAll(".thumb-picture canvas").length >= 4`, 8000);
  await app.clickOn(".thumb", 2);
  check("clicking a thumbnail goes to that page", await app.waitFor("window.__fpe.viewer.currentPage === 2", 3000));
  await app.clickOn(`.thumb-tools [title="Turn right"]`);
  check("turns the selected page", (await pages())[2] === "0:3@90" && (await app.evaluate(`document.querySelectorAll(".page")[2].dataset.rotation`)) === "90");
  await app.shoot("page-turned");

  // Items stay on their page as pages move, and stay put on a turned page.
  await app.tool("Add text");
  const [x, y, w, h] = await app.center(".page", 2);
  await app.click(x - w * 0.2, y);
  await app.type("Note on page 3");
  await app.key(...ESC);
  await app.key(...ESC);
  const onPage = () => app.evaluate(`window.__fpe.store.items.map((i) => i.page)`);
  check("adds text on a turned page", (await onPage()).join() === "2");
  void h;

  await app.clickOn(".thumb", 1);
  await app.clickOn(`.thumb-tools [title^="Delete"]`);
  check("deletes a page", (await pages()).length === 11 && !(await pages()).includes("0:2"));
  check("the text moved up with its page", (await onPage()).join() === "1");

  // Drag the first page below the third. Both thumbnails are measured with the
  // list scrolled to the top: scrolling one into view would move the other.
  await app.evaluate(`document.querySelector(".thumb-list").scrollTop = 0`);
  const thumbAt = (i) => app.evaluate(`(() => { const r = document.querySelectorAll(".thumb")[${i}].getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height]; })()`);
  const from = await thumbAt(0);
  const to = await thumbAt(2);
  await app.drag(from[0], from[1], to[0], to[1] + to[3] * 0.45);
  check("dragging a thumbnail reorders the pages", (await pages()).slice(0, 4).join() === "0:3@90,0:4,0:1,0:5", (await pages()).slice(0, 5).join());
  check("and the text follows its page", (await onPage()).join() === "0");

  await app.clickOn(`.thumb-tools [title="Insert a blank page"]`);
  check("inserts a blank page", (await pages()).includes("blank") && (await pages()).length === 12);

  await app.evaluate(`window.__fpe.addPdf(${JSON.stringify(sample("form.pdf"))}, 0)`);
  check("merges another PDF's pages", (await pages())[0] === "1:1" && (await pages()).length === 13);
  // Pages are drawn when they come into view.
  await app.scrollTo(0);
  check("the merged page's form fields work", await app.waitFor(`document.querySelectorAll(".page")[0].querySelectorAll(".annotationLayer input").length > 0`, 8000));
  await app.shoot("pages-rearranged");

  const saved = await app.evaluate(`(async () => {
    const pdfjs = window.__fpe.viewer.pdf;
    void pdfjs;
    const bytes = await window.__fpe.build();
    return Array.from(bytes.slice(0, 5)).join() + "|" + bytes.length;
  })()`);
  check("saves the rearranged document", saved.startsWith("37,80,68,70,45"), saved);
  const extracted = await app.evaluate(`(async () => {
    const ids = window.__fpe.store.pages.slice(1, 3).map((p) => p.id);
    const bytes = await window.__fpe.tab.buildPages(ids);
    return bytes.length;
  })()`);
  check("extracts pages as a new PDF", extracted > 500, String(extracted));

  for (let i = 0; i < 6; i++) await app.key("z", 90, CTRL);
  check("undo brings the original pages back", (await pages()).join() === Array.from({ length: 12 }, (_, i) => `0:${i + 1}`).join(), (await pages()).join());
  check("no errors in the app", app.errors.length === 0, app.errors.join("; "));
});

await session(sample("long.pdf"), 9342, async (app) => {
  await app.debugHandle();
  check("a 300-page document lists every page", (await app.count(".thumb")) === 300);
  // Page numbers from the toolbar: one on every page, undone in one step.
  await app.clickOn('.toolbar [title="Add page numbers"]');
  await app.waitFor(`!!document.querySelector("dialog[open] select")`, 3000);
  await app.evaluate(`document.querySelector("dialog[open] form").requestSubmit()`);
  const numbered = await app.evaluate(`window.__fpe.store.items.filter((i) => i.type === "text" && /^Page \\d+ of 300$/.test(i.text)).length`);
  check("Add page numbers puts one on every page", numbered === 300, String(numbered));
  await app.evaluate(`window.__fpe.store.undo()`);
  check("and Undo takes them all off at once", (await app.evaluate(`window.__fpe.store.items.length`)) === 0);
  // A watermark: turned, see-through words on every page.
  await app.clickOn('.toolbar [title="Add a watermark"]');
  await app.waitFor(`!!document.querySelector("dialog[open] input[list]")`, 3000);
  await app.evaluate(`document.querySelector("dialog[open] form").requestSubmit()`);
  const marked = await app.evaluate(`window.__fpe.store.items.filter((i) => i.type === "text" && i.text === "DRAFT" && i.angle === 45 && i.opacity === 0.25).length`);
  check("Add a watermark puts DRAFT across every page", marked === 300, String(marked));
  check("shown turned and see-through", await app.waitFor(`(() => { const el = document.querySelector(".item.text"); return !!el && el.style.transform.includes("rotate(-45deg)") && el.style.opacity === "0.25"; })()`, 3000));
  await app.evaluate(`window.__fpe.store.undo()`);
  const started = Date.now();
  await app.evaluate(`document.querySelector(".thumb-list").scrollTop = 1e9`);
  const drawn = await app.waitFor(`[...document.querySelectorAll(".thumb")].slice(-3).every((t) => t.querySelector("canvas"))`, 8000);
  check("thumbnails far down draw quickly", drawn, `${Date.now() - started} ms`);
  await app.clickOn(".thumb", 249);
  check("jumps to page 250", await app.waitFor("window.__fpe.viewer.currentPage === 249", 5000));
  check("only the pages near the view are kept drawn", (await app.count(".page canvas")) < 30);
  check("no errors in the app", app.errors.length === 0, app.errors.join("; "));
});

// ---- search, select and copy -----------------------------------------------

await session(sample("search.pdf"), 9343, async (app) => {
  await app.debugHandle();
  const find = async (text) => {
    await app.key("f", 70, CTRL);
    // Forget the last result, so the wait below sees this search's.
    await app.evaluate(`document.querySelector(".search-status").textContent = ""`);
    await app.evaluate(`(() => { const input = document.querySelector(".search-input"); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event("input")); })()`);
    await app.waitFor(`/of|Not found/.test(document.querySelector(".search-status").textContent)`, 15000);
    return app.evaluate(`document.querySelector(".search-status").textContent`);
  };
  check("Ctrl+F finds every match in 50 pages", (await find("needle")) === "1 of 4", await app.evaluate(`document.querySelector(".search-status").textContent`));
  check("and shows the first one", await app.waitFor("window.__fpe.viewer.currentPage === 2 && !!document.querySelector('.hit.current')", 5000));
  await app.shoot("search");
  await app.key("Enter", 13);
  check("Enter goes to the next match", await app.waitFor("window.__fpe.viewer.currentPage === 16", 5000));
  await app.key("Enter", 13);
  await app.key("Enter", 13);
  check("both matches on one page are found", await app.waitFor("window.__fpe.viewer.currentPage === 41 && document.querySelector('.search-status').textContent === '4 of 4'", 5000));
  check("every match on the page is highlighted", await app.waitFor(`document.querySelectorAll(".page")[41].querySelectorAll(".hit").length === 2`, 5000));
  await app.key("Enter", 13);
  check("it wraps around to the first", await app.waitFor("document.querySelector('.search-status').textContent === '1 of 4'", 3000));
  await app.key("Enter", 13, 8);
  check("Shift+Enter goes back", await app.waitFor("document.querySelector('.search-status').textContent === '4 of 4'", 3000));
  check("finds Norwegian letters, whatever the case", (await find("BLÅBÆR")) === "1 of 1");
  check("finds words across a line break", (await find("delta wye")) === "1 of 1");
  check("says when nothing is found", (await find("unicorn")) === "Not found");
  await app.key("Escape", 27);
  check("Escape closes the search", await app.waitFor(`document.querySelector(".search-bar").hidden && !document.querySelector(".hit")`, 3000));

  // Select the page's own text with the mouse and copy it.
  await app.scrollTo(0);
  await app.waitFor(`document.querySelectorAll(".page")[0].querySelector(".textLayer span")`, 8000);
  const line = await app.evaluate(`(() => { const span = [...document.querySelectorAll(".page")[0].querySelectorAll(".textLayer span")].find((s) => s.textContent.startsWith("Lorem")); const r = span.getBoundingClientRect(); return [r.left + 2, r.top + r.height / 2, r.width]; })()`);
  await app.drag(line[0], line[1], line[0] + line[2] * 0.45, line[1]);
  const selected = await app.evaluate("window.getSelection().toString()");
  check("dragging over the text selects it", selected.startsWith("Lorem ipsum"), selected);
  await app.evaluate(`document.addEventListener("copy", () => { window.__copied = window.getSelection().toString(); }, { once: true })`);
  await app.key("c", 67, CTRL);
  check("Ctrl+C copies the selected text", (await app.evaluate("window.__copied")) === selected);
  check("no errors in the app", app.errors.length === 0, app.errors.join("; "));
});

// ---- highlight, underline, strike-through, comments ------------------------

const marked = join(tmpdir(), "duckument-smoke-marked.pdf");
await session(sample("search.pdf"), 9344, async (app) => {
  await app.debugHandle();
  await app.waitFor(`document.querySelectorAll(".page")[0].querySelector(".textLayer span")`, 8000);
  const spanOf = (prefix) =>
    app.evaluate(`(() => { const span = [...document.querySelectorAll(".page")[0].querySelectorAll(".textLayer span")].find((s) => s.textContent.startsWith(${JSON.stringify(prefix)})); const r = span.getBoundingClientRect(); return [r.left, r.top + r.height / 2, r.width]; })()`);
  const markText = async (prefix, share = 0.6) => {
    const [x, y, w] = await spanOf(prefix);
    await app.drag(x + 1, y, x + w * share, y);
  };

  await app.tool("Highlight");
  await markText("Lorem");
  const items = () => app.evaluate("window.__fpe.store.items.map((i) => ({ type: i.type, text: i.text, rects: i.rects?.length, color: i.color }))");
  let list = await items();
  check("selecting text in Highlight mode highlights it", list.length === 1 && list[0].type === "highlight" && list[0].text.startsWith("Lorem ipsum"), JSON.stringify(list));
  check("the highlight covers one line", list[0]?.rects === 1);
  await app.clickOn(".props .labelled-small", 1); // Underline
  await markText("Page 1");
  await app.clickOn(".props .labelled-small", 2); // Strike through
  const [x, y, w] = await spanOf("Lorem");
  await app.drag(x + w * 0.7, y, x + w * 0.98, y);
  list = await items();
  check("underline and strike-through work the same way", list.map((i) => i.type).join() === "highlight,underline,strike", JSON.stringify(list));

  await app.tool("Add a comment");
  const [px, py, pw] = await app.center(".page", 0);
  await app.click(px + pw * 0.3, py);
  await app.type("Husk å signere her");
  check("a comment opens for typing where you click", (await app.evaluate("window.__fpe.store.items.at(-1).text")) === "Husk å signere her");
  await app.shoot("highlights-and-comment");
  await app.tool("Select");
  check("an empty click elsewhere closes the comment, keeping it", (await app.evaluate("window.__fpe.store.items.filter((i) => i.type === 'note').length")) === 1);
  await app.key("z", 90, CTRL);
  check("undo removes the comment", (await app.evaluate("window.__fpe.store.items.filter((i) => i.type === 'note').length")) === 0);
  await app.key("y", 89, CTRL);

  await app.evaluate(`(async () => {
    const bytes = await window.__fpe.build();
    await window.__TAURI_INTERNALS__.invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(${JSON.stringify(marked)}) } });
  })()`);
  check("no errors in the app", app.errors.length === 0, app.errors.join("; "));
});

{
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(marked)), verbosity: 0 }).promise;
  const notes = (await (await pdf.getPage(1)).getAnnotations()).filter((a) => a.subtype === "Text");
  check("the saved file has the comment, readable by any PDF reader", notes.length === 1 && notes[0].contentsObj?.str === "Husk å signere her");
}
await session(marked, 9345, async (app) => {
  // Saved on this computer, so they come back as Duckument's own, still editable.
  check("comments in an opened file are shown", await app.waitFor(`!!document.querySelector(".annotationLayer .textAnnotation, .item.note")`, 8000));
  await app.shoot("saved-highlights-and-comment");
});
rmSync(marked, { force: true });

// ---- dotted, dashed and shaded fields ---------------------------------------

await session(sample("dotted.pdf"), 9346, async (app) => {
  await app.debugHandle();
  await app.tool("Add text");
  await app.waitFor("window.__fpe.viewer.pages[0].blanks !== null", 8000);
  const found = await app.evaluate("window.__fpe.viewer.pages[0].blanks.map((b) => b.kind).join()");
  check("finds dotted, dashed and shaded fields, and not the shaded panel with text", found === "line,line,box,box", found);
  await app.shoot("dotted-dashed-shaded");
});

// ---- editing a whole paragraph ------------------------------------------------

const rewrapped = join(tmpdir(), "duckument-smoke-paragraph.pdf");
await session(sample("paragraphs.pdf"), 9347, async (app) => {
  await app.debugHandle();
  await app.tool("Edit text");
  await app.waitFor(`document.querySelectorAll(".run").length > 0`, 8000);
  // The second line of the paragraph.
  const [x, y, w] = await app.center(".run", 2);
  await app.click(x - w * 0.3, y);
  const item = () => app.evaluate("(() => { const i = window.__fpe.store.items[0]; return i && { text: i.text, width: i.width, align: i.align, lineHeight: i.lineHeight }; })()");
  const before = await item();
  check("clicking a line in a paragraph edits the whole paragraph", before?.text.startsWith("A delta network") && before.text.endsWith("sum of all three.") && before.align === "justify", JSON.stringify(before));
  await app.key("Home", 36, CTRL);
  await app.type("Note: ");
  await app.key(...ESC);
  await app.key(...ESC);
  const lines = await app.evaluate(`[...document.querySelectorAll(".item.text.paragraph .line")].map((l) => l.textContent)`);
  check("the paragraph re-wraps to its width", lines.length >= 4 && lines[0].startsWith("Note: A delta"), JSON.stringify(lines));
  await app.shoot("paragraph-edited");
  await app.evaluate(`(async () => {
    const bytes = await window.__fpe.build();
    await window.__TAURI_INTERNALS__.invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(${JSON.stringify(rewrapped)}) } });
  })()`);
  check("no errors in the app", app.errors.length === 0, app.errors.join("; "));
});
{
  const page = await (await pdfjs.getDocument({ data: new Uint8Array(readFileSync(rewrapped)), verbosity: 0 }).promise).getPage(1);
  const all = (await page.getTextContent()).items.map((i) => i.str).join(" ");
  const occurrences = (all.match(/delta network/g) ?? []).length;
  check("the saved paragraph has the new text, once", all.includes("Note:") && occurrences === 1, all.slice(0, 300));
  check("text around it is untouched", all.includes("Workshop 4: Delta to wye transformation") && all.includes("Exercise 1"));
}
await session(rewrapped, 9348, async (app) => {
  await app.shoot("paragraph-saved");
});
rmSync(rewrapped, { force: true });

// ---- a flat form: blanks, editing text, and the saved file ------------------

const saved = join(tmpdir(), "freepdfeditor-smoke-saved.pdf");
rmSync(saved, { force: true });

await session(sample("letter.pdf"), 9334, async (app) => {
  await app.debugHandle();

  await app.tool("Add text");
  await app.waitFor(`document.querySelectorAll(".blank").length > 0`);
  await sleep(300);
  const kinds = await app.evaluate(`(() => { const o = {}; for (const el of document.querySelectorAll(".blank")) o[el.classList[1]] = (o[el.classList[1]] ?? 0) + 1; return o; })()`);
  check("finds the underlines, boxes and tick boxes", kinds.line === 6 && kinds.box === 10 && kinds.checkbox === 3, JSON.stringify(kinds));
  await app.scrollTo(0);
  await app.shoot("blanks-found-top");
  await app.scrollTo(620);
  await sleep(900);
  await app.shoot("blanks-found-lower");

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
  await app.clickOn(".blank.checkbox", 1);

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

  await app.scrollTo(0);
  await sleep(600);
  await app.shoot("blanks-filled-and-text-edited-top");
  await app.scrollTo(620);
  await sleep(900);
  await app.shoot("blanks-filled-lower");

  const edits = await app.evaluate(`window.__fpe.store.items.filter((i) => i.cover).map((i) => ({ text: i.text, font: i.font, size: i.size, bold: i.bold, color: i.color, cover: i.cover.color }))`);
  check("leaves text alone when it was opened but not changed", edits.length === 2, `${edits.length} replacements`);
  check("keeps the size, weight and font of edited text", edits[0]?.font === "calibri" && edits[0]?.size === 12 && !edits[0]?.bold && edits[1]?.size === 24 && edits[1]?.bold, JSON.stringify(edits));
  check("picks up the text and background colours", edits[0]?.color === "#000000" && edits[0]?.cover === "#ffffff" && edits[1]?.color === "#ffffff" && edits[1]?.cover !== "#ffffff", JSON.stringify(edits));

  await app.evaluate(`(async () => {
    const bytes = await window.__fpe.build();
    await window.__TAURI_INTERNALS__.invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(${JSON.stringify(saved)}) } });
  })()`);
  check("no errors in the app", app.errors.length === 0, app.errors.join("; "));
});

// ---- editing keeps the font, however the PDF stores it ----------------------

await session(sample("fonts.pdf"), 9336, async (app) => {
  await app.debugHandle();
  await app.shoot("fonts-original");
  await app.tool("Edit text");
  await app.waitFor(`document.querySelectorAll(".run").length > 0`);
  await sleep(300);
  const runs = await app.count(".run");
  for (let i = 0; i < runs; i++) {
    const [x, y, w] = await app.center(".run", i);
    // A line of a paragraph that is already being edited belongs to that edit.
    if (await app.evaluate(`document.elementsFromPoint(${x}, ${y}).some((el) => el.matches(".item.text"))`)) continue;
    await app.click(x + w / 2 - 2, y);
    await app.key("Backspace", 8);
    await app.key("Backspace", 8);
    await app.key(...ESC);
  }
  const style = (item) => `${item.font}${item.bold ? " bold" : ""}${item.italic ? " italic" : ""}`;
  const edits = await app.evaluate(`window.__fpe.store.items.filter((i) => i.cover).map((i) => ({ text: i.cover.original, font: i.font, bold: i.bold, italic: i.italic }))`);
  // Times New Roman and Arial are the standard Times and Helvetica's twins; either is right.
  const expectedFor = (text) =>
    /^(The delta|simplifies|into one)/.test(text) ? /^(serif|timesnewroman) italic$/
    : /^(Workshop|Hand in)/.test(text) ? /^calibri bold$/
    : /^(Hint|and work)/.test(text) ? /^(sans|arial) italic$/
    : /^Named only, bold italic/.test(text) ? /^timesnewroman bold italic$/
    : /^(Named only|Embedded)/.test(text) ? /^timesnewroman italic$/
    : /^One of the standard/.test(text) ? /^serif italic$/
    : null;
  const covered = edits.map((e) => e.text).join(" ");
  const everyLine = ["The delta", "Workshop", "Hand in", "Hint", "and work", "Named only, bold", "with a comma", "usual italic", "with spaces", "Embedded", "One of the standard"].every((t) => covered.includes(t));
  const wrong = edits.filter((e) => !expectedFor(e.text)?.test(style(e))).map((e) => `${e.text.slice(0, 20)}: ${style(e)}`);
  check("edits every line", everyLine, covered);
  check("edited text keeps its font and style, however the PDF stores the font", edits.length > 0 && wrong.length === 0, wrong.join(", "));
  await app.key(...ESC);
  await app.scrollTo(0);
  await app.shoot("fonts-after-editing-every-line");

  // Changing the font by hand afterwards still works.
  await app.tool("Select");
  await app.clickOn(".item.text", 0);
  await app.evaluate(`(() => { const select = document.querySelector(".props select[title=Font]"); select.value = "georgia"; select.dispatchEvent(new Event("change")); })()`);
  await app.clickOn(".props .tb.bold");
  const changed = await app.evaluate(`(() => { const i = window.__fpe.store.items.find((item) => item.cover); return { font: i.font, bold: i.bold, italic: i.italic }; })()`);
  check("the font of edited text can be changed from the toolbar", style(changed) === "georgia bold italic", style(changed));
  check("no errors in the app", app.errors.length === 0, app.errors.join("; "));
});

// ---- a text-heavy document: nothing but the real blanks ---------------------

await session(sample("flat.pdf"), 9337, async (app) => {
  await app.debugHandle();
  await app.tool("Add text");
  await app.waitFor(`window.__fpe.viewer.pages[0].blanks !== null`);
  const found = await app.evaluate(`window.__fpe.viewer.pages[0].blanks.map((b) => b.kind).sort().join(",")`);
  check("finds only the real blanks on a page full of text", found === "checkbox,line,line", found);
  await app.scrollTo(520);
  await sleep(900);
  await app.shoot("text-heavy-page-blanks");
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
  const ops = await page.getOperatorList();
  check("saved file has the tick drawn in", ops.fnArray.filter((fn) => fn === pdfjs.OPS.constructPath).length > 0);
  check("saved file has the edited text in the document's font", /^Calibri-\d+$/.test(fontOf("Riverside Tennis Club, founded 1992 in Bergen") ?? ""), String(fontOf("Riverside Tennis Club, founded 1992 in Bergen")));
  check("including the bold heading", /^Calibri-Bold-\d+$/.test(fontOf("Søknad om medlemskap") ?? ""), String(fontOf("Søknad om medlemskap")));
  const everything = content.items.map((i) => i.str).join(" ");
  check("the edited original words are gone from the saved file", !everything.includes("1987") && !everything.includes("Membership application"), everything.slice(0, 200));
  check("text opened but not changed stays in the file", everything.includes("Please complete this form in block letters"), everything.slice(0, 300));
  const grew = readFileSync(saved).length - readFileSync(sample("letter.pdf")).length;
  check("embeds only the letters used, not whole fonts", grew < 80_000, `${grew} bytes added`);
}

// ---- edits stay editable, for this Duckument only ---------------------------------

const resaved = join(tmpdir(), "duckument-smoke-resaved.pdf");
await session(saved, 9335, async (app) => {
  await app.debugHandle();
  check("the saved file opens again", (await app.evaluate("document.title")).startsWith("freepdfeditor-smoke-saved.pdf"));
  const restored = await app.evaluate("window.__fpe.store.items.map((i) => i.type === 'text' ? i.text : i.type)");
  check(
    "this Duckument gets the edits back as editable items",
    ["Kari", "Nordmann", "Ola Nordmann", "Brother", "Riverside Tennis Club, founded 1992 in Bergen", "Søknad om medlemskap"].every((t) => restored.includes(t)),
    JSON.stringify(restored),
  );
  check("and the document isn't marked as changed", !(await app.evaluate("window.__fpe.tabs[0].dirty")));
  check("the removed original text was not kept", !(await app.evaluate("JSON.stringify(window.__fpe.store.items)")).includes("1987"));
  await app.shoot("saved-file-reopened-top");
  await app.scrollTo(620);
  await sleep(1200);
  await app.shoot("saved-file-reopened-lower");
  // Move one item and save again.
  await app.evaluate(`(() => { const s = window.__fpe.store; const item = s.items.find((i) => i.text === "Kari"); s.replace({ ...item, x: item.x + 40 }); s.commit(); })()`);
  await app.evaluate(`(async () => {
    const bytes = await window.__fpe.build();
    await window.__TAURI_INTERNALS__.invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(${JSON.stringify(resaved)}) } });
  })()`);
  check("no errors opening it", app.errors.length === 0, app.errors.join("; "));
});
{
  const page = await (await pdfjs.getDocument({ data: new Uint8Array(readFileSync(resaved)), verbosity: 0 }).promise).getPage(1);
  const runs = (await page.getTextContent()).items.filter((i) => i.str?.trim());
  const count = (text) => runs.filter((i) => i.str === text).length;
  check("saving again doesn't leave the old drawing behind", count("Kari") === 1 && count("Søknad om medlemskap") === 1 && count("Brother") === 1);
}

// Links: a click on a linked picture opens the web page (here only recorded, not opened).
await session(sample("links.pdf"), 9350, async (app) => {
  await app.waitFor(`!!document.querySelector(".linkAnnotation a")`, 8000);
  const [x, y] = await app.center(".linkAnnotation a");
  await app.click(x, y);
  // Test copies don't really open the browser (see open_url), so the request is checked.
  const opened = () => app.ipc.filter((request) => request.method === "POST" && request.url.endsWith("/open_url")).map((request) => request.postData);
  for (let i = 0; i < 30 && !opened().length; i++) await sleep(100);
  check("clicking a linked picture opens its web page", opened().length === 1 && JSON.parse(opened()[0]).url === "https://example.com/duck", JSON.stringify(opened()));
  check("no errors in the app", app.errors.length === 0, app.errors.join("; "));
});

// Save as Word: the PDF worked out into a Word document.
/** The paragraphs of a .docx (its style and words), and its parts. */
async function wordParts(base64) {
  const zip = await JSZip.loadAsync(Buffer.from(base64, "base64"));
  const xml = await zip.file("word/document.xml").async("string");
  const rels = (await zip.file("word/_rels/document.xml.rels")?.async("string")) ?? "";
  const paras = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(([p]) => ({
    style: /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? "",
    text: [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(""),
  }));
  return { paras, rels, files: Object.keys(zip.files) };
}
const wordOf = (app) => app.evaluate(`(async () => { const bytes = await window.__fpe.tab.wordDocument(); let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); })()`);

await session(sample("paragraphs.pdf"), 9351, async (app) => {
  await app.debugHandle();
  const { paras } = await wordParts(await wordOf(app));
  const heading = paras.find((p) => p.text.startsWith("Workshop 4"));
  check("Save as Word keeps the heading as a heading", heading?.style === "Heading1", JSON.stringify(heading));
  check("and joins each paragraph's lines into one", paras.some((p) => p.text.includes("simplify circuits that contain neither series nor parallel connections")), paras.map((p) => p.text.slice(0, 50)).join(" | "));
  check("no errors in the app", app.errors.length === 0, app.errors.join("; "));
});

await session(sample("links.pdf"), 9352, async (app) => {
  await app.debugHandle();
  const { paras, rels, files } = await wordParts(await wordOf(app));
  check("Save as Word keeps links", rels.includes("mailto:duck@example.com"), rels);
  check("and pictures", files.some((f) => /^word\/media\/.+\.png$/.test(f)), files.join(", "));
  check("and the words", paras.some((p) => p.text.includes("Write to us")));
  check("no errors in the app", app.errors.length === 0, app.errors.join("; "));
});

// Another Duckument (another computer's key) sees only the finished pages.
const stranger = mkdtempSync(join(tmpdir(), "duckument-smoke-other-"));
await session(resaved, 9349, async (app) => {
  await app.debugHandle();
  check("another Duckument can't see or change the edits", (await app.evaluate("window.__fpe.store.items.length")) === 0);
  await app.waitFor(`document.querySelectorAll(".page")[0].querySelector(".textLayer span")`, 8000);
  const words = await app.evaluate(`[...document.querySelectorAll(".page")[0].querySelectorAll(".textLayer span")].map((s) => s.textContent).join(" ")`);
  check("it shows the finished document", words.includes("Kari") && words.includes("Søknad om medlemskap"), words.slice(0, 200));
  await app.shoot("seen-by-another-duckument");
}, { profileDir: stranger });
rmSync(stranger, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
rmSync(resaved, { force: true });

rmSync(saved, { force: true });
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });

if (shotsDir) console.log(`\n${shots} screenshots saved to ${shotsDir}`);
// ---- redaction: the text under the box is gone from the saved file ------------------------------

await session(sample("flat.pdf"), 9348, async (app) => {
  await app.debugHandle();
  await app.waitFor(`document.querySelectorAll(".page").length > 0`, 8000);
  const before = await app.evaluate(`(async () => (await window.__fpe.viewer.pageText(0)).length)()`);
  await app.tool("Redact");
  const [px, py, pw, ph] = await app.center(".page", 0);
  await app.drag(px - pw * 0.45, py - ph * 0.3, px + pw * 0.45, py + ph * 0.3);
  check("the Redact tool draws a black box", (await app.evaluate(`window.__fpe.store.items.filter((i) => i.redact && i.fill === "#000000").length`)) === 1);
  await app.evaluate(`window.__fpe.showSaved()`);
  await app.waitFor(`window.__fpe.tabs.length === 2 && window.__fpe.tabs[1].active`, 15000);
  const after = await app.evaluate(`(async () => (await window.__fpe.viewer.pageText(0)).length)()`);
  check("saving takes the text on a redacted page out of the file", before > 0 && after === 0, `${before} → ${after}`);
  const second = await app.evaluate(`(async () => (await window.__fpe.viewer.pageText(1)).length)()`);
  check("other pages keep their text", second > 0, String(second));
});

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
