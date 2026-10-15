// End-to-end test of automatic updates, with the real installer and updater:
//
//   npm run test:update
//
// Builds two copies of Duckument that look for updates on a local test server
// instead of GitHub: version A (the current version) and B (one patch higher).
// A must find B, install it and restart as B, keeping saved data. Then B must
// refuse an update signed with someone else's key, and an altered installer
// carrying the genuine signature.
//
// Needs the update-signing key (~/.tauri/duckument.key, or DUCKUMENT_KEY=path).
// Takes about 15 minutes. It installs Duckument for the current user while it
// runs and uninstalls it at the end. It leaves the test build in
// src-tauri/target, so run a normal build before using the app or `npm run smoke`.
import { execFileSync, execSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), "duckument-update-test-"));
const shots = join(root, "test-screenshots", "update");
mkdirSync(shots, { recursive: true });
const installDir = join(process.env.LOCALAPPDATA, "Duckument");
const profile = join(work, "profile");

// ---- build the two versions -------------------------------------------------
const keyFile = process.env.DUCKUMENT_KEY ?? join(homedir(), ".tauri", "duckument.key");
if (!existsSync(keyFile)) {
  console.error(`The update-signing key was not found at ${keyFile}`);
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const [major, minor, patch] = version.split(".").map(Number);
const newer = `${major}.${minor}.${patch + 1}`;
const testServer = { updater: { endpoints: ["http://127.0.0.1:8977/latest.json"], dangerousInsecureTransportProtocol: true } };
const build = (config, extra) => {
  const file = join(work, `config-${config.version ?? "a"}.json`);
  writeFileSync(file, JSON.stringify(config));
  console.log(`building ${config.version ?? version}…`);
  execSync(`npx tauri build ${extra} --config "${file}"`, {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyFile, "utf8"), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" },
  });
};
build({ version: newer, plugins: testServer }, "");
const folderB = join(work, "b");
mkdirSync(folderB);
const nsis = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const installer = `Duckument_${newer}_x64-setup.exe`;
copyFileSync(join(nsis, installer), join(folderB, installer));
copyFileSync(join(nsis, `${installer}.sig`), join(folderB, `${installer}.sig`));
build({ plugins: testServer }, "--no-bundle");
const exeA = join(work, "duckument.exe");
copyFileSync(join(root, "src-tauri", "target", "release", "duckument.exe"), exeA);
const goodSignature = readFileSync(join(folderB, `${installer}.sig`), "utf8").trim();

// Someone else's key, signing the very same installer.
execSync(`npx tauri signer generate -w "${join(work, "other.key")}" --password "" --ci -f`, { cwd: root, stdio: "ignore" });
copyFileSync(join(folderB, installer), join(work, "other-setup.exe"));
execSync(`npx tauri signer sign -k "${readFileSync(join(work, "other.key"), "utf8")}" -p "" "${join(work, "other-setup.exe")}"`, {
  cwd: root,
  stdio: "ignore",
  env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" },
});
const otherSignatureFile = join(work, "other-setup.exe.sig");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// ---- the update server ------------------------------------------------------
let manifest = null;
let payload = readFileSync(join(folderB, installer));
const server = createServer((req, res) => {
  if (req.url.startsWith("/latest.json") && manifest) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(manifest));
  } else if (req.url.startsWith("/Duckument-Setup.exe")) {
    const body = payload;
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
    res.end(body);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(8977, "127.0.0.1", r));
const serve = (version, signature) => {
  manifest = {
    version,
    notes: "test",
    pub_date: new Date().toISOString(),
    platforms: { "windows-x86_64": { signature, url: "http://127.0.0.1:8977/Duckument-Setup.exe" } },
  };
};

// ---- driving the app --------------------------------------------------------
async function connect(port, ms = 30000) {
  let target;
  for (let t = 0; t < ms && !target; t += 500) {
    await sleep(500);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === "page");
    } catch {}
  }
  if (!target) return null;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 1;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = id++;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression) => {
    const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return result?.result?.value;
  };
  const waitFor = async (expression, limit = 15000) => {
    for (let t = 0; t < limit; t += 250) {
      if (await evaluate(expression).catch(() => false)) return true;
      await sleep(250);
    }
    return false;
  };
  const click = async (selector) => {
    const at = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: at[0], y: at[1], button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    }
  };
  const shoot = async (name) => {
    const { result } = await send("Page.captureScreenshot", { format: "png" });
    if (result) writeFileSync(join(shots, `${name}.png`), Buffer.from(result.data, "base64"));
  };
  await send("Runtime.enable");
  await send("Page.enable");
  return { ws, evaluate, waitFor, click, shoot };
}

const launch = (exe, port) =>
  spawn(exe, [], {
    env: {
      ...process.env,
      DUCKUMENT_TEST_OFFSCREEN: "1",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
    detached: true,
  });

const processes = () => {
  const out = execFileSync("powershell", ["-NoProfile", "-Command", "Get-Process | Where-Object { $_.ProcessName -like '*duckument*' } | ForEach-Object { $_.Id.ToString() + '|' + $_.Path + '|' + $_.MainModule.FileVersionInfo.ProductVersion }"], { encoding: "utf8" });
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, path, version] = line.split("|");
    return { pid: Number(pid), path, version };
  });
};
const installedExe = () => (existsSync(installDir) ? readdirSync(installDir).find((f) => /duckument\.exe$/i.test(f)) : null);
const fileVersion = (path) =>
  execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${path}').VersionInfo.ProductVersion`], { encoding: "utf8" }).trim();

try {
  check("Duckument is not installed before the test", !installedExe(), installDir);

  // ---- 1. version A finds B and installs it ----
  serve(newer, goodSignature);
  launch(exeA, 9441);
  const a = await connect(9441);
  check("version A starts", !!a);
  check(`A says it is version ${version}`, await a.waitFor(`document.querySelector(".welcome .version")?.textContent === "Version ${version}"`));
  await a.evaluate(`localStorage.setItem("freepdfeditor.signatures", JSON.stringify([{ id: "marker", src: "data:image/png;base64,iVBORw0KGgo=", w: 10, h: 5 }]))`);
  check("A offers the update", await a.waitFor(`document.querySelector(".update-bar")?.textContent.includes("${newer} is available")`, 20000));
  await a.shoot("u1-update-offered");
  await a.click(".update-bar .btn.primary");
  await sleep(1500);
  await a.shoot("u2-downloading").catch(() => {});

  // A closes, the installer runs, B starts from the install folder.
  let b = null;
  for (let t = 0; t < 90000 && !b; t += 1000) {
    await sleep(1000);
    b = processes().find((p) => p.path && p.path.toLowerCase().startsWith(installDir.toLowerCase()));
  }
  check("the update installed and the new version started", !!b, JSON.stringify(processes()));
  const exeB = installedExe() && join(installDir, installedExe());
  check(`the installed program is version ${newer}`, exeB && fileVersion(exeB) === newer, exeB && fileVersion(exeB));
  check("version A has closed", !processes().some((p) => p.path?.toLowerCase() === exeA.toLowerCase()));

  // If the new version inherited the test settings, look inside it too.
  const started = await connect(9441, 8000);
  if (started) {
    check(`the restarted app reports version ${newer}`, await started.waitFor(`document.querySelector(".welcome .version")?.textContent === "Version ${newer}"`));
    check("saved signatures survived the update", await started.evaluate(`JSON.parse(localStorage.getItem("freepdfeditor.signatures") ?? "[]").some((s) => s.id === "marker")`));
    await started.shoot("u3-after-update");
    started.ws.close();
  } else {
    console.log("note: the restarted app runs without the test's debugging settings, so its contents weren't inspected");
  }
  for (const p of processes()) process.kill(p.pid);
  await sleep(1500);

  // ---- 2. tampered updates are refused ----
  const attackerSignature = readFileSync(otherSignatureFile, "utf8").trim();
  const altered = Buffer.from(readFileSync(join(folderB, installer)));
  altered[altered.length - 100] ^= 0xff;
  const cases = [
    ["signed with someone else's key", attackerSignature, readFileSync(join(folderB, installer))],
    ["a changed installer with the real signature", goodSignature, altered],
  ];
  for (const [what, signature, body] of cases) {
    serve("9.9.9", signature);
    payload = body;
    launch(exeB, 9442);
    const c = await connect(9442);
    check(`the installed version starts (${what})`, !!c);
    check(`it offers 9.9.9 (${what})`, await c.waitFor(`document.querySelector(".update-bar")?.textContent.includes("9.9.9 is available")`, 20000));
    await c.click(".update-bar .btn.primary");
    check(
      `it refuses an update ${what}`,
      await c.waitFor(`document.querySelector(".update-message")?.textContent.includes("safety check")`, 60000),
      await c.evaluate(`document.querySelector(".update-message")?.textContent`),
    );
    await c.shoot(`u4-refused-${cases.findIndex((x) => x[0] === what) + 1}`);
    check(`the installed program is still ${newer} (${what})`, fileVersion(exeB) === newer);
    c.ws.close();
    for (const p of processes()) process.kill(p.pid);
    await sleep(1500);
  }
} catch (error) {
  failures++;
  console.log("FAIL  " + (error.stack ?? error));
} finally {
  for (const p of processes()) {
    try {
      process.kill(p.pid);
    } catch {}
  }
  await sleep(1500);
  const uninstaller = join(installDir, "uninstall.exe");
  if (existsSync(uninstaller)) {
    execFileSync(uninstaller, ["/S"]);
    for (let t = 0; t < 30 && installedExe(); t++) await sleep(1000);
  }
  check("the test installation was removed again", !installedExe());
  server.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  console.log("\nThe app in src-tauri/target is the test build now; run a normal build before using it.");
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll update checks passed");
  process.exit(failures ? 1 : 0);
}
