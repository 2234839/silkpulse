/**
 * 精简的 source map consumer —— 无依赖实现
 *
 * 仅实现 originalPositionFor（生成位置 → 原始位置），用于解析压缩代码错误堆栈。
 * 算法遵循 Source Map v3 规范：https://sourcemaps.info/spec.html
 *
 * mappings 字符串结构：
 * - 分号 ';' 分隔生成文件的行
 * - 逗号 ',' 分隔一行内的 segment
 * - 每个 segment 是 1/4/5 个 VLQ 编码的字段：
 *     [genCol, source, origLine, origCol, name]
 * - 除 genCol 在每行开头重置为 0 外，其余字段都是相对前值的增量（跨行持续累加）
 */

/** Source Map v3 的 base64 字符表 */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_MAP = new Map<string, number>();
for (let i = 0; i < B64.length; i++) B64_MAP.set(B64[i], i);

/**
 * 解码一个 VLQ 值，从 str 的 pos 开始
 * 返回 [value, nextPos]
 * 每个 base64 字符 6 bit：最高位 continuation，次高位 sign，低 4 位数据（首个字符）/ 全 6 位数据（续字符，但首位贡献 5 位因 sign 占 1）
 */
function decodeVlq(str: string, pos: number): [number, number] {
  let shift = 0;
  let result = 0;
  let cont = 1;
  while (cont !== 0) {
    const code = B64_MAP.get(str[pos]);
    if (code === undefined) throw new Error(`无效 base64 字符: ${str[pos]}`);
    pos++;
    /** 低 5 位是数据（首个字符含 sign） */
    cont = code & 0x20;
    let digit = code & 0x1f;
    result += digit << shift;
    shift += 5;
  }
  /** 最低位是符号位 */
  const sign = result & 1;
  result >>= 1;
  return [sign ? -result : result, pos];
}

/** 单个 segment：生成位置 + 原始位置（若有） */
interface Segment {
  /** 生成文件列号（0-based） */
  genCol: number;
  /** source 数组索引 */
  source: number;
  /** 原始行号（0-based） */
  origLine: number;
  /** 原始列号（0-based） */
  origCol: number;
  /** names 数组索引（-1 表示无） */
  name: number;
}

/**
 * 解析后的 source map
 */
export interface SourceMapData {
  /** 源文件列表 */
  sources: string[];
  /** 符号名列表 */
  names: string[];
  /** 每行的 segment 数组（已排序，按 genCol 升序） */
  lines: Segment[][];
}

/**
 * 解析 source map JSON 为内部结构
 * 只解析 mappings，sources/names 原样保留
 */
export function parseSourceMap(raw: {
  sources?: string[];
  names?: string[];
  mappings?: string;
}): SourceMapData {
  const sources = raw.sources ?? [];
  const names = raw.names ?? [];
  const mappings = raw.mappings ?? "";
  const lines: Segment[][] = [];

  /** 跨 segment / 跨行累加的增量基准 */
  let prevSource = 0;
  let prevOrigLine = 0;
  let prevOrigCol = 0;
  let prevName = 0;

  const rows = mappings.split(";");
  for (const row of rows) {
    const segments: Segment[] = [];
    if (row.length > 0) {
      /** 每行 genCol 从 0 开始 */
      let prevGenCol = 0;
      const fields = row.split(",");
      for (const field of fields) {
        if (field.length === 0) continue;
        let pos = 0;
        const [genColDelta, p1] = decodeVlq(field, pos);
        pos = p1;
        prevGenCol += genColDelta;
        const seg: Segment = {
          genCol: prevGenCol,
          source: 0,
          origLine: 0,
          origCol: 0,
          name: -1,
        };
        /** 字段 2-5 可选（1 字段 segment 只有 genCol，用于无 mapping 的生成位置） */
        if (pos < field.length) {
          const [srcDelta, p2] = decodeVlq(field, pos);
          pos = p2;
          const [lineDelta, p3] = decodeVlq(field, pos);
          pos = p3;
          const [colDelta, p4] = decodeVlq(field, pos);
          pos = p4;
          prevSource += srcDelta;
          prevOrigLine += lineDelta;
          prevOrigCol += colDelta;
          seg.source = prevSource;
          seg.origLine = prevOrigLine;
          seg.origCol = prevOrigCol;
          if (pos < field.length) {
            const [nameDelta, p5] = decodeVlq(field, pos);
            pos = p5;
            prevName += nameDelta;
            seg.name = prevName;
          }
        }
        segments.push(seg);
      }
    }
    lines.push(segments);
  }

  return { sources, names, lines };
}

/**
 * 给定生成位置（1-based line, 0-based col），查找原始位置
 * 返回最近的（genCol <= 查找列）segment 的原始位置
 */
export function originalPositionFor(
  map: SourceMapData,
  /** 1-based 行号（堆栈里的行号） */
  line: number,
  /** 0-based 列号（堆栈里的列号） */
  column: number,
): { source: string; line: number; column: number; name?: string } | null {
  /** 转为 0-based 行索引 */
  const rowIndex = line - 1;
  if (rowIndex < 0 || rowIndex >= map.lines.length) return null;
  const segments = map.lines[rowIndex];
  if (segments.length === 0) return null;

  /** 二分查找：最后一个 genCol <= column 的 segment */
  let lo = 0;
  let hi = segments.length - 1;
  /** 无匹配时返回 null（查找列在所有 segment 之前） */
  let found: Segment | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].genCol <= column) {
      found = segments[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (!found) return null;

  return {
    source: map.sources[found.source] ?? `<unknown:${found.source}>`,
    /** 原始行号转回 1-based */
    line: found.origLine + 1,
    column: found.origCol,
    name: found.name >= 0 ? map.names[found.name] : undefined,
  };
}
