/**
 * 特性检测项类型定义
 *
 * 每个检测项是一条独立的 JS 表达式，在目标设备浏览器里执行，
 * 返回 true（支持）/ false（不支持）/ string（版本号等详细信息）。
 */
export interface FeatureCheck {
  /** 检测项 ID（唯一标识，如 'css.grid'） */
  id: string
  /** 显示名称（如 'CSS Grid'） */
  label: string
  /**
   * 检测表达式（字符串形式的 JS 代码）
   *
   * 约定：求值后转 Boolean/JSON.stringify 即可得到结果。
   * 使用 try-catch 包裹执行，抛异常视为不支持。
   */
  test: string
}

/**
 * 检测结果（单项）
 *
 * value 类型：
 * - true：支持
 * - false：不支持
 * - string：详细信息（如 '1.2.3' / 'partial'）
 */
export interface FeatureResult {
  /** 检测项 ID */
  id: string
  /** 显示名称 */
  label: string
  /** 分类 */
  category: FeatureCategory
  /** 检测结果 */
  value: boolean | string
}

/** 检测项分类 */
export type FeatureCategory = 'css' | 'js-api' | 'network' | 'media' | 'storage' | 'device'

/** 按分类组织的检测结果报告 */
export interface FeatureReport {
  /** 设备 ID */
  deviceId: string
  /** 检测时间戳 */
  timestamp: string
  /** 按分类组织的检测结果 */
  categories: Array<{
    category: FeatureCategory
    label: string
    results: FeatureResult[]
  }>
}

/** 分类显示名 */
export const CATEGORY_LABELS: Record<FeatureCategory, string> = {
  css: 'CSS 特性',
  'js-api': 'JS API',
  network: '网络能力',
  media: '媒体能力',
  storage: '存储能力',
  device: '设备信息',
}
