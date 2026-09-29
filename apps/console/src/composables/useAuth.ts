/**
 * useAuth —— 控制台鉴权 hook
 *
 * 管理用户输入的密钥（超管密钥或项目密钥），
 * 持久化到 localStorage，WS 和 HTTP 请求都携带此密钥。
 */
import { ref, readonly } from "vue";

const STORAGE_KEY = "__silkpulse_auth_key__";

/** 兄弟 tab 鉴权共享 channel（借鉴 devframe 的 devframe-auth BroadcastChannel） */
const AUTH_CHANNEL_NAME = "silkpulse-auth";

/** 跨 tab 消息格式 */
interface AuthBroadcast {
  type: "key-updated" | "key-cleared";
  /** key-updated 时携带新密钥 */
  key?: string;
}

/** 广播句柄（BroadcastChannel 不可用时为 null，静默降级） */
let authChannel: BroadcastChannel | null = null;
try {
  authChannel = new BroadcastChannel(AUTH_CHANNEL_NAME);
} catch {
  /** 旧浏览器无 BroadcastChannel：多 tab 共享降级为不可用，单 tab 功能不受影响 */
}

/** 密钥输入值 */
const apiKey = ref<string>("");
/** 鉴权状态 */
const authStatus = ref<{
  authEnabled: boolean;
  hasAdminKey: boolean;
  playgroundEnabled?: boolean;
  /** 游客可自建项目 Key（仅 Playground 开启时） */
  guestProjectsEnabled?: boolean;
} | null>(null);
/** 当前用户角色信息（verify 后填充） */
const userRole = ref<"admin" | "project" | null>(null);
const projectId = ref<string | undefined>(undefined);
const projectName = ref<string | undefined>(undefined);
/** 是否为 Playground 游客 */
const isPlayground = ref<boolean>(false);
/** 是否为游客自建项目（5 天后自动销毁） */
const isGuestProject = ref<boolean>(false);
/** 游客项目的过期时间（ISO） */
const projectExpiresAt = ref<string | undefined>(undefined);

/** 从 localStorage 恢复密钥 */
function restoreKey(): void {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) apiKey.value = saved;
  } catch {
    /** localStorage 不可用时忽略 */
  }
}

/** 保存密钥到 localStorage（并广播给兄弟 tab） */
function saveKey(key: string): void {
  apiKey.value = key;
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /** localStorage 不可用时忽略 */
  }
  authChannel?.postMessage({ type: "key-updated", key } satisfies AuthBroadcast);
}

/** 清除密钥和角色信息（并广播给兄弟 tab 同步登出） */
function clearKey(): void {
  apiKey.value = "";
  userRole.value = null;
  projectId.value = undefined;
  projectName.value = undefined;
  isPlayground.value = false;
  isGuestProject.value = false;
  projectExpiresAt.value = undefined;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /** */
  }
  authChannel?.postMessage({ type: "key-cleared" } satisfies AuthBroadcast);
}

/** 查询 server 鉴权状态 */
async function checkAuthStatus(): Promise<void> {
  try {
    const res = await fetch("/api/auth/status");
    authStatus.value = await res.json();
  } catch {
    authStatus.value = null;
  }
}

/** 向 server 验证当前密钥，拿角色 + projectId */
async function verifyKey(): Promise<boolean> {
  if (!apiKey.value) {
    userRole.value = null;
    return false;
  }
  try {
    const res = await fetch("/api/auth/verify", {
      headers: { Authorization: `Bearer ${apiKey.value}` },
    });
    if (!res.ok) {
      userRole.value = null;
      return false;
    }
    const data: {
      role: string;
      projectId?: string;
      projectName?: string;
      isPlayground?: boolean;
      isGuestProject?: boolean;
      expiresAt?: string;
    } = await res.json();
    if (data.role === "admin" || data.role === "project") {
      userRole.value = data.role;
      projectId.value = data.projectId;
      projectName.value = data.projectName;
      isPlayground.value = !!data.isPlayground;
      isGuestProject.value = !!data.isGuestProject;
      projectExpiresAt.value = data.expiresAt;
      return true;
    }
    userRole.value = null;
    return false;
  } catch {
    userRole.value = null;
    return false;
  }
}

/**
 * 游客一键登录：调用 /api/auth/playground，
 * 服务端返回 token（playgroundKey），保存后即可正常使用。
 */
async function guestLogin(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/playground", { method: "POST" });
    if (!res.ok) return false;
    const data: { role: string; token: string; isPlayground?: boolean } = await res.json();
    if (data.role === "admin" || data.role === "project") {
      saveKey(data.token);
      return await verifyKey();
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 游客自建项目 Key：创建一个属于自己的临时项目（最长 5 天）。
 * 服务端只存哈希，apiKey 只返回这一次——必须立即复制，否则再也看不到。
 */
async function guestCreateProject(
  name?: string,
): Promise<{ apiKey: string; projectId: string; projectName: string; expiresAt?: string } | null> {
  try {
    const res = await fetch("/api/guest/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(name?.trim() ? { name: name.trim() } : {}),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 检查是否已鉴权 */
function isAuthenticated(): boolean {
  if (!authStatus.value) return false;
  if (!authStatus.value.authEnabled) return true;
  return !!apiKey.value;
}

/**
 * URL 注入：优先级高于 localStorage（分享带密钥的控制台直达链接）。
 * 支持 `?key=`（兼容旧链接）与 `#key=`（fragment 不进 server 日志、
 * Referer 与浏览器历史同步，优先采用，借鉴 devframe 的 magic link 设计）。
 * 用后即刻从地址栏清除，避免密钥留在浏览器历史/分享链路。
 *
 * 注意：vue-router（createWebHistory）初始化时会记住含 hash 的初始 URL，
 * 并在首次导航 ready 时 replaceState 回去——所以这里不能只清一次，
 * 需要在 router 首次导航完成后（下一个宏任务 + hashchange 后）再兜底清一次。
 */
function restoreKeyFromUrl(): void {
  try {
    const u = new URL(window.location.href);
    /** fragment 形式：#key=xxx（URL.searchParams 看不到 fragment，单独解析） */
    const hash = u.hash.startsWith("#") ? u.hash.slice(1) : "";
    if (hash) {
      const hashParams = new URLSearchParams(hash);
      const hashKey = hashParams.get("key");
      if (hashKey) {
        saveKey(hashKey);
        /** 立即清一次 + router 首次导航后兜底再清（router 会把初始 URL 写回） */
        clearUrlKey(u, false);
        setTimeout(() => clearUrlKey(new URL(window.location.href), true), 0);
        return;
      }
    }
    /** query 形式：?key=xxx（旧链接兼容） */
    const key = u.searchParams.get("key");
    if (key) {
      saveKey(key);
      clearUrlKey(u, false);
    }
  } catch {
    /** URL 解析异常忽略（如非浏览器环境） */
  }
}

/**
 * 从地址栏移除 key（fragment 和 query 都清），replaceState 不产生历史记录。
 * onlyHash=true 时只处理 fragment（router ready 后的兜底路径）。
 */
function clearUrlKey(u: URL, onlyHash: boolean): void {
  let changed = false;
  if (u.hash) {
    const hashParams = new URLSearchParams(u.hash.startsWith("#") ? u.hash.slice(1) : "");
    if (hashParams.get("key")) {
      hashParams.delete("key");
      const rest = hashParams.toString();
      u.hash = rest ? `#${rest}` : "";
      changed = true;
    }
  }
  if (!onlyHash && u.searchParams.get("key")) {
    u.searchParams.delete("key");
    changed = true;
  }
  if (changed) window.history.replaceState(null, "", u.toString());
}

restoreKeyFromUrl();
restoreKey();

/* ════════ 兄弟 tab 鉴权同步 ════════ */

/**
 * 监听兄弟 tab 的鉴权变化：
 * - key-updated：采纳新密钥（只更新本地 ref + localStorage，不再回广播，防乒乓）；
 *   WS 层（useConsoleSocket）watch apiKey 变化自动重连
 * - key-cleared：同步登出
 */
authChannel?.addEventListener("message", (ev: MessageEvent<AuthBroadcast>) => {
  const msg = ev.data;
  if (msg?.type === "key-updated" && msg.key) {
    apiKey.value = msg.key;
    try {
      localStorage.setItem(STORAGE_KEY, msg.key);
    } catch {
      /** */
    }
  } else if (msg?.type === "key-cleared") {
    apiKey.value = "";
    userRole.value = null;
    projectId.value = undefined;
    projectName.value = undefined;
    isPlayground.value = false;
    isGuestProject.value = false;
    projectExpiresAt.value = undefined;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /** */
    }
  }
});

export function useAuth() {
  return {
    apiKey: readonly(apiKey),
    authStatus: readonly(authStatus),
    userRole: readonly(userRole),
    projectId: readonly(projectId),
    projectName: readonly(projectName),
    isPlayground: readonly(isPlayground),
    isGuestProject: readonly(isGuestProject),
    projectExpiresAt: readonly(projectExpiresAt),
    saveKey,
    clearKey,
    checkAuthStatus,
    verifyKey,
    guestLogin,
    guestCreateProject,
    isAuthenticated,
  };
}
