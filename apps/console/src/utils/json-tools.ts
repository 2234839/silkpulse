/**
 * json-tools —— 工具箱的纯函数集合（无 Vue 依赖，可单测）
 *
 * 从 ToolsPanel.vue 抽出：JSONC/JSON5 预处理、JQ 风格路径、key 排序、
 * SSE/JSONL 解析、时长人性化。后续拆分工具子组件时共享此模块。
 */

/**
 * 去除 JSONC 注释（不破坏字符串内的内容）
 *
 * 遍历每个字符，跟踪是否在字符串内部（及转义状态），
 * 遇到字符串外的单行或多行注释标记时跳过。
 */
export function stripComments(text: string): string {
  let result = "";
  let i = 0;
  /** 是否在字符串内部 */
  let inString = false;
  /** 字符串的引号类型（双引号或单引号） */
  let quoteChar = "";

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    /** 转义字符：跳过下一位 */
    if (ch === "\\" && inString) {
      result += ch + (next ?? "");
      i += 2;
      continue;
    }

    /** 进入/退出字符串 */
    if ((ch === '"' || ch === "'") && !inString) {
      inString = true;
      quoteChar = ch;
      result += ch;
      i++;
      continue;
    }
    if (ch === quoteChar && inString) {
      inString = false;
      quoteChar = "";
      result += ch;
      i++;
      continue;
    }

    if (!inString) {
      /** 单行注释 // */
      if (ch === "/" && next === "/") {
        /** 跳到行尾 */
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      /** 多行注释 */
      if (ch === "/" && next === "*") {
        i += 2;
        while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
    }

    result += ch;
    i++;
  }
  return result;
}

/**
 * 去除尾逗号（},] 或 },} 前面多余的逗号）
 *
 * 在 stripComments 之后执行，此时注释已清除。
 */
export function stripTrailingCommas(text: string): string {
  return text.replace(/,\s*([\]}])/g, "$1");
}

/**
 * JSON5 → 标准 JSON 的预处理
 *
 * 处理 JSON5 的核心扩展语法：
 * - 单引号字符串 → 双引号
 * - 无引号的对象 key → 加双引号
 * - 十六进制数字 (0x1F) → 十进制
 * - 前导/尾随小数点 (.5 → 0.5, 5. → 5.0)
 * - + 号开头的正数 (+42 → 42)
 * - Infinity / -Infinity / NaN
 */
export function json5ToStandardJson(text: string): string {
  /** 先去注释和尾逗号 */
  let s = stripTrailingCommas(stripComments(text));

  /** 单引号字符串 → 双引号（逐字符遍历，正确处理转义） */
  s = s.replace(/(['"])((?:\\.|(?!\1).)*)\1/g, (_, q, content) => {
    if (q === '"') return _;
    /** 单引号：反转义单引号，转义双引号 */
    const unescaped = content.replace(/\\'/g, "'").replace(/\\"/g, '"');
    /** 转义内嵌双引号 */
    const reEscaped = unescaped.replace(/"/g, '\\"');
    return '"' + reEscaped + '"';
  });

  /** 无引号的 key：{ key: → { "key": 或 , key: → , "key": */
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');

  /** 十六进制数字 → 十进制 */
  s = s.replace(/(^|[^\w.])-?(0x[0-9a-fA-F]+)/g, (_match, pre, hex) => {
    return pre + String(parseInt(hex, 16));
  });

  /** 前导小数点 .5 → 0.5 */
  s = s.replace(/(^|[^\w.])\.(\d)/g, "$10.$2");

  /** + 开头正数 → 去掉 + */
  s = s.replace(/([:{,[\s])\+(\d)/g, "$1$2");

  /** Infinity / -Infinity / NaN → null（JSON 不支持） */
  s = s.replace(/(^|[^\w])Infinity/g, "$1null").replace(/(^|[^\w])-Infinity/g, "$1null");
  s = s.replace(/(^|[^\w])NaN/g, "$1null");

  return s;
}

/** JSON 解析模式 */
export type JsonParseMode = "json" | "jsonc" | "json5";

/** 根据模式解析 JSON 文本 */
export function parseByMode(text: string, mode: JsonParseMode): unknown {
  switch (mode) {
    case "json":
      return JSON.parse(text);
    case "jsonc":
      return JSON.parse(stripTrailingCommas(stripComments(text)));
    case "json5":
      return JSON.parse(json5ToStandardJson(text));
  }
}

/**
 * 应用 JQ 风格路径表达式（如 `.items[].msg`）
 *
 * 基于 tokens 数组顺序推进（不再回头切原始字符串），
 * 表达式含意外字符时会在路径取值处抛错而非静默错位。
 */
export function applyJq(data: unknown, expr: string): unknown {
  let cur = data;
  /** 按 . 和 [] 拆分路径段 */
  const tokens = expr.match(/\.(\w+)|\[(\d+)\]|\[\]/g);
  if (!tokens) return cur;
  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti];
    if (tok === "[]") {
      if (!Array.isArray(cur)) throw new Error("[] 只能用于数组");
      /** 剩余 tokens 重新拼接为子表达式递归应用于每个元素 */
      const rest = tokens.slice(ti + 1).join("");
      if (!rest) return cur;
      return cur.map((item) => applyJq(item, rest));
    }
    const key = tok.startsWith(".") ? tok.slice(1) : tok.slice(1, -1);
    cur = (cur as Record<string, unknown>)[key];
    if (cur === undefined) throw new Error(`路径 "${tok}" 无值`);
  }
  return cur;
}

/**
 * 递归排序 plain object 的 key（原地构造新对象，不改原引用）
 *
 * 数组保持元素顺序，但元素内部的 object 仍递归排序。
 * 非 plain object（Date/Map 等）原样返回。
 */
export function sortKeysDeep(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortKeysDeep);
  if (val !== null && typeof val === "object" && Object.getPrototypeOf(val) === Object.prototype) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(val as Record<string, unknown>).sort()) {
      sorted[k] = sortKeysDeep((val as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return val;
}

/** 解析 SSE 文本块 */
export function parseSse(text: string) {
  const events: { data: string; type: string; id: string }[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const ev = { data: "", type: "", id: "" };
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (!line.trim() || line.startsWith(":")) continue;
      const ci = line.indexOf(":");
      const field = ci > 0 ? line.slice(0, ci) : "";
      const val = ci > 0 ? line.slice(ci + 1).replace(/^ /, "") : line;
      if (field === "data") dataLines.push(val);
      else if (field === "event") ev.type = val;
      else if (field === "id") ev.id = val;
      else dataLines.push(line);
    }
    ev.data = dataLines.join("\n");
    if (ev.data || ev.type) events.push(ev);
  }
  return events;
}

/** 解析 JSONL */
export function parseJsonl(text: string) {
  const events: { data: string; type: string; id: string }[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      events.push({
        data: JSON.stringify(obj),
        type: String(obj.level || obj.type || ""),
        id: String(obj.id ?? obj.ts ?? ""),
      });
    } catch {
      events.push({ data: line, type: "", id: "" });
    }
  }
  return events;
}

/** 毫秒数 → 人性化时长（如 "3分钟"、"2小时"） */
export function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "秒";
  if (s < 3600) return Math.floor(s / 60) + "分钟";
  if (s < 86400) return Math.floor(s / 3600) + "小时";
  return Math.floor(s / 86400) + "天";
}

/**
 * UTF-8 安全的 Base64 编码（替代废弃的 unescape/escape 组合）
 *
 * 分块 fromCharCode，避免大字符串展开爆栈。
 */
export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** UTF-8 安全的 Base64 解码（替代废弃的 escape/decodeURIComponent 组合） */
export function base64ToUtf8(s: string): string {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
