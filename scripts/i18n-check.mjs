/**
 * i18n 校验脚本
 *
 * 1. 每个消息包对（en/zh 基准包、batch-*.ts 分包）的 key 一致性：中文侧缺 key / 多 key 都报错
 * 2. i18n/index.ts 合并后的完整消息必须与「基准包 + 全部分包」的合并结果一致（防止漏合某个分包）
 * 3. 扫描 console 源码 <template> 段里残留的硬编码中文（HTML 注释剔除）
 *
 * 用法：node scripts/i18n-check.mjs；退出码非 0 表示校验失败
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

// 消息包源码内部用无扩展名相对导入（bundler 风格），node 直跑需要补 .ts 解析
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // 落回默认解析
      }
    }
    return nextResolve(specifier, context);
  },
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const consoleSrc = join(root, "apps/console/src");

/** 把嵌套消息对象压平成 "a.b.c" key 集合 */
function flatten(obj, prefix = "", out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out.add(key);
  }
  return out;
}

// 由于消息包是 TS 文件，用正则提取不靠谱 —— 这里直接借 node 的 TS 剥离能力：
// 项目 node >= 22.18 原生支持 type stripping，可直接 import .ts
const messagesDir = join(consoleSrc, "i18n/messages");
const { en } = await import(join(messagesDir, "en.ts"));
const { zh } = await import(join(messagesDir, "zh.ts"));

let failed = false;

/** 对一对消息包做 key 对齐检查 */
function checkPair(label, a, aName, b, bName) {
  const aKeys = flatten(a);
  const bKeys = flatten(b);
  for (const k of aKeys) {
    if (!bKeys.has(k)) {
      console.error(`[i18n] ${label}: ${bName} 缺少 key: ${k}`);
      failed = true;
    }
  }
  for (const k of bKeys) {
    if (!aKeys.has(k)) {
      console.error(`[i18n] ${label}: ${bName} 多出 key（${aName} 里不存在）: ${k}`);
      failed = true;
    }
  }
  return { aKeys, bKeys };
}

checkPair("基准包", en, "en", zh, "zh");

/** 各分包（batch-*.ts 导出 xEn/xZh 对），分别做对齐检查 */
const enExports = {};
const zhExports = {};
for (const name of readdirSync(messagesDir)) {
  if (!name.startsWith("batch-") || !name.endsWith(".ts")) continue;
  const mod = await import(join(messagesDir, name));
  const enNames = Object.keys(mod).filter((k) => /En$/.test(k));
  for (const enName of enNames) {
    const zhName = enName.replace(/En$/, "Zh");
    checkPair(`分包 ${name}`, mod[enName], enName, mod[zhName], zhName);
    Object.assign(enExports, mod[enName]);
    Object.assign(zhExports, mod[zhName]);
  }
}

/** messages/index.ts 合并后的完整消息必须与「基准包 + 全部分包」的合并结果一致（防漏合分包） */
const { messages } = await import(join(consoleSrc, "i18n/messages/index.ts"));
checkPair(
  "messages/index.ts 合并(en)",
  { ...en, ...enExports },
  "基准+分包",
  messages.en,
  "messages/index.ts",
);
checkPair(
  "messages/index.ts 合并(zh)",
  { ...zh, ...zhExports },
  "基准+分包",
  messages.zh,
  "messages/index.ts",
);

const enKeys = flatten(messages.en);
const zhKeys = flatten(messages.zh);

/** 递归收集 .vue / .ts 文件（跳过 node_modules、i18n 消息包、blog 文章正文） */
function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "i18n" || name === "posts") continue;
      walk(p, files);
    } else if (name.endsWith(".vue") || name.endsWith(".ts")) {
      files.push(p);
    }
  }
  return files;
}

/** 判断一行是否属于注释（粗略：trim 后以 //、*、/* 开头） */
function isCommentLine(line) {
  const s = line.trimStart();
  return s.startsWith("//") || s.startsWith("*") || s.startsWith("/*");
}

/** 扫描 .vue 文件 <template> 段的硬编码中文 */
function scanVueTemplates() {
  const problems = [];
  for (const f of walk(consoleSrc)) {
    if (!f.endsWith(".vue")) continue;
    const content = readFileSync(f, "utf8");
    const tplStart = content.indexOf("<template>");
    if (tplStart === -1) continue;
    const tplEnd = content.lastIndexOf("</template>");
    const template = content
      .slice(tplStart, tplEnd)
      .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, "")); // 剔除 HTML 注释（保留换行以维持行号）
    template.split("\n").forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (/\p{Script=Han}/u.test(line)) {
        problems.push(`${f}:${content.slice(0, tplStart).split("\n").length + i}: ${line.trim()}`);
      }
    });
  }
  return problems;
}

/** 扫描 .ts 文件与 .vue 的 <script> 段里字符串字面量中的中文（排除注释行；词库等合法场景行尾加 i18n-allowed 标记豁免） */
function scanScriptStrings() {
  const problems = [];
  for (const f of walk(consoleSrc)) {
    let content = readFileSync(f, "utf8");
    let lineOffset = 0;
    if (f.endsWith(".vue")) {
      const s = content.indexOf("<script");
      const e = content.indexOf("</script>");
      if (s === -1 || e === -1) continue;
      lineOffset = content.slice(0, s).split("\n").length - 1;
      content = content.slice(s, e);
    }
    content.split("\n").forEach((line, i) => {
      if (isCommentLine(line)) return;
      // 先查豁免标记（标记本身写在行尾注释里，必须在剔除注释前判断）
      if (line.includes("i18n-allowed")) return; // 词库等合法中文场景的豁免标记
      // 剔除行内注释尾巴（粗略）
      const code = line.replace(/\/\/.*$/, "");
      const m = code.match(/(["'`])[^"'`]*\p{Script=Han}[^"'`]*\1/u);
      if (m) {
        problems.push(`${f}:${i + 1 + lineOffset}: ${line.trim()}`);
      }
    });
  }
  return problems;
}

const templateProblems = scanVueTemplates();
const scriptProblems = scanScriptStrings();

if (templateProblems.length) {
  console.error(`\n[i18n] 模板中残留硬编码中文 ${templateProblems.length} 处：`);
  for (const p of templateProblems) console.error("  " + p);
  failed = true;
}
if (scriptProblems.length) {
  console.error(
    `\n[i18n] ts 脚本中字符串含中文 ${scriptProblems.length} 处（如为多语言词库请在行尾加 i18n-allowed 标记）：`,
  );
  for (const p of scriptProblems) console.error("  " + p);
  failed = true;
}

if (failed) process.exit(1);
console.log(`[i18n] 校验通过：en/zh 各 ${enKeys.size} 个 key，模板与脚本无残留硬编码中文`);
