import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { getBuildInfo } from "./utils/buildInfo";
import "./style.css";

const buildInfo = getBuildInfo();
console.log(
  `%c silkpulse %c v-${buildInfo.commit.slice(0, 7)}${buildInfo.dirty ? "+dirty" : ""} · 构建于 ${new Date(buildInfo.buildAt).toLocaleString()} %c`,
  "background:#3b82f6;color:#fff;padding:2px 6px;border-radius:3px 0 0 3px;font-weight:bold",
  "background:#1e293b;color:#94a3b8;padding:2px 6px;border-radius:0 3px 3px 0;font-family:monospace",
  "",
);

createApp(App).use(router).mount("#app");
