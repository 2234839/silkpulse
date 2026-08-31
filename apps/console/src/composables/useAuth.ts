/**
 * useAuth —— 控制台鉴权 hook
 *
 * 管理用户输入的密钥（超管密钥或项目密钥），
 * 持久化到 localStorage，WS 和 HTTP 请求都携带此密钥。
 */
import { ref, readonly } from 'vue'

const STORAGE_KEY = '__silkpulse_auth_key__'

/** 密钥输入值 */
const apiKey = ref<string>('')
/** 鉴权状态 */
const authStatus = ref<{
  authEnabled: boolean
  hasAdminKey: boolean
  playgroundEnabled?: boolean
  /** 游客可自建项目 Key（仅 Playground 开启时） */
  guestProjectsEnabled?: boolean
} | null>(null)
/** 当前用户角色信息（verify 后填充） */
const userRole = ref<'admin' | 'project' | null>(null)
const projectId = ref<string | undefined>(undefined)
const projectName = ref<string | undefined>(undefined)
/** 是否为 Playground 游客 */
const isPlayground = ref<boolean>(false)
/** 是否为游客自建项目（5 天后自动销毁） */
const isGuestProject = ref<boolean>(false)
/** 游客项目的过期时间（ISO） */
const projectExpiresAt = ref<string | undefined>(undefined)

/** 从 localStorage 恢复密钥 */
function restoreKey(): void {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) apiKey.value = saved
  } catch { /** localStorage 不可用时忽略 */ }
}

/** 保存密钥到 localStorage */
function saveKey(key: string): void {
  apiKey.value = key
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key)
    else localStorage.removeItem(STORAGE_KEY)
  } catch { /** localStorage 不可用时忽略 */ }
}

/** 清除密钥和角色信息 */
function clearKey(): void {
  apiKey.value = ''
  userRole.value = null
  projectId.value = undefined
  projectName.value = undefined
  isPlayground.value = false
  isGuestProject.value = false
  projectExpiresAt.value = undefined
  try { localStorage.removeItem(STORAGE_KEY) } catch { /** */ }
}

/** 查询 server 鉴权状态 */
async function checkAuthStatus(): Promise<void> {
  try {
    const res = await fetch('/api/auth/status')
    authStatus.value = await res.json()
  } catch {
    authStatus.value = null
  }
}

/** 向 server 验证当前密钥，拿角色 + projectId */
async function verifyKey(): Promise<boolean> {
  if (!apiKey.value) {
    userRole.value = null
    return false
  }
  try {
    const res = await fetch('/api/auth/verify', {
      headers: { Authorization: `Bearer ${apiKey.value}` },
    })
    if (!res.ok) {
      userRole.value = null
      return false
    }
    const data: { role: string; projectId?: string; projectName?: string; isPlayground?: boolean; isGuestProject?: boolean; expiresAt?: string } = await res.json()
    if (data.role === 'admin' || data.role === 'project') {
      userRole.value = data.role
      projectId.value = data.projectId
      projectName.value = data.projectName
      isPlayground.value = !!data.isPlayground
      isGuestProject.value = !!data.isGuestProject
      projectExpiresAt.value = data.expiresAt
      return true
    }
    userRole.value = null
    return false
  } catch {
    userRole.value = null
    return false
  }
}

/**
 * 游客一键登录：调用 /api/auth/playground，
 * 服务端返回 token（playgroundKey），保存后即可正常使用。
 */
async function guestLogin(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/playground', { method: 'POST' })
    if (!res.ok) return false
    const data: { role: string; token: string; isPlayground?: boolean } = await res.json()
    if (data.role === 'admin' || data.role === 'project') {
      saveKey(data.token)
      return await verifyKey()
    }
    return false
  } catch {
    return false
  }
}

/**
 * 游客自建项目 Key：创建一个属于自己的临时项目（最长 5 天）。
 * 服务端只存哈希，apiKey 只返回这一次——必须立即复制，否则再也看不到。
 */
async function guestCreateProject(name?: string): Promise<{ apiKey: string; projectId: string; projectName: string; expiresAt?: string } | null> {
  try {
    const res = await fetch('/api/guest/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(name?.trim() ? { name: name.trim() } : {}),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** 检查是否已鉴权 */
function isAuthenticated(): boolean {
  if (!authStatus.value) return false
  if (!authStatus.value.authEnabled) return true
  return !!apiKey.value
}

/**
 * URL ?key= 注入：优先级高于 localStorage（分享带密钥的控制台直达链接）。
 * 用后即刻从地址栏清除，避免密钥留在浏览器历史/分享链路。
 */
function restoreKeyFromUrl(): void {
  try {
    const u = new URL(window.location.href)
    const key = u.searchParams.get('key')
    if (key) {
      saveKey(key)
      u.searchParams.delete('key')
      window.history.replaceState(null, '', u.toString())
    }
  } catch { /** URL 解析异常忽略（如非浏览器环境） */ }
}

restoreKeyFromUrl()
restoreKey()

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
  }
}
