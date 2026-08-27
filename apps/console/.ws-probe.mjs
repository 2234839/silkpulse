/** 分层复现：无插件 → lazyPlugins(vue,tailwind)，看哪层把 WS upgrade 弄哑 */
import net from "node:net";
import { createServer } from "vite-plus";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

function rawUpgrade(port, label) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write(
        "GET /ws/console HTTP/1.1\r\nHost: localhost:" +
          port +
          "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    s.on("data", (d) => {
      resolve(label + ": " + d.toString().split("\r\n")[0]);
      s.destroy();
    });
    s.on("close", () => resolve(label + ": CLOSED-no-response"));
    s.on("error", (e) => resolve(label + ": ERR " + e.code));
    setTimeout(() => {
      resolve(label + ": SILENT");
      s.destroy();
    }, 3000);
  });
}

async function make(port, plugins) {
  const sv = await createServer({
    root: new URL(".", import.meta.url).pathname,
    logLevel: "error",
    plugins,
    server: {
      port,
      strictPort: true,
      proxy: { "/ws": { target: "ws://localhost:8080", ws: true } },
    },
  });
  await sv.listen();
  return sv;
}

const c1 = await make(5301, []);
console.log(await rawUpgrade(5301, "C1(no-plugins)"));
await c1.close();

const c2 = await make(5302, [vue(), tailwindcss()]);
console.log(await rawUpgrade(5302, "C2(vue+tw)"));
await c2.close();
process.exit(0);
