<script setup lang="ts">
/**
 * ObjectInspector —— 统一对象展示/编辑组件
 *
 * 替代旧版 ObjectTreeView（只读）+ JsonTreeEditor（可编辑），
 * 一个组件覆盖所有需要展示/编辑对象数据的场景。
 *
 * ### 数据入口（三选一）
 * - `value: SerializedValue` —— exec 结果等结构化序列化值（远程环境采集的丰富类型）
 * - `raw: unknown` —— 普通 JS 对象/数组/基本类型（自动适配为 SerializedValue 树）
 * - `json: string` —— JSON 字符串（自动 parse 为对象树，非 JSON 时降级纯文本）
 *
 * ### 模式
 * - `readonly`（默认）—— 只读展示，所有节点不可编辑
 * - `:editable="true"` —— 叶子节点（string/number/boolean/null）可原地编辑，
 *   修改后 emit `update:modelValue` 传递新值
 *
 * ### 展示场景
 * - ConsolePanel exec 结果（只读 SerializedValue）
 * - ExecPanel exec 结果（只读 SerializedValue）
 * - NetworkPanel headers/body（只读 JSON 字符串）
 * - StoragePanel localStorage 编辑（可编辑 JSON / 文本）
 * - StoragePanel IndexedDB 记录（只读）
 */
import { ref, computed, watch, provide, inject, triggerRef } from "vue";
import type { Ref } from "vue";
import type { SerializedValue } from "@silkpulse/shared";
import { diffText, type TextDiffSegment } from "@silkpulse/renderer";
import { onClickOutside } from "@vueuse/core";

/* ==================== 右键菜单：展开控制广播通道 ==================== */

/**
 * 子树展开覆盖信号
 *
 * 当用户右键"展开/收起全部子节点"时，根实例设置此信号。
 * 所有节点通过 inject 读取，如果自己的 path 是 targetPath 的子孙，
 * 则 expanded 被 override 为指定值。
 *
 * 用响应式 ref 实现——即使子节点尚未渲染，一旦渲染就会立即读取到 override 值，
 * 实现"逐层自动展开"效果（Vue 的响应式更新 + nextTick 递进）。
 */
type ExpandOverride = {
  targetPath: number[];
  value: boolean;
  /** 版本号，每次操作递增以触发 watch */ version: number;
} | null;

/** 右键菜单上下文 */
interface MenuContext {
  /** 触发菜单的节点 path */
  path: number[];
  /** 该节点的 SerializedValue */
  node: SerializedValue;
  /** 鼠标坐标 */
  x: number;
  y: number;
  /** 是否有子节点 */
  hasChildren: boolean;
}

const props = withDefaults(
  defineProps<{
    /** 结构化序列化值（优先使用，来自远程 exec） */
    value?: SerializedValue;
    /** 普通 JS 对象/基本类型（自动适配） */
    raw?: unknown;
    /** JSON 字符串（自动 parse，非 JSON 降级纯文本） */
    json?: string;
    /** 属性键名（子节点才有） */
    keyName?: string;
    /** 嵌套深度（根为 0，自动控制默认展开层级） */
    depth?: number;
    /** 是否可编辑 */
    editable?: boolean;
    /** 子节点索引（用于构建唯一 path，右键菜单展开控制用） */
    childIndex?: number;
    /** Diff 模式：对侧的 raw 树（与本侧对比），仅根实例需要传 */
    diffRaw?: unknown;
    /** Diff 模式：本侧角色（old=红/删除，new=绿/新增），仅根实例需要传 */
    diffSide?: "old" | "new";
  }>(),
  {
    depth: 0,
    editable: false,
    childIndex: 0,
    diffRaw: undefined,
    diffSide: undefined,
  },
);

const emit = defineEmits<{
  /** 值被修改时触发（editable 模式），传递新值 */
  "update:modelValue": [value: unknown];
  /** 右键菜单事件冒泡（子→父→根） */
  "context-menu": [ctx: MenuContext];
}>();

/* ==================== 数据归一化：三入口 → SerializedValue ==================== */

/**
 * 把任意输入归一化为 SerializedValue 树节点
 *
 * SerializedValue 直接透传；unknown 手动构建；JSON 字符串先 parse。
 */
function normalizeToSerialized(input: {
  value?: SerializedValue;
  raw?: unknown;
  json?: string;
}): SerializedValue {
  /** 优先级：value > raw > json */
  if (input.value) return input.value;
  if (input.raw !== undefined) return rawToSerialized(input.raw);
  if (input.json !== undefined) {
    const trimmed = input.json.trim();
    if (!trimmed) return { type: "string", preview: '""', value: "" };
    try {
      const parsed = JSON.parse(trimmed);
      return rawToSerialized(parsed);
    } catch {
      /** 非 JSON：作为纯字符串展示 */
      return { type: "string", preview: `"${truncate(input.json, 200)}"`, value: input.json };
    }
  }
  return { type: "undefined", preview: "undefined" };
}

/* ==================== Diff 模式：raw 树对比 ==================== */

/**
 * 单个节点的 diff 状态
 *
 * - equal：两侧值完全一致（含所有后代）
 * - added：仅 new 侧有（整棵子树新增）
 * - removed：仅 old 侧有（整棵子树删除）
 * - modified：叶子值变化（如 1→2、"a"→"b"）
 * - children-changed：容器节点的后代有变化，但自身 key 存在两侧
 */
type DiffStatus = "equal" | "added" | "removed" | "modified" | "children-changed";

/** Diff 模式下根实例 provide 的上下文 */
interface DiffContext {
  /** 本侧角色 */
  side: "old" | "new";
  /** path（逗号 join 的 childIndex 链）→ 节点 diff 状态（响应式 ref，增量更新时触发视图刷新） */
  statusMap: Ref<Map<string, DiffStatus>>;
  /** modified 节点的对侧值（字符级 diff 用）：path → 对侧叶子值 */
  otherValueMap: Ref<Map<string, unknown>>;
  /** 有变化的祖先路径集合（这些路径的容器节点需要默认展开） */
  changedAncestors: Ref<Set<string>>;
  /** 对侧树的 raw 引用（增量更新时按路径取对侧值对比） */
  otherRaw: unknown;
  /** 根路径字符串（computeDiffMap 的 rootPath） */
  rootPath: string;
  /**
   * 编辑链路标记：updateDiffPath 已同步增量更新过 diff 状态，
   * 随后 emit 冒泡导致 props.raw 变化触发的 watch 应跳过全量重算（避免抵消增量）。
   */
  skipNextRawWatch: boolean;
  /**
   * 增量更新受影响路径的 diff 状态
   * @param path 逗号 join 的 childIndex 路径（如 "0,2,1"）
   * @param newSelfValue 本侧该路径的新值
   */
  updateDiffPath(path: string, newSelfValue: unknown): void;
}

/**
 * 深比较两个 raw 值是否完全相等（用于 diff 的 equal 判定）
 *
 * 只处理 JSON 兼容类型（object/array/基本类型），
 * 这是 diff 场景的输入约束（diffRaw 来自 JSON.parse）。
 */
function rawDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => rawDeepEqual(item, (b as unknown[])[i]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      rawDeepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * 计算单侧树的 diff 状态 map
 *
 * 递归对齐两侧的 raw 树（按 childIndex 路径），为每个节点标状态。
 * 数组按下标对齐（不做 LCS，简单直观）；object 按 key 对齐。
 */
function computeDiffMap(
  selfRaw: unknown,
  otherRaw: unknown,
  side: "old" | "new",
  rootPath: string,
): { statusMap: Map<string, DiffStatus>; otherValueMap: Map<string, unknown> } {
  const statusMap = new Map<string, DiffStatus>();
  /** modified 节点的对侧值（字符级 diff 用） */
  const otherValueMap = new Map<string, unknown>();

  function walk(self: unknown, other: unknown, path: string) {
    /** 完全相等：整棵子树 equal，不再深入 */
    if (rawDeepEqual(self, other)) {
      statusMap.set(path, "equal");
      return;
    }

    /** 类型不同或都是叶子：modified，记录对侧值用于字符级 diff */
    const selfObj = self !== null && typeof self === "object";
    const otherObj = other !== null && typeof other === "object";
    if (!selfObj || !otherObj) {
      statusMap.set(path, "modified");
      otherValueMap.set(path, other);
      return;
    }

    const selfArr = Array.isArray(self);
    const otherArr = Array.isArray(other);
    if (selfArr !== otherArr) {
      statusMap.set(path, "modified");
      otherValueMap.set(path, other);
      return;
    }

    /** 容器节点：自身 key 存在两侧，标 children-changed，递归子节点 */
    statusMap.set(path, "children-changed");

    if (selfArr && otherArr) {
      const maxLen = Math.max(self.length, other.length);
      for (let i = 0; i < maxLen; i++) {
        const childPath = `${path},${i}`;
        const inSelf = i < self.length;
        const inOther = i < other.length;
        if (inSelf && inOther) {
          walk(self[i], other[i], childPath);
        } else if (inSelf) {
          /** 仅本侧有：added/removed 整棵子树 */
          markSubtree(self[i], childPath, side === "new" ? "added" : "removed");
        }
        /** 仅对侧有：本侧没有对应节点，不标（对侧的 added 会自己标） */
      }
    } else {
      const selfObj2 = self as Record<string, unknown>;
      const otherObj2 = other as Record<string, unknown>;
      const allKeys = new Set([...Object.keys(selfObj2), ...Object.keys(otherObj2)]);
      /** 需要把 key 映射到 childIndex：rawToSerialized 用 Object.keys 顺序 */
      const selfKeys = Object.keys(selfObj2);
      const otherKeys = Object.keys(otherObj2);
      for (const k of allKeys) {
        const inSelf = k in selfObj2;
        const inOther = k in otherObj2;
        if (inSelf && inOther) {
          const idx = selfKeys.indexOf(k);
          walk(selfObj2[k], otherObj2[k], `${path},${idx}`);
        } else if (inSelf) {
          const idx = selfKeys.indexOf(k);
          markSubtree(selfObj2[k], `${path},${idx}`, side === "new" ? "added" : "removed");
        } else {
          /** 仅对侧有的 key：本侧没有节点，但对侧需要知道自己的 childIndex 是 added。
           * 由于 childIndex 由各自树的 Object.keys 顺序决定，对侧新增 key 的 idx
           * 在对侧树里是独立计算的（otherKeys.indexOf(k)），所以这里无需处理。 */
          void otherKeys;
        }
      }
    }
  }

  /** 给整棵子树标同一状态（用于 added/removed 分支） */
  function markSubtree(val: unknown, path: string, status: DiffStatus) {
    statusMap.set(path, status);
    if (val !== null && typeof val === "object") {
      if (Array.isArray(val)) {
        val.forEach((item, i) => markSubtree(item, `${path},${i}`, status));
      } else {
        Object.keys(val as Record<string, unknown>).forEach((k, i) =>
          markSubtree((val as Record<string, unknown>)[k], `${path},${i}`, status),
        );
      }
    }
  }

  walk(selfRaw, otherRaw, rootPath);
  return { statusMap, otherValueMap };
}

/**
 * 按路径从树中取值
 *
 * path 是逗号 join 的 childIndex 链（如 "0,2,1"），rootPath 是起始路径。
 * 数组按下标取，object 按 Object.keys 顺序的第 idx 个 key 取。
 */
function getValueByPath(tree: unknown, path: string, rootPath: string): unknown {
  /** 去掉 rootPath 前缀，得到相对路径 */
  const relPath = path.startsWith(rootPath) ? path.slice(rootPath.length) : path;
  const segments = relPath.split(",").filter(Boolean);
  let cur = tree;
  for (const seg of segments) {
    const idx = Number(seg);
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      cur = cur[idx];
    } else if (typeof cur === "object") {
      const keys = Object.keys(cur as Record<string, unknown>);
      cur = (cur as Record<string, unknown>)[keys[idx]];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * 计算单个节点的 diff 状态（增量更新用）
 *
 * 只做一层比较，不递归——调用方保证只在叶子值变化时调用。
 */
function computeNodeDiffStatus(self: unknown, other: unknown, side: "old" | "new"): DiffStatus {
  if (rawDeepEqual(self, other)) return "equal";
  const selfObj = self !== null && typeof self === "object";
  const otherObj = other !== null && typeof other === "object";
  if (!selfObj || !otherObj) return "modified";
  if (Array.isArray(self) !== Array.isArray(other)) return "modified";
  /** 容器节点：如果之前是 children-changed，现在可能变成 equal（由调用方判断） */
  return "children-changed";
}

/**
 * 更新受影响路径的祖先链状态
 *
 * 从 path 往上遍历所有祖先，重新计算每个祖先的 changedAncestors 成员资格。
 * 规则：如果祖先的所有子节点都 equal → 祖先从 changedAncestors 移除；
 *      否则 → 祖先加入 changedAncestors。
 */
function updateAncestorsForPath(
  statusMap: Map<string, DiffStatus>,
  changedAncestors: Set<string>,
  path: string,
  rootPath: string,
) {
  const segments = path.split(",");
  /** 从 path 的父级开始往上（不含 path 本身，因为 path 的状态已经单独更新） */
  for (let i = segments.length - 1; i >= 1; i--) {
    const ancestorPath = segments.slice(0, i).join(",");
    if (ancestorPath === rootPath) continue;
    /** 检查该祖先的所有子节点是否都 equal */
    const hasChangedChild = Array.from(statusMap.entries()).some(([p, s]) => {
      if (s === "equal") return false;
      /** p 是 ancestorPath 的直接子节点（不多不少正好深一层） */
      if (!p.startsWith(ancestorPath + ",")) return false;
      const rel = p.slice(ancestorPath.length + 1);
      return !rel.includes(",");
    });
    if (hasChangedChild) {
      changedAncestors.add(ancestorPath);
      statusMap.set(ancestorPath, "children-changed");
    } else {
      changedAncestors.delete(ancestorPath);
      statusMap.set(ancestorPath, "equal");
    }
  }
  /** 根节点单独处理：检查是否有任何非根节点有变化 */
  const rootHasChanges = Array.from(statusMap.entries()).some(
    ([p, s]) => p !== rootPath && s !== "equal",
  );
  if (rootHasChanges) {
    statusMap.set(rootPath, "children-changed");
  } else {
    statusMap.set(rootPath, "equal");
  }
}

/**
 * 收集有变化的祖先路径（用于自动展开）
 *
 * 从 statusMap 里所有非 equal 节点的 path 推导祖先链，
 * 这些路径的容器节点需要默认展开才能看到变化。
 */
function collectChangedAncestorPaths(
  statusMap: Map<string, DiffStatus>,
  rootPath: string,
): Set<string> {
  const result = new Set<string>();
  for (const [path, status] of statusMap) {
    if (status === "equal" || path === rootPath) continue;
    /** 把 "0,2,1" 拆成 ["0", "0,2", "0,2,1"]，所有祖先都加入 */
    const segs = path.split(",");
    for (let i = 1; i < segs.length; i++) {
      result.add(segs.slice(0, i).join(","));
    }
  }
  return result;
}

/**
 * 把普通 JS 值转为 SerializedValue（简化版，不含远程环境的特殊类型）
 *
 * 只覆盖 object/array/基本类型——足够本地数据（storage/network）使用。
 */
function rawToSerialized(val: unknown, depth = 0): SerializedValue {
  if (val === null) return { type: "null", preview: "null" };
  if (val === undefined) return { type: "undefined", preview: "undefined" };
  const t = typeof val;
  if (t === "string") return { type: "string", preview: `"${truncate(val, 100)}"`, value: val };
  if (t === "number") return { type: "number", preview: String(val), value: val };
  if (t === "boolean") return { type: "boolean", preview: String(val), value: val };
  if (t === "bigint") return { type: "bigint", preview: `${val}n`, value: String(val) };

  if (t === "function") {
    const fn = val as { name?: string; toString(): string };
    const src = fn.toString();
    return { type: "function", preview: `ƒ ${fn.name || ""}()`, value: src };
  }
  if (t === "symbol") return { type: "symbol", preview: String(val) };
  if (val instanceof RegExp) return { type: "regexp", preview: String(val) };
  if (val instanceof Date)
    return { type: "date", preview: isNaN(val.getTime()) ? "Invalid Date" : val.toISOString() };

  if (Array.isArray(val)) {
    if (depth >= 8) return { type: "array", preview: `[${val.length}]`, length: val.length };
    return {
      type: "array",
      preview: `Array(${val.length}) [${val.slice(0, 3).map(previewOne).join(", ")}${val.length > 3 ? ", …" : ""}]`,
      elements: val.map((v) => rawToSerialized(v, depth + 1)),
      length: val.length,
    };
  }

  if (t === "object") {
    const keys = Object.keys(val as Record<string, unknown>);
    const ctorName = (val as { constructor?: { name?: string } }).constructor?.name;
    if (depth >= 8) {
      return { type: "object", preview: `${ctorName || "Object"} {…}`, constructorName: ctorName };
    }
    return {
      type: "object",
      preview: `${ctorName && ctorName !== "Object" ? ctorName + " " : ""}{${keys
        .slice(0, 3)
        .map((k) => `${k}: ${previewOne((val as Record<string, unknown>)[k])}`)
        .join(", ")}${keys.length > 3 ? ", …" : ""}}`,
      properties: keys.map((k) => ({
        key: k,
        value: rawToSerialized((val as Record<string, unknown>)[k], depth + 1),
      })),
      constructorName: ctorName,
    };
  }

  return { type: "unknown", preview: String(val) };
}

/** 辅助：单值预览（用于父对象 summary） */
function previewOne(val: unknown): string {
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  const t = typeof val;
  if (t === "string") return `"${truncate(val as string, 30)}"`;
  if (t === "number" || t === "boolean" || t === "bigint") return String(val);
  if (t === "function") return `ƒ ${(val as { name?: string }).name || ""}()`;
  if (t === "symbol") return String(val);
  if (val instanceof RegExp) return String(val);
  if (val instanceof Date) return isNaN(val.getTime()) ? "Invalid Date" : val.toISOString();
  if (Array.isArray(val)) return `Array(${val.length})`;
  if (t === "object") {
    const ctorName = (val as { constructor?: { name?: string } }).constructor?.name;
    if (ctorName && ctorName !== "Object") return ctorName;
    return "{…}";
  }
  return String(val);
}

/** 辅助：截断字符串 */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** 当前节点的归一化值（响应式：props 变化重新计算） */
const node = computed(() =>
  normalizeToSerialized({
    value: props.value,
    raw: props.raw,
    json: props.json,
  }),
);

/* ==================== 展开/折叠 ==================== */

/** 是否有子节点可展开 */
const hasChildren = computed(() => {
  const v = node.value;
  /** 函数节点：有源码可展开 */
  if (v.type === "function" && v.value) return true;
  return (
    (v.type === "object" || v.type === "array") &&
    ((v.properties?.length ?? 0) > 0 || (v.elements?.length ?? 0) > 0)
  );
});

/** 子项列表（object→properties, array→elements 映射为 properties 格式） */
const children = computed(() => {
  const v = node.value;
  if (v.elements) {
    return v.elements.map((e, i) => ({ key: String(i), value: e }));
  }
  return (v.properties ?? []).filter((p) => !p.inherited);
});

/**
 * 继承属性（来自原型链，inherited 标记）分组
 *
 * 自有属性直接平铺；继承属性折叠进单个 [[Prototype]] 节点（DevTools 同款体验），
 * 避免原型方法（hasOwnProperty/toString/…）淹没自有字段。
 */
const protoChildren = computed(() => (node.value.properties ?? []).filter((p) => p.inherited));

/** [[Prototype]] 分组是否展开（独立于 expandOverride 通道，保持简单） */
const protoExpanded = ref(false);

/**
 * 分批渲染：当前可见的子节点条数（每批 50 条）
 *
 * 大数组/大对象下避免一次渲染全部子节点导致 DOM 爆炸。
 * 点「更多」按钮 +50，双击直接展开全部。
 */
const visibleCount = ref(50);

watch(
  () => [props.value, props.raw, props.json],
  () => {
    /**
     * 外部数据变化时：
     * - 不重置 manualExpanded（保留用户的展开/折叠状态，避免文本框每次输入都折叠整棵树）
     * - 仅清除根实例的 expandOverride（override 是基于旧路径的，新树下可能失效）
     */
    if (isRoot) expandOverride.value = null;
  },
);

/** 展开/折叠切换（清除 override，让手动状态接管） */
function toggle() {
  if (!hasChildren.value) return;
  /** 如果有 override，先清除再 toggle */
  if (expandOverride.value) {
    expandOverride.value = null;
  }
  manualExpanded.value = !manualExpanded.value;
}

/* ==================== 右键菜单：展开控制通道实现 ==================== */

/** 是否为根实例 */
const isRoot = props.depth === 0;

/** 从 inject 拿到父级 path */
const parentPath = inject<number[]>("oi-path", []);

/** 当前节点的 path = 父 path + 自己的 childIndex */
const nodePath = computed(() => [...parentPath, props.childIndex]);

/** 根实例创建响应式的 expandOverride 并 provide；非根 inject 已有的 */
const expandOverride = isRoot
  ? ref<ExpandOverride>(null)
  : inject<Ref<ExpandOverride>>("oi-expand-override", ref<ExpandOverride>(null));

/** provide 给子组件 */
provide("oi-path", nodePath.value);
provide("oi-expand-override", expandOverride as Ref<ExpandOverride>);

/* ==================== Diff 模式：raw 树对比 ==================== */

/** 当前节点 path 的字符串形式（diff map 查询用） */
const nodePathStr = computed(() => nodePath.value.join(","));

/** 根实例：计算 diff map 并 provide；非根：inject */
const diffCtx = (() => {
  if (isRoot && props.diffSide && props.raw !== undefined && props.diffRaw !== undefined) {
    const { statusMap, otherValueMap } = computeDiffMap(
      props.raw,
      props.diffRaw,
      props.diffSide,
      nodePathStr.value,
    );
    const changedAncestors = collectChangedAncestorPaths(statusMap, nodePathStr.value);
    const ctx: DiffContext = {
      side: props.diffSide,
      statusMap: ref(statusMap),
      otherValueMap: ref(otherValueMap),
      changedAncestors: ref(changedAncestors),
      otherRaw: props.diffRaw,
      rootPath: nodePathStr.value,
      skipNextRawWatch: false,
      updateDiffPath(path: string, newSelfValue: unknown) {
        /** 按路径取对侧值 */
        const otherValue = getValueByPath(ctx.otherRaw, path, ctx.rootPath);
        /** 重新计算该路径的 diff 状态 */
        const newStatus = computeNodeDiffStatus(newSelfValue, otherValue, ctx.side);
        ctx.statusMap.value.set(path, newStatus);
        /** 如果是 modified 且两侧都是叶子，更新 otherValueMap（字符级 diff 用） */
        if (newStatus === "modified") {
          ctx.otherValueMap.value.set(path, otherValue);
        } else {
          ctx.otherValueMap.value.delete(path);
        }
        /** 重新收集 changedAncestors（只针对受影响路径的祖先链） */
        updateAncestorsForPath(ctx.statusMap.value, ctx.changedAncestors.value, path, ctx.rootPath);
        /** 触发响应式更新 */
        triggerRef(ctx.statusMap);
        triggerRef(ctx.otherValueMap);
        triggerRef(ctx.changedAncestors);
        /** 标记：随后 emit 冒泡导致的 props.raw watch 应跳过全量重算 */
        ctx.skipNextRawWatch = true;
      },
    };
    /** 对侧树引用变化时同步更新（B 侧编辑后 A 侧的 otherRaw 要跟上） */
    watch(
      () => props.diffRaw,
      (newDiffRaw) => {
        ctx.otherRaw = newDiffRaw;
        /** 对侧变了：全量重算 diff（因为无法知道对侧改了哪个路径） */
        const { statusMap, otherValueMap } = computeDiffMap(
          props.raw,
          newDiffRaw,
          ctx.side,
          ctx.rootPath,
        );
        ctx.statusMap.value = statusMap;
        ctx.otherValueMap.value = otherValueMap;
        ctx.changedAncestors.value = collectChangedAncestorPaths(statusMap, ctx.rootPath);
        triggerRef(ctx.statusMap);
        triggerRef(ctx.otherValueMap);
        triggerRef(ctx.changedAncestors);
      },
    );
    /** 本侧树引用变化时全量重算（文本框输入等非编辑场景） */
    watch(
      () => props.raw,
      (newRaw) => {
        /** 编辑链路已增量更新过，跳过一次全量重算（避免抵消增量） */
        if (ctx.skipNextRawWatch) {
          ctx.skipNextRawWatch = false;
          return;
        }
        const { statusMap, otherValueMap } = computeDiffMap(
          newRaw,
          ctx.otherRaw,
          ctx.side,
          ctx.rootPath,
        );
        ctx.statusMap.value = statusMap;
        ctx.otherValueMap.value = otherValueMap;
        ctx.changedAncestors.value = collectChangedAncestorPaths(statusMap, ctx.rootPath);
        triggerRef(ctx.statusMap);
        triggerRef(ctx.otherValueMap);
        triggerRef(ctx.changedAncestors);
      },
    );
    provide("oi-diff", ctx);
    return ctx;
  }
  return inject<DiffContext | null>("oi-diff", null);
})();

/** 当前节点的 diff 状态（无 diff 上下文时为 equal） */
const diffStatus = computed<DiffStatus>(() => {
  if (!diffCtx) return "equal";
  return diffCtx.statusMap.value.get(nodePathStr.value) ?? "equal";
});

/** 是否处于 diff 模式（决定行 class 是否生效） */
const isDiffMode = computed(() => diffCtx !== null);

/**
 * modified 叶子的字符级 diff 分段
 *
 * 仅当当前节点是 modified 且两侧都是字符串时计算。
 * old 侧渲染时只显示 equal+removed 段，new 侧只显示 equal+added 段。
 */
const diffCharSegments = computed<TextDiffSegment[] | null>(() => {
  if (!diffCtx || diffStatus.value !== "modified") return null;
  const other = diffCtx.otherValueMap.value.get(nodePathStr.value);
  /**
   * 本侧字符串值：raw 入口直接用 props.raw；value 入口从 SerializedValue 取。
   * （子节点递归时是 value 路径，props.raw 会是 undefined）
   */
  const self =
    props.raw !== undefined
      ? props.raw
      : node.value.type === "string"
        ? node.value.value
        : undefined;
  /** 只对字符串做字符级 diff（数字/boolean 直接整行标色即可） */
  if (typeof self !== "string" || typeof other !== "string") return null;
  /** diffText(oldText, newText)：old 侧传 (self, other)，new 侧传 (other, self) */
  return diffCtx.side === "old" ? diffText(self, other) : diffText(other, self);
});

/** 当前侧应该渲染的字符段（old=去掉 added 段，new=去掉 removed 段） */
const diffCharVisible = computed<TextDiffSegment[] | null>(() => {
  const segs = diffCharSegments.value;
  if (!segs) return null;
  const isOld = diffCtx?.side === "old";
  return segs.filter((s) => s.op === "equal" || (isOld ? s.op === "removed" : s.op === "added"));
});

/**
 * 子树内的差异条数（不含自身，折叠容器的「N 处差异」提示用）。
 * 遍历 statusMap 前缀匹配；仅在折叠且有差异时才在模板中访问，开销可控。
 */
const diffDescendantCount = computed(() => {
  if (!diffCtx) return 0;
  const selfPath = nodePathStr.value;
  const prefix = selfPath + ",";
  let n = 0;
  for (const [p, s] of diffCtx.statusMap.value) {
    if (s !== "equal" && p !== selfPath && p.startsWith(prefix)) n++;
  }
  return n;
});

/** 判断 path A 是否为 path B 的子孙（或自身） */
function isDescendantOrSelf(maybeChild: number[], ancestor: number[]): boolean {
  if (maybeChild.length < ancestor.length) return false;
  return ancestor.every((seg, i) => maybeChild[i] === seg);
}

/** 用户手动 toggle 的展开状态（优先级低于 expandOverride） */
const manualExpanded = ref(
  props.depth < 1 ||
    /** diff 模式下，变化路径的祖先节点默认展开 */
    (diffCtx?.changedAncestors.value.has(nodePathStr.value) ?? false),
);

/**
 * diff 模式下，watch changedAncestors 变化：
 * 当当前路径被加入 changedAncestors（增量更新或全量重算后）时自动展开。
 * 只自动展开，不自动折叠——折叠由用户手动控制。
 */
if (diffCtx) {
  watch(diffCtx.changedAncestors, (newSet) => {
    if (newSet.has(nodePathStr.value) && !manualExpanded.value) {
      manualExpanded.value = true;
    }
  });
}

/** 当前展开状态：expandOverride 覆盖 > 手动 toggle */
const expanded = computed({
  get: () => {
    const ov = expandOverride.value;
    if (ov && isDescendantOrSelf(nodePath.value, ov.targetPath)) {
      return ov.value;
    }
    return manualExpanded.value;
  },
  set: (v: boolean) => {
    manualExpanded.value = v;
  },
});

/**
 * 监听 override 变化，同步 manualExpanded
 *
 * 这样当 override 被清除后，manualExpanded 已记录了 override 设置的值，
 * 节点不会回退到旧状态。
 */
watch(
  expandOverride,
  (ov) => {
    if (ov && isDescendantOrSelf(nodePath.value, ov.targetPath) && hasChildren.value) {
      manualExpanded.value = ov.value;
    }
  },
  { deep: true },
);

/** 右键菜单状态（仅根实例持有） */
const menuVisible = ref(false);
const menuX = ref(0);
const menuY = ref(0);
/** 菜单操作目标的 path */
const menuTargetPath = ref<number[]>([]);
/** 菜单操作目标的 SerializedValue */
const menuTargetNode = ref<SerializedValue | null>(null);
/** 菜单目标是否有子节点 */
const menuTargetHasChildren = ref(false);
/** 复制成功提示 */
const copyToast = ref("");

/** 右键事件 */
function onContextMenu(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();

  const ctx: MenuContext = {
    path: nodePath.value,
    node: node.value,
    x: e.clientX,
    y: e.clientY,
    hasChildren: hasChildren.value,
  };

  if (isRoot) {
    onChildContextMenu(ctx);
  } else {
    /** 非根：冒泡给父级 */
    emit("context-menu", ctx);
  }
}

/** 子节点右键冒泡到根 */
function onChildContextMenu(ctx: MenuContext) {
  if (!isRoot) return;
  menuTargetPath.value = ctx.path;
  menuTargetNode.value = ctx.node;
  menuTargetHasChildren.value = ctx.hasChildren;
  /** 边界检测：靠近右/下边缘时偏移 */
  const menuW = 200,
    menuH = 160;
  menuX.value = ctx.x + menuW > window.innerWidth ? ctx.x - menuW : ctx.x;
  menuY.value = ctx.y + menuH > window.innerHeight ? ctx.y - menuH : ctx.y;
  menuVisible.value = true;
}

/** 从 SerializedValue 重建可 JSON 序列化的 JS 值 */
function serializedToJson(val: SerializedValue): unknown {
  switch (val.type) {
    case "string":
    case "number":
    case "boolean":
      return val.value ?? null;
    case "null":
      return null;
    case "undefined":
      return undefined;
    case "bigint":
      /** bigint 保留 n 后缀，复制后可直接粘贴到 JS 环境 */
      return val.value ? `${val.value}n` : "0n";
    case "array":
      return (val.elements ?? []).map(serializedToJson);
    case "object":
    case "map":
    case "set": {
      const props = val.properties ?? [];
      const obj: Record<string, unknown> = {};
      for (const p of props) {
        obj[p.key] = serializedToJson(p.value);
      }
      return obj;
    }
    case "date":
      return val.preview;
    case "regexp":
      return val.preview;
    case "function":
      /** 函数复制返回完整源码（value 字段存的是 toString() 结果） */
      return val.value ?? `[function ${val.preview}]`;
    case "symbol":
      /** Symbol 保留类型标记（Symbol("desc") 形式） */
      return val.preview;
    default:
      return val.preview;
  }
}

/** 执行菜单操作 */
async function copyJson() {
  if (!menuTargetNode.value) return;
  const jsonVal = serializedToJson(menuTargetNode.value);
  const text = JSON.stringify(jsonVal, null, 2);
  await doCopy(text);
}

async function copyValue() {
  if (!menuTargetNode.value) return;
  /** 函数类型：value 存的是完整源码，优先复制源码；其他类型复制 preview */
  const text =
    menuTargetNode.value.type === "function" && menuTargetNode.value.value
      ? String(menuTargetNode.value.value)
      : menuTargetNode.value.preview;
  await doCopy(text);
}

async function doCopy(text: string) {
  menuVisible.value = false;
  try {
    await navigator.clipboard.writeText(text);
    showToast("✓ 已复制");
  } catch {
    showToast("✗ 复制失败");
  }
}

function showToast(msg: string) {
  copyToast.value = msg;
  setTimeout(() => {
    copyToast.value = "";
  }, 1500);
}

/**
 * 展开/收起全部子节点
 *
 * 设置 expandOverride 信号：所有 targetPath 下的子孙节点的 expanded computed
 * 会读取 override 值。由于 override 是响应式 ref，新渲染的子节点（因父级展开
 * 而出现的）也会立即读到 override 值并自动展开——实现逐层自动展开效果。
 * 同时 watch override 会把 manualExpanded 同步过来，保证 override 清除后状态不回退。
 */
function expandAll() {
  menuVisible.value = false;
  if (!isRoot) return;
  expandOverride.value = {
    targetPath: menuTargetPath.value,
    value: true,
    version: (expandOverride.value?.version ?? 0) + 1,
  };
}

function collapseAll() {
  menuVisible.value = false;
  if (!isRoot) return;
  expandOverride.value = {
    targetPath: menuTargetPath.value,
    value: false,
    version: (expandOverride.value?.version ?? 0) + 1,
  };
}

function closeMenu() {
  menuVisible.value = false;
}

/* ==================== 编辑模式 ==================== */

/** 是否正在编辑（仅 editable 模式的叶子节点） */
const editing = ref(false);
/** 编辑草稿 */
const editDraft = ref("");
/** 编辑框 DOM 引用（失焦兜底用） */
const editInputRef = ref<HTMLInputElement | null>(null);

/** 当前叶子是否可编辑（只有 string/number/boolean/null 可编辑） */
const isEditableLeaf = computed(() => {
  if (!props.editable || hasChildren.value) return false;
  const t = node.value.type;
  return t === "string" || t === "number" || t === "boolean" || t === "null";
});

function startEdit() {
  if (!isEditableLeaf.value) return;
  editing.value = true;
  const v = node.value;
  if (v.type === "string") {
    editDraft.value = (v.value as string) ?? "";
  } else if (v.type === "null") {
    editDraft.value = "null";
  } else {
    editDraft.value = String(v.value ?? v.preview);
  }
}

function saveEdit() {
  if (!editing.value) return;
  editing.value = false;
  const raw = editDraft.value.trim();
  const t = node.value.type;
  let newValue: unknown = raw;

  if (t === "number") {
    newValue = Number(raw);
    if (isNaN(newValue as number)) return;
  } else if (t === "boolean") {
    if (raw === "true") newValue = true;
    else if (raw === "false") newValue = false;
    else return;
  } else if (t === "null") {
    if (raw !== "null") return;
    newValue = null;
  }
  /** diff 模式：增量更新当前路径的 diff 状态 */
  if (diffCtx) {
    diffCtx.updateDiffPath(nodePathStr.value, newValue);
  }
  emit("update:modelValue", newValue);
}

function cancelEdit() {
  editing.value = false;
}

/**
 * 编辑中点击组件外部时兜底失焦保存
 *
 * 浏览器原生 blur 只在焦点转移到另一个 focusable 元素时触发；
 * 点击 div/空白区域不会触发 blur，导致编辑框一直留着。
 * onClickOutside 内部用 pointerdown 捕获阶段监听，点击目标不在编辑框内时主动 saveEdit。
 */
onClickOutside(editInputRef, () => {
  if (editing.value) saveEdit();
});

/** 子节点编辑冒泡 */
function onChildUpdate(childKey: string, newChildValue: unknown) {
  /**
   * 从 SerializedValue 重建原始对象——但编辑模式只用于 raw/json 入口，
   * value 入口（SerializedValue）是只读的不会触发。
   */
  if (props.raw !== undefined) {
    if (Array.isArray(props.raw)) {
      const arr = [...props.raw];
      arr[Number(childKey)] = newChildValue;
      /** diff 模式：增量更新当前路径的 diff 状态 */
      if (diffCtx) {
        diffCtx.updateDiffPath(nodePathStr.value, arr);
      }
      emit("update:modelValue", arr);
    } else if (props.raw !== null && typeof props.raw === "object") {
      const obj = { ...(props.raw as Record<string, unknown>) };
      obj[childKey] = newChildValue;
      /** diff 模式：增量更新当前路径的 diff 状态 */
      if (diffCtx) {
        diffCtx.updateDiffPath(nodePathStr.value, obj);
      }
      emit("update:modelValue", obj);
    }
  } else if (props.json !== undefined) {
    try {
      const parsed = JSON.parse(props.json);
      if (Array.isArray(parsed)) {
        parsed[Number(childKey)] = newChildValue;
      } else if (parsed !== null && typeof parsed === "object") {
        parsed[childKey] = newChildValue;
      }
      emit("update:modelValue", JSON.stringify(parsed, null, 2));
    } catch {
      /* 忽略 */
    }
  } else {
    /**
     * value 入口（SerializedValue）的中间层节点：把自身序列化树重建为 JS 值，
     * 替换被编辑的子值后继续向上冒泡——否则编辑事件在中间层被吞掉，
     * 深度 ≥3 的编辑永远到不了根实例（这是之前「编辑不生效」的根因）。
     */
    const selfJs = serializedToJson(node.value);
    if (Array.isArray(selfJs)) {
      selfJs[Number(childKey)] = newChildValue;
    } else if (selfJs !== null && typeof selfJs === "object") {
      (selfJs as Record<string, unknown>)[childKey] = newChildValue;
    } else {
      return;
    }
    /** diff 模式：增量更新当前路径的 diff 状态 */
    if (diffCtx) {
      diffCtx.updateDiffPath(nodePathStr.value, selfJs);
    }
    emit("update:modelValue", selfJs);
  }
}

/* ==================== 类型配色 ==================== */

/** 类型 → CSS 变量（跟随亮/暗主题，亮色下饱和度更高更醒目） */
function typeColor(type: string): string {
  const colors: Record<string, string> = {
    string: "var(--cs-oi-string)",
    number: "var(--cs-oi-number)",
    boolean: "var(--cs-oi-boolean)",
    null: "var(--cs-oi-boolean)",
    undefined: "var(--cs-oi-boolean)",
    bigint: "var(--cs-oi-number)",
    function: "var(--cs-oi-function)",
    array: "var(--cs-oi-type)",
    object: "var(--cs-oi-type)",
    date: "var(--cs-oi-function)",
    regexp: "var(--cs-oi-regexp)",
    error: "var(--cs-oi-error)",
    symbol: "var(--cs-oi-regexp)",
    map: "var(--cs-oi-type)",
    set: "var(--cs-oi-type)",
    promise: "var(--cs-oi-type)",
    element: "var(--cs-oi-element)",
    event: "var(--cs-oi-element)",
  };
  return colors[type] || "var(--cs-oi-default)";
}

function typeBadge(type: string): string {
  const badges: Record<string, string> = {
    string: "str",
    number: "num",
    boolean: "bool",
    null: "null",
    undefined: "undef",
    bigint: "bigint",
    function: "fn",
    array: "arr",
    object: "obj",
    date: "date",
    regexp: "re",
    error: "err",
    map: "Map",
    set: "Set",
    weakmap: "WMap",
    weakset: "WSet",
    promise: "Promise",
    element: "el",
    textnode: "#text",
    event: "evt",
    symbol: "sym",
    unknown: "?",
  };
  return badges[type] || type;
}

/** 处理子组件冒泡上来的右键菜单事件 */
function handleChildContextMenu(ctx: MenuContext) {
  if (isRoot) {
    onChildContextMenu(ctx);
  } else {
    /** 非根：继续向上冒泡 */
    emit("context-menu", ctx);
  }
}
</script>

<template>
  <div class="oi-node">
    <!-- 行：箭头 + key + 值预览 -->
    <div
      class="oi-row"
      :class="{
        'oi-diff-added': isDiffMode && diffStatus === 'added',
        'oi-diff-removed': isDiffMode && diffStatus === 'removed',
        'oi-diff-modified': isDiffMode && diffStatus === 'modified',
        'oi-diff-children-changed': isDiffMode && diffStatus === 'children-changed',
      }"
      @click.stop="toggle"
      @contextmenu="onContextMenu"
    >
      <!-- 展开箭头 -->
      <span
        class="oi-arrow"
        :class="{ 'oi-expanded': expanded && hasChildren, 'oi-hidden': !hasChildren }"
      >
        ▶
      </span>

      <!-- key 名（子节点才有） -->
      <span v-if="keyName" class="oi-key">{{ keyName }}:</span>

      <!-- 叶子节点值 -->
      <span v-if="!hasChildren" class="oi-leaf">
        <!-- 编辑模式 -->
        <input
          v-if="editing"
          ref="editInputRef"
          v-model="editDraft"
          @keydown.enter.stop.prevent="saveEdit"
          @keydown.esc.stop.prevent="cancelEdit"
          @blur="saveEdit"
          @click.stop
          class="oi-edit-input"
        />
        <!-- diff 模式 modified 叶子：字符级高亮 -->
        <span
          v-else-if="diffCharVisible"
          class="oi-value"
          :class="{ 'oi-clickable': isEditableLeaf }"
          :style="{ color: typeColor(node.type) }"
          @click.stop="startEdit"
          ><template v-for="(seg, si) in diffCharVisible" :key="si"
            ><span
              v-if="seg.op !== 'equal'"
              :class="seg.op === 'removed' ? 'oi-diff-char-removed' : 'oi-diff-char-added'"
              >{{ seg.text }}</span
            ><template v-else>{{ seg.text }}</template></template
          ></span
        >
        <!-- 只读/查看模式：字符串显示完整 value（不截断），其他类型用 preview -->
        <span
          v-else
          class="oi-value"
          :class="{ 'oi-clickable': isEditableLeaf }"
          :style="{ color: typeColor(node.type) }"
          @click.stop="startEdit"
          >{{ node.type === "string" ? (node.value ?? node.preview) : node.preview }}</span
        >
      </span>

      <!-- 容器节点摘要 -->
      <span v-else class="oi-summary">
        <span class="oi-badge" :style="{ color: typeColor(node.type) }">
          {{ typeBadge(node.type) }}
        </span>
        <!-- 展开时完整 preview 冗余（子节点已列出），只显示数量提示 -->
        <span v-if="expanded" class="oi-collapsed-hint">
          ({{
            node.type === "function"
              ? (node.value || "").split("\n").length + " lines"
              : children.length + (node.type === "array" ? " items" : " props")
          }})
        </span>
        <template v-else>
          <span :style="{ color: typeColor(node.type) }">{{ node.preview }}</span>
          <!-- 折叠容器看不到内部，用差异数提示里面有没有变化 -->
          <span v-if="isDiffMode && diffDescendantCount > 0" class="oi-diff-count-hint"
            >({{ diffDescendantCount }} 处差异)</span
          >
          <span v-if="node.type === 'function'" class="oi-collapsed-hint">
            ({{ (node.value || "").split("\n").length }} lines)
          </span>
          <span v-else-if="node.type !== 'array'" class="oi-collapsed-hint">
            ({{ children.length }} props)
          </span>
        </template>
      </span>
    </div>

    <!-- 子节点（展开时） -->
    <div v-if="expanded && hasChildren" class="oi-children">
      <!-- 函数类型：展开显示源码 -->
      <template v-if="node.type === 'function' && node.value">
        <pre class="oi-fn-src">{{ node.value }}</pre>
      </template>
      <!-- 普通对象/数组：递归子节点（分批渲染：每批 50 条，点「更多」加载下一批） -->
      <template v-else>
        <ObjectInspector
          v-for="(child, idx) in children.slice(0, visibleCount)"
          :key="idx"
          :value="child.value"
          :key-name="child.key"
          :depth="depth + 1"
          :child-index="idx"
          :editable="editable"
          @update:model-value="onChildUpdate(child.key, $event)"
          @context-menu="handleChildContextMenu"
        />
        <div v-if="children.length > visibleCount" class="oi-more">
          … 还有 {{ children.length - visibleCount }} 条
          <button class="oi-more-btn" @click.stop="visibleCount += 50">+50</button>
          <button class="oi-more-btn" @click.stop="visibleCount = children.length">全部</button>
        </div>
        <!-- 原型链继承属性分组：折叠进单个 [[Prototype]] 节点 -->
        <div v-if="protoChildren.length > 0" class="oi-proto">
          <div class="oi-row" @click.stop="protoExpanded = !protoExpanded">
            <span class="oi-arrow" :class="{ 'oi-expanded': protoExpanded }">▶</span>
            <span class="oi-key">[[Prototype]]:</span>
            <span class="oi-collapsed-hint">({{ protoChildren.length }} inherited)</span>
          </div>
          <div v-if="protoExpanded" class="oi-children">
            <ObjectInspector
              v-for="(child, idx) in protoChildren.slice(0, visibleCount)"
              :key="'p' + idx"
              :value="child.value"
              :key-name="child.key"
              :depth="depth + 1"
              :child-index="idx"
              :editable="false"
              @context-menu="handleChildContextMenu"
            />
            <div v-if="protoChildren.length > visibleCount" class="oi-more">
              … 还有 {{ protoChildren.length - visibleCount }} 条
              <button class="oi-more-btn" @click.stop="visibleCount += 50">+50</button>
              <button class="oi-more-btn" @click.stop="visibleCount = protoChildren.length">
                全部
              </button>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 右键上下文菜单（仅根实例渲染） -->
    <Teleport to="body">
      <div
        v-if="isRoot && menuVisible"
        class="oi-context-menu"
        :style="{ left: menuX + 'px', top: menuY + 'px' }"
        @click.stop
        @contextmenu.prevent.stop
      >
        <button v-if="menuTargetHasChildren" class="oi-menu-item" @click="expandAll">
          <span class="oi-menu-icon">▾</span> 展开全部子节点
        </button>
        <button v-if="menuTargetHasChildren" class="oi-menu-item" @click="collapseAll">
          <span class="oi-menu-icon">▸</span> 收起全部子节点
        </button>
        <div v-if="menuTargetHasChildren" class="oi-menu-sep"></div>
        <button class="oi-menu-item" @click="copyJson">
          <span class="oi-menu-icon">📋</span> 复制 JSON
        </button>
        <button class="oi-menu-item" @click="copyValue">
          <span class="oi-menu-icon">📄</span> 复制值
        </button>
      </div>
      <!-- 遮罩层：点击关闭菜单 -->
      <div
        v-if="isRoot && menuVisible"
        class="oi-menu-overlay"
        @click="closeMenu"
        @contextmenu.prevent.stop="closeMenu"
      ></div>
      <!-- 复制提示 toast -->
      <div v-if="isRoot && copyToast" class="oi-copy-toast">
        {{ copyToast }}
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.oi-node {
  font-family: "SF Mono", "Monaco", "Cascadia Code", "Menlo", monospace;
  font-size: 12px;
  line-height: 1.6;
  user-select: text;
}

.oi-row {
  display: flex;
  align-items: baseline;
  gap: 4px;
  cursor: default;
  white-space: nowrap;
  padding: 0 2px;
  border-radius: 3px;
}

.oi-row:hover {
  background: var(--cs-oi-row-hover);
}

/* ════ Diff 模式行高亮 ════ */
.oi-row.oi-diff-added {
  background: rgba(34, 197, 94, 0.12);
  border-left: 2px solid rgba(34, 197, 94, 0.6);
}
.oi-row.oi-diff-removed {
  background: rgba(239, 68, 68, 0.1);
  border-left: 2px solid rgba(239, 68, 68, 0.6);
}
.oi-row.oi-diff-modified {
  background: rgba(234, 179, 8, 0.12);
  border-left: 2px solid rgba(234, 179, 8, 0.6);
}
.oi-row.oi-diff-children-changed {
  background: rgba(148, 163, 184, 0.12);
  border-left: 2px solid rgba(148, 163, 184, 0.5);
}
/* 折叠容器的「N 处差异」提示：用 modified 同款黄色，醒目但不刺眼 */
.oi-diff-count-hint {
  color: #eab308;
  font-size: 11px;
  font-weight: 500;
}
/* 字符级 diff：变化的字符段加浓底色 */
.oi-diff-char-removed {
  background: rgba(239, 68, 68, 0.35);
  border-radius: 2px;
}
.oi-diff-char-added {
  background: rgba(34, 197, 94, 0.35);
  border-radius: 2px;
}

.oi-arrow {
  display: inline-block;
  width: 12px;
  font-size: 9px;
  color: var(--cs-oi-arrow);
  transition: transform 0.1s;
  flex-shrink: 0;
  cursor: pointer;
}

.oi-arrow.oi-expanded {
  transform: rotate(90deg);
}

.oi-arrow.oi-hidden {
  visibility: hidden;
}

.oi-key {
  color: var(--cs-oi-key);
  flex-shrink: 0;
}

.oi-leaf {
  word-break: break-all;
  white-space: pre-wrap;
  min-width: 0;
}

.oi-value {
  word-break: break-all;
  white-space: pre-wrap;
}

.oi-clickable {
  cursor: pointer;
  border-radius: 2px;
}

.oi-clickable:hover {
  background: var(--cs-oi-edit-hover);
}

.oi-edit-input {
  font-family: inherit;
  font-size: inherit;
  padding: 0 2px;
  border: 1px solid var(--cs-oi-edit-border);
  border-radius: 2px;
  background: var(--cs-oi-edit-bg);
  color: inherit;
  outline: none;
  width: 160px;
}

.oi-summary {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.oi-badge {
  font-size: 10px;
  padding: 0 2px;
  border: 1px solid currentColor;
  border-radius: 2px;
  flex-shrink: 0;
}

.oi-collapsed-hint {
  color: var(--cs-oi-hint);
  font-size: 11px;
}

.oi-children {
  margin-left: 16px;
  border-left: 1px solid var(--cs-oi-children-border);
  padding-left: 4px;
}

.oi-more {
  color: var(--cs-oi-hint);
  font-style: italic;
  padding-left: 16px;
  font-size: 11px;
}

/** 「加载更多」按钮 */
.oi-more-btn {
  cursor: pointer;
  border: 1px solid var(--cs-oi-hint);
  border-radius: 3px;
  padding: 0 6px;
  margin-left: 6px;
  font-size: 10px;
  font-style: normal;
  color: var(--cs-oi-hint);
  background: transparent;
  line-height: 1.4;
}

.oi-more-btn:hover {
  color: var(--cs-oi-string);
  border-color: var(--cs-oi-string);
}

/** [[Prototype]] 分组容器（与自有属性间留呼吸感） */
.oi-proto {
  margin-top: 2px;
}

/** 函数展开时显示的源码块 */
.oi-fn-src {
  font-family: inherit;
  font-size: 11px;
  color: var(--cs-oi-function);
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  padding: 2px 0 2px 16px;
  line-height: 1.5;
}
</style>

<!-- 右键菜单样式（非 scoped，因为 Teleport 到 body） -->
<style>
.oi-context-menu {
  position: fixed;
  z-index: 100000;
  min-width: 180px;
  background: var(--cs-elevated, #252526);
  border: 1px solid var(--cs-border, #454545);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  padding: 4px 0;
  font-family: -apple-system, "Segoe UI", sans-serif;
  font-size: 13px;
  user-select: none;
}

.oi-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 14px;
  background: none;
  border: none;
  color: var(--cs-text, #cccccc);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s;
}

.oi-menu-item:hover {
  background: #04395e;
  color: #ffffff;
}

.oi-menu-icon {
  display: inline-block;
  width: 18px;
  text-align: center;
  font-size: 12px;
  opacity: 0.8;
}

.oi-menu-sep {
  height: 1px;
  background: var(--cs-border, #454545);
  margin: 4px 0;
}

.oi-menu-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 99999;
}

.oi-copy-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100001;
  background: #2d4f2d;
  color: #b5cea8;
  padding: 8px 20px;
  border-radius: 6px;
  font-size: 13px;
  font-family: -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  animation: oi-toast-in 0.2s ease;
}

@keyframes oi-toast-in {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}
</style>
