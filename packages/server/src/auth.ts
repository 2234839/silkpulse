/**
 * 安全鉴权模块 —— 项目管理 + 密钥验证 + 请求鉴权
 *
 * 鉴权架构：
 * - 超管密钥 (Admin Key)：环境变量 SILKPULSE_ADMIN_KEY 配置，全量权限
 * - 项目 (Project)：每个项目有唯一 projectId + apiKey，SDK 接入时携带
 * - 设备连接鉴权：WebSocket 连接 URL query 中携带 projectId + apiKey
 * - API 鉴权：Authorization: Bearer <key>（超管密钥或项目密钥）
 * - Console 鉴权：同 API，超管密钥看所有项目，项目密钥只看本项目
 *
 * 安全措施：
 * - 密钥哈希存储（scryptSync + salt），明文只在创建时返回一次
 * - 请求限流（滑动窗口，防暴力枚举）
 * - 定时密钥比较（timingSafeEqual 防时序攻击）
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { maybeGzipResponse } from './gzip.js'
import type { Ctx } from './uws/http-helpers.js'


// ─── 类型定义 ─────────────────────────────────────────────

/** 项目信息（存储结构，apiKey 已哈希） */
export interface Project {
  /** 项目唯一标识（cs_ 开头 + 随机 hex） */
  id: string
  /** 项目名称（人类可读） */
  name: string
  /** 项目描述（可选） */
  description?: string
  /** API 密钥的哈希值（scryptSync） */
  apiKeyHash: string
  /** 密钥盐值 */
  apiKeySalt: string
  /** 创建时间（ISO） */
  createdAt: string
  /** 最近更新时间（ISO） */
  updatedAt: string
  /** 是否启用（禁用后 SDK 无法接入） */
  enabled: boolean
}

/** 项目信息（对外展示，不含密钥哈希） */
export type ProjectPublic = Omit<Project, 'apiKeyHash' | 'apiKeySalt'>

/** 鉴权上下文（附加到 req 上） */
export interface AuthContext {
  /** 鉴权身份类型：admin=超管 | project=项目密钥 | device=设备WS（无密钥，可被管理端查看） | anonymous=未鉴权 */
  role: 'admin' | 'project' | 'anonymous'
  /** 项目 ID（role='project' 时有值，admin 可访问所有项目） */
  projectId?: string
}

// ─── 密钥工具 ─────────────────────────────────────────────

/** 生成随机 ID（指定前缀 + hex 长度） */
function generateId(prefix: string, hexLen = 16): string {
  return `${prefix}_${randomBytes(hexLen).toString('hex')}`
}

/** 生成随机 API Key 明文（返回给用户，只一次） */
export function generateApiKey(): string {
  return `cs_live_${randomBytes(24).toString('hex')}`
}

/** 哈希密钥（scryptSync + 随机 salt） */
function hashApiKey(plainKey: string): { hash: string; salt: string } {
  const salt = randomBytes(16)
  const hash = scryptSync(plainKey, salt, 64)
  return { hash: hash.toString('hex'), salt: salt.toString('hex') }
}

/** 验证明文密钥是否匹配哈希（timingSafeEqual 防时序攻击） */
function verifyApiKey(plainKey: string, hash: string, salt: string): boolean {
  const expectedHash = Buffer.from(hash, 'hex')
  const actualHash = scryptSync(plainKey, Buffer.from(salt, 'hex'), 64)
  if (expectedHash.length !== actualHash.length) return false
  return timingSafeEqual(expectedHash, actualHash)
}

/** 定时安全比较超管密钥 */
function safeEqual(a: string, b: string): boolean {
  /**
   * 双方先过一遍 SHA256 再 timingSafeEqual
   *
   * 直接比较会因长度早退泄露 adminKey 长度；SHA256 把任意输入归一成等长摘要，
   * 既隐藏真实长度，又保持恒定时间比较特性。
   */
  const da = createHash('sha256').update(a).digest()
  const db = createHash('sha256').update(b).digest()
  return timingSafeEqual(da, db)
}

// ─── 项目存储（JSON 文件持久化） ──────────────────────────

/**
 * 项目管理器 —— 负责项目的 CRUD + 密钥验证 + 持久化
 *
 * 数据存储为 JSON 文件（~/.silkpulse/projects.json 或指定路径）。
 * 适合个人/小团队场景，无需数据库依赖。
 */
/** 密钥验证成功缓存的容量上限：防恶意海量不同假 key 撑内存 */
const VERIFY_CACHE_MAX = 512

export class ProjectStore {
  private projects: Map<string, Project> = new Map()
  private filePath: string
  /**
   * 数据版本号：任何写操作递增
   *
   * 供密钥验证缓存做失效判断 —— 缓存记住取值时的版本号，
   * 读到的版本号不同即说明密钥可能已变（rotate/delete/disable），需重新 scrypt 验证。
   */
  private dataVersion = 0
  /**
   * 密钥验证成功缓存：明文密钥 → { projectId, 缓存时的数据版本号 }
   *
   * verifyKey 是全表 scrypt 扫描（每项目一次 ~32MB 同步计算），在 HTTP 热路径上
   * 每请求都要跑一遍，是最容易被打爆的 CPU 放大器。首次 scrypt 验证成功后缓存结果，
   * 后续同密钥请求直接查 Map（O(1)），项目数据变更时靠 dataVersion 失效。
   * 容量上限防恶意海量不同假 key 撑内存（命中不了缓存照旧走 scrypt，无额外风险）。
   */
  private verifyCache = new Map<string, { projectId: string; version: number }>()

  constructor(filePath: string) {
    this.filePath = filePath
    this.load()
  }

  /** 从 JSON 文件加载项目数据 */
  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const arr: Project[] = JSON.parse(raw)
      for (const p of arr) {
        this.projects.set(p.id, p)
      }
    } catch {
      /** 文件损坏时从空开始 */
    }
  }

  /** 保存到 JSON 文件（版本号随写入递增，作为缓存失效信号） */
  private save(): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const arr = Array.from(this.projects.values())
    writeFileSync(this.filePath, JSON.stringify(arr, null, 2), 'utf-8')
    this.dataVersion++
  }

  /**
   * 创建新项目
   * @returns 项目信息 + 明文 API Key（只返回这一次）
   */
  create(name: string, description?: string): { project: ProjectPublic; apiKey: string } {
    const id = generateId('cs', 12)
    const apiKey = generateApiKey()
    const { hash, salt } = hashApiKey(apiKey)
    const now = new Date().toISOString()
    const project: Project = {
      id,
      name,
      description,
      apiKeyHash: hash,
      apiKeySalt: salt,
      createdAt: now,
      updatedAt: now,
      enabled: true,
    }
    this.projects.set(id, project)
    this.save()
    const { apiKeyHash, apiKeySalt, ...publicInfo } = project
    return { project: publicInfo, apiKey }
  }

  /** 列出所有项目（不含密钥） */
  list(): ProjectPublic[] {
    return Array.from(this.projects.values()).map(p => {
      const { apiKeyHash, apiKeySalt, ...rest } = p
      return rest
    })
  }

  /** 获取项目（不含密钥） */
  get(projectId: string): ProjectPublic | undefined {
    const p = this.projects.get(projectId)
    if (!p) return undefined
    const { apiKeyHash, apiKeySalt, ...rest } = p
    return rest
  }

  /** 获取项目原始数据（含密钥哈希，仅供内部使用） */
  getRaw(projectId: string): Project | undefined {
    return this.projects.get(projectId)
  }

  /** 直接写入项目原始数据（供 Playground 项目初始化使用） */
  setRaw(projectId: string, project: Project): void {
    this.projects.set(projectId, project)
    this.save()
  }

  /** 更新项目密钥哈希（供 Playground key 变更时同步） */
  updateRaw(projectId: string, patch: { apiKeyHash: string; apiKeySalt: string }): void {
    const p = this.projects.get(projectId)
    if (!p) return
    p.apiKeyHash = patch.apiKeyHash
    p.apiKeySalt = patch.apiKeySalt
    p.updatedAt = new Date().toISOString()
    this.save()
  }

  /** 删除项目 */
  delete(projectId: string): boolean {
    if (!this.projects.delete(projectId)) return false
    this.save()
    return true
  }

  /** 更新项目信息 */
  update(projectId: string, patch: { name?: string; description?: string; enabled?: boolean }): ProjectPublic | undefined {
    const p = this.projects.get(projectId)
    if (!p) return undefined
    if (patch.name !== undefined) p.name = patch.name
    if (patch.description !== undefined) p.description = patch.description
    if (patch.enabled !== undefined) p.enabled = patch.enabled
    p.updatedAt = new Date().toISOString()
    this.save()
    const { apiKeyHash, apiKeySalt, ...rest } = p
    return rest
  }

  /**
   * 重新生成 API Key
   * @returns 新的明文密钥（只返回这一次）
   */
  rotateKey(projectId: string): string | undefined {
    const p = this.projects.get(projectId)
    if (!p) return undefined
    const newKey = generateApiKey()
    const { hash, salt } = hashApiKey(newKey)
    p.apiKeyHash = hash
    p.apiKeySalt = salt
    p.updatedAt = new Date().toISOString()
    this.save()
    return newKey
  }

  /**
   * 验证 API Key，返回对应的项目
   * @returns 项目 ID（验证成功）或 undefined（失败）
   */
  verifyKey(plainKey: string): string | undefined {
    /** 先查缓存：版本号一致直接返回，避免热路径上的同步 scrypt 计算 */
    const cached = this.verifyCache.get(plainKey)
    if (cached && cached.version === this.dataVersion) {
      const p = this.projects.get(cached.projectId)
      if (p?.enabled) return cached.projectId
      this.verifyCache.delete(plainKey)
      return undefined
    }
    // 遍历所有项目尝试验证（因为密钥是哈希的，不能直接反查）
    // 有缓存兜底后，只有冷启动/数据变更后的首次请求才走到这里
    for (const [id, p] of this.projects) {
      if (!p.enabled) continue
      if (verifyApiKey(plainKey, p.apiKeyHash, p.apiKeySalt)) {
        /** FIFO 淘汰：Map 保序，删最老的一条控制总量 */
        if (this.verifyCache.size >= VERIFY_CACHE_MAX) {
          const oldest = this.verifyCache.keys().next().value
          if (oldest !== undefined) this.verifyCache.delete(oldest)
        }
        this.verifyCache.set(plainKey, { projectId: id, version: this.dataVersion })
        return id
      }
    }
    return undefined
  }
}

// ─── 鉴权中间件 ───────────────────────────────────────────

/** 从请求中提取 Bearer token */
function extractBearerToken(ctx: Ctx): string | undefined {
  const auth = ctx.headers['authorization']
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim()
  }
  /** 回退：?key= query 参数（skill 文档拉取等场景，方便 agent 直接 curl） */
  return extractQueryParam(ctx.url, 'key')
}

/** 从 URL query 中提取参数 */
function extractQueryParam(url: string, key: string): string | undefined {
  try {
    const u = new URL(url, 'http://localhost')
    return u.searchParams.get(key) ?? undefined
  } catch {
    return undefined
  }
}

/**

 * AuthManager —— 鉴权核心管理器
 *
 * 统一管理超管密钥 + 项目密钥的验证逻辑，
 * 为 HTTP API 和 WebSocket 连接提供鉴权。
 */
export class AuthManager {
  /** 超管密钥（环境变量配置） */
  private adminKey: string | undefined
  /** 项目存储 */
  readonly projects: ProjectStore

  constructor(projectStore: ProjectStore) {
    this.adminKey = process.env.SILKPULSE_ADMIN_KEY
    this.projects = projectStore

    /** Playground 游客模式：初始化时创建/确保存在一个真实的公开项目 */
    this.ensurePlaygroundProject()
  }

  /** 是否启用了鉴权（配置了超管密钥或至少一个项目） */
  isAuthEnabled(): boolean {
    return !!this.adminKey || this.projects.list().length > 0
  }

  /** 检查是否配置了超管密钥 */
  hasAdminKey(): boolean {
    return !!this.adminKey
  }

  /** Playground 密钥（环境变量 SILKPULSE_PLAYGROUND_KEY 配置） */
  get playgroundKey(): string | undefined {
    return process.env.SILKPULSE_PLAYGROUND_KEY
  }

  /** 是否启用了 Playground（游客访问）模式 */
  isPlaygroundEnabled(): boolean {
    return !!this.playgroundKey
  }

  /** Playground 项目的固定 ID（真实项目，不是虚拟 ID） */
  static readonly PLAYGROUND_PROJECT_ID = 'cs_playground'

  /** Playground 项目名称 */
  static readonly PLAYGROUND_PROJECT_NAME = 'Playground'

  /**
   * 确保 Playground 项目存在：如果配置了 SILKPULSE_PLAYGROUND_KEY，
   * 就创建一个真实的公开项目（固定 ID + 固定名称），
   * apiKeyHash = hash(playgroundKey)。
   * 这样游客的权限隔离、设备归属、接入代码全部复用现有项目逻辑，零特殊处理。
   */
  private ensurePlaygroundProject(): void {
    const key = this.playgroundKey
    if (!key) return
    const pid = AuthManager.PLAYGROUND_PROJECT_ID
    /** 已存在则检查 key 是否需要更新（用户可能改了环境变量） */
    const existing = this.projects.getRaw(pid)
    const { hash, salt } = hashApiKey(key)
    if (existing) {
      /** key 没变就跳过 */
      if (verifyApiKey(key, existing.apiKeyHash, existing.apiKeySalt)) return
      this.projects.updateRaw(pid, { apiKeyHash: hash, apiKeySalt: salt })
      return
    }
    const now = new Date().toISOString()
    this.projects.setRaw(pid, {
      id: pid,
      name: AuthManager.PLAYGROUND_PROJECT_NAME,
      description: '游客公开体验项目（环境变量自动创建）',
      apiKeyHash: hash,
      apiKeySalt: salt,
      createdAt: now,
      updatedAt: now,
      enabled: true,
    })
  }

  /**
   * 验证 HTTP 请求的鉴权
   * @returns 鉴权上下文（role='anonymous' 表示未鉴权）
   */
  authorizeHttpRequest(ctx: Ctx): AuthContext {
    const token = extractBearerToken(ctx)

    // 无 token：检查是否匿名可用（未启用鉴权时）
    if (!token) {
      if (!this.isAuthEnabled()) return { role: 'admin' }
      return { role: 'anonymous' }
    }

    // 尝试超管密钥
    if (this.adminKey && safeEqual(token, this.adminKey)) {
      return { role: 'admin' }
    }

    // 尝试项目密钥（包括 Playground 项目）
    const projectId = this.projects.verifyKey(token)
    if (projectId) {
      return { role: 'project', projectId }
    }

    return { role: 'anonymous' }
  }

  /**
   * 验证 WebSocket 连接鉴权
   * @returns 鉴权上下文（role='anonymous' 表示未鉴权）
   */
  authorizeWsConnection(url: string, wsPath: string): AuthContext {
    // 未启用鉴权：允许匿名
    if (!this.isAuthEnabled()) return { role: 'admin' }

    // 控制台 WebSocket：需要超管密钥或项目密钥
    if (wsPath === '/ws/console') {
      const token = extractQueryParam(url, 'token')
      if (!token) return { role: 'anonymous' }
      // 超管密钥
      if (this.adminKey && safeEqual(token, this.adminKey)) {
        return { role: 'admin' }
      }
      // 项目密钥（包括 Playground 项目）
      const pid = this.projects.verifyKey(token)
      if (pid) return { role: 'project', projectId: pid }
      return { role: 'anonymous' }
    }

    // 设备 WebSocket：鉴权模式下必须凭有效项目密钥接入
    if (wsPath === '/ws/device') {
      const token = extractQueryParam(url, 'apiKey')
      if (!token) return { role: 'anonymous' }
      /** projectId 一律从密钥反查，不信任 query 参数（防伪造归属项目） */
      const pid = this.projects.verifyKey(token)
      if (pid) return { role: 'project', projectId: pid }
      return { role: 'anonymous' }
    }

    return { role: 'anonymous' }
  }

  /**
   * 检查鉴权上下文是否有权限访问指定项目
   */
  canAccessProject(ctx: AuthContext, projectId: string): boolean {
    if (ctx.role === 'admin') return true
    if (ctx.role === 'project') return ctx.projectId === projectId
    return false
  }

  /**
   * 检查鉴权上下文是否有权限访问指定设备
  /**
   * 检查鉴权上下文是否有权限访问指定设备
   * @param ctx 鉴权上下文
   * @param deviceProjectId 设备所属项目 ID（undefined 表示公共设备，无项目归属）
   */
  canAccessDevice(ctx: AuthContext, deviceProjectId?: string): boolean {
    if (ctx.role === 'admin') return true
    if (ctx.role === 'project') return ctx.projectId === deviceProjectId
    return false
  }
}

// ─── 项目管理 API 路由 ────────────────────────────────────

/** 安全响应头（注入 sendJson 的 headers） */
function securityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  }
}

/** JSON 响应（安全头 + gzip） */
function jsonResponse(ctx: Ctx, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  const { body: respBody, headers } = maybeGzipResponse(
    { headers: ctx.headers },
    json,
    {
      'Content-Type': 'application/json; charset=utf-8',
      ...securityHeaders(),
    },
  )
  if (ctx.responded || ctx.aborted) return
  ctx.responded = true
  ctx.res.cork(() => {
    ctx.res.writeStatus(`${status} ${status === 204 ? 'No Content' : status === 200 ? 'OK' : status === 201 ? 'Created' : status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : status === 400 ? 'Bad Request' : 'Unknown'}`)
    for (const [k, v] of Object.entries(headers)) {
      ctx.res.writeHeader(k, v)
    }
    ctx.res.end(respBody)
  })
}

/**
 * 处理项目管理 API 路由
 *
 * 路由表：
 * - GET    /api/projects          — 列出项目（仅超管）
 * - POST   /api/projects          — 创建项目（仅超管）
 * - GET    /api/projects/:id      — 获取项目详情（仅超管）
 * - PATCH  /api/projects/:id      — 更新项目（仅超管）
 * - DELETE /api/projects/:id      — 删除项目（仅超管）
 * - POST   /api/projects/:id/rotate — 重新生成密钥（仅超管）
 * - GET    /api/auth/status       — 查询鉴权状态（公开）
 *
 * @returns true=已处理, false=不匹配
 */
export function handleProjectApiRoute(
  ctx: Ctx,
  auth: AuthManager,
): boolean {
  const url = ctx.url.split('?')[0]
  const method = ctx.method

  /** CORS 预检 */
  if (url.startsWith('/api/projects') && method === 'OPTIONS') {
    if (ctx.responded) return true
    ctx.responded = true
    ctx.res.cork(() => {
      ctx.res.writeStatus('204 No Content')
      for (const [k, v] of Object.entries(securityHeaders())) {
        ctx.res.writeHeader(k, v)
      }
      ctx.res.endWithoutBody()
    })
    return true
  }

  /** 鉴权状态查询（公开） */
  if (url === '/api/auth/status' && method === 'GET') {
    jsonResponse(ctx, 200, {
      authEnabled: auth.isAuthEnabled(),
      hasAdminKey: auth.hasAdminKey(),
      playgroundEnabled: auth.isPlaygroundEnabled(),
    })
    return true
  }

  /** 验证密钥并返回角色信息（前端登录后调用，拿 role + projectId） */
  if (url === '/api/auth/verify' && method === 'GET') {
    const verifyCtx = auth.authorizeHttpRequest(ctx)
    if (verifyCtx.role === 'anonymous') {
      jsonResponse(ctx, 401, { error: '密钥无效' })
      return true
    }
    /** 项目密钥：附带项目名称供前端展示 */
    let projectName: string | undefined
    let isPlayground = false
    if (verifyCtx.role === 'project' && verifyCtx.projectId) {
      const proj = auth.projects.get(verifyCtx.projectId)
      projectName = proj?.name
      isPlayground = verifyCtx.projectId === AuthManager.PLAYGROUND_PROJECT_ID
    }
    jsonResponse(ctx, 200, {
      role: verifyCtx.role,
      projectId: verifyCtx.projectId,
      projectName,
      isPlayground,
    })
    return true
  }

  /**
   * 游客一键登录：返回 playground key 作为 token，
   * 前端保存后用作后续请求的 Authorization。
   */
  if (url === '/api/auth/playground' && method === 'POST') {
    if (!auth.isPlaygroundEnabled()) {
      jsonResponse(ctx, 403, { error: 'Playground 未开启' })
      return true
    }
    const key = auth.playgroundKey!
    const pid = AuthManager.PLAYGROUND_PROJECT_ID
    jsonResponse(ctx, 200, {
      role: 'project',
      projectId: pid,
      projectName: AuthManager.PLAYGROUND_PROJECT_NAME,
      isPlayground: true,
      /** 前端保存此 key 作为后续请求的 token */
      token: key,
    })
    return true
  }

  // 项目管理路由需要超管权限
  if (!url.startsWith('/api/projects')) return false

  const authResult = auth.authorizeHttpRequest(ctx)
  if (authResult.role !== 'admin') {
    jsonResponse(ctx, 403, { error: '需要超管权限' })
    return true
  }

  /** 列出项目 */
  if (url === '/api/projects' && method === 'GET') {
    jsonResponse(ctx, 200, { projects: auth.projects.list() })
    return true
  }

  /** 创建项目 */
  if (url === '/api/projects' && method === 'POST') {
    let body: { name?: string; description?: string }
    try {
      body = JSON.parse(readBodySync(ctx))
    } catch {
      jsonResponse(ctx, 400, { error: '请求体格式错误' })
      return true
    }
    if (!body.name) {
      jsonResponse(ctx, 400, { error: '项目名称必填' })
      return true
    }
    const result = auth.projects.create(body.name, body.description)
    jsonResponse(ctx, 201, result)
    return true
  }

  /** 单项目操作 /api/projects/:id... */
  const match = url.match(/^\/api\/projects\/([^/]+)(\/.*)?$/)
  if (!match) {
    jsonResponse(ctx, 404, { error: '路由不匹配' })
    return true
  }

  const [, projectId, subPath] = match

  /**
   * Playground 项目由环境变量管理，禁止轮换密钥、禁用、删除。
   * 只允许 GET（查看）。
   */
  const isPlaygroundProject = projectId === AuthManager.PLAYGROUND_PROJECT_ID
  if (isPlaygroundProject && method !== 'GET') {
    jsonResponse(ctx, 403, { error: 'Playground 项目由环境变量管理，不支持此操作' })
    return true
  }

  /** 重新生成密钥 */
  if (subPath === '/rotate' && method === 'POST') {
    const newKey = auth.projects.rotateKey(projectId)
    if (!newKey) {
      jsonResponse(ctx, 404, { error: '项目不存在' })
      return true
    }
    jsonResponse(ctx, 200, { apiKey: newKey })
    return true
  }

  /** 获取项目详情 */
  if (!subPath && method === 'GET') {
    const project = auth.projects.get(projectId)
    if (!project) {
      jsonResponse(ctx, 404, { error: '项目不存在' })
      return true
    }
    jsonResponse(ctx, 200, { project })
    return true
  }

  /** 更新项目 */
  if (!subPath && method === 'PATCH') {
    let body: { name?: string; description?: string; enabled?: boolean }
    try {
      body = JSON.parse(readBodySync(ctx))
    } catch {
      jsonResponse(ctx, 400, { error: '请求体格式错误' })
      return true
    }
    const project = auth.projects.update(projectId, body)
    if (!project) {
      jsonResponse(ctx, 404, { error: '项目不存在' })
      return true
    }
    jsonResponse(ctx, 200, { project })
    return true
  }

  /** 删除项目 */
  if (!subPath && method === 'DELETE') {
    const deleted = auth.projects.delete(projectId)
    if (!deleted) {
      jsonResponse(ctx, 404, { error: '项目不存在' })
      return true
    }
    jsonResponse(ctx, 200, { ok: true })
    return true
  }

  jsonResponse(ctx, 404, { error: '未知路由' })
  return true
}

/**
 * 同步读取请求体（项目管理 API 用，body 已由前置 readBody 缓存到 ctx.bodyBuf）
 */
function readBodySync(ctx: Ctx): string {
  return ctx.bodyBuf ? ctx.bodyBuf.toString('utf-8') : ''
}

/** 从缓存的请求体中读取 JSON */
export function getCachedBody<T = unknown>(ctx: Ctx): T | undefined {
  const buf = ctx.bodyBuf
  if (!buf || buf.length === 0) return undefined
  try {
    return JSON.parse(buf.toString('utf-8')) as T
  } catch {
    return undefined
  }
}
