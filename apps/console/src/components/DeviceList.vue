<script setup lang="ts">
/**
 * 左侧设备列表
 *
 * 功能：搜索、设备卡片（标题/URL/标签/备注/OS/项目徽章）、
 * 内联标签编辑。
 */
import { ref, computed, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import type { DeviceInfo } from "@silkpulse/shared";
import { apiFetch } from "../utils/api";

const { t } = useI18n();

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

/** 设备是否在线（server 侧保留离线设备，仅标记 offlineAt） */
function isOnline(d: DeviceInfo): boolean {
  return d.offlineAt === undefined;
}

/** 在线设备数（离线设备保留展示但不计入在线数） */
const onlineCount = computed(() => props.devices.filter(isOnline).length);

/**
 * 列表排序：在线设备在前，组内按 onlineAt 降序（新连接的设备排前面）；
 * 离线设备沉底，按离线时间降序。
 */
const sortedDevices = computed(() => {
  return [...props.devices].sort((a, b) => {
    const aOnline = isOnline(a);
    const bOnline = isOnline(b);
    if (aOnline !== bOnline) return aOnline ? -1 : 1;
    if (aOnline) return b.onlineAt - a.onlineAt;
    return (b.offlineAt ?? 0) - (a.offlineAt ?? 0);
  });
});

/** 搜索关键字 */
const deviceSearch = ref("");

/** 过滤后的设备列表 */
const filteredDevices = computed(() => {
  const q = deviceSearch.value.trim().toLowerCase();
  if (!q) return sortedDevices.value;
  return sortedDevices.value.filter(
    (d) =>
      d.title.toLowerCase().includes(q) ||
      d.url.toLowerCase().includes(q) ||
      (d.deviceType ?? "").toLowerCase().includes(q) ||
      (d.tags ?? []).some((t) => t.toLowerCase().includes(q)) ||
      (d.note ?? "").toLowerCase().includes(q),
  );
});

/** 无项目归属的分组 key（内部标识，不直接展示；展示名走消息包 ungrouped） */
const NO_PROJECT = "__ungrouped__";
/** 分组 key（projectId 或 NO_PROJECT）→ 项目名 */
function groupLabel(key: string): string {
  if (key === NO_PROJECT) return t("deviceList.ungrouped");
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

/** 删除中的设备 ID（防重复点击） */
const deletingDeviceId = ref<string | null>(null);

/** 硬删设备（含历史缓冲数据），仅离线设备展示删除入口 */
async function removeDevice(device: DeviceInfo) {
  if (!confirm(t("deviceList.confirmDelete", { name: device.title }))) return;
  deletingDeviceId.value = device.id;
  try {
    await apiFetch(`/api/devices/${device.id}`, { method: "DELETE" });
    /** server 删除后会广播 device-list 刷新，这里无需手动更新 */
  } catch {
    /** 删除失败：列表不变，用户可重试 */
  }
  deletingDeviceId.value = null;
}

/** 一键清理中的分组 key（防重复点击） */
const clearingGroupKey = ref<string | null>(null);

/** 一键清理某分组（超管传 group.key；非超管传 undefined = 当前项目全部）的离线设备 */
async function clearOfflineDevices(groupKey?: string) {
  const scoped =
    groupKey === undefined
      ? props.devices
      : (groupedDevices.value.find((g) => g.key === groupKey)?.devices ?? []);
  const offline = scoped.filter((d) => !isOnline(d));
  if (offline.length === 0) return;
  const scopeLabel = groupKey === undefined ? t("deviceList.currentScope") : groupLabel(groupKey);
  if (!confirm(t("deviceList.confirmClearOffline", { scope: scopeLabel, count: offline.length })))
    return;
  clearingGroupKey.value = groupKey ?? "__all__";
  try {
    /** projectId=none 表示未分组设备；不传 = 全部（项目用户由 server 侧强制限定为自己项目） */
    let q = "";
    if (groupKey === NO_PROJECT) q = "?projectId=none";
    else if (groupKey && groupKey !== "__all__") q = `?projectId=${encodeURIComponent(groupKey)}`;
    await apiFetch(`/api/devices${q}`, { method: "DELETE" });
    /** server 删除后会广播 device-list 更新，这里无需手动更新 */
  } catch {
    /** 清理失败：列表不变，用户可重试 */
  }
  clearingGroupKey.value = null;
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
const relativeTimeTimer = setInterval(() => {
  now.value = Date.now();
}, 30000);
onUnmounted(() => clearInterval(relativeTimeTimer));

function relativeTime(ts: number): string {
  const elapsed = Math.max(0, now.value - ts);
  const mins = Math.floor(elapsed / 60000);
  if (mins < 1) return t("deviceList.justNow");
  if (mins < 60) return t("deviceList.minsAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("deviceList.hoursAgo", { n: hours });
  return t("deviceList.daysAgo", { n: Math.floor(hours / 24) });
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
        {{ t("deviceList.onlineDevices") }}
        <span class="text-faint font-normal">({{ onlineCount }}/{{ devices.length }})</span>
        <button
          v-if="!isAdmin && onlineCount < devices.length"
          @click="clearOfflineDevices()"
          :disabled="clearingGroupKey === '__all__'"
          class="ml-auto text-[10px] text-faint hover:text-red-500 disabled:opacity-40"
          :title="t('deviceList.clearOfflineAllTitle')"
        >
          {{ t("deviceList.clearOffline") }}
        </button>
      </h2>
      <input
        v-model="deviceSearch"
        :placeholder="t('deviceList.searchPlaceholder')"
        class="mt-2 w-full px-2.5 py-1.5 text-xs border border-input rounded-lg bg-input text-primary placeholder:text-faint focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15 transition"
      />
    </div>
    <ul>
      <!-- 超管模式：按项目分组 -->
      <template v-if="isAdmin">
        <template v-for="group in groupedDevices" :key="group.key">
          <div
            class="px-4 py-1.5 bg-base/50 border-b border-light sticky top-0 z-10 flex items-center gap-1"
          >
            <span class="text-xs font-semibold text-secondary">{{ group.label }}</span>
            <span class="text-faint font-normal ml-1">({{ group.devices.length }})</span>
            <button
              v-if="group.devices.some((d) => !isOnline(d))"
              @click="clearOfflineDevices(group.key)"
              :disabled="clearingGroupKey === group.key"
              class="ml-auto text-[10px] text-faint hover:text-red-500 disabled:opacity-40"
              :title="t('deviceList.clearOfflineGroupTitle')"
            >
              {{ t("deviceList.clearOffline") }}
            </button>
          </div>
          <li
            v-for="d in group.devices"
            :key="d.id"
            @click="emit('select', d.id)"
            class="px-4 py-3 border-b border-light cursor-pointer hover:bg-base relative transition-colors"
            :class="[
              selectedDeviceId === d.id ? 'bg-blue-soft border-l-2 border-l-blue-500' : '',
              !isOnline(d) ? 'opacity-60' : '',
            ]"
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
              <!-- 离线徽章：设备保留在列表中，缓存数据仍可查看 -->
              <span
                v-if="!isOnline(d)"
                class="ml-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-base text-faint align-middle"
                :title="
                  t('deviceList.offlineSince', { time: new Date(d.offlineAt!).toLocaleString() })
                "
                >{{ t("deviceList.offline") }}</span
              >
              <!-- 编辑标签按钮 -->
              <button
                v-if="selectedDeviceId === d.id && editingTagDeviceId !== d.id"
                @click.stop="startEditTags(d.id)"
                class="ml-1 text-faint hover:text-blue-500 text-xs align-middle"
                :title="t('deviceList.editTagsTitle')"
              >
                🏷️
              </button>
              <!-- 删除按钮：仅离线设备展示（在线设备误点会丢数据） -->
              <button
                v-if="!isOnline(d)"
                @click.stop="removeDevice(d)"
                :disabled="deletingDeviceId === d.id"
                class="ml-1 text-faint hover:text-red-500 text-xs align-middle disabled:opacity-40"
                :title="t('deviceList.deleteDeviceTitle')"
              >
                🗑️
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
                :placeholder="t('deviceList.tagsPlaceholder')"
                class="w-full px-2 py-0.5 text-xs border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-500"
                @keydown.enter="saveTags"
                @keydown.escape="cancelEditTags"
              />
              <input
                v-model="noteDraft"
                :placeholder="t('deviceList.notePlaceholder')"
                class="w-full px-2 py-0.5 text-xs border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-500"
                @keydown.enter="saveTags"
                @keydown.escape="cancelEditTags"
              />
              <div class="flex gap-1">
                <button
                  @click="saveTags"
                  class="px-2 py-0.5 text-[10px] bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  {{ t("deviceList.save") }}
                </button>
                <button
                  @click="cancelEditTags"
                  class="px-2 py-0.5 text-[10px] bg-elevated text-secondary rounded bg-elevated-hover"
                >
                  {{ t("deviceList.cancel") }}
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
                >{{ t("deviceList.errorCount", { count: d.errorCount }) }}</span
              >
            </div>
          </li>
        </template>
        <li v-if="devices.length === 0" class="px-4 py-8 text-center text-sm text-faint">
          {{ t("deviceList.empty") }}
        </li>
        <li
          v-else-if="filteredDevices.length === 0"
          class="px-4 py-8 text-center text-sm text-faint"
        >
          {{ t("deviceList.noMatch") }}
        </li>
      </template>

      <!-- 项目用户/游客模式：平铺显示 -->
      <template v-else>
        <li
          v-for="d in filteredDevices"
          :key="d.id"
          @click="emit('select', d.id)"
          class="px-4 py-3 border-b border-light cursor-pointer hover:bg-base relative transition-colors"
          :class="[
            selectedDeviceId === d.id ? 'bg-blue-soft border-l-2 border-l-blue-500' : '',
            !isOnline(d) ? 'opacity-60' : '',
          ]"
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
            <!-- 离线徽章：设备保留在列表中，缓存数据仍可查看 -->
            <span
              v-if="!isOnline(d)"
              class="ml-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-base text-faint align-middle"
              :title="
                t('deviceList.offlineSince', { time: new Date(d.offlineAt!).toLocaleString() })
              "
              >{{ t("deviceList.offline") }}</span
            >
            <button
              v-if="selectedDeviceId === d.id && editingTagDeviceId !== d.id"
              @click.stop="startEditTags(d.id)"
              class="ml-1 text-faint hover:text-blue-500 text-xs align-middle"
              :title="t('deviceList.editTagsTitle')"
            >
              🏷️
            </button>
            <!-- 删除按钮：仅离线设备展示（在线设备误点会丢数据） -->
            <button
              v-if="!isOnline(d)"
              @click.stop="removeDevice(d)"
              :disabled="deletingDeviceId === d.id"
              class="ml-1 text-faint hover:text-red-500 text-xs align-middle disabled:opacity-40"
              :title="t('deviceList.deleteDeviceTitle')"
            >
              🗑️
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
              :placeholder="t('deviceList.tagsPlaceholder')"
              class="w-full px-2 py-0.5 text-xs border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-500"
              @keydown.enter="saveTags"
              @keydown.escape="cancelEditTags"
            />
            <input
              v-model="noteDraft"
              :placeholder="t('deviceList.notePlaceholder')"
              class="w-full px-2 py-0.5 text-xs border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-500"
              @keydown.enter="saveTags"
              @keydown.escape="cancelEditTags"
            />
            <div class="flex gap-1">
              <button
                @click="saveTags"
                class="px-2 py-0.5 text-[10px] bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                {{ t("deviceList.save") }}
              </button>
              <button
                @click="cancelEditTags"
                class="px-2 py-0.5 text-[10px] bg-elevated text-secondary rounded bg-elevated-hover"
              >
                {{ t("deviceList.cancel") }}
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
              >{{ t("deviceList.errorCount", { count: d.errorCount }) }}</span
            >
          </div>
        </li>
        <li v-if="devices.length === 0" class="px-4 py-8 text-center text-sm text-faint">
          {{ t("deviceList.emptyOnline") }}
        </li>
        <li
          v-else-if="filteredDevices.length === 0"
          class="px-4 py-8 text-center text-sm text-faint"
        >
          {{ t("deviceList.noMatch") }}
        </li>
      </template>
    </ul>
  </aside>
</template>
