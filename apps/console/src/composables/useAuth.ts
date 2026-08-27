/**
 * useAuth —— 控制台鉴权 hook
 *
 * 管理用户输入的密钥（超管密钥或项目密钥），
 * 持久化到 localStorage，WS 和 HTTP 请求都携带此密钥。
 */
import { ref, readonly } from "vue";

const STORAGE_KEY = "__silkpulse_auth_key__";

/** 密钥输入值 */
const apiKey = ref<string>("");
/** 鉴权状态 */
const authStatus = ref<{
  authEnabled: boolean;
  hasAdminKey: boolean;
  playgroundEnabled?: boolean;
} | null>(null);
/** 当前用户角色信息（verify 后填充） */
const userRole = ref<"admin" | "project" | null>(null);
const projectId = ref<string | undefined>(undefined);
const projectName = ref<string | undefined>(undefined);
/** 是否为 Playground 游客 */
const isPlayground = ref<boolean>(false);

/** 从 localStorage 恢复密钥 */
function restoreKey(): void {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) apiKey.value = saved;
  } catch {
    /** localStorage 不可用时忽略 */
  }
}

/** 保存密钥到 localStorage */
function saveKey(key: string): void {
  apiKey.value = key;
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /** localStorage 不可用时忽略 */
  }
}

/** 清除密钥和角色信息 */
function clearKey(): void {
  apiKey.value = "";
  userRole.value = null;
  projectId.value = undefined;
  projectName.value = undefined;
  isPlayground.value = false;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /** */
  }
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

/**
 * 向 server 验证密钥，拿角色 + projectId
 *
 * candidate 不传时验证当前已保存的 apiKey（onMounted 恢复登录态用）；
 * 登录页传用户输入的候选密钥——验证通过前不写入 apiKey，
 * 否则 needAuth（依赖 apiKey 非空）会先翻 false 再翻回 true，
 * AuthPage 卸载重挂，authError 被清空，错误提示永远显示不出来。
 */
async function verifyKey(candidate?: string): Promise<boolean> {
  const key = candidate ?? apiKey.value;
  if (!key) {
    userRole.value = null;
    return false;
  }
  try {
    const res = await fetch("/api/auth/verify", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      userRole.value = null;
      return false;
    }
    const data: { role: string; projectId?: string; projectName?: string; isPlayground?: boolean } =
      await res.json();
    if (data.role === "admin" || data.role === "project") {
      userRole.value = data.role;
      projectId.value = data.projectId;
      projectName.value = data.projectName;
      isPlayground.value = !!data.isPlayground;
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

/** 检查是否已鉴权 */
function isAuthenticated(): boolean {
  if (!authStatus.value) return false;
  if (!authStatus.value.authEnabled) return true;
  return !!apiKey.value;
}

/**
 * URL ?key= 注入：优先级高于 localStorage（分享带密钥的控制台直达链接）。
 * 用后即刻从地址栏清除，避免密钥留在浏览器历史/分享链路。
 */
function restoreKeyFromUrl(): void {
  try {
    const u = new URL(window.location.href);
    const key = u.searchParams.get("key");
    if (key) {
      saveKey(key);
      u.searchParams.delete("key");
      window.history.replaceState(null, "", u.toString());
    }
  } catch {
    /** URL 解析异常忽略（如非浏览器环境） */
  }
}

restoreKeyFromUrl();
restoreKey();

export function useAuth() {
  return {
    apiKey: readonly(apiKey),
    authStatus: readonly(authStatus),
    userRole: readonly(userRole),
    projectId: readonly(projectId),
    projectName: readonly(projectName),
    isPlayground: readonly(isPlayground),
    saveKey,
    clearKey,
    checkAuthStatus,
    verifyKey,
    guestLogin,
    isAuthenticated,
  };
}
