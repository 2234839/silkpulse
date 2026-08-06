<script setup lang="ts">
/**
 * 项目管理 Modal（仅超管可用）
 *
 * 功能：创建项目、查看项目列表、启停/删除/轮换密钥。
 * 创建/轮换后返回的 apiKey 仅展示一次，需立即复制保存。
 */
import { ref, watch } from 'vue'
import { apiFetch } from '../utils/api'
import { copyText } from '../utils/clipboard'

/** 项目公开信息类型 */
interface ProjectPublic {
  id: string
  name: string
  description?: string
  enabled: boolean
  createdAt: number
}

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

/** 项目列表 */
const projects = ref<ProjectPublic[]>([])
/** 创建表单 */
const newProjectName = ref('')
const newProjectDesc = ref('')
/** 创建/轮换后一次性展示的密钥 */
const createdApiKey = ref('')

/** 加载项目列表 */
async function loadProjects() {
  try {
    const res = await apiFetch('/api/projects')
    if (res.ok) {
      const data = await res.json() as { projects: ProjectPublic[] }
      projects.value = data.projects
    }
  } catch { /* 忽略 */ }
}

/** Modal 打开时自动加载 */
watch(() => props.modelValue, (v) => {
  if (v) {
    loadProjects()
  } else {
    /** 关闭时清空一次性密钥展示 */
    createdApiKey.value = ''
  }
})

/** 创建新项目 */
async function createProject() {
  if (!newProjectName.value.trim()) return
  try {
    const res = await apiFetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newProjectName.value.trim(), description: newProjectDesc.value.trim() || undefined }),
    })
    if (res.ok) {
      const data = await res.json() as { apiKey: string }
      createdApiKey.value = data.apiKey
      newProjectName.value = ''
      newProjectDesc.value = ''
      await loadProjects()
    }
  } catch { /* 忽略 */ }
}

/** 轮换项目密钥 */
async function rotateProjectKey(pid: string) {
  try {
    const res = await apiFetch(`/api/projects/${pid}/rotate`, { method: 'POST' })
    if (res.ok) {
      const data = await res.json() as { apiKey: string }
      createdApiKey.value = data.apiKey
    }
  } catch { /* 忽略 */ }
}

/** 切换项目启用/禁用 */
async function toggleProject(pid: string, enabled: boolean) {
  try {
    await apiFetch(`/api/projects/${pid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    await loadProjects()
  } catch { /* 忽略 */ }
}

/** 删除项目 */
async function deleteProject(pid: string, name: string) {
  if (!confirm(`确定删除项目「${name}」？关联设备的 projectId 将被清除。`)) return
  try {
    await apiFetch(`/api/projects/${pid}`, { method: 'DELETE' })
    await loadProjects()
  } catch { /* 忽略 */ }
}

/** 复制密钥 */
async function doCopy(key: string) {
  const ok = await copyText(key)
  if (ok) createdApiKey.value = '✓ 已复制'
}

/** 暴露给父组件（设备列表需要 projectId→name 映射） */
defineExpose({ projects, loadProjects })
</script>

<template>
  <div
    v-if="modelValue"
    class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    @click.self="emit('update:modelValue', false)"
  >
    <div class="bg-surface rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col border border-base">
      <div class="flex items-center justify-between px-5 py-3 border-b border-base">
        <h3 class="text-sm font-semibold text-primary">📁 项目管理</h3>
        <button
          @click="emit('update:modelValue', false)"
          class="text-muted hover:text-primary text-lg"
        >✕</button>
      </div>

      <div class="flex-1 overflow-y-auto p-5 space-y-4">
        <!-- 创建项目 -->
        <div class="space-y-2 p-3 rounded border border-base bg-base/50">
          <h4 class="text-xs font-semibold text-secondary">创建新项目</h4>
          <div class="flex gap-2">
            <input
              v-model="newProjectName"
              placeholder="项目名称"
              class="flex-1 px-3 py-1.5 text-sm border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-500"
              @keydown.enter="createProject"
            />
            <input
              v-model="newProjectDesc"
              placeholder="描述（可选）"
              class="flex-1 px-3 py-1.5 text-sm border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-500"
            />
            <button
              @click="createProject"
              :disabled="!newProjectName.trim()"
              class="px-4 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
            >创建</button>
          </div>
          <!-- 新创建的密钥一次性展示 -->
          <div v-if="createdApiKey" class="p-3 rounded bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-300 dark:border-yellow-700">
            <p class="text-xs text-yellow-800 dark:text-yellow-200 font-medium mb-1">⚠️ 密钥仅展示一次，请立即复制保存：</p>
            <div class="flex items-center gap-2">
              <code class="flex-1 px-2 py-1 text-xs bg-input rounded font-mono break-all text-primary">{{ createdApiKey }}</code>
              <button
                v-if="!createdApiKey.startsWith('✓')"
                @click="doCopy(createdApiKey)"
                class="px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap"
              >复制</button>
            </div>
          </div>
        </div>

        <!-- 项目列表 -->
        <div class="space-y-2">
          <h4 class="text-xs font-semibold text-secondary">已有项目 ({{ projects.length }})</h4>
          <div
            v-for="p in projects"
            :key="p.id"
            class="p-3 rounded border border-base bg-base/30 space-y-2"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="flex-1 min-w-0">
                <span class="text-sm font-medium text-primary">{{ p.name }}</span>
                <span
                  :class="p.enabled ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400'"
                  class="ml-2 px-1.5 py-0.5 text-[10px] rounded font-medium"
                >{{ p.enabled ? '启用' : '禁用' }}</span>
                <span class="ml-1 text-[10px] text-faint">{{ new Date(p.createdAt).toLocaleDateString() }}</span>
              </div>
              <div class="flex items-center gap-1">
                <button
                  @click="toggleProject(p.id, !p.enabled)"
                  class="px-2 py-1 text-[10px] rounded text-secondary hover:bg-base-hover"
                >{{ p.enabled ? '禁用' : '启用' }}</button>
                <button
                  @click="rotateProjectKey(p.id)"
                  class="px-2 py-1 text-[10px] rounded text-secondary hover:bg-base-hover"
                  title="重新生成密钥（旧密钥立即失效）"
                >🔄 轮换密钥</button>
                <button
                  @click="deleteProject(p.id, p.name)"
                  class="px-2 py-1 text-[10px] rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                >删除</button>
              </div>
            </div>
            <div v-if="p.description" class="text-xs text-muted">{{ p.description }}</div>
            <div class="text-[10px] text-faint font-mono truncate">{{ p.id }}</div>
          </div>
          <div v-if="projects.length === 0" class="text-center text-xs text-faint py-4">
            暂无项目，创建一个来管理设备密钥
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
