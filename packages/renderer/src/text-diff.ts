/**
 * 字符级文本 diff 引擎
 *
 * 基于 grapheme cluster（用户感知字符）而非 UTF-16 code unit，
 * 正确处理 emoji、组合字符、国旗等复杂 Unicode 序列。
 *
 * 算法：经典 LCS（最长公共子序列）动态规划 → 回溯出 equal/added/removed 段。
 * 文本量小（快照元素 text 通常 < 500 字符），O(n×m) 完全可接受。
 */

/**
 * grapheme cluster 分割器（单例复用）
 *
 * Intl.Segmenter 以 grapheme 粒度分割，一个 "用户感知字符" 作为一个 segment。
 * 正确处理：
 * - 代理对：👋（U+1F44B）= 2 个 code unit，但 1 个 grapheme
 * - ZWJ 序列：👨‍👩‍👧‍👦 = 7 个 code unit + 4 个 ZWJ，但 1 个 grapheme
 * - 国旗：🇨🇳 = 2 个 regional indicator，但 1 个 grapheme
 * - 变体选择器：❤️ = ❤ + VS16，1 个 grapheme
 * - 组合附标：é = e + combining accent（部分形式），1 个 grapheme
 */
const segmenter = new Intl.Segmenter();

/**
 * 将字符串分割为 grapheme cluster 数组
 *
 * @param str 原始字符串
 * @returns grapheme 数组（每个元素是一个用户感知字符）
 *
 * @example
 * splitGraphemes('hi 👋')  // → ['h', 'i', ' ', '👋']
 * splitGraphemes('👨‍👩‍👧‍👦')  // → ['👨‍👩‍👧‍👦']（1 个 grapheme，而非 11 个 code unit）
 */
export function splitGraphemes(str: string): string[] {
  if (!str) return [];
  const result: string[] = [];
  for (const seg of segmenter.segment(str)) {
    result.push(seg.segment);
  }
  return result;
}

/** 单个 diff 段的类型 */
export type TextDiffOp = "equal" | "added" | "removed";

/** 文本 diff 的一段（连续的 equal / added / removed 片段） */
export interface TextDiffSegment {
  /** 段类型：equal=不变，added=新增，removed=删除 */
  op: TextDiffOp;
  /** 段文本内容 */
  text: string;
}

/**
 * 通用 LCS diff 引擎（内部核心）
 *
 * 接受任意字符串数组作为最小比较单位，输出 diff 段。
 * 行级 diff 传 `splitLines(text)`，字符级 diff 传 `splitGraphemes(text)`。
 *
 * @param oldSegs 旧文本的单位数组
 * @param newSegs 新文本的单位数组
 * @returns diff 段数组（相邻同类型已合并）
 */
function lcsDiff(oldSegs: string[], newSegs: string[]): TextDiffSegment[] {
  const n = oldSegs.length;
  const m = newSegs.length;

  /** 两方都空 → 无段 */
  if (n === 0 && m === 0) return [];
  /** 某一方为空 → 整体增/删 */
  if (n === 0) return [{ op: "added", text: newSegs.join("") }];
  if (m === 0) return [{ op: "removed", text: oldSegs.join("") }];
  /** 完全相同 → 整体 equal（快速路径，避免 dp 表分配） */
  if (oldSegs.join("") === newSegs.join("")) {
    return [{ op: "equal", text: oldSegs.join("") }];
  }

  /**
   * LCS 动态规划表
   *
   * dp[i][j] = oldSegs[0..i-1] 与 newSegs[0..j-1] 的 LCS 长度。
   * 用 Uint32Array 降内存（行列各 +1）。
   */
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) {
    dp.push(new Uint32Array(m + 1));
  }

  /** 填表 */
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldSegs[i - 1] === newSegs[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  /**
   * 回溯：从 dp[n][m] 出发，逆推 diff 段
   *
   * - oldSegs[i-1] === newSegs[j-1] → equal，i-- j--
   * - dp[i-1][j] >= dp[i][j-1] → oldSegs[i-1] 是 removed，i--
   * - 否则 → newSegs[j-1] 是 added，j--
   */
  const rawSegments: TextDiffSegment[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldSegs[i - 1] === newSegs[j - 1]) {
      rawSegments.push({ op: "equal", text: oldSegs[i - 1] });
      i--;
      j--;
    } else if (i > 0 && (j === 0 || dp[i - 1][j] >= dp[i][j - 1])) {
      rawSegments.push({ op: "removed", text: oldSegs[i - 1] });
      i--;
    } else {
      rawSegments.push({ op: "added", text: newSegs[j - 1] });
      j--;
    }
  }

  /** 回溯产生的是逆序段，翻转回来 */
  rawSegments.reverse();

  /** 合并相邻同类型段 */
  const segments: TextDiffSegment[] = [];
  for (const seg of rawSegments) {
    const last = segments[segments.length - 1];
    if (last && last.op === seg.op) {
      last.text += seg.text;
    } else {
      segments.push({ ...seg });
    }
  }

  /**
   * 重排：在每个 equal 边界之间的「变更块」内，确保 removed 排在 added 前。
   *
   * LCS 回溯从右下角往左上角走，连续的纯插入行会先被消耗（j--），
   * 导致 added 段出现在 removed 段前面。标准 diff（git/VS Code）习惯
   * 先显示删除再显示新增，这里对每个变更块内做 stable 排序来纠正顺序。
   */
  const result: TextDiffSegment[] = [];
  let buf: TextDiffSegment[] = [];
  for (const seg of segments) {
    if (seg.op === "equal") {
      if (buf.length > 0) {
        buf.sort((a, b) => (a.op === "removed" ? -1 : b.op === "removed" ? 1 : 0));
        result.push(...buf);
        buf = [];
      }
      result.push(seg);
    } else {
      buf.push(seg);
    }
  }
  if (buf.length > 0) {
    buf.sort((a, b) => (a.op === "removed" ? -1 : b.op === "removed" ? 1 : 0));
    result.push(...buf);
  }

  return result;
}

/**
 * 计算两段文本的字符级 diff
 *
 * 使用 LCS 动态规划找到最长公共子序列，然后回溯生成 equal/added/removed 段序列。
 * 相邻的同类型段会自动合并。
 *
 * @param oldText 旧文本
 * @param newText 新文本
 * @returns diff 段数组（按顺序排列，消费方据此高亮渲染）
 *
 * @example
 * diffText('hello', 'hallo')
 * // → [{ op: 'equal', text: 'h' }, { op: 'removed', text: 'e' }, { op: 'added', text: 'a' }, { op: 'equal', text: 'llo' }]
 *
 * diffText('Hi 👋', 'Hi 👋👋')
 * // → [{ op: 'equal', text: 'Hi 👋' }, { op: 'added', text: '👋' }]
 */
export function diffText(oldText: string, newText: string): TextDiffSegment[] {
  /** 两段文本完全相同 → 不需要 diff */
  if (oldText === newText) {
    return oldText ? [{ op: "equal", text: oldText }] : [];
  }

  /**
   * 分割成 grapheme 数组，确保 emoji 等复杂字符不被拆碎。
   * 后续 LCS 以 grapheme 为最小单位操作。
   */
  return lcsDiff(splitGraphemes(oldText), splitGraphemes(newText));
}

/**
 * 行级文本 diff —— 以行为最小单位做 LCS，正确处理行的增删移位
 *
 * 与 diffText 的区别：diffText 以 grapheme（字符）为单位，
 * diffLines 以整行为单位，适合多行文本/JSON 的结构化对比。
 *
 * @param oldText 旧文本
 * @param newText 新文本
 * @returns diff 段数组（每段的 text 是一整行含换行符）
 *
 * @example
 * diffLines('a\nb\nc', 'a\nc')
 * // → [equal: 'a\n', removed: 'b\n', equal: 'c']
 */
export function diffLines(oldText: string, newText: string): TextDiffSegment[] {
  if (oldText === newText) {
    return oldText ? [{ op: "equal", text: oldText }] : [];
  }
  return lcsDiff(splitLines(oldText), splitLines(newText));
}

/**
 * 将文本按行分割（保留行尾换行符，与 split() 不同）
 *
 * 用 lookahead split 保证换行符附在行尾而非行首，
 * 重建时 join('') 即可还原原文。
 *
 * @example
 * splitLines('a\nb')  // → ['a\n', 'b']
 * splitLines('a\nb\n') // → ['a\n', 'b\n']
 */
export function splitLines(text: string): string[] {
  if (!text) return [];
  /** 用正则把每行（含换行符）作为一个元素 */
  const lines = text.match(/[^\n]*\n?/g);
  if (!lines) return [text];
  /** match 末尾会多出一个空字符串，去掉 */
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 将 diff 段序列化为紧凑的标记文本（供 AI / 纯文本场景消费）
 *
 * 格式：用 [-old-]{+new+} 标记变化部分，未变化的原样输出。
 *
 * @example
 * formatTextDiff(diffText('hello', 'hallo'))
 * // → 'h[-e-]{+a+}llo'
 */
export function formatTextDiff(segments: TextDiffSegment[]): string {
  return segments
    .map((seg) => {
      switch (seg.op) {
        case "equal":
          return seg.text;
        case "added":
          return `{+${seg.text}+}`;
        case "removed":
          return `[-${seg.text}-]`;
      }
    })
    .join("");
}
