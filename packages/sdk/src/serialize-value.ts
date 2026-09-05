/**
 * 结构化序列化器 —— 把任意 JS 值转为 SerializedValue 节点树
 *
 * 用于 exec 返回值的可交互对象树展示（类似 DevTools console）。
 * 前端拿到 SerializedValue 后递归渲染为可展开/折叠的树。
 *
 * 核心设计：
 * - WeakMap 检测循环引用（祖先链模式：进递归 add，出递归 delete）
 * - 无深度/数量硬限制，用节点计数安全阀防止超大数据爆栈
 * - 循环引用的对象正常展开，环路径标记 [Circular refId:N]
 * - 特殊类型（Date/RegExp/Error/Map/Set/Element 等）有专属 type + preview
 */

import type { SerializedValue, SerializedProperty } from "@silkpulse/shared";

/** 节点总数安全阀：超过此值停止递归，防止单次 exec 序列化超大数据爆栈 */
const MAX_NODES = 50000;

/** 序列化上下文（在一次 toSerializedValue 调用中共享） */
interface SerializeContext {
  /** 祖先链：当前递归路径上的对象 → refId（用于检测循环引用） */
  seen: WeakMap<object, number>;
  /** 所有遇到过的对象 → refId（用于分配唯一 id） */
  refMap: Map<object, number>;
  /** 已创建的节点数（安全阀） */
  nodeCount: number;
}

/**
 * 主序列化入口
 *
 * 循环引用处理：对象在祖先链上出现时标记 [Circular refId:N]，不再递归。
 * 跨分支重复对象正常展开（数据冗余但保证展示完整性）。
 */
export function toSerializedValue(val: unknown): SerializedValue {
  const ctx: SerializeContext = {
    seen: new WeakMap(),
    refMap: new Map(),
    nodeCount: 0,
  };
  return serialize(val, ctx);
}

/**
 * 内部递归实现
 */
function serialize(val: unknown, ctx: SerializeContext): SerializedValue {
  /** 安全阀：节点数超限停止递归 */
  if (ctx.nodeCount++ > MAX_NODES) {
    return { type: "unknown", preview: "…(节点数超限 " + MAX_NODES + ")" };
  }

  /** 基本类型直接返回 */
  if (val === null) return { type: "null", preview: "null", value: "null" };
  if (val === undefined) return { type: "undefined", preview: "undefined", value: "undefined" };
  if (typeof val === "string")
    return { type: "string", preview: `"${truncate(val, 100)}"`, value: val };
  if (typeof val === "number") return { type: "number", preview: String(val), value: val };
  if (typeof val === "boolean") return { type: "boolean", preview: String(val), value: val };
  if (typeof val === "bigint") return { type: "bigint", preview: `${val}n`, value: String(val) };
  if (typeof val === "symbol") {
    return { type: "symbol", preview: val.toString() };
  }

  /** function */
  if (typeof val === "function") {
    const name = (val as { name?: string }).name || "anonymous";
    const isAsync = val.constructor?.name === "AsyncFunction";
    const isGen = val.constructor?.name === "GeneratorFunction";
    const prefix = isAsync ? "async " : isGen ? "function* " : "ƒ ";
    return { type: "function", preview: `${prefix}${name}()`, constructorName: "Function" };
  }

  /** 到此一定是 object，做循环引用检测 */
  const obj = val as object;

  /** 循环引用检测：如果这个对象在当前祖先链上 → 标记 [Circular] */
  const ancestorRefId = ctx.seen.get(obj);
  if (ancestorRefId !== undefined) {
    return { type: "object", preview: `[Circular refId:${ancestorRefId}]`, refId: ancestorRefId };
  }

  /** 分配 refId（每个对象一个唯一 id，用于前端标记循环引用来源） */
  let refId: number;
  const existing = ctx.refMap.get(obj);
  if (existing !== undefined) {
    refId = existing;
  } else {
    refId = ctx.refMap.size + 1;
    ctx.refMap.set(obj, refId);
  }

  /** 标记当前对象在祖先链上 */
  ctx.seen.set(obj, refId);

  try {
    return serializeObject(val, ctx, refId);
  } finally {
    /** 退出祖先链 */
    ctx.seen.delete(obj);
  }
}

/**
 * 序列化对象/数组/特殊类型
 */
function serializeObject(val: unknown, ctx: SerializeContext, refId: number): SerializedValue {
  /** Date */
  if (val instanceof Date) {
    return { type: "date", preview: val.toISOString(), constructorName: "Date" };
  }

  /** RegExp */
  if (val instanceof RegExp) {
    return { type: "regexp", preview: val.toString(), constructorName: "RegExp" };
  }

  /** Error */
  if (val instanceof Error) {
    const props: SerializedProperty[] = [
      { key: "message", value: serialize(val.message, ctx) },
      { key: "stack", value: serialize(val.stack, ctx) },
    ];
    return {
      type: "error",
      preview: `${val.name}: ${val.message}`,
      properties: props,
      constructorName: val.name,
    };
  }

  /** Map */
  if (val instanceof Map) {
    const entries = Array.from(val.entries());
    const props: SerializedProperty[] = entries.map(([k, v]) => ({
      key: formatKey(k),
      value: serialize(v, ctx),
    }));
    return {
      type: "map",
      preview: `Map(${val.size})`,
      properties: props,
      length: val.size,
      constructorName: "Map",
      refId,
    };
  }

  /** Set */
  if (val instanceof Set) {
    const values = Array.from(val);
    const elements: SerializedValue[] = values.map((v) => serialize(v, ctx));
    return {
      type: "set",
      preview: `Set(${val.size})`,
      elements,
      length: val.size,
      constructorName: "Set",
      refId,
    };
  }

  /** WeakMap / WeakSet（不可遍历） */
  if (val instanceof WeakMap) {
    return { type: "weakmap", preview: "WeakMap { … }", constructorName: "WeakMap", refId };
  }
  if (val instanceof WeakSet) {
    return { type: "weakset", preview: "WeakSet { … }", constructorName: "WeakSet", refId };
  }

  /** Promise */
  if (val instanceof Promise) {
    return { type: "promise", preview: "Promise { <pending> }", constructorName: "Promise", refId };
  }

  /** DOM Element */
  if (val instanceof Element) {
    const el = val as Element;
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls =
      el.className && typeof el.className === "string"
        ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
        : "";
    const text = el.textContent?.trim().slice(0, 30);
    const props: SerializedProperty[] = [
      { key: "tagName", value: serialize(tag.toUpperCase(), ctx) },
      { key: "id", value: serialize(el.id, ctx) },
      { key: "className", value: serialize(el.className, ctx) },
      { key: "innerHTML", value: serialize(el.innerHTML?.slice(0, 200), ctx) },
    ];
    return {
      type: "element",
      preview: `<${tag}${id}${cls}>${text ? " " + truncate(text, 30) : ""}</${tag}>`,
      properties: props,
      constructorName: el.constructor?.name || tag.toUpperCase(),
      refId,
    };
  }

  /** Text Node */
  if (val instanceof Text) {
    const text = (val as Text).textContent || "";
    return {
      type: "textnode",
      preview: `#text "${truncate(text, 50)}"`,
      constructorName: "Text",
      refId,
    };
  }

  /** Event */
  if (typeof Event !== "undefined" && val instanceof Event) {
    const ev = val as Event;
    return {
      type: "event",
      preview: `[${ev.constructor?.name || "Event"} type=${ev.type}]`,
      constructorName: ev.constructor?.name || "Event",
      refId,
    };
  }

  /** Array */
  if (Array.isArray(val)) {
    const elements = val.map((v) => serialize(v, ctx));
    return {
      type: "array",
      preview: `Array(${val.length}) [${val.slice(0, 3).map(previewOne).join(", ")}${val.length > 3 ? ", …" : ""}]`,
      elements,
      length: val.length,
      constructorName: "Array",
      refId,
    };
  }

  /** TypedArray */
  if (ArrayBuffer.isView(val)) {
    /** ArrayBufferView（TypedArray / DataView）有 length 和数字索引 */
    const arr = val as unknown as { length: number; [i: number]: unknown };
    const elements: SerializedValue[] = Array.from({ length: arr.length }, (_, i) =>
      serialize(arr[i], ctx),
    );
    const name = (val as { constructor: { name: string } }).constructor.name;
    return {
      type: "array",
      preview: `${name}(${arr.length})`,
      elements,
      length: arr.length,
      constructorName: name,
      refId,
    };
  }

  /** 普通对象 */
  const ctorName = (val as { constructor?: { name?: string } }).constructor?.name;
  const isPlain = !ctorName || ctorName === "Object";

  /** 收集自身 + 原型链属性名（带 inherited 标记，展示层据此折叠原型链分组） */
  const allKeys: { key: string; isSymbol: boolean; inherited: boolean }[] = [];
  const seenKeys = new Set<string>();

  /** 自身可枚举属性 */
  for (const k of Object.keys(val as Record<string, unknown>)) {
    if (!seenKeys.has(k)) {
      seenKeys.add(k);
      allKeys.push({ key: k, isSymbol: false, inherited: false });
    }
  }

  /** 自身不可枚举属性（Web API 对象如 Navigator/Location 的属性大多在此） */
  for (const k of Object.getOwnPropertyNames(val)) {
    if (!seenKeys.has(k)) {
      seenKeys.add(k);
      allKeys.push({ key: k, isSymbol: false, inherited: false });
    }
  }

  /**
   * 原型链属性（最多遍历 3 层）
   *
   * 很多 Web API 对象（navigator, location, history 等）的属性
   * 定义在原型链上而非实例自身，需要遍历原型链才能采集到。
   */
  let proto = Object.getPrototypeOf(val);
  let protoDepth = 0;
  while (proto && protoDepth < 3) {
    try {
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (k === "constructor") continue;
        if (!seenKeys.has(k)) {
          seenKeys.add(k);
          allKeys.push({ key: k, isSymbol: false, inherited: true });
        }
      }
    } catch {
      /** 安全降级 */
    }
    proto = Object.getPrototypeOf(proto);
    protoDepth++;
  }

  /** Symbol 属性 */
  const symbols = Object.getOwnPropertySymbols(val);
  for (const s of symbols) {
    const key = s.toString();
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      allKeys.push({ key: s.description || key, isSymbol: true, inherited: false });
    }
  }

  /** 取属性值 + 检测 getter */
  const props: SerializedProperty[] = [];
  for (const { key, isSymbol, inherited } of allKeys) {
    /** 安全阀触发后不再递归 */
    if (ctx.nodeCount > MAX_NODES) break;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(val, key);
      const isGetter = !!descriptor && typeof descriptor.get === "function";
      const rawVal = (val as Record<string, unknown>)[key];
      props.push({
        key,
        value: serialize(rawVal, ctx),
        isGetter,
        isSymbol,
        inherited,
      });
    } catch {
      /** getter 抛错时跳过 */
      props.push({
        key,
        value: { type: "unknown", preview: "[getter throws]" },
        isGetter: true,
        isSymbol,
        inherited,
      });
    }
  }

  const previewKeys = allKeys.slice(0, 3).map((k) => k.key);
  const previewBody = previewKeys
    .map((k) => {
      try {
        return `${k}: ${previewOne((val as Record<string, unknown>)[k])}`;
      } catch {
        return `${k}: …`;
      }
    })
    .join(", ");

  return {
    type: "object",
    preview: `${isPlain ? "{" : (ctorName || "Object") + " {"}${previewBody ? " " + previewBody : ""}${allKeys.length > 3 ? ", …" : ""} }`,
    properties: props,
    constructorName: isPlain ? undefined : ctorName,
    refId,
  };
}

/** 单个值的预览（一行摘要） */
function previewOne(val: unknown): string {
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  const t = typeof val;
  if (t === "string") return `"${truncate(val as string, 30)}"`;
  if (t === "number" || t === "boolean" || t === "bigint") return String(val);
  if (t === "function") return `ƒ ${(val as { name?: string }).name || ""}()`;
  if (Array.isArray(val)) return `Array(${val.length})`;
  if (t === "object") {
    const ctorName = (val as { constructor?: { name?: string } }).constructor?.name;
    if (ctorName && ctorName !== "Object") return ctorName;
    return "{…}";
  }
  return String(val);
}

/** 格式化 Map key */
function formatKey(k: unknown): string {
  if (typeof k === "string") return k;
  if (typeof k === "number") return String(k);
  if (typeof k === "symbol") return k.toString();
  return String(k);
}

/** 截断字符串 */
function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}
