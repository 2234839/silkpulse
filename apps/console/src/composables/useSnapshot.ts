/**
 * useSnapshot —— 拉取设备页面快照 hook
 *
 * 同时获取 compact 文本（AI 友好）和原始 JSON（含 rect 布局信息，供预览渲染）
 */
import { ref } from 'vue'
import type { SnapshotData } from '@silkpulse/shared'
import { apiFetch } from '../utils/api'

export function useSnapshot() {
  const snapshotText = ref('')
  /** 原始结构化快照数据（含 rect 位置信息，布局预览用） */
  const snapshotData = ref<SnapshotData | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchSnapshot(deviceId: string) {
    loading.value = true
    error.value = null
    try {
      /** 并行拉取文本版和 JSON 版 */
      const [textRes, jsonRes] = await Promise.all([
        apiFetch(`/api/devices/${deviceId}/snapshot`),
        apiFetch(`/api/devices/${deviceId}/snapshot?format=json`),
      ])
      if (!textRes.ok) {
        error.value = `HTTP ${textRes.status}`
        snapshotText.value = ''
        snapshotData.value = null
      } else {
        snapshotText.value = await textRes.text()
        if (jsonRes.ok) {
          snapshotData.value = await jsonRes.json()
        }
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      snapshotText.value = ''
      snapshotData.value = null
    } finally {
      loading.value = false
    }
  }

  return { snapshotText, snapshotData, loading, error, fetchSnapshot }
}
