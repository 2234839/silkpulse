<script setup lang="ts">
/**
 * 左侧设备列表
 *
 * 功能：搜索、设备卡片（标题/URL/标签/备注/OS/项目徽章）、
 * 内联标签编辑。
 */
import { ref, computed } from "vue";
import type { DeviceInfo } from "@silkpulse/shared";
import { apiFetch } from "../utils/api";

const props = defineProps<{
  /** 所有设备 */
  devices: DeviceInfo[];
  /** 当前选中设备 ID */
  selectedDeviceId: string | null;
  /** 超管模式（决定是否显示项目徽章） */
  isAdmin: boolean;
  /** projectId → 项目名映射 */
  projectNameMap: Record<string, string>;
}>();

const emit = defineEmits<{
  select: [deviceId: string];
}>();

/** 搜索关键字 */
const deviceSearch = ref("");

/** 过滤后的设备列表 */
const filteredDevices = computed(() => {
  const q = deviceSearch.value.trim().toLowerCase();
  if (!q) return props.devices;
  return props.devices.filter(
    (d) =>
      d.title.toLowerCase().includes(q) ||
      d.url.toLowerCase().includes(q) ||
      (d.deviceType ?? "").toLowerCase().includes(q) ||
      (d.tags ?? []).some((t) => t.toLowerCase().includes(q)) ||
      (d.note ?? "").toLowerCase().includes(q),
  );
});

/** 无项目归属的标签名 */
const NO_PROJECT = "未分组";
/** 分组 key（projectId 或 NO_PROJECT）→ 项目名 */
function groupLabel(key: string): string {
  if (key === NO_PROJECT) return NO_PROJECT;
  return props.projectNameMap[key] ?? key.slice(0, 8);
}

/** 按项目分组的设备列表（超管模式用） */
const groupedDevices = computed(() => {
  const groups: { key: string; label: string; devices: typeof filteredDevices.value }[] = [];
  const map = new Map<string, typeof filteredDevices.value>();
  for (const d of filteredDevices.value) {
    const key = d.projectId ?? NO_PROJECT;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(d);
  }
  for (const [key, devices] of map) {
    groups.push({ key, label: groupLabel(key), devices });
  }
  return groups;
});

/** 标签编辑状态 */
const editingTagDeviceId = ref<string | null>(null);
const tagDraft = ref("");
const noteDraft = ref("");

function startEditTags(deviceId: string) {
  const d = props.devices.find((x) => x.id === deviceId);
  editingTagDeviceId.value = deviceId;
  tagDraft.value = d?.tags?.join(", ") ?? "";
  noteDraft.value = d?.note ?? "";
}

async function saveTags() {
  const id = editingTagDeviceId.value;
  if (!id) return;
  const tags = tagDraft.value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const note = noteDraft.value.trim() || undefined;
  try {
    await apiFetch(`/api/devices/${id}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags, note }),
    });
  } catch {
    /** server 会广播 device-list 更新 */
  }
  editingTagDeviceId.value = null;
}

function cancelEditTags() {
  editingTagDeviceId.value = null;
}

/** favicon 加载失败时隐藏 img，露出后备 emoji */
function onFaviconError(e: Event) {
  const img = e.target as HTMLImageElement;
  img.style.display = "none";
}

/** 从 User-Agent 解析操作系统名称 */
function detectOS(ua: string): string {
  if (/Windows NT 10/.test(ua)) return "Windows";
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X ([\d_]+)/.test(ua)) {
    const m = ua.match(/Mac OS X ([\d_]+)/);
    return "macOS " + (m?.[1]?.replace(/_/g, ".") ?? "");
  }
  if (/Android ([\d.]+)/.test(ua)) {
    const m = ua.match(/Android ([\d.]+)/);
    return "Android " + (m?.[1] ?? "");
  }
  if (/iPhone OS ([\d_]+)/.test(ua)) {
    const m = ua.match(/iPhone OS ([\d_]+)/);
    return "iOS " + (m?.[1]?.replace(/_/g, ".") ?? "");
  }
  if (/iPad.*OS ([\d_]+)/.test(ua)) {
    const m = ua.match(/OS ([\d_]+)/);
    return "iPadOS " + (m?.[1]?.replace(/_/g, ".") ?? "");
  }
  if (/Linux/.test(ua)) return "Linux";
  if (/CrOS/.test(ua)) return "ChromeOS";
  return "Unknown";
}

/** 设备类型 → emoji 图标 */
function deviceTypeIcon(t: string): string {
  if (t === "mobile") return "📱";
  if (t === "tablet") return "📲";
  return "🖥️";
}

/** 相对时间 */
const now = ref(Date.now());
setInterval(() => {
  now.value = Date.now();
}, 30000);

function relativeTime(ts: number): string {
  const elapsed = Math.max(0, now.value - ts);
  const mins = Math.floor(elapsed / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}
</script>

<template>
  <aside
    class="w-full md:w-full h-full border-r border-base bg-surface overflow-y-auto flex flex-col"
  >
    <div class="px-4 py-3 border-b border-base">
      <h2 class="text-sm font-semibold text-secondary flex items-center gap-1.5">
        <span class="relative flex w-2 h-2">
          <span
            class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60"
          ></span>
          <span class="relative inline-flex w-2 h-2 rounded-full bg-green-500"></span>
        </span>
        在线设备
        <span class="text-faint font-normal">({{ devices.length }})</span>
      </h2>
      <input
        v-model="deviceSearch"
        placeholder="搜索设备（标题/URL/类型）..."
        class="mt-2 w-full px-2.5 py-1.5 text-xs border border-input rounded-lg bg-input text-primary placeholder:text-faint focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15 transition"
      />
    </div>
    <ul>
      <!-- 超管模式：按项目分组 -->
      <template v-if="isAdmin">
        <template v-for="group in groupedDevices" :key="group.key">
          <div class="px-4 py-1.5 bg-base/50 border-b border-light sticky top-0 z-10">
            <span class="text-xs font-semibold text-secondary">{{ group.label }}</span>
            <span class="text-faint font-normal ml-1">({{ group.devices.length }})</span>
          </div>
          <li
            v-for="d in group.devices"
            :key="d.id"
            @click="emit('select', d.id)"
            class="px-4 py-3 border-b border-light cursor-pointer hover:bg-base relative transition-colors"
            :class="selectedDeviceId === d.id ? 'bg-blue-soft border-l-2 border-l-blue-500' : ''"
          >
            <!-- 有错误时左侧红条 -->
            <span v-if="d.errorCount > 0" class="absolute left-0 top-0 bottom-0 w-1 bg-red-400" />
            <div class="text-sm font-medium text-primary truncate">
              <img
                v-if="d.icon"
                :src="d.icon"
                @error="onFaviconError"
                class="inline-block w-4 h-4 mr-1 align-text-bottom rounded-sm"
                alt=""
              /><span v-else class="mr-1">{{ deviceTypeIcon(d.deviceType) }}</span
              >{{ d.title }}
              <!-- 编辑标签按钮 -->
              <button
                v-if="selectedDeviceId === d.id && editingTagDeviceId !== d.id"
                @click.stop="startEditTags(d.id)"
                class="ml-1 text-faint hover:text-blue-500 text-xs align-middle"
                title="编辑标签/备注"
              >
                🏷️
              </button>
            </div>
            <div class="text-xs text-muted truncate">{{ d.url }}</div>
            <!-- tags 徽章 + 备注 -->
            <div
              v-if="(d.tags?.length || d.note) && editingTagDeviceId !== d.id"
              class="flex flex-wrap items-center gap-1 mt-1"
            >
              <span
                v-for="tag in d.tags ?? []"
                :key="tag"
                class="px-1.5 py-0.5 text-[10px] font-medium rounded bg-blue-soft text-blue-key"
                >{{ tag }}</span
              >
              <span
                v-if="d.note"
                class="text-[10px] text-faint italic truncate max-w-[140px]"
                :title="d.note"
                >{{ d.note }}</span
              >
            </div>
            <!-- 内联编辑态 -->
            <div v-if="editingTagDeviceId === d.id" class="mt-1 space-y-1" @click.stop>
              <input
                v-model="tagDraft"
                placeholder="标签（逗号分隔）"
                class="w-full px-2 py-0.5 text-xs border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-500"
                @keydown.enter="saveTags"
                @keydown.escape="cancelEditTags"
              />
              <input
                v-model="noteDraft"
                placeholder="备注（可选）"
                class="w-full px-2 py-0.5 text-xs border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-500"
                @keydown.enter="saveTags"
                @keydown.escape="cancelEditTags"
              />
              <div class="flex gap-1">
                <button
                  @click="saveTags"
                  class="px-2 py-0.5 text-[10px] bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  保存
                </button>
                <button
                  @click="cancelEditTags"
                  class="px-2 py-0.5 text-[10px] bg-elevated text-secondary rounded bg-elevated-hover"
                >
                  取消
                </button>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1">
              <span class="text-xs text-faint">{{ detectOS(d.userAgent) }}</span>
              <span class="text-xs text-faint whitespace-nowrap"
                >· {{ d.deviceType }} {{ d.viewportWidth }}×{{ d.viewportHeight }}</span
              >
              <span
                v-if="d.onlineAt"
                class="text-xs text-faint whitespace-nowrap"
                :title="new Date(d.onlineAt).toLocaleString()"
                >· {{ relativeTime(d.onlineAt) }}</span
              >
              <span
                v-if="d.errorCount > 0"
                class="text-xs text-red-500 font-medium whitespace-nowrap"
                >{{ d.errorCount }} 错误</span
              >
            </div>
          </li>
        </template>
        <li v-if="devices.length === 0" class="px-4 py-8 text-center text-sm text-faint">
          暂无在线设备
        </li>
        <li
          v-else-if="filteredDevices.length === 0"
          class="px-4 py-8 text-center text-sm text-faint"
        >
          无匹配设备
        </li>
      </template>

      <!-- 项目用户/游客模式：平铺显示 -->
      <template v-else>
        <li
          v-for="d in filteredDevices"
          :key="d.id"
          @click="emit('select', d.id)"
          class="px-4 py-3 border-b border-light cursor-pointer hover:bg-base relative transition-colors"
          :class="selectedDeviceId === d.id ? 'bg-blue-soft border-l-2 border-l-blue-500' : ''"
        >
          <span v-if="d.errorCount > 0" class="absolute left-0 top-0 bottom-0 w-1 bg-red-400" />
          <div class="text-sm font-medium text-primary truncate">
            <img
              v-if="d.icon"
              :src="d.icon"
              @error="onFaviconError"
              class="inline-block w-4 h-4 mr-1 align-text-bottom rounded-sm"
              alt=""
            /><span v-else class="mr-1">{{ deviceTypeIcon(d.deviceType) }}</span
            >{{ d.title }}
            <button
              v-if="selectedDeviceId === d.id && editingTagDeviceId !== d.id"
              @click.stop="startEditTags(d.id)"
              class="ml-1 text-faint hover:text-blue-500 text-xs align-middle"
              title="编辑标签/备注"
            >
              🏷️
            </button>
          </div>
          <div class="text-xs text-muted truncate">{{ d.url }}</div>
          <div
            v-if="(d.tags?.length || d.note) && editingTagDeviceId !== d.id"
            class="flex flex-wrap items-center gap-1 mt-1"
          >
            <span
              v-for="tag in d.tags ?? []"
              :key="tag"
              class="px-1.5 py-0.5 text-[10px] font-medium rounded bg-blue-soft text-blue-key"
              >{{ tag }}</span
            >
            <span
              v-if="d.note"
              class="text-[10px] text-faint italic truncate max-w-[140px]"
              :title="d.note"
              >{{ d.note }}</span
            >
          </div>
          <div v-if="editingTagDeviceId === d.id" class="mt-1 space-y-1" @click.stop>
            <input
              v-model="tagDraft"
              placeholder="标签（逗号分隔）"
              class="w-full px-2 py-0.5 text-xs border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-500"
              @keydown.enter="saveTags"
              @keydown.escape="cancelEditTags"
            />
            <input
              v-model="noteDraft"
              placeholder="备注（可选）"
              class="w-full px-2 py-0.5 text-xs border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-500"
              @keydown.enter="saveTags"
              @keydown.escape="cancelEditTags"
            />
            <div class="flex gap-1">
              <button
                @click="saveTags"
                class="px-2 py-0.5 text-[10px] bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                保存
              </button>
              <button
                @click="cancelEditTags"
                class="px-2 py-0.5 text-[10px] bg-elevated text-secondary rounded bg-elevated-hover"
              >
                取消
              </button>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1">
            <span class="text-xs text-faint">{{ detectOS(d.userAgent) }}</span>
            <span class="text-xs text-faint whitespace-nowrap"
              >· {{ d.deviceType }} {{ d.viewportWidth }}×{{ d.viewportHeight }}</span
            >
            <span
              v-if="d.onlineAt"
              class="text-xs text-faint whitespace-nowrap"
              :title="new Date(d.onlineAt).toLocaleString()"
              >· {{ relativeTime(d.onlineAt) }}</span
            >
            <span v-if="d.errorCount > 0" class="text-xs text-red-500 font-medium whitespace-nowrap"
              >{{ d.errorCount }} 错误</span
            >
          </div>
        </li>
        <li v-if="devices.length === 0" class="px-4 py-8 text-center text-sm text-faint">
          暂无在线设备
        </li>
        <li
          v-else-if="filteredDevices.length === 0"
          class="px-4 py-8 text-center text-sm text-faint"
        >
          无匹配设备
        </li>
      </template>
    </ul>
  </aside>
</template>
