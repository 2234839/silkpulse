/**
 * 增量渲染引擎 —— 快照 diff + 预览计算
 *
 * 设计理念：
 * - **纯函数 + 框架无关**：styles/diff/preview 全部是纯 TS，不依赖 Vue/React
 * - **增量 diff**：对比新旧快照，输出 added/updated/removed 补丁集，
 *   控制台只重渲染变化的元素，而非整棵树
 * - **截图叠加**：支持 getDisplayMedia 截图作为底图 + DOM 框叠加交互层
 */

export { elementStyle, elementColor, isContainer, elementLabel, canShowLabel } from './styles.js'
export { diffSnapshots, type SnapshotDiff, type ElementPatch } from './diff.js'
export { computeScale, filterRectElements, computeCanvasSize, type PreviewLayout } from './preview.js'
export { SCREENSHOT_QUALITY, compressScreenshot, type ScreenshotData } from './screenshot.js'
export { FrameCompositor } from './compositor.js'
