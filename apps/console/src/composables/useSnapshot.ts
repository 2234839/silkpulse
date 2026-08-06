/**
 * useSnapshot —— 拉取设备页面快照 hook
 *
 * 调用 HTTP API GET /api/devices/:id/snapshot，返回 AI 友好的 compact 文本
 */
import { ref } from 'vue'
import { apiFetch } from '../utils/api'

export function useSnapshot() {
  const snapshotText = ref('')
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchSnapshot(deviceId: string) {
    loading.value = true
    error.value = null
    try {
      const res = await apiFetch(`/api/devices/${deviceId}/snapshot`)
      if (!res.ok) {
        error.value = `HTTP ${res.status}`
        snapshotText.value = ''
      } else {
        snapshotText.value = await res.text()
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      snapshotText.value = ''
    } finally {
      loading.value = false
    }
  }

  return { snapshotText, loading, error, fetchSnapshot }
}
