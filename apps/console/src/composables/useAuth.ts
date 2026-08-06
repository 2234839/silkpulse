/**
 * useAuth —— 控制台鉴权 hook
 *
 * 管理用户输入的密钥（超管密钥或项目密钥），
 * 持久化到 localStorage，WS 和 HTTP 请求都携带此密钥。
 */
import { ref, readonly } from 'vue'

const STORAGE_KEY = '__clarosight_auth_key__'

/** 密钥输入值 */
const apiKey = ref<string>('')
/** 鉴权状态 */
const authStatus = ref<{
  authEnabled: boolean
  hasAdminKey: boolean
} | null>(null)
/** 当前用户角色信息（verify 后填充） */
const userRole = ref<'admin' | 'project' | null>(null)
const projectId = ref<string | undefined>(undefined)
const projectName = ref<string | undefined>(undefined)

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
    const data: { role: string; projectId?: string; projectName?: string } = await res.json()
    if (data.role === 'admin' || data.role === 'project') {
      userRole.value = data.role
      projectId.value = data.projectId
      projectName.value = data.projectName
      return true
    }
    userRole.value = null
    return false
  } catch {
    userRole.value = null
    return false
  }
}

/** 检查是否已鉴权 */
function isAuthenticated(): boolean {
  if (!authStatus.value) return false
  if (!authStatus.value.authEnabled) return true
  return !!apiKey.value
}

restoreKey()

export function useAuth() {
  return {
    apiKey: readonly(apiKey),
    authStatus: readonly(authStatus),
    userRole: readonly(userRole),
    projectId: readonly(projectId),
    projectName: readonly(projectName),
    saveKey,
    clearKey,
    checkAuthStatus,
    verifyKey,
    isAuthenticated,
  }
}
