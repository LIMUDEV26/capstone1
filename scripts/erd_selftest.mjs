// Headless self-test for Database_ERD.html (offline, no npm deps).
//
//   node scripts/erd_selftest.mjs                      # default file URL
//   node scripts/erd_selftest.mjs "file:///path/to/Database_ERD.html"
//
// Verifies: parse counts (tables/relations/columns), canvas rendering,
// zoom / pan / table drag, search, table+column editing, add/delete,
// localStorage persistence, and PNG/JPG/JPEG/WEBP export data URLs.
// Requires Chrome at the path below and Node >= 21 (native WebSocket).
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9336;
const URL = process.argv[2] || "file:///C:/xampp/htdocs/capstone1/Database_ERD.html?test=1";
const DL = "C:/xampp/htdocs/capstone1/_erd_dl";
try { rmSync(DL, { recursive: true, force: true }); } catch {}
mkdirSync(DL, { recursive: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--user-data-dir=C:/xampp/htdocs/capstone1/.cdp_profile",
  "--window-size=1680,1050",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const step = (s) => process.stderr.write("STEP " + s + "\n");
let ws = null, id = 0;
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === mid) { ws.removeEventListener("message", onMsg); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

async function evalJS(expr) {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true });
  return r.result?.value;
}

try {
  // wait for devtools endpoint
  let targets = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      targets = await r.json();
      if (targets.length) break;
    } catch {}
    await sleep(500);
  }
  if (!targets?.length) throw new Error("no CDP target");
  const page = targets.find(t => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  // attach listeners BEFORE navigating so load-time errors are captured
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL });
  const issues = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") {
      issues.push("EX: " + m.params.exceptionDetails?.exception?.description +
                  " @line " + m.params.exceptionDetails?.lineNumber + " col " +
                  m.params.exceptionDetails?.columnNumber);
    }
    if (m.method === "Log.entryAdded") {
      const t = m.params.entry?.text;
      if (t) issues.push("LOG: " + t);
    }
    if (m.method === "Runtime.consoleAPICalled") {
      issues.push("CONSOLE: " + (m.params.args || []).map(a => a.value ?? a.description).join(" "));
    }
  });
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.addEventListener("error", function(e){
      window.__err = (e.message||"") + " @line " + e.lineno + " col " + e.colno +
                     " src " + (e.filename||"inline");
    });`,
  });
  await call("Page.navigate", { url: URL });
  await sleep(3000);
  step("loaded");

  const out = {};
  out.bootInfo = await evalJS(`(() => {
    const b = document.getElementById("boot");
    return { display: b.style.display,
             text: (b.textContent || "").replace(/\\s+/g, " ").slice(0, 220) };
  })()`);
  out.erd = await evalJS(`window.__erd ? {
      tables: window.__erd.state.tables.length,
      rels: window.__erd.state.relations.length,
      zoom: document.getElementById("zoomPct").textContent
    } : "no-__erd-hook"`);
  out.scriptProbe = await evalJS(`(() => {
    const out = [];
    for (let i = 0; i < document.scripts.length; i++) {
      const src = document.scripts[i].textContent;
      try {
        (0, eval)(src + "; window.__done" + i + " = 1;");
        out.push({ i, len: src.length, ok: true, done: window["__done" + i] });
      } catch (e) {
        out.push({ i, len: src.length, ok: false, err: String(e), msg: e.message,
                   loc: (e.stack || "").split("\\n")[1] || "" });
      }
    }
    return out;
  })()`);
  out.loadError = await evalJS(`window.__err || null`);
  out.probe = await evalJS(`(() => {
    const x = document.createElement("script");
    x.textContent = "window.__probe = 42;";
    document.body.appendChild(x);
    return window.__probe;
  })()`);
  out.navHref = await evalJS(`location.href`);
  out.reparse = await evalJS(`(() => {
    const src = document.scripts[document.scripts.length-1].textContent;
    try{ new Function(src); return "PARSES_OK len=" + src.length; }
    catch(e){ return "PARSE_ERR: " + e.message; }
  })()`);
  out.evalRun = await evalJS(`(() => {
    try{
      const src = document.scripts[document.scripts.length-1].textContent;
      (0, eval)(src + "\\n;window.__final={state:typeof state, n:(typeof state!=='undefined'&&state)?state.tables.length:-1, zoom:document.getElementById('zoomPct').textContent, counts:document.getElementById('stCounts').textContent};");
      return window.__final;
    }catch(e){ return { err: String(e), msg: e.message, stack: (e.stack||"").slice(0,300) }; }
  })()`);
  out.issues = issues;
  out.testout = await evalJS(`document.getElementById("testout")?.textContent || null`);
  out.markers = await evalJS(`({
    SCHEMA: typeof SCHEMA,
    state: typeof state,
    stateTables: (typeof state !== "undefined" && state) ? state.tables.length : -1,
    cam: typeof cam !== "undefined" ? JSON.stringify(cam) : "none",
    ctx: typeof ctx !== "undefined" ? "ok" : "none",
    stored: (() => { try { return localStorage.getItem("llb-erd-v1"); } catch(e) { return "LS-ERR:" + e.name; } })()
  })`);
  out.scripts = await evalJS(`(() => {
    const s = document.querySelectorAll("script");
    return { count: s.length, head: s[s.length-1].textContent.slice(0, 60),
             len: s[s.length-1].textContent.length,
             tail: s[s.length-1].textContent.slice(-80) };
  })()`);
  out.ready = await evalJS(`document.readyState`);
  out.bodyChildren = await evalJS(`document.getElementById("wrap").children.length`);
  out.canvasSize = await evalJS(`(() => { const c=document.getElementById("c"); return [c.width, c.height, c.clientWidth, c.clientHeight]; })()`);
  out.counts = await evalJS(`document.getElementById("stCounts")?.textContent`);
  out.zoom = await evalJS(`document.getElementById("zoomPct")?.textContent`);
  // sample pixels: need canvas ctx in page; getImageData center
  out.pixel = await evalJS(`(() => {
    const c = document.getElementById("c");
    const ctx = c.getContext("2d");
    const d = ctx.getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 1, 1).data;
    return [d[0],d[1],d[2],d[3]];
  })()`);
  out.tablesDrawn = await evalJS(`(() => {
    const c = document.getElementById("c"); const ctx = c.getContext("2d");
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let colorCount = new Set();
    for(let i=0;i<d.length;i+=400){ colorCount.add(d[i]+","+d[i+1]+","+d[i+2]); }
    return colorCount.size;
  })()`);
  const shot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync("C:/xampp/htdocs/capstone1/_erd_live.png", Buffer.from(shot.data, "base64"));

  // ---- interaction checks ----
  out.scope = await evalJS(`({
    editorMode: typeof editorMode, findTable: typeof findTable, drawScene: typeof drawScene,
    onWindowEditor: typeof window.editorMode, schemaOnWindow: typeof window.SCHEMA
  })`);
  out.formats = await evalJS(`(() => {
    const c = document.createElement("canvas"); c.width = 64; c.height = 64;
    const g = c.getContext("2d"); g.fillStyle = "#123456"; g.fillRect(0, 0, 64, 64);
    const r = {};
    ["image/png","image/jpeg","image/webp"].forEach(f => {
      const u = c.toDataURL(f, 0.92);
      r[f] = u.slice(0, 22) + " len=" + u.length;
    });
    return r;
  })()`);
  out.zoomIn = await evalJS(`(() => { const a = document.getElementById("zoomPct").textContent;
    document.getElementById("btnZoomIn").click();
    return a + " -> " + document.getElementById("zoomPct").textContent; })()`);
  out.search = await evalJS(`(() => { const i = document.getElementById("search");
    i.focus(); i.value = "payroll";
    i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return { stSel: document.getElementById("stSel").textContent,
             zoom: document.getElementById("zoomPct").textContent }; })()`);
  out.rename = await evalJS(`(() => {
    const E = window.__erd;
    E.editorMode("table", "settings", null);
    document.getElementById("edTableName").value = "settings_renamed";
    document.getElementById("edSave").click();
    const renamed = !!E.state.tables.find(t => t.name === "settings_renamed");
    const posKept = !!E.state.pos["settings_renamed"];
    E.editorMode("table", "settings_renamed", null);
    document.getElementById("edTableName").value = "settings";
    document.getElementById("edSave").click();
    return { renamed, posKept, reverted: !!E.state.tables.find(t => t.name === "settings") };
  })()`);
  out.colEdit = await evalJS(`(() => {
    const E = window.__erd;
    E.editorMode("col", "holidays", 0);
    document.getElementById("edColName").value = "holiday_id_tmp";
    document.getElementById("edColType").value = "BIGINT";
    document.getElementById("edSave").click();
    const c = E.state.tables.find(t => t.name === "holidays").columns[0];
    const ok = c.name === "holiday_id_tmp" && c.type === "BIGINT";
    E.editorMode("col", "holidays", 0);
    document.getElementById("edColName").value = "holiday_id";
    document.getElementById("edColType").value = "INT";
    document.getElementById("edSave").click();
    return { ok, reverted: E.state.tables.find(t => t.name === "holidays").columns[0].name };
  })()`);
  out.addTable = await evalJS(`(() => {
    const E = window.__erd, n0 = E.state.tables.length;
    document.getElementById("btnAddTable").click();
    const nm = E.state.tables[E.state.tables.length-1].name;
    E.editorClose();
    return { added: E.state.tables.length - n0, name: nm,
             hasPos: !!E.state.pos[nm], cols: E.state.tables[E.state.tables.length-1].columns.length };
  })()`);
  out.deleteTable = await evalJS(`(() => {
    const E = window.__erd, n0 = E.state.tables.length;
    window.confirm = () => true;
    E.editorMode("table", "new_table", null);
    E.editorDelete();
    return { removed: n0 - E.state.tables.length,
             gone: !E.state.tables.find(t => t.name === "new_table") };
  })()`);
  out.stateful = await evalJS(`(() => {
    const E = window.__erd;
    return { tables: E.state.tables.length, rels: E.state.relations.length,
             stored: (localStorage.getItem("llb-erd-v1") || "").length };
  })()`);
  out.camPan = await evalJS(`(() => {
    const E = window.__erd, before = { x: E.cam.x, y: E.cam.y };
    const c = document.getElementById("c");
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent("mousedown", { clientX: 5, clientY: 400, bubbles: true, buttons: 1 }));
    c.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, clientY: 460, bubbles: true, buttons: 1 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return { dx: Math.round(E.cam.x - before.x), dy: Math.round(E.cam.y - before.y) };
  })()`);
  step("edits-done");

  // ---- export clicks (intercept anchor clicks) ----
  out.patched = await evalJS(`(() => {
    const H = HTMLAnchorElement.prototype, orig = H.click;
    window.__nativeClick = orig;
    window.__dl = [];
    H.click = function(){ window.__dl.push(this.download + " | " + this.href.slice(0,24) +
      " | bytes=" + this.href.length); };
    return "patched";
  })()`);
  for (const id of ["btnPng", "btnJpg", "btnJpeg", "btnWebp"]) {
    await evalJS(`document.getElementById("${id}").click()`);
    await sleep(700);
  }
  out.exportCalls = await evalJS(`window.__dl`);
  out.downloads = readdirSync(DL);
  step("exports-done");

  // ---- drag a table with synthetic mouse events (uses real handlers) ----
  out.dragTable = await evalJS(`(() => {
    const E = window.__erd, c = document.getElementById("c");
    const r = c.getBoundingClientRect();
    const p = E.state.pos["users"];
    const sx = p.x * E.cam.k + E.cam.x + 50;
    const sy = p.y * E.cam.k + E.cam.y + 12;
    const hit = E.hitTest((sx - E.cam.x) / E.cam.k, (sy - E.cam.y) / E.cam.k);
    const before = { x: p.x, y: p.y };
    if (!hit || hit.table !== "users"){
      return { skipped: "hit test mismatch", hit, sx, sy, cam: E.cam };
    }
    const fire = (t, x, y) => c.dispatchEvent(new MouseEvent(t,
      { clientX: x + r.left, clientY: y + r.top, bubbles: true,
        buttons: t === "mouseup" ? 0 : 1 }));
    fire("mousedown", sx, sy);
    fire("mousemove", sx + 150, sy + 100);
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    const after = E.state.pos["users"];
    return { from: { x: Math.round(before.x), y: Math.round(before.y) },
             to: { x: Math.round(after.x), y: Math.round(after.y) },
             moved: Math.abs(after.x - before.x) > 40 && Math.abs(after.y - before.y) > 40 };
  })()`);

  // ---- pan on empty space ----
  out.pan = await evalJS(`(() => {
    const E = window.__erd, c = document.getElementById("c");
    const hit = (x, y) => E.hitTest((x - E.cam.x) / E.cam.k, (y - E.cam.y) / E.cam.k);
    // scan for an empty spot near the bottom-right
    let spot = null;
    for (let x = c.clientWidth - 20; x > c.clientWidth - 400 && !spot; x -= 20)
      for (let y = c.clientHeight - 20; y > c.clientHeight - 300; y -= 20)
        if (!hit(x, y)) { spot = { x, y }; break; }
    if (!spot) return { error: "no empty spot" };
    const before = { x: E.cam.x, y: E.cam.y };
    const fire = (t, x, y) => c.dispatchEvent(new MouseEvent(t,
      { clientX: x, clientY: y, bubbles: true, buttons: t === "mouseup" ? 0 : 1 }));
    fire("mousedown", spot.x, spot.y);
    fire("mousemove", spot.x - 90, spot.y - 60);
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return { dx: Math.round(E.cam.x - before.x), dy: Math.round(E.cam.y - before.y) };
  })()`);

  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error("TEST_FAIL", e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  spawnSync("rm", ["-rf", "C:/xampp/htdocs/capstone1/.cdp_profile"], { shell: true });
}