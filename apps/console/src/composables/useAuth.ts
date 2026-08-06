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

/** 清除密钥 */
function clearKey(): void {
  apiKey.value = ''
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
    saveKey,
    clearKey,
    checkAuthStatus,
    isAuthenticated,
  }
}
