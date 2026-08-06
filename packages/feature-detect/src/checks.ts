import type { FeatureCheck, FeatureCategory } from './types.js'

/**
 * 特性检测项清单
 *
 * 每项 test 是一个 JS 表达式字符串，在目标设备 IIFE 内 try-catch 执行。
 * 求值结果 JSON.stringify 后回传。
 *
 * 分类按诊断场景组织：
 * - css：布局/视觉效果能力（排障"为什么布局坏了"）
 * - js-api：核心 JS API（排障"为什么 API 调用报错"）
 * - network：网络相关能力（排障"为什么请求失败/连不上"）
 * - media：音视频能力（排障"为什么播放不了"）
 * - storage：持久化能力（排障"为什么数据丢了"）
 * - device：设备基础信息（屏幕/触摸/语言等环境诊断）
 */
export const FEATURE_CHECKS: Array<FeatureCheck & { category: FeatureCategory }> = [
  // ────────────────── CSS ──────────────────
  {
    id: 'css.grid',
    label: 'CSS Grid',
    category: 'css',
    test: `CSS.supports('display', 'grid')`,
  },
  {
    id: 'css.flexbox',
    label: 'Flexbox',
    category: 'css',
    test: `CSS.supports('display', 'flex')`,
  },
  {
    id: 'css.subgrid',
    label: 'CSS Subgrid',
    category: 'css',
    test: `CSS.supports('grid-template-columns', 'subgrid')`,
  },
  {
    id: 'css.sticky',
    label: 'position: sticky',
    category: 'css',
    test: `CSS.supports('position', 'sticky')`,
  },
  {
    id: 'css.gap',
    label: 'CSS gap（flex）',
    category: 'css',
    test: `CSS.supports('gap', '1px')`,
  },
  {
    id: 'css.aspect-ratio',
    label: 'aspect-ratio',
    category: 'css',
    test: `CSS.supports('aspect-ratio', '16 / 9')`,
  },
  {
    id: 'css.container-queries',
    label: 'Container Queries',
    category: 'css',
    test: `CSS.supports('container-type', 'inline-size')`,
  },
  {
    id: 'css.backdrop-filter',
    label: 'backdrop-filter',
    category: 'css',
    test: `CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)')`,
  },
  {
    id: 'css.oklch',
    label: 'oklch() 颜色',
    category: 'css',
    test: `CSS.supports('color', 'oklch(0.5 0.1 180)')`,
  },
  {
    id: 'css.color-mix',
    label: 'color-mix()',
    category: 'css',
    test: `CSS.supports('color', 'color-mix(in srgb, red, blue)')`,
  },
  {
    id: 'css.scroll-driven',
    label: 'Scroll-Driven Animations',
    category: 'css',
    test: `'animate' in document && CSS.supports('animation-timeline', 'scroll()')`,
  },

  // ────────────────── JS API ──────────────────
  {
    id: 'js.optional-chaining',
    label: 'Optional Chaining (?.)',
    category: 'js-api',
    test: `(function(){ try { eval('({})?.a') } catch(e) { return false } return true })()`,
  },
  {
    id: 'js.nullish-coalescing',
    label: 'Nullish Coalescing (??)',
    category: 'js-api',
    test: `(function(){ try { eval('null ?? 1') } catch(e) { return false } return true })()`,
  },
  {
    id: 'js.structured-clone',
    label: 'structuredClone()',
    category: 'js-api',
    test: `typeof structuredClone === 'function'`,
  },
  {
    id: 'js.intersection-observer',
    label: 'IntersectionObserver',
    category: 'js-api',
    test: `'IntersectionObserver' in window`,
  },
  {
    id: 'js.mutation-observer',
    label: 'MutationObserver',
    category: 'js-api',
    test: `'MutationObserver' in window`,
  },
  {
    id: 'js.resize-observer',
    label: 'ResizeObserver',
    category: 'js-api',
    test: `'ResizeObserver' in window`,
  },
  {
    id: 'js.performance-observer',
    label: 'PerformanceObserver',
    category: 'js-api',
    test: `'PerformanceObserver' in window`,
  },
  {
    id: 'js.web-components',
    label: 'Custom Elements + Shadow DOM',
    category: 'js-api',
    test: `'customElements' in window && 'attachShadow' in Element.prototype`,
  },
  {
    id: 'js.crypto',
    label: 'Web Crypto (crypto.subtle)',
    category: 'js-api',
    test: `'subtle' in crypto`,
  },
  {
    id: 'js.share',
    label: 'navigator.share',
    category: 'js-api',
    test: `'share' in navigator`,
  },
  {
    id: 'js.clipboard',
    label: 'Clipboard API',
    category: 'js-api',
    test: `'clipboard' in navigator && 'writeText' in navigator.clipboard`,
  },
  {
    id: 'js.service-worker',
    label: 'Service Worker',
    category: 'js-api',
    test: `'serviceWorker' in navigator`,
  },
  {
    id: 'js.web-worker',
    label: 'Web Worker',
    category: 'js-api',
    test: `'Worker' in window`,
  },
  {
    id: 'js.shared-array-buffer',
    label: 'SharedArrayBuffer',
    category: 'js-api',
    test: `'SharedArrayBuffer' in window`,
  },
  {
    id: 'js.importmap',
    label: 'Import Maps',
    category: 'js-api',
    test: `HTMLScriptElement.supports && HTMLScriptElement.supports('importmap')`,
  },

  // ────────────────── Network ──────────────────
  {
    id: 'net.fetch',
    label: 'Fetch API',
    category: 'network',
    test: `typeof fetch === 'function'`,
  },
  {
    id: 'net.fetch-streams',
    label: 'Fetch ReadableStream',
    category: 'network',
    test: `typeof fetch === 'function' && typeof ReadableStream !== 'undefined'`,
  },
  {
    id: 'net.websocket',
    label: 'WebSocket',
    category: 'network',
    test: `'WebSocket' in window`,
  },
  {
    id: 'net.eventsource',
    label: 'EventSource (SSE)',
    category: 'network',
    test: `'EventSource' in window`,
  },
  {
    id: 'net.beacon',
    label: 'navigator.sendBeacon',
    category: 'network',
    test: `'sendBeacon' in navigator`,
  },
  {
    id: 'net.online',
    label: '当前在线',
    category: 'network',
    test: `navigator.onLine`,
  },
  {
    id: 'net.connection',
    label: 'Network Information API',
    category: 'network',
    test: `'connection' in navigator || 'mozConnection' in navigator`,
  },

  // ────────────────── Media ──────────────────
  {
    id: 'media.video',
    label: '<video> 元素',
    category: 'media',
    test: `!!document.createElement('video').canPlayType`,
  },
  {
    id: 'media.audio',
    label: '<audio> 元素',
    category: 'media',
    test: `!!document.createElement('audio').canPlayType`,
  },
  {
    id: 'media.webcodecs',
    label: 'WebCodecs',
    category: 'media',
    test: `'VideoDecoder' in window`,
  },
  {
    id: 'media.mediastream',
    label: 'Media Capture (getUserMedia)',
    category: 'media',
    test: `!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)`,
  },
  {
    id: 'media.webaudio',
    label: 'Web Audio API',
    category: 'media',
    test: `'AudioContext' in window || 'webkitAudioContext' in window`,
  },
  {
    id: 'media.webgl',
    label: 'WebGL',
    category: 'media',
    test: `(function(){ try { return !!document.createElement('canvas').getContext('webgl') } catch(e) { return false } })()`,
  },
  {
    id: 'media.webgl2',
    label: 'WebGL2',
    category: 'media',
    test: `(function(){ try { return !!document.createElement('canvas').getContext('webgl2') } catch(e) { return false } })()`,
  },

  // ────────────────── Storage ──────────────────
  {
    id: 'storage.localstorage',
    label: 'localStorage',
    category: 'storage',
    test: `(function(){ try { return 'localStorage' in window && window.localStorage !== null } catch(e) { return false } })()`,
  },
  {
    id: 'storage.sessionstorage',
    label: 'sessionStorage',
    category: 'storage',
    test: `(function(){ try { return 'sessionStorage' in window && window.sessionStorage !== null } catch(e) { return false } })()`,
  },
  {
    id: 'storage.indexeddb',
    label: 'IndexedDB',
    category: 'storage',
    test: `'indexedDB' in window`,
  },
  {
    id: 'storage.cookies',
    label: 'Cookie',
    category: 'storage',
    test: `'cookie' in document`,
  },
  {
    id: 'storage.cache-api',
    label: 'Cache API',
    category: 'storage',
    test: `'caches' in window`,
  },

  // ────────────────── Device ──────────────────
  {
    id: 'device.touch',
    label: '触摸屏',
    category: 'device',
    test: `'ontouchstart' in window || navigator.maxTouchPoints > 0`,
  },
  {
    id: 'device.pwa-installable',
    label: 'PWA 可安装',
    category: 'device',
    test: `'BeforeInstallPromptEvent' in window`,
  },
  {
    id: 'device.dark-mode',
    label: 'prefers-color-scheme',
    category: 'device',
    test: `window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'`,
  },
  {
    id: 'device.cookie-enabled',
    label: 'Cookie 启用',
    category: 'device',
    test: `navigator.cookieEnabled`,
  },
  {
    id: 'device.do-not-track',
    label: 'Do Not Track',
    category: 'device',
    test: `navigator.doNotTrack === '1' || navigator.doNotTrack === 'yes'`,
  },
]
