/**
 * Storage 变化采集器 —— 监听 localStorage / sessionStorage 修改并上报
 *
 * 浏览器原生 storage 事件只在**跨 tab**修改时触发（同一个 tab 内 setItem 不触发），
 * 所以必须劫持 setItem / removeItem / clear 才能捕获当前页面内的修改。
 *
 * 上报策略：变化后发一条轻量的 storage-change 消息（只含 storageType，不含数据），
 * 控制台收到后重新拉取完整数据（GET /storage）。这样消息体恒定小，
 * 不受 storage value 大小影响。
 *
 * 按需启停：默认不激活，控制台打开 Storage 面板时通过 set-watchers 激活。
 * 劫持的原生方法无法撤销，所以在 sink 外层包 active flag 控制是否真正上报。
 */

/**
 * 上报回调（SDK index.ts 注入 ws send）
 *
 * key+timestamp 可选——劫持 setItem 时能拿到具体 key，
 * clear() 无法确定具体 key 所以不带（控制台收到后全量刷新）。
 */
type Sink = (storageType: "local" | "session", key?: string, timestamp?: number) => void;

/** 是否激活上报（默认 false，控制台打开 Storage 面板时激活） */
let active = false;

/** 安装 storage 变化采集器 */
export function installStorageWatcher(sink: Sink): void {
  /** 激活时透传 sink，未激活时静默丢弃 */
  const guardedSink: Sink = (...args) => {
    if (!active) return;
    sink(...args);
  };
  /** 劫持单个 Storage 对象的三个修改方法 */
  function patchStorage(storage: Storage, storageType: "local" | "session"): void {
    const origSetItem = storage.setItem.bind(storage);
    const origRemoveItem = storage.removeItem.bind(storage);
    const origClear = storage.clear.bind(storage);

    storage.setItem = function (key: string, value: string) {
      origSetItem(key, value);
      guardedSink(storageType, key, Date.now());
    };
    storage.removeItem = function (key: string) {
      origRemoveItem(key);
      guardedSink(storageType, key, Date.now());
    };
    storage.clear = function () {
      origClear();
      guardedSink(storageType);
    };
  }

  try {
    patchStorage(localStorage, "local");
  } catch {
    /** localStorage 不可用（隐私模式）忽略 */
  }
  try {
    patchStorage(sessionStorage, "session");
  } catch {
    /** sessionStorage 不可用忽略 */
  }

  /**
   * 跨 tab storage 事件（其他标签页修改 localStorage 时触发）
   *
   * 同 tab 内的修改已被上面的劫持捕获，这里补上跨 tab 场景。
   * event.storageArea 判断是 localStorage 还是 sessionStorage。
   */
  window.addEventListener("storage", (e) => {
    if (e.storageArea === localStorage) {
      guardedSink("local", e.key ?? undefined, Date.now());
    } else if (e.storageArea === sessionStorage) {
      guardedSink("session", e.key ?? undefined, Date.now());
    }
  });
}

/** 暂停/恢复上报（控制台未打开 Storage 面板时不发数据减少开销） */
export function setStorageWatcherActive(value: boolean): void {
  active = value;
}
