// Launches the built desktop app with WebView2 remote debugging and drives it
// over the DevTools protocol: opening a file, form fields, adding and moving
// items, undo, scrolling, zooming and the native file commands. Prints a report.
//
//   npm run samples && npm run tauri build -- --no-bundle && npm run smoke
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = join(root, "src-tauri", "target", "release", "freepdfeditor.exe");
const pdf = join(root, "samples", "form.pdf");
const scratch = tmpdir();
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(exe, [pdf], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});

let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    target = list.find((t) => t.type === "page");
  } catch {}
}
if (!target) {
  child.kill();
  throw new Error("no debuggable page appeared");
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 1;
const pending = new Map();
const problems = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === "Runtime.exceptionThrown") {
    problems.push("exception: " + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
  } else if (msg.method === "Log.entryAdded" && ["error", "warning"].includes(msg.params.entry.level)) {
    problems.push(`${msg.params.entry.level}: ${msg.params.entry.text} ${msg.params.entry.url ?? ""}`);
  } else if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
    problems.push(`console.${msg.params.type}: ` + msg.params.args.map((a) => a.value ?? a.description).join(" "));
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
  return result.result.value;
};
const mouse = (type, x, y, extra = {}) =>
  send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
const click = async (x, y) => {
  await mouse("mouseMoved", x, y, { buttons: 0 });
  await mouse("mousePressed", x, y);
  await mouse("mouseReleased", x, y);
};
const drag = async (x1, y1, x2, y2) => {
  await mouse("mouseMoved", x1, y1, { buttons: 0 });
  await mouse("mousePressed", x1, y1);
  for (let i = 1; i <= 8; i++) await mouse("mouseMoved", x1 + ((x2 - x1) * i) / 8, y1 + ((y2 - y1) * i) / 8);
  await mouse("mouseReleased", x2, y2);
};
const center = (selector, index = 0) =>
  evaluate(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);

await send("Runtime.enable");
await send("Log.enable");

const report = {};
try {
  // 1. The file passed on the command line opens and renders.
  for (let i = 0; i < 40; i++) {
    if (await evaluate(`!!document.querySelector(".page canvas")`)) break;
    await sleep(250);
  }
  await sleep(800);
  report.title = await evaluate("document.title");
  report.url = await evaluate("location.href");
  report.pages = await evaluate(`document.querySelectorAll(".page").length`);
  report.canvas = await evaluate(`(() => { const c = document.querySelector(".page canvas"); return c ? [c.width, c.height] : null; })()`);
  report.canvasHasInk = await evaluate(`(() => { const c = document.querySelector(".page canvas"); if (!c) return false; const d = c.getContext("2d").getImageData(0, 0, c.width, Math.min(c.height, 600)).data; for (let i = 0; i < d.length; i += 4) if (d[i] < 100) return true; return false; })()`);
  report.formFields = await evaluate(`document.querySelectorAll(".annotationLayer input, .annotationLayer textarea, .annotationLayer select").length`);

  // 2. Type into a form field.
  const field = await center(".annotationLayer input[type=text]");
  await click(...field);
  await send("Input.insertText", { text: "Kari Nordmann" });
  report.fieldValue = await evaluate(`document.querySelector(".annotationLayer input[type=text]").value`);

  // 3. Add text with the text tool.
  const page = await evaluate(`(() => { const r = document.querySelector(".page").getBoundingClientRect(); return [r.left, r.top, r.width]; })()`);
  await click(...(await center(`.tb[title^="Add text"]`)));
  await click(page[0] + page[2] * 0.75, page[1] + 120);
  await send("Input.insertText", { text: "Hei på deg" });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  report.textItems = await evaluate(`[...document.querySelectorAll(".item.text")].map((el) => el.textContent)`);

  // 4. Draw a rectangle, then undo and redo it.
  await click(...(await center(`.tb[title^="Rectangle"]`)));
  await drag(page[0] + page[2] * 0.7, page[1] + 200, page[0] + page[2] * 0.9, page[1] + 280);
  report.shapesAfterDraw = await evaluate(`document.querySelectorAll(".item.shape").length`);
  await click(...(await center(`.tb[title^="Undo"]`)));
  report.shapesAfterUndo = await evaluate(`document.querySelectorAll(".item.shape").length`);
  await click(...(await center(`.tb[title^="Redo"]`)));
  report.shapesAfterRedo = await evaluate(`document.querySelectorAll(".item.shape").length`);

  // 5. Move the rectangle by dragging its edge with the select tool.
  await click(...(await center(`.tb[title^="Select"]`)));
  const before = await evaluate(`document.querySelector(".item.shape path").getAttribute("d")`);
  await drag(page[0] + page[2] * 0.7, page[1] + 240, page[0] + page[2] * 0.6, page[1] + 300);
  report.rectMoved = before !== (await evaluate(`document.querySelector(".item.shape path").getAttribute("d")`));
  report.selectionShown = await evaluate(`!!document.querySelector(".selection.box")`);

  // 6. Wheel scrolling and ctrl+wheel zooming.
  const scrollBefore = await evaluate(`document.querySelector(".viewer").scrollTop`);
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: page[0] + 50, y: page[1] + 300, deltaX: 0, deltaY: 240 });
  await sleep(500);
  report.wheelScrolled = (await evaluate(`document.querySelector(".viewer").scrollTop`)) - scrollBefore;
  const zoomBefore = await evaluate(`document.querySelector(".tb.zoom").textContent`);
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: page[0] + 50, y: page[1] + 300, deltaX: 0, deltaY: -200, modifiers: 2 });
  await sleep(900);
  report.zoom = [zoomBefore, await evaluate(`document.querySelector(".tb.zoom").textContent`)];
  report.rerenderedAfterZoom = await evaluate(`(() => { const c = document.querySelector(".page canvas"); return [c.width, c.height]; })()`);

  // 7. Native file commands: write bytes, read them back.
  const out = join(scratch, "ipc-test æøå.bin");
  rmSync(out, { force: true });
  report.ipcRoundTrip = await evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const path = ${JSON.stringify(out)};
    const bytes = new Uint8Array(300000).map((_, i) => i % 251);
    await invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(path) } });
    const back = new Uint8Array(await invoke("read_file", { path }));
    return back.length === bytes.length && back.every((v, i) => v === bytes[i]);
  })()`);
  report.fileOnDisk = existsSync(out) && readFileSync(out).length;
  rmSync(out, { force: true });
  report.startupFile = await evaluate(`window.__TAURI_INTERNALS__.invoke("startup_file")`);
  report.windowTitleDirty = await evaluate("document.title");
} catch (error) {
  report.failed = String(error);
}
report.problems = problems;
console.log(JSON.stringify(report, null, 2));
ws.close();
child.kill();
