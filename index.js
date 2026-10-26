/**
 * dsh-prime-diary — 宿主半边。
 *
 * 扫描 ~/.dsh/sessions 的会话日志 → 按间隔/上下文阈值触发 → 调宿主 LLM
 * 生成「日记 + 重要记忆候选」草稿 → UI 审阅 → 采纳（写入 prime 的 outbox，
 * 直写 L1 的通道在下一阶段接通）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const PLUGIN = 'dsh-prime-diary'
const CHANNEL = '/prime-diary'
const RPC = 'prime-diary'

const DEFAULTS = {
  enabled: true,
  intervalDays: 1,
  dailyAt: '23:00',
  contextThreshold: 85,
  contextCheckMinutes: 15,
  autoSnapshot: true,
  autoRefine: false,
  autoDigestMode: '项目',
  sessionModes: {},
  skipProbability: 0.2,
  minChars: 10,
  maxChars: 500,
  importanceThresholdProject: 0.6,
  importanceThresholdChat: 0.6,
  diaryCandidateLimit: 8,
  autoAdopt: false,
  includedSessions: null,
  hideArchived: true,
  archiveEnabled: true,
  archiveDir: '',
  snapshotBookDir: '',
  diaryBookEnabled: true,
  diaryBookDir: '',
  llmProvider: '',
  llmModel: '',
  maxInputTokens: 12000,
}

const MODES = ['项目', '闲聊', '全部']
function normalizeMode(m) {
  if (m === '闲谈' || m === '聊天' || m === '闲聊') return '闲聊'
  if (m === '全部') return '全部'
  return '项目'
}

const HOME = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA = () => path.join(HOME(), 'prime-diary')
const DRAFTS = () => path.join(DATA(), 'drafts')
const OUTBOX = () => path.join(DATA(), 'outbox')
const DIGESTS = () => path.join(DATA(), 'digests')
const STATE_FILE = () => path.join(DATA(), 'state.json')
const DEBUG_LOG = () => path.join(DATA(), 'debug.log')
function localDay(ts = Date.now()) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function dbg(msg) { try { fs.appendFileSync(DEBUG_LOG(), `${new Date().toISOString()} ${msg}\n`) } catch {} }
const CONFIG_FILE = () => path.join(DATA(), 'config.json')

function ensure(dir) { fs.mkdirSync(dir, { recursive: true }) }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, data) {
  ensure(path.dirname(file))
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}
function loadConfig() {
  const file = readJson(CONFIG_FILE(), {})
  const cfg = { ...DEFAULTS, ...file }
  cfg.autoDigestMode = normalizeMode(cfg.autoDigestMode)
  {
    const sm = {}
    for (const [k, v] of Object.entries(cfg.sessionModes || {})) sm[k] = normalizeMode(v)
    cfg.sessionModes = sm
  }
  if (file.importanceThreshold != null) {
    if (file.importanceThresholdProject == null) cfg.importanceThresholdProject = Number(file.importanceThreshold)
    if (file.importanceThresholdChat == null) cfg.importanceThresholdChat = Number(file.importanceThreshold)
  }
  delete cfg.importanceThreshold
  return cfg
}
function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch }
  next.snapshotBookDir = String(next.snapshotBookDir || '').trim()
  if (Array.isArray(next.includedSessions)) next.includedSessions = next.includedSessions.map(String)
  else next.includedSessions = null
  delete next.excludedSessions
  next.intervalDays = Math.min(7, Math.max(1, Math.round(Number(next.intervalDays) || 1)))
  const prevCfg = loadConfig()
  const wantDailyAt = normalizeDailyAt(next.dailyAt)
  const scheduleChanged = wantDailyAt !== normalizeDailyAt(prevCfg.dailyAt) ||
    next.intervalDays !== Math.max(1, Math.round(Number(prevCfg.intervalDays) || 1))
  next.dailyAt = wantDailyAt
  next.scheduleAnchor = scheduleChanged ? localDay(Date.now()) : anchorDateOf(next)
  next.contextThreshold = Math.min(100, Math.max(0, Number(next.contextThreshold) || 0))
  next.contextCheckMinutes = Math.min(1440, Math.max(1, Math.round(Number(next.contextCheckMinutes) || 15)))
  next.autoSnapshot = next.autoSnapshot !== false
  next.autoRefine = next.autoRefine === true
  next.skipProbability = Math.min(1, Math.max(0, Number(next.skipProbability) || 0))
  next.minChars = Math.max(1, Number(next.minChars) || 10)
  next.maxChars = Math.max(next.minChars, Number(next.maxChars) || 500)
  const legacy = next.importanceThreshold
  if (legacy != null) {
    if (next.importanceThresholdProject == null) next.importanceThresholdProject = legacy
    if (next.importanceThresholdChat == null) next.importanceThresholdChat = legacy
    delete next.importanceThreshold
  }
  next.importanceThresholdProject = Math.min(1, Math.max(0, Number(next.importanceThresholdProject) || 0.6))
  next.importanceThresholdChat = Math.min(1, Math.max(0, Number(next.importanceThresholdChat) || 0.6))
  delete next.importanceThreshold
  next.diaryCandidateLimit = Math.min(30, Math.max(2, Math.round(Number(next.diaryCandidateLimit) || 8)))
  next.autoDigestMode = normalizeMode(next.autoDigestMode)
  {
    const sm = {}
    if (next.sessionModes && typeof next.sessionModes === 'object') { for (const [k, v] of Object.entries(next.sessionModes)) sm[k] = normalizeMode(v) }
    next.sessionModes = sm
  }
  writeJson(CONFIG_FILE(), next)
  return next
}
function loadState() {
  return { lastRunAt: 0, nextAt: 0, lastSkip: 0, lastError: '', ...readJson(STATE_FILE(), {}) }
}
function saveState(state) { writeJson(STATE_FILE(), state) }

// ── 固定时刻调度 ────────────────────────────────────────────────────────────
// 语义：锚点日(YYYY-MM-DD) + 每 intervalDays 天的 dailyAt(HH:mm) 即为一个生成时刻。
// 自动生成后**不回写锚点**，因此时刻永远对齐，不会越跑越漂。
// 「立即生成」不触碰 lastRunAt / nextAt / 锚点（2026-10-26 产品方要求）。
function normalizeDailyAt(v) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v ?? '').trim())
  if (!m) return '23:00'
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)))
  const mi = Math.min(59, Math.max(0, parseInt(m[2], 10)))
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}
function anchorDateOf(cfg) {
  const a = String(cfg?.scheduleAnchor ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(a)) return a
  return localDay(Date.now())
}
function slotMsOf(dateStr, dailyAt) {
  const [h, mi] = normalizeDailyAt(dailyAt).split(':').map(Number)
  const d = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(d.getTime())) return NaN
  d.setHours(h, mi, 0, 0)
  return d.getTime()
}
function nextSlotFrom(now, cfg) {
  const step = Math.max(1, Math.round(Number(cfg?.intervalDays) || 1)) * 86400000
  const base = slotMsOf(anchorDateOf(cfg), cfg?.dailyAt)
  if (!Number.isFinite(base)) return now + step
  if (base > now) return base
  const k = Math.floor((now - base) / step) + 1
  return base + k * step
}
function scheduleSignature(cfg) {
  return `${normalizeDailyAt(cfg?.dailyAt)}|${Math.max(1, Math.round(Number(cfg?.intervalDays) || 1))}|${anchorDateOf(cfg)}`
}

const PRIME_DB = () => path.join(HOME(), 'memory', 'memory.db')
const BACKUP_DIR = () => path.join(DATA(), 'backups')
let jiebaCut = null
try {
  const req = createRequire(import.meta.url)
  const j = req('@node-rs/jieba')
  if (j && typeof j.cut === 'function') jiebaCut = (t) => j.cut(t, true)
} catch {}

function segment(text) {
  const raw = String(text || '')
  try { if (jiebaCut) { const toks = jiebaCut(raw).filter(Boolean); if (toks.length) return toks.join(' ') } } catch {}
  return (raw.match(/[\u4e00-\u9fff]|[A-Za-z0-9_]+/g) || []).join(' ')
}
const sqlEsc = (s) => String(s == null ? '' : s).replace(/'/g, "''")

function backupPrimeDb() {
  ensure(BACKUP_DIR())
  const dst = path.join(BACKUP_DIR(), `memory-${Date.now()}.db`)
  execFileSync('sqlite3', [PRIME_DB(), `VACUUM INTO '${sqlEsc(dst)}'`], { stdio: 'pipe' })
  return dst
}

function normType(t) {
  const map = {
    work_decision: 'important_decision_experience',
    user_pref: 'user_info',
    common_pitfalls: 'common_pitfalls_experience',
    emotion_event: 'episodic',
  }
  return map[String(t || '')] || String(t || 'episodic')
}

function writePrime(tag, memories, dbPath = PRIME_DB(), opts = {}) {
  if (!fs.existsSync(dbPath)) throw new Error('prime memory.db 不存在: ' + dbPath)
  const real = dbPath === PRIME_DB()
  const backup = real ? backupPrimeDb() : null
  const db = dbPath
  const now = new Date().toISOString()
  const extPrefix = opts.extPrefix || 'diary'
  const sceneRoot = opts.sceneRoot || '日记'
  const existing = new Set(
    execFileSync('sqlite3', [db, `SELECT ext_key FROM l1_records WHERE ext_key LIKE '${sqlEsc(extPrefix)}-${sqlEsc(tag)}-%';`], { encoding: 'utf8' })
      .split('\n').filter(Boolean),
  )
  const planned = (memories || []).filter(m => String(m?.content || '').trim()).length
  const rows = []
  ;(memories || []).forEach((m, i) => {
    const content = String(m?.content || '').trim()
    if (!content) return
    const ext = m.ext_key || `${extPrefix}-${tag}-${i + 1}`
    if (existing.has(ext)) return
    const type = normType(m.type)
    const importance = Math.min(1, Math.max(0, Number(m.importance) || 0.6))
    const rid = `mem_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    const meta = JSON.stringify({ hall: 'work', status: 'adopted', source: 'prime-diary', diary_date: tag, scene_root: sceneRoot, importance })
    rows.push({ rid, content, type, priority: Math.round(importance * 100), scene: `${sceneRoot}/${tag}`, ext, seg: segment(content), meta, ts: now })
  })
  if (!rows.length) return { written: 0, planned, skippedExisting: planned, backup, total: existing.size }
  const stmts = rows.map((r) => `
INSERT INTO l1_records (record_id, content, type, priority, scene_name, session_id, version, timestamp_str, timestamp_start, timestamp_end, created_time, updated_time, metadata_json, family, scope, workspace_id, repo_key_name, repo_key_owner, applicability, ext_key, name, valid_from, valid_to, persistence)
VALUES ('${sqlEsc(r.rid)}','${sqlEsc(r.content)}','${sqlEsc(r.type)}',${r.priority},'${sqlEsc(r.scene)}','default',0,'${r.ts}','${r.ts}','${r.ts}','${r.ts}','${r.ts}','${sqlEsc(r.meta)}','work','global','','','','','${sqlEsc(r.ext)}','','','','');
INSERT INTO l1_fts (keywords, content, content_original, record_id, type, priority, scene_name, session_id, version, timestamp_str, timestamp_start, timestamp_end, metadata_json, family, scope, workspace_id)
VALUES ('${sqlEsc(r.seg)}','${sqlEsc(r.seg)}','${sqlEsc(r.content)}','${sqlEsc(r.rid)}','${sqlEsc(r.type)}',${r.priority},'${sqlEsc(r.scene)}','default',0,'${r.ts}','${r.ts}','${r.ts}','${sqlEsc(r.meta)}','work','global','');`).join('\n')
  execFileSync('sqlite3', [db], { input: `BEGIN IMMEDIATE;\n${stmts}\nCOMMIT;\n`, encoding: 'utf8' })
  const total = Number(execFileSync('sqlite3', [db, `SELECT count(*) FROM l1_records WHERE ext_key LIKE '${sqlEsc(extPrefix)}-${sqlEsc(tag)}-%';`], { encoding: 'utf8' }).trim())
  return { written: rows.length, planned, skippedExisting: planned - rows.length, total, backup }
}

function diagWriteTest() {
  ensure(BACKUP_DIR())
  const copy = path.join(BACKUP_DIR(), `write-test-${Date.now()}.db`)
  execFileSync('sqlite3', [PRIME_DB(), `VACUUM INTO '${sqlEsc(copy)}'`], { stdio: 'pipe' })
  const r = writePrime('diag', [{ content: '日记写入通道自检（测试记录）', type: 'work_fact', importance: 0.99 }], copy)
  const fts = execFileSync('sqlite3', [copy, "SELECT count(*) FROM l1_fts WHERE l1_fts MATCH '日记';"], { encoding: 'utf8' }).trim()
  return { ok: r.written > 0 && Number(fts) > 0, ...r, ftsTotal: Number(fts), copy }
}

function walkSessionFiles() {
  const root = path.join(HOME(), 'sessions')
  const out = []
  let workspaces = []
  try { workspaces = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()) } catch { return out }
  for (const ws of workspaces) {
    const wsDir = path.join(root, ws.name)
    let sessions = []
    try { sessions = fs.readdirSync(wsDir, { withFileTypes: true }).filter(d => d.isDirectory()) } catch { continue }
    for (const s of sessions) {
      const file = path.join(wsDir, s.name, 'session.v4.jsonl.zstd')
      if (fs.existsSync(file)) out.push({ file, workspace: ws.name, sessionId: s.name })
    }
  }
  return out
}


function decodeZstd(buf) {
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
  const starts = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
  }
  if (starts.length <= 1) return zlib.zstdDecompressSync(buf)
  const parts = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    parts.push(zlib.zstdDecompressSync(buf.subarray(starts[k], end)))
  }
  return Buffer.concat(parts)
}

function readSession(file) {
  let text
  try { text = decodeZstd(fs.readFileSync(file)).toString('utf8') } catch (err) { dbg('decode fail ' + file + ' :: ' + String(err?.message || err)); return null }
  const lines = text.split('\n').filter(Boolean)
  let title = ''
  const messages = []
  let lastUsage = null
  let maxInput = 0
  let firstAt = 0
  let lastAt = 0
  for (const line of lines) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.time) { if (!firstAt) firstAt = e.time; lastAt = e.time }
    if (e.type === 'session/title' && e.data?.title) title = e.data.title
    if (e.type === 'user/message') {
      const parts = Array.isArray(e.data?.content) ? e.data.content : []
      const t = parts.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n').trim()
      if (t) messages.push({ role: 'user', text: t, time: e.time })
    } else if (e.type === 'assistant/message') {
      if (e.data?.usage) { lastUsage = e.data.usage; const v = Number(e.data.usage.inputTokens) || 0; if (v > maxInput) maxInput = v }
      const parts = Array.isArray(e.data?.message?.content) ? e.data.message.content : []
      const t = parts.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n').trim()
      if (t) messages.push({ role: 'assistant', text: t, time: e.time })
    }
  }
  return { title, messages, lastUsage, maxInput, firstAt, lastAt }
}

function archivedSessionIds() {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(HOME(), 'storages', 'workspace.json'), 'utf8'))
    return new Set((w && w.global && w.global.archivedSessionIds) || [])
  } catch { return new Set() }
}

function resolveArchivePath(cfg) {
  const raw = String(cfg.archiveDir || '').trim()
  return raw ? raw.replace(/^~(?=$|\/)/, os.homedir()) : path.join(DATA(), 'archives')
}

function resolveArchiveDir(cfg) {
  const dir = resolveArchivePath(cfg)
  ensure(dir)
  return dir
}

function resolveDiaryBookDir(cfg) {
  const raw = String(cfg.diaryBookDir || '').trim()
  const dir = raw ? raw.replace(/^~(?=$|\/)/, os.homedir()) : path.join(DATA(), 'diary-book')
  ensure(dir)
  return dir
}

function renderDiaryBook(entries) {
  const lines = ['# 日记合集', '', `> 共 ${entries.length} 篇 · 更新于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`, '']
  for (const e of entries) {
    lines.push(`## ${e.date}`, '', e.diary || '（空）', '')
    if (e.memories && e.memories.length) {
      lines.push('### 重要记忆候选', '')
      for (const m of e.memories) lines.push(`- [${m.type}] ${m.content}（重要度 ${Number(m.importance || 0).toFixed(2)}）`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

function updateDiaryBook(date, draft) {
  const cfg = loadConfig()
  const dir = resolveDiaryBookDir(cfg)
  const jsonFile = path.join(dir, 'diary-book.json')
  const mdFile = path.join(dir, 'diary-book.md')
  let entries = readJson(jsonFile, [])
  if (!Array.isArray(entries)) entries = []
  const entry = { date, diary: draft.diary || '', memories: draft.memories || [], createdAt: draft.createdAt || Date.now() }
  const idx = entries.findIndex(e => e.date === date)
  if (idx >= 0) entries[idx] = entry; else entries.push(entry)
  entries.sort((a, b) => String(b.date).localeCompare(String(a.date)))
  writeJson(jsonFile, entries)
  fs.writeFileSync(mdFile, renderDiaryBook(entries))
  return { dir, path: mdFile, entries: entries.length }
}

function archiveList() {
  const dir = resolveArchiveDir(loadConfig())
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
      const st = fs.statSync(path.join(dir, f))
      return { name: f, size: st.size, mtime: st.mtimeMs }
    }).sort((a, b) => b.mtime - a.mtime)
  } catch { return [] }
}

function archiveDelete(name) {
  const dir = resolveArchiveDir(loadConfig())
  const file = String(name || '')
  if (!file || file.includes('/') || file.includes('\\') || file.includes('..')) throw new Error('非法归档文件名')
  const full = path.join(dir, file)
  if (path.relative(dir, full).startsWith('..')) throw new Error('非法归档路径')
  if (!fs.existsSync(full)) throw new Error('归档文件不存在: ' + file)
  fs.unlinkSync(full)
  return { ok: true, removed: file, dir }
}

function openDiaryBookDir() {
  const dir = resolveDiaryBookDir(loadConfig())
  execFileSync('open', [dir])
  return { ok: true, dir }
}

function openArchiveDir() {
  const dir = resolveArchiveDir(loadConfig())
  execFileSync('open', [dir])
  return { ok: true, dir }
}

function safeFileName(s) {
  return String(s || 'session').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)
}

function archiveSession(sessionId) {
  const cfg = loadConfig()
  const dir = resolveArchiveDir(cfg)
  const all = scanSessions({ ...cfg, hideArchived: false })
  const s = all.find(x => x.id === sessionId)
  if (!s) throw new Error('会话不存在: ' + sessionId)
  const day = localDay()
  const file = path.join(dir, `${day}-${sessionId.slice(-8)}-${safeFileName(s.title)}.md`)
  const lines = [
    `# ${s.title}`,
    `- 会话：${sessionId}`,
    `- 工作区：${s.workspace}`,
    `- 归档时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `- 消息数：${s.messagesRaw.length}`,
    '',
  ]
  for (const m of s.messagesRaw) {
    lines.push(`## ${new Date(m.time).toLocaleString('zh-CN', { hour12: false })} · ${m.role}`, '', m.text, '')
  }
  const text = lines.join('\n')
  fs.writeFileSync(file, text)
  const st = loadState()
  st.lastArchive = { at: Date.now(), sessionId, path: file, messages: s.messagesRaw.length, bytes: Buffer.byteLength(text) }
  saveState(st)
  return st.lastArchive
}

function scanSessions(cfg) {
  const files = walkSessionFiles()
  dbg('scan: files=' + files.length + ' home=' + HOME())
  const rows = []
  for (const meta of files) {
    const s = readSession(meta.file)
    if (!s || !s.messages.length) continue
    const chars = s.messages.reduce((n, m) => n + m.text.length, 0)
    dbg('row ' + meta.sessionId.slice(-8) + ' msgs=' + s.messages.length + ' title=' + (s.title || '').slice(0, 20))
    rows.push({
      id: meta.sessionId,
      workspace: meta.workspace,
      title: s.title || meta.sessionId,
      messages: s.messages.length,
      chars,
      firstAt: s.firstAt,
      lastAt: s.lastAt,
      lastUsage: s.lastUsage,
      maxInput: s.maxInput || 0,
      excluded: false,
      messagesRaw: s.messages,
    })
  }
  const archived = archivedSessionIds()
  for (const r of rows) r.archived = archived.has(r.id)
  const ids = rows.map(r => r.id)
  const legacyExcluded = new Set(cfg.excludedSessions || [])
  const included = Array.isArray(cfg.includedSessions)
    ? new Set(cfg.includedSessions)
    : new Set(ids.filter(id => !legacyExcluded.has(id)))
  for (const r of rows) r.excluded = !included.has(r.id)
  rows.sort((a, b) => b.lastAt - a.lastAt)
  return rows
}

function buildTranscript(sessions, cfg) {
  const limit = Math.max(2000, Number(cfg.maxInputTokens) * 2)
  const parts = []
  let used = 0
  for (const s of sessions) {
    if (s.excluded) continue
    for (const m of s.messages) {
      const line = `[${new Date(m.time).toLocaleString('zh-CN', { hour12: false })}] ${m.role === 'user' ? '用户' : '助手'}：${m.text}`
      if (used + line.length > limit) return parts.join('\n')
      parts.push(line)
      used += line.length + 1
    }
  }
  return parts.join('\n')
}

async function resolveRoute(ctx, cfg) {
  if (cfg.llmProvider && cfg.llmModel) return { provider: cfg.llmProvider, model: cfg.llmModel }
  try {
    const sel = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
  } catch {}
  return { provider: 'deepseek-official', model: 'deepseek-flash' }
}

async function callLLM(ctx, route, cfg, system, user, maxTokens = 4000) {
  let createUserMessage = null
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    createUserMessage = mod.createUserMessage
  } catch {}
  const messages = [createUserMessage
    ? createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } })
    : { role: 'user', content: [{ type: 'text', text: user }] }]
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system,
    messages,
    temperature: 0.8,
    maxTokens,
  })
  let delta = ''
  let block = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') delta += chunk.text
    else if (chunk.type === 'block-end' && chunk.block?.type === 'text') block += chunk.block.text
    else if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') throw new Error(`llm ${kind}: ${chunk.reason?.failure?.message || ''}`)
    }
  }
  return delta || block
}

function findJsonObject(text) {
  const s = String(text || '')
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1) }
  }
  return s.slice(start)
}

function parseDraft(text) {
  const raw = String(text || '').trim()
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const objText = findJsonObject(stripped)
  if (objText) {
    try { return JSON.parse(objText) } catch {}
  }
  return { diary: stripped, memories: [] }
}

function buildSystemPrompt(cap) { return `你是 popo 的私人日记助手。日记既要记录项目工作，也要记录闲聊、心情与人际互动。请只输出一个 JSON 对象，不要输出代码块以外的解释。
JSON 结构：
{
  "diary": "第一人称日记正文（10-500字）。有项目内容就写进展/决策/坑；同时写今天聊了什么、心情如何、和 popo 的互动、吐槽、遇到喜欢的东西或事、以及你自己的感受。没有项目内容时就写闲聊与心情，不要硬凑工作。语气跟随对话风格。",
  "memories": [
    {"content": "一句话事实", "type": "work_fact|work_task|work_method|work_artifact|important_decision_experience|user_info|user_hobby|episodic", "importance": 0.0-1.0, "quote": "原文关键句"}
  ]
}
记忆候选要同时覆盖两类：
1) 项目：决策、事实、任务、路径/命令、版本、踩坑、未决；
2) 闲聊：popo 的人物喜好/xp、关系与称呼、情绪与心情、AI 自己的心情与偏好、梗/玩笑、重要原话、日常事实。
重要度：关键决策与稳定偏好 0.7-1.0；普通日常 0.4-0.6；寒暄 0.1-0.3。最多 ${cap} 条；**项目类与闲聊类各占一半（各约 ${Math.floor(cap / 2)} 条）**；某类素材不足时另一类可补足；只要素材里出现闲聊、情绪、喜好或关系内容，就至少保留 1-2 条闲聊类候选；没有就输出空数组。不要编造。` }

function clampDiary(s, cfg) {
  const t = String(s || '').trim()
  if (!t) return ''
  if (t.length <= cfg.maxChars) return t.length < cfg.minChars ? t + '…' : t
  // 只在接近上限（最后 25%）时的句读处截断；句子太长就硬截断，避免“句号在前 20% 就砍掉大半”
  const minKeep = Math.floor(cfg.maxChars * 0.75)
  const window = t.slice(0, cfg.maxChars)
  const m = window.match(/[。！？!?\n]/g)
  if (m && m.length) {
    const idx = window.lastIndexOf(m[m.length - 1])
    if (idx + 1 >= minKeep) return window.slice(0, idx + 1).replace(/\s+$/, '') + '…'
  }
  return window.slice(0, cfg.maxChars - 1).replace(/\s+$/, '') + '…'
}

function isProjectType(t) {
  return ['work_fact', 'work_task', 'work_method', 'work_artifact', 'important_decision_experience', 'common_pitfalls_experience', 'work_decision'].includes(String(t || ''))
}

function balanceCandidates(list, cap) {
  const arr = (list || []).slice().sort((a, b) => (b.importance || 0) - (a.importance || 0))
  const proj = arr.filter(m => isProjectType(m.type))
  const chat = arr.filter(m => !isProjectType(m.type))
  const targetP = Math.floor(cap / 2)
  const targetC = cap - targetP
  const picked = [...proj.slice(0, targetP), ...chat.slice(0, targetC)]
  if (picked.length < cap) {
    const used = new Set(picked)
    for (const m of arr) {
      if (picked.length >= cap) break
      if (!used.has(m)) picked.push(m)
    }
  }
  return picked.slice(0, cap)
}

async function generate(ctx, force = false, testMode = false, testSample = '') {
  const cfg = loadConfig()
  if (!cfg.enabled) return { ok: false, error: '插件未启用' }
  if (testMode) {
    const routeT = await resolveRoute(ctx, cfg)
    let transcriptT = ''
    if (typeof testSample === 'string' && testSample.trim()) {
      transcriptT = testSample.trim()
    } else {
      const nowT = Date.now()
      const sessionsT = scanSessions(cfg)
      const windowT = sessionsT.map(s => ({ ...s, messages: s.messagesRaw.filter(m => m.time >= nowT - 86400000 && m.time < nowT) }))
        .filter(s => s.messages.length > 0 && !s.excluded && (!cfg.hideArchived || !s.archived))
      if (!windowT.length) return { ok: false, error: '没有可用的测试素材' }
      transcriptT = buildTranscript(windowT, cfg)
    }
    const capT = Math.max(2, Math.min(30, Number(cfg.diaryCandidateLimit) || 8))
    const textT = await callLLM(ctx, routeT, cfg, buildSystemPrompt(capT),
      '【测试模式·分类覆盖】这次不写草稿、不写记忆。严格按 system 要求的 JSON 输出 {"diary":"...","memories":[...]}；memories 每条的 type 必须从这 12 个分类里选：人物画像/喜好、xp/性癖、关系/称呼/约定、梗/玩笑、情绪与心情、AI 自己的心情与偏好、重要原话、日常事实、未决/约定、日常杂事/生活安排、游戏/爱好、聊天/绯闻/杂事；diary 里追加「分类盘点」：12 个分类各抽到几条。对已划重点之外的关键内容与高潮情节也请引用。\n\n会话素材：\n' + transcriptT)
    const parsedT = parseDraft(textT)
    const memoriesT = (Array.isArray(parsedT.memories) ? parsedT.memories : []).map(m => ({
      content: String(m?.content || '').trim(), type: typeForCategory(m?.type || '', '闲聊'),
      category: String(m?.type || ''), importance: Number(m?.importance) || 0,
    })).filter(m => m.content)
    return { ok: true, testMode: true, diary: clampDiary(parsedT.diary, cfg), diaryLen: String(parsedT.diary || '').length, rawPreview: memoriesT.length ? '' : String(textT || '').slice(0, 500), memories: memoriesT.slice(0, 40) }
  }
  const state = loadState()
  const now = Date.now()
  const since0 = state.lastRunAt || (now - cfg.intervalDays * 86400000)
  const sessions = scanSessions(cfg)
  const windowOf = (from) => sessions.map(s => ({ ...s, messages: s.messagesRaw.filter(m => m.time >= from && m.time < now) }))
    .filter(s => s.messages.length > 0 && !s.excluded && (!cfg.hideArchived || !s.archived))
  let since = since0
  let withWindow = windowOf(since)
  // 手动「立即生成」时，如果上次运行之后没有新内容，就回退到最近一个间隔窗口，
  // 避免因为窗口为空而永远生成不出草稿。
  if (!withWindow.length && force) {
    since = now - cfg.intervalDays * 86400000
    withWindow = windowOf(since)
  }
  if (!withWindow.length) {
    state.lastError = '窗口内没有可用会话内容'
    saveState(state)
    return { ok: false, error: state.lastError }
  }
  if (!force && Math.random() < cfg.skipProbability) {
    state.lastSkip = now
    state.nextAt = nextSlotFrom(now, cfg)
    state.lastError = ''
    saveState(state)
    return { ok: true, skipped: true }
  }
  const transcript = buildTranscript(withWindow, cfg)
  const route = await resolveRoute(ctx, cfg)
  const cap = Math.max(2, Math.min(30, Number(cfg.diaryCandidateLimit) || 8))
  const text = await callLLM(ctx, route, cfg, buildSystemPrompt(cap),
    `时间范围：${new Date(since).toLocaleString('zh-CN', { hour12: false })} ~ ${new Date(now).toLocaleString('zh-CN', { hour12: false })}\n\n会话素材：\n${transcript}`)
  const parsed = parseDraft(text)
  const diary = clampDiary(parsed.diary, cfg)
  const memories = (Array.isArray(parsed.memories) ? parsed.memories : [])
    .map(m => ({
      content: String(m?.content || '').trim(),
      type: String(m?.type || 'episodic'),
      importance: Math.min(1, Math.max(0, Number(m?.importance) || 0)),
      quote: String(m?.quote || '').slice(0, 200),
    }))
    .filter(m => m.content && m.importance >= (isProjectType(m.type) ? cfg.importanceThresholdProject : cfg.importanceThresholdChat))
  const balanced = balanceCandidates(memories, cap)
  const date = localDay(now)
  const draft = {
    date, periodStart: since, periodEnd: now, diary, memories: balanced,
    model: `${route.provider}/${route.model}`, createdAt: now, adopted: false,
    sessions: withWindow.map(s => ({ id: s.id, title: s.title, workspace: s.workspace, messages: s.messages.length })),
  }
  ensure(DRAFTS())
  writeJson(path.join(DRAFTS(), `${date}.json`), draft)
  fs.writeFileSync(path.join(DRAFTS(), `${date}.md`),
    `# ${date} 日记\n\n${diary}\n\n## 重要记忆候选\n\n` +
    (memories.length ? memories.map(m => `- [${m.type}] ${m.content}（重要度 ${m.importance.toFixed(2)}）`).join('\n') : '（无）') + '\n')
  if (!force) {
    // 只有自动生成才推进调度与取材窗口；「立即生成」一概不动（2026-10-26 产品方要求）
    state.lastRunAt = now
    state.nextAt = nextSlotFrom(now, cfg)
  }
  state.lastError = ''
  if (cfg.diaryBookEnabled) {
    try { const b = updateDiaryBook(date, draft); state.lastDiaryBook = { at: Date.now(), path: b.path, entries: b.entries }; dbg('diary book: ' + b.path) }
    catch (e) { state.lastBookError = String(e?.message || e); dbg('diary book failed: ' + e) }
  }
  saveState(state)
  return { ok: true, draft }
}

const DIGEST_PROMPT = `你在为一个即将被上下文压缩的会话做「全量重要信息快照」。把下面对话里所有重要信息尽量完整地提取出来，供之后重新提炼记忆使用。
要求：
1. 分类：决策、事实、任务/待办、偏好、踩坑/错误、文件与路径、数据与版本、未决问题。
2. 每条一句话，必须具体：保留路径、命令、数字、版本号、报错原文。
3. 不要遗漏，不要编造；拿不准的标「待确认」。
4. 先写 5–10 行摘要，再给 items。
5. 只输出 JSON：{"summary":"...","items":[{"category":"...","content":"...","evidence":"...","importance":0.0}]}
6. items 最多 80 条。`

const DIGEST_PROMPT_ALL = `你在为一个会话做「项目 + 闲谈」合并快照，两边的信息都不能漏。
采集范围：
- 项目侧：决策、事实、任务/待办、文件路径、命令、数据/版本、踩坑/报错原文、未决问题。
- 闲谈侧：人物画像/喜好、xp/性癖、关系/称呼/约定、情绪与心情、AI 自己的心情与偏好、梗/玩笑、重要原话、日常事实。
要求：
1. 分类按上面两侧的具体类别命名。
2. 项目关键决策与稳定偏好/关系/AI 心情给 0.7–1.0；普通日常 0.4–0.6；寒暄 0.1–0.3。
3. 保留关键原话、路径、命令、数字、版本与报错原文，不编造。
4. 两侧都要有代表性条目，不要只偏向项目或只偏向闲聊。
5. 先写 5–10 行摘要，再给 items。
6. 只输出 JSON：{"summary":"...","items":[{"category":"...","content":"...","evidence":"...","importance":0.0}]}
7. items 最多 80 条，必须输出完整、合法的 JSON，不要截断。`

const DIGEST_PROMPT_CHAT = `你在为一个「聊天闲谈」会话做全量重要信息快照。这段对话的价值不在项目决策，而在人本身：pipo 的喜好、xp、关系、情绪、梗，以及 AI 自己的心情与偏好。请尽量完整地提取，供之后重新提炼记忆使用。
要求：
1. 分类（括号内为必须覆盖的边缘语义）：人物画像/喜好（禁忌/雷点/底线、语言习惯/口癖、表情包偏好、审美）、xp/性癖、关系/称呼/约定（社交圈/家人朋友、亲密度变化）、梗/玩笑、情绪与心情（冲突/吵架/和解的触发与结果）、AI 自己的心情与偏好、重要原话、日常事实（健康/身体状态/作息、共同经历/回忆）、未决/约定（计划/提醒/待办、对 AI 的边界与期待）、日常杂事/生活安排、游戏/爱好（玩什么、喜欢哪款、进度、氪金/平台偏好、ID/区服）、聊天/绯闻/杂事（隐私/秘密只记“存在这条边界”，不写具体敏感细节）。
2. 人物喜好要具体（喜欢什么、讨厌什么、为什么、程度），保留关键原话，不要概括成空话。
3. 关系与称呼（怎么叫 popo、怎么被叫、亲密度变化）单独记。
4. 情绪要写清触发事件与反应；AI 自己的心情/偏好也要记。
5. 日常寒暄不重要，可少记；稳定偏好、关系、情绪模式才重要。
6. 不要编造，拿不准标「待确认」。
7. 先写 5–10 行摘要，再给 items。
8. 只输出 JSON：{"summary":"...","items":[{"category":"...","content":"...","evidence":"...","importance":0.0}]}
9. 重要度：稳定的喜好/关系/称呼/AI 心情 0.7–1.0；普通日常 0.4–0.6；一次性寒暄 0.1–0.3。
10. items 最多 80 条。`

function parseJsonLoose(text) {
  let t = String(text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const objText = findJsonObject(t)
  if (objText) t = objText
  try { return JSON.parse(t) } catch (e) {
    // 截断修复：尽量保住已完整的 summary 与 items
    const sum = t.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    const items = []
    const re = /\{[^{}]*"content"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*\}/g
    let m
    while ((m = re.exec(t))) {
      try {
        const objText = m[0]
        const content = JSON.parse('"' + m[1] + '"')
        const cat = /"category"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(objText)
        const imp = /"importance"\s*:\s*([0-9.]+)/.exec(objText)
        items.push({ category: cat ? JSON.parse('"' + cat[1] + '"') : '其他', content, importance: imp ? Number(imp[1]) : 0.5 })
      } catch {}
    }
    if (sum || items.length) return { summary: sum ? JSON.parse('"' + sum[1] + '"') : '', items }
    throw e
  }
}

function deleteDigest(date, sessionId) {
  const day = String(date || '').replace(/[^0-9-]/g, '')
  const sid = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '')
  if (!day || !sid) return { ok: false, error: '参数不完整' }
  const base = path.join(DIGESTS(), day)
  let removed = 0
  for (const f of [path.join(base, sid + '.json'), path.join(base, sid + '.md')]) {
    if (fs.existsSync(f)) { fs.unlinkSync(f); removed++ }
  }
  if (removed && fs.existsSync(base) && fs.readdirSync(base).length === 0) { try { fs.rmdirSync(base) } catch {} }
  return { ok: removed > 0, removed }
}

function digestList() {
  ensure(DIGESTS())
  const out = []
  for (const day of fs.readdirSync(DIGESTS()).sort().reverse()) {
    const dir = path.join(DIGESTS(), day)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      const d = readJson(path.join(dir, f), null)
      if (d) out.push({ date: day, sessionId: d.sessionId, title: d.title, createdAt: d.createdAt, pct: d.pct, mode: normalizeMode(d.mode || '项目'), items: (d.items || []).length, summary: (d.summary || '').slice(0, 80) })
    }
  }
  return out.slice(0, 50)
}

async function generateDigest(ctx, session, pct, mode = '项目') {
  mode = normalizeMode(mode)
  const cfg = loadConfig()
  const route = await resolveRoute(ctx, cfg)
  const transcript = buildTranscript([{ ...session, excluded: false, messages: session.messagesRaw }], cfg)
  if (!transcript) throw new Error('会话没有可提取的内容')
  const prompt = mode === '闲聊' ? DIGEST_PROMPT_CHAT : mode === '全部' ? DIGEST_PROMPT_ALL : DIGEST_PROMPT
  const text = await callLLM(ctx, route, cfg, prompt,
    `会话：${session.title}\n工作区：${session.workspace}\n\n${transcript}\n\n注意：items 最多 60 条，必须输出完整、合法的 JSON，不要截断。`, 16000)
  const parsed = parseJsonLoose(text)
  const summary = String(parsed.summary || '').trim()
  const items = (Array.isArray(parsed.items) ? parsed.items : []).map(x => ({
    category: String(x?.category || '其他').trim(),
    content: String(x?.content || '').trim(),
    evidence: String(x?.evidence || '').slice(0, 200),
    importance: Math.min(1, Math.max(0, Number(x?.importance) || 0.5)),
  })).filter(x => x.content).slice(0, 80)
  const day = localDay()
  const dir = path.join(DIGESTS(), day); ensure(dir)
  const rec = { sessionId: session.id, title: session.title, workspace: session.workspace, createdAt: Date.now(), pct: Math.round(pct), mode, summary, items }
  writeJson(path.join(dir, `${session.id}.json`), rec)
  const groups = {}
  for (const it of items) (groups[it.category] ||= []).push(it)
  const md = `# 会话快照：${session.title}\n\n- 时间：${new Date(rec.createdAt).toLocaleString('zh-CN', { hour12: false })}\n- 上下文占用：${rec.pct}%\n- 条目：${items.length}\n\n## 摘要\n\n${summary}\n\n` +
    Object.entries(groups).map(([k, v]) => `## ${k}\n\n` + v.map(it => `- ${it.content}${it.evidence ? `\n  - 证据：${it.evidence}` : ''}`).join('\n')).join('\n\n') + '\n'
  fs.writeFileSync(path.join(dir, `${session.id}.md`), md)
  const state = loadState()
  state.lastDigest = { at: rec.createdAt, sessionId: session.id, items: items.length }
  saveState(state)
  return { ok: true, digest: rec, file: path.join(dir, `${session.id}.md`) }
}

async function checkContext(ctx) {
  const cfg = loadConfig()
  if (!cfg.enabled || !(cfg.contextThreshold > 0)) return { triggered: false }
  if (cfg.autoSnapshot === false) return { triggered: false, autoSnapshot: false, reason: '自动快照已关闭' }
  const state = loadState()
  const hits = state.contextHits || {}
  const route = await resolveRoute(ctx, cfg)
  let win = 0
  try { const info = await ctx.llm?.resolveModelInfo?.(route.provider, route.model); win = Number(info?.context?.contextWindow) || 0 } catch {}
  if (!win) return { triggered: false, error: 'contextWindow unknown' }
  const day = localDay()
  for (const s of scanSessions(cfg)) {
    if (s.excluded) continue
    const used = Number(s.maxInput) || Number(s.lastUsage?.inputTokens) || 0
    if (!used) continue
    const pct = (used / win) * 100
    const rec = hits[s.id] || {}
    const armBelow = Math.max(20, cfg.contextThreshold * 0.5)
    if (rec.armed === false && pct < armBelow) { hits[s.id] = { ...rec, armed: true }; state.contextHits = { ...hits }; saveState(state) }
    if (pct < cfg.contextThreshold) continue
    if (rec.armed === false) continue
    const at = Date.now()
    try {
      await generateDigest(ctx, s, pct, normalizeMode(cfg.autoDigestMode))
      state.lastError = ''
      if (cfg.archiveEnabled) {
        try { const a = archiveSession(s.id); dbg('archived: ' + a.path) }
        catch (e) { dbg('archive failed: ' + e); state.lastArchiveError = String(e?.message || e); saveState(state) }
      }
      if (cfg.autoRefine) {
        try {
          const rr = digestRefine(day, s.id)
          dbg('auto refine: ' + String(rr.note || ''))
        } catch (e) {
          dbg('auto refine failed: ' + e)
          state.lastError = '自动提炼失败：' + String(e?.message || e)
        }
      }
      state.contextHits = { ...hits, [s.id]: { day, at, pct: Math.round(pct), armed: false } }
      saveState(state)
    } catch (err) {
      dbg('digest generation failed: ' + err)
      state.lastError = '快照生成失败：' + String(err?.message || err)
      state.contextHits = { ...hits, [s.id]: { day, at, pct: Math.round(pct), armed: true } }
      saveState(state)
    }
    return { triggered: true, action: 'digest', session: s.id, pct: Math.round(pct) }
  }
  return { triggered: false }
}

async function contextStatus(ctx) {
  const cfg = loadConfig()
  const route = await resolveRoute(ctx, cfg)
  let win = 0
  try { const info = await ctx.llm?.resolveModelInfo?.(route.provider, route.model); win = Number(info?.context?.contextWindow) || 0 } catch {}
  const hits = loadState().contextHits || {}
  const day = localDay()
  const rows = scanSessions(cfg).filter(s => !s.excluded).map(s => {
    const used = Number(s.maxInput) || Number(s.lastUsage?.inputTokens) || 0
    return { id: s.id, title: s.title, used, pct: win ? Math.round((used / win) * 1000) / 10 : null, hitDay: hits[s.id]?.day || null }
  })
  return { autoSnapshot: cfg.autoSnapshot !== false, threshold: cfg.contextThreshold, checkMinutes: cfg.contextCheckMinutes, lastCheck: loadState().lastContextCheck || 0, contextWindow: win, route: `${route.provider}/${route.model}`, today: day, rows }
}

function typeForCategory(c, mode = '项目') {
  const s = String(c || '')
  if (mode === '闲聊' || mode === '闲谈' || mode === '聊天' || mode === '全部') {
    // 闲聊模式：先按闲聊语义整体归类，避免“日常事实/未决”回落项目门槛
    if (/xp|XP|性癖/.test(s)) return 'user_info'
    if (/游戏|爱好/.test(s)) return 'user_hobby'
    if (/关系|称呼|昵称|约定|梗|玩笑|互动/.test(s)) return 'episodic'
    if (/AI|助手|小鱼雷|自己/.test(s)) return 'episodic'
    if (/情绪|心情|感受|状态|生气|开心|难过/.test(s)) return 'episodic'
    if (/喜好|口味|爱吃|讨厌|喜欢|人物画像|朋友|家人|社交|健康|作息|日常|生活|经历|回忆|绯闻|杂事|寒暄|雷点|禁忌|底线|秘密|隐私|冲突|吵架|和解|口癖/.test(s)) return 'episodic'
    if (/未决|待办|计划|任务|想做|以后/.test(s)) return 'episodic'
    if (/重要原话|原话/.test(s)) return 'episodic'
    if (/隐私|秘密/.test(s)) return 'episodic'
    return 'episodic'
  }
  if (/决策/.test(s)) return 'important_decision_experience'
  if (/偏好/.test(s)) return 'user_info'
  if (/踩坑|错误|报错/.test(s)) return 'common_pitfalls_experience'
  if (/文件|路径|产物/.test(s)) return 'work_artifact'
  if (/任务|待办|未决/.test(s)) return 'work_task'
  if (/数据|版本|事实/.test(s)) return 'work_fact'
  return 'episodic'
}

function resolveSnapshotBookDir() {
  const raw = String(loadConfig().snapshotBookDir || '').trim()
  if (!raw) return path.join(DATA(), 'snapshot-books')
  if (raw === '~') return HOME()
  if (raw.startsWith('~/')) return path.join(HOME(), raw.slice(2))
  return path.resolve(raw)
}

function appendSnapshotBook(d) {
  const dir = resolveSnapshotBookDir()
  ensure(dir)
  const sid = String(d.sessionId || 'session').slice(-8)
  const safe = String(d.title || 'session').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)
  const file = path.join(dir, `${sid}-${safe}.md`)
  const marker = `<!-- snapshot:${d.date} -->`
  const items = Array.isArray(d.items) ? d.items : []
  const section = `${marker}\n## ${d.date} · ${d.pct ?? '?'}% · ${items.length} 条\n\n${d.summary || ''}\n\n| 类别 | 内容 | 重要度 |\n| --- | --- | --- |\n` +
    items.map(it => `| ${it.category || ''} | ${String(it.content || '').replace(/\|/g, '\\|')} | ${Number(it.importance || 0).toFixed(2)} |`).join('\n') + '\n'
  let text = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8')
    : `# 会话快照总集 · ${d.title || ''}\n\n> 会话：${d.sessionId || ''}\n> 工作区：${d.workspace || ''}\n\n`
  if (text.includes(marker)) {
    const start = text.indexOf(marker)
    const next = text.indexOf('<!-- snapshot:', start + 1)
    text = text.slice(0, start) + section + (next >= 0 ? text.slice(next) : '')
  } else {
    text += `\n${section}`
  }
  fs.writeFileSync(file + '.tmp', text)
  fs.renameSync(file + '.tmp', file)
  return file
}

function digestRefine(date, sessionId, dryRun = false) {
  const file = path.join(DIGESTS(), String(date), String(sessionId) + '.json')
  const d = readJson(file, null)
  if (!d) throw new Error('快照不存在')
  const cfg = loadConfig()
  let bookPath = null
  if (!dryRun) {
    try { bookPath = appendSnapshotBook(d) } catch (e) { dbg('snapshot-book: ' + e) }
  }
  const mode = normalizeMode(d.mode)
  const mems = (d.items || []).map(it => ({
    content: String(it.content || '').trim(),
    type: typeForCategory(it.category, mode),
    importance: Math.min(1, Math.max(0, Number(it.importance) || 0.6)),
    category: String(it.category || ''),
  })).filter(m => m.content && m.importance >= (isProjectType(m.type) ? cfg.importanceThresholdProject : cfg.importanceThresholdChat)).slice(0, 30)
  if (!mems.length) return { ok: true, written: 0, planned: 0, skippedExisting: 0, safeToDiscard: false, bookPath, note: '没有达到入库门槛的条目' }
  if (dryRun) return { ok: true, dryRun: true, planned: mems.length, memories: mems }
  const tag = `${date}-${String(sessionId).slice(-8)}`
  const sceneRoot = (mode === '闲聊' || mode === '聊天') ? '聊天' : mode === '全部' ? '综合' : '快照'
  const w = writePrime(tag, mems, PRIME_DB(), { sceneRoot, extPrefix: 'digest' })
  const safeToDiscard = w.planned > 0 && w.written + w.skippedExisting === w.planned
  return { ok: true, planned: w.planned, written: w.written, skippedExisting: w.skippedExisting, total: w.total, safeToDiscard, backup: w.backup, bookPath, note: `已提炼：新增 ${w.written} 条${w.skippedExisting ? `，已有 ${w.skippedExisting} 条在库` : ''}（累计 ${w.total}）` }
}

function listDrafts() {
  ensure(DRAFTS())
  return fs.readdirSync(DRAFTS()).filter(f => f.endsWith('.json')).sort().reverse().map(f => {
    const d = readJson(path.join(DRAFTS(), f), null)
    if (!d) return null
    return { date: d.date, createdAt: d.createdAt, chars: (d.diary || '').length, memories: (d.memories || []).length, adopted: !!d.adopted, note: d.note || '' }
  }).filter(Boolean)
}

function adopt(date, dryRun = false) {
  const file = path.join(DRAFTS(), `${date}.json`)
  const d = readJson(file, null)
  if (!d) return { ok: false, error: '草稿不存在' }
  ensure(OUTBOX())
  const diaryRecord = d.diary ? [{
    content: `【日记 ${date}】\n${d.diary}`,
    type: 'episodic',
    scene: `日记/${date}`,
    ext_key: `diary-${date}-diary`,
    dedupe_key: `diary-${date}-diary`,
    source_id: `diary-${date}`,
    importance: 1,
  }] : []
  const candidates = (d.memories || []).map((m, i) => ({
    content: m.content, type: m.type, scene: `日记/${date}`,
    ext_key: `diary-${date}-${i + 1}`,
    dedupe_key: `diary-${date}-${i}`, source_id: `diary-${date}`, importance: m.importance,
  }))
  const records = [...diaryRecord, ...candidates]
  writeJson(path.join(OUTBOX(), `${date}.json`), { date, records, createdAt: Date.now(), status: dryRun ? 'dry-run' : 'pending-write' })
  if (dryRun) return { ok: true, dryRun: true, records: records.length, preview: records }
  let write
  try {
    write = writePrime(date, records)
  } catch (err) {
    d.note = '写入 prime 失败：' + String(err?.message || err)
    writeJson(file, d)
    return { ok: false, error: d.note, outbox: true }
  }
  d.adopted = true
  d.note = `已写入 prime L1：新增 ${write.written} 条，累计 ${write.total} 条`
  writeJson(file, d)
  const planned = Number(write.planned || records.length)
  const written = Number(write.written || 0)
  const skippedExisting = Number(write.skippedExisting || 0)
  const safeToDiscard = planned > 0 && written + skippedExisting === planned
  d.note = `新增 ${written} 条${skippedExisting ? `（已有 ${skippedExisting} 条在库）` : ''}，累计 ${write.total} 条`
  writeJson(file, d)
  return { ok: true, records: records.length, planned, written, skippedExisting, total: write.total, backup: write.backup, safeToDiscard, note: d.note }
}

function overview() {
  const cfg = loadConfig()
  const state = loadState()
  let sessions = []
  try { sessions = scanSessions(cfg).map(s => ({ id: s.id, title: s.title, workspace: s.workspace, messages: s.messages, chars: s.chars, lastAt: s.lastAt, excluded: s.excluded, archived: !!s.archived })) } catch {}
  if (cfg.hideArchived) sessions = sessions.filter(s => !s.archived)
  if (!Array.isArray(cfg.includedSessions)) {
    const ids = sessions.map(s => s.id)
    cfg.includedSessions = ids
    saveConfig({ includedSessions: ids })
  }
  return { config: cfg, state, sessions, drafts: listDrafts(), digests: digestList(), archives: archiveList(), archiveDirResolved: resolveArchivePath(cfg), diaryBookResolved: resolveDiaryBookDir(cfg), snapshotBookDirResolved: resolveSnapshotBookDir() }
}

async function handle(ctx, endpoint, payload) {
  const cfg = loadConfig()
  switch (endpoint) {
    case 'overview': return overview()
    case 'config.get': return cfg
    case 'config.set': return { config: saveConfig(payload?.patch || {}) }
    case 'sessions.list': return { sessions: overview().sessions }
    case 'drafts.list': return { drafts: listDrafts() }
    case 'draft.get': return readJson(path.join(DRAFTS(), `${payload?.date}.json`), null)
    case 'draft.generate': return generate(ctx, !!payload?.force)
    case 'draft.adopt': return adopt(payload?.date, !!payload?.dryRun)
    case 'diag.writeTest': return diagWriteTest()
    case 'diag.testGenerate': return generate(ctx, true, true, payload?.sample || '')
    case 'books.openDir': {
      const dir = resolveSnapshotBookDir()
      ensure(dir)
      try { spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref() } catch (e) { dbg('books.openDir: ' + e) }
      return { ok: true, path: dir }
    }
    case 'diag.context': return contextStatus(ctx)
    case 'archive.run': return archiveSession(payload?.sessionId)
    case 'archive.open': return openArchiveDir()
    case 'archive.list': return archiveList()
    case 'archive.delete': return archiveDelete(payload?.name)
    case 'diarybook.open': return openDiaryBookDir()
    case 'digest.list': return digestList()
    case 'digest.delete': return deleteDigest(payload?.date, payload?.sessionId)
    case 'digest.get': {
      const obj = readJson(path.join(DIGESTS(), String(payload?.date || ''), String(payload?.sessionId || '') + '.json'), null)
      return obj ? { ...obj, date: String(payload?.date || '') } : null
    }
    case 'digest.refine': return digestRefine(payload?.date, payload?.sessionId, !!payload?.dryRun)
    case 'digest.generate': {
      const sid = String(payload?.sessionId || '')
      const sess = scanSessions(loadConfig()).find(x => x.id === sid)
      if (!sess) throw new Error('会话不存在')
      return generateDigest(ctx, sess, 0, normalizeMode(payload?.mode))
    }
    case 'draft.discard': {
      const f = path.join(DRAFTS(), `${payload?.date}.json`)
      if (fs.existsSync(f)) fs.unlinkSync(f)
      const md = path.join(DRAFTS(), `${payload?.date}.md`)
      if (fs.existsSync(md)) fs.unlinkSync(md)
      return { ok: true }
    }
    default: throw new Error(`unknown endpoint: ${endpoint}`)
  }
}

export const name = PLUGIN
export const inject = ['tools', 'llm', 'webServer']

export function apply(ctx) {
  ensure(DATA())
  dbg('apply start')
  const state = loadState()
  if (!state.nextAt) {
    state.nextAt = nextSlotFrom(Date.now(), loadConfig())
    saveState(state)
  }

  const webServer = ctx.get('webServer')
  dbg('webServer=' + String(!!webServer) + ' register=' + String(typeof webServer?.register))
  if (webServer && typeof webServer.register === 'function') {
    const dispose = webServer.register({
      kind: 'prefix',
      path: CHANNEL,
      handler: async (req, res) => {
        const host = String(req.headers?.host || '').split(':')[0]
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
          res.writeHead(403, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ ok: false, error: { message: 'forbidden' } }))
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ ok: false, error: { message: 'method not allowed' } }))
        }
        const pathname = new URL(req.url || '/', 'http://dsh.internal').pathname
        if (!pathname.startsWith(CHANNEL + '/')) {
          res.writeHead(404, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ ok: false, error: { message: 'unknown api path' } }))
        }
        const endpoint = pathname.slice(CHANNEL.length + 1)
        let envelopeRpcId = null
        try {
          const raw = await new Promise((resolve, reject) => {
            const chunks = []
            req.on('data', c => chunks.push(c))
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
            req.on('error', reject)
          })
          const envelope = raw ? JSON.parse(raw) : {}
          envelopeRpcId = envelope.rpcId
          dbg('http rpc ' + endpoint)
          const data = await handle(ctx, endpoint, envelope.payload || {})
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: data } }))
        } catch (err) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'server-response', rpcId: envelopeRpcId, result: { ok: false, error: { code: 'internal', message: String(err?.message || err) } } }))
        }
      },
    })
    dbg('webServer registered, dispose=' + typeof dispose)
    ctx.effect(() => () => { try { dispose?.() } catch {} }, `${PLUGIN}: webserver route`)
  } else {
    dbg('webServer unavailable; RPC disabled')
  }

  let running = false
  ctx.effect(() => {
    const timer = setInterval(async () => {
      if (running) return
      const cfg = loadConfig()
      if (!cfg.enabled) return
      running = true
      try {
        const st0 = loadState()
        const every = Math.max(1, Math.round(Number(cfg.contextCheckMinutes) || 15)) * 60000
        if (Date.now() - (st0.lastContextCheck || 0) >= every) {
          st0.lastContextCheck = Date.now()
          saveState(st0)
          try { await checkContext(ctx) } catch (err) { dbg('checkContext: ' + err) }
        }
        const st1 = loadState()
        const sig = scheduleSignature(cfg)
        if (!st1.nextAt || st1.scheduleSig !== sig) {
          // 配置变了（时刻/间隔/锚点）就按新规则重排，不改锚点本身
          st1.nextAt = nextSlotFrom(Date.now(), cfg)
          st1.scheduleSig = sig
          saveState(st1)
        }
        if (Date.now() >= st1.nextAt) await generate(ctx, false)
      } catch (err) { const st = loadState(); st.lastError = String(err?.message || err); saveState(st) }
      finally { running = false }
    }, 60 * 1000)
    return () => clearInterval(timer)
  }, `${PLUGIN}: scheduler`)
}

export const __test = { scanSessions, readSession, walkSessionFiles, nextSlotFrom, normalizeDailyAt, scheduleSignature }
