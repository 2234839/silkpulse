/** 外部 CPU 采样器：每 500ms 读 /proc/PID/stat，输出平均/峰值 CPU%（含所有线程） */
const pid = Number(process.argv[2]);
const secs = Number(process.argv[3] ?? 40);

function cpuJiffies() {
  const fs = require("node:fs");
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  /** 第 14/15 字段 utime/stime（括号后的字段从 state 开始数） */
  const after = stat.slice(stat.lastIndexOf(")") + 2);
  const f = after.split(" ");
  return Number(f[11]) + Number(f[12]); // utime + stime
}

const CLK_TCK = 100;
let prev = cpuJiffies();
const t0 = Date.now();
let max = 0;
let sum = 0;
let n = 0;

const timer = setInterval(() => {
  const cur = cpuJiffies();
  const pct = ((cur - prev) / CLK_TCK / 0.5) * 100;
  prev = cur;
  max = Math.max(max, pct);
  sum += pct;
  n++;
}, 500);

setTimeout(() => {
  clearInterval(timer);
  console.log(
    `CPU 采样 ${n} 次：avg=${(sum / n).toFixed(1)}% max=${max.toFixed(1)}%（${secs}s 窗口，PID=${pid}）`,
  );
  process.exit(0);
}, secs * 1000);
