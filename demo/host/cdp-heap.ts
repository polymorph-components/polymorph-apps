// Heap growth in a REAL Chromium (outside paseo's instrumented webview),
// driven over CDP: load the demo, let it boot, then sample
// Runtime.getHeapUsage while the page's own loops run.
//
//   deno run -A cdp-heap.ts <url> <seconds> [--kill-timers]

const CHROME = Deno.env.get("CHROME") ??
  "/home/lmartin/.cache/ms-playwright/chromium-1234/chrome-linux/chrome";
const url = Deno.args[0] ?? "http://localhost:8641/control.html";
const seconds = Number(Deno.args[1] ?? 120);
const killTimers = Deno.args.includes("--kill-timers");

const profile = await Deno.makeTempDir({ prefix: "cdp-heap-" });
const proc = new Deno.Command(CHROME, {
  args: [
    "--headless=new",
    "--remote-debugging-port=9222",
    `--user-data-dir=${profile}`,
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "about:blank",
  ],
  stdout: "null",
  stderr: "null",
}).spawn();

const targets = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch("http://127.0.0.1:9222/json/list");
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("chromium devtools never came up");
};

const list = await targets();
const page = list.find((t: { type: string }) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.onopen = () => res(null));

let id = 0;
const pending = new Map<number, (v: unknown) => void>();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg.result);
    pending.delete(msg.id);
  }
};
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url });

const evaluate = async (expr: string) => {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  return r?.result?.value;
};

// Wait for boot.
for (let i = 0; i < 80; i++) {
  const banner = await evaluate(`document.getElementById('banner')?.textContent ?? ''`);
  if (typeof banner === "string" && banner.includes("ready")) break;
  await new Promise((r) => setTimeout(r, 1000));
}
console.log("booted:", await evaluate(`document.getElementById('banner').textContent`));

if (killTimers) {
  await evaluate(`(() => { for (let i = 1; i < 20000; i++) clearInterval(i); return 'timers cleared'; })()`);
  console.log("page timers cleared");
}

const usage = async () => (await send("Runtime.getHeapUsage")).usedSize / 1048576;
const start = await usage();
console.log(`t=0s used=${start.toFixed(1)}MB`);
for (let t = 15; t <= seconds; t += 15) {
  await new Promise((r) => setTimeout(r, 15000));
  const u = await usage();
  console.log(`t=${t}s used=${u.toFixed(1)}MB (${(u - start >= 0 ? "+" : "")}${(u - start).toFixed(1)})`);
}
// Force GC, then read again: separates retention from uncollected garbage.
await send("HeapProfiler.enable");
await send("HeapProfiler.collectGarbage");
const afterGc = await usage();
console.log(`after forced GC: ${afterGc.toFixed(1)}MB (net ${(afterGc - start).toFixed(1)}MB over ${seconds}s)`);

ws.close();
proc.kill();
await proc.status;
await Deno.remove(profile, { recursive: true }).catch(() => {});
