/** 诊断先注入场景：SDK 为何未注册到 server */
import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";

let chrom = process.env.CHROMIUM_PATH;
if (!chrom) {
  for (const n of ["chromium-browser", "chromium", "google-chrome"]) {
    try {
      const f = execSync(`which ${n} 2>/dev/null`, { encoding: "utf8" }).trim();
      if (f) {
        chrom = f;
        break;
      }
    } catch {}
  }
}
const b = await puppeteer.launch({ executablePath: chrom, headless: true, args: ["--no-sandbox"] });
const p = await b.newPage();
p.on("console", (m) => {
  const t = m.text();
  if (!t.includes("favicon")) console.log("[console]", t.slice(0, 200));
});
p.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 300)));
p.on("requestfailed", (r) => console.log("[reqfail]", r.url().slice(-70), r.failure()?.errorText));

await p.setRequestInterception(true);
p.on("request", (req) => {
  req.continue({ headers: req.headers() }).catch(() => {});
});

await p.evaluateOnNewDocument((origin) => {
  const inject = () => {
    const s = document.createElement("script");
    s.src = `${origin}/sdk.js`;
    s.dataset.server = origin;
    (document.head ?? document.documentElement).appendChild(s);
  };
  if (document.documentElement) inject();
  else
    document.addEventListener(
      "readystatechange",
      () => document.readyState !== "loading" && inject(),
      { once: true },
    );
}, "http://localhost:8080");
await p.goto("http://localhost:8080/post-inject-react-test.html", { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 3000));

const state = await p.evaluate(() => ({
  sdkGlobal: typeof window.SilkPulseSDK,
  ready: window.__TEST_PAGE_READY__,
  /** SDK 是否留了初始化痕迹 */
  hasHelpers: typeof window.__silkpulse_devtools_tree,
}));
console.log("state:", JSON.stringify(state));

const devs = await fetch("http://localhost:8080/api/devices", {
  headers: { Authorization: `Bearer ${process.env.SILKPULSE_ADMIN_KEY}` },
}).then((r) => r.json());
console.log(
  "devices:",
  JSON.stringify(
    (devs.devices ?? []).map((d) => ({ id: d.id, title: d.title, url: (d.url ?? "").slice(-50) })),
  ),
);
await b.close();
