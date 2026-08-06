import { FEATURE_CHECKS } from './checks.js'
import type { FeatureResult, FeatureCategory, FeatureReport } from './types.js'
import { CATEGORY_LABELS } from './types.js'

/**
 * 生成特性检测 exec 脚本
 *
 * 生成的代码是一个 IIFE 字符串，通过 exec-bridge 在目标设备浏览器里执行。
 * 逐条 try-catch 执行所有检测项，收集结果后 JSON.stringify 返回。
 *
 * 设计要点：
 * - 检测项清单内联到脚本里（不依赖目标页面有任何模块系统）
 * - 每条 test 用 new Function 隔离执行（避免检测项之间污染全局）
 * - 抛异常/语法错误统一视为不支持（value: false）
 */
export function generateFeatureDetectScript(): string {
  return `return (function(){
  var checks = ${JSON.stringify(
    FEATURE_CHECKS.map((c) => ({ id: c.id, label: c.label, category: c.category, test: c.test, mdn: c.mdn ?? '', desc: c.desc ?? '' })),
  )};
  var results = [];
  for (var i = 0; i < checks.length; i++) {
    var c = checks[i];
    var value = false;
    try {
      var fn = new Function('return (' + c.test + ')');
      value = fn();
      if (value === undefined) value = false;
    } catch(e) {
      value = false;
    }
    results.push({ id: c.id, label: c.label, category: c.category, value: value, mdn: c.mdn ? 'https://developer.mozilla.org/zh-CN/docs/' + c.mdn : '', desc: c.desc });
  }
  return results;
})()`
}

/**
 * 解析 exec 回传的检测结果字符串，按分类组织成 FeatureReport
 *
 * exec 的 result 是序列化后的 JSON 字符串，这里 parse 后按 category 分组。
 */
export function parseFeatureResults(deviceId: string, rawJson: string): FeatureReport['categories'] {
  const results: FeatureResult[] = JSON.parse(rawJson)

  /** 按 category 分组 */
  const grouped = new Map<FeatureCategory, FeatureResult[]>()
  for (const r of results) {
    const arr = grouped.get(r.category) ?? []
    arr.push(r)
    grouped.set(r.category, arr)
  }

  /** 按 FEATURE_CHECKS 定义顺序输出分类 */
  const categoryOrder: FeatureCategory[] = [...new Set(FEATURE_CHECKS.map((c) => c.category))]
  return categoryOrder
    .filter((cat) => grouped.has(cat))
    .map((cat) => ({
      category: cat,
      label: CATEGORY_LABELS[cat],
      results: grouped.get(cat)!,
    }))
}
