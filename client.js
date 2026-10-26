/**
 * dsh-prime-diary — 客户端半边。
 * Settings → 每日日记：配置、会话剔除、草稿查看/生成/采纳。
 */
window.__ModuleLoader__.load({
  id: 'dsh-prime-diary',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const { useState, useEffect } = React
    const h = React.createElement

    const S = {
      wrap: { padding: '10px 6px', fontSize: 13, lineHeight: 1.6, color: 'inherit', boxSizing: 'border-box' },
      card: { border: '1px solid rgba(127,127,127,.18)', borderRadius: 12, padding: 16, marginBottom: 16, background: 'rgba(127,127,127,.035)' },
      title: { fontWeight: 600, marginBottom: 12, letterSpacing: '.01em' },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 },
      label: { opacity: .7, minWidth: 112 },
      input: { width: 88, height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', boxSizing: 'border-box' },
      btn: { height: 30, padding: '0 12px', borderRadius: 8, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12.5 },
      btnPrimary: { height: 30, padding: '0 12px', borderRadius: 8, border: '1px solid rgba(80,140,255,.55)', background: 'rgba(80,140,255,.12)', color: 'inherit', cursor: 'pointer', fontSize: 12.5 },
      table: { width: '100%', borderCollapse: 'collapse' },
      th: { textAlign: 'left', fontWeight: 500, opacity: .7, padding: '8px 10px', borderBottom: '1px solid rgba(127,127,127,.22)', fontSize: 12 },
      td: { padding: '8px 10px', borderBottom: '1px solid rgba(127,127,127,.1)', verticalAlign: 'top' },
      err: { color: '#e5534b', whiteSpace: 'pre-wrap', margin: '6px 0' },
      ok: { color: '#2da44e', margin: '6px 0' },
      pre: { whiteSpace: 'pre-wrap', background: 'rgba(127,127,127,.08)', padding: 10, borderRadius: 8, maxHeight: 260, overflow: 'auto' },
      muted: { opacity: .6 },
    }

    function yes(v) { return v ? '是' : '否' }
    function fmtTime(ts) { return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—' }

    function Section(props) {
      const call = props.call
      const [ov, setOv] = useState(null)
      const [cfg, setCfg] = useState(null)
      const [err, setErr] = useState('')
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState('')
      const [openDrafts, setOpenDrafts] = useState([])
      const [openDigests, setOpenDigests] = useState([])
      const [digestBusy, setDigestBusy] = useState(null)
      const [digestElapsed, setDigestElapsed] = useState(0)
      const [digestStatus, setDigestStatus] = useState(null)
      const [genBusy, setGenBusy] = useState(false)
      const [genElapsed, setGenElapsed] = useState(0)
      const [genStatus, setGenStatus] = useState(null)
      const [adoptBusy, setAdoptBusy] = useState('')
      const [adoptElapsed, setAdoptElapsed] = useState(0)
      const [adoptStatus, setAdoptStatus] = useState(null)
      const [dialog, setDialog] = useState(null)
      const [confirmBox, setConfirmBox] = useState(null)
      const [job, setJob] = useState(null)
      const [jobElapsed, setJobElapsed] = useState(0)

      async function load() {
        try {
          const d = await call('overview')
          setOv(d)
          setCfg(d.config)
          setErr('')
        } catch (e) { setErr(String(e && e.message || e)) }
      }
      useEffect(() => { load() }, [])
      useEffect(() => {
        if (!digestBusy) return
        setDigestElapsed(0)
        const t = setInterval(() => setDigestElapsed(v => v + 1), 1000)
        return () => clearInterval(t)
      }, [digestBusy])
      useEffect(() => {
        if (!job) { setJobElapsed(0); return }
        setJobElapsed(0)
        const t = setInterval(() => setJobElapsed(v => v + 1), 1000)
        return () => clearInterval(t)
      }, [job])

      useEffect(() => {
        if (!genBusy) return
        setGenElapsed(0)
        const t = setInterval(() => setGenElapsed(v => v + 1), 1000)
        return () => clearInterval(t)
      }, [genBusy])
      useEffect(() => {
        if (!adoptBusy) return
        setAdoptElapsed(0)
        const t = setInterval(() => setAdoptElapsed(v => v + 1), 1000)
        return () => clearInterval(t)
      }, [adoptBusy])

      async function save(patch) {
        setBusy('save'); setMsg('')
        try {
          const r = await call('config.set', { patch: patch || cfg })
          setCfg(r.config)
          setMsg('已保存')
          await load()
        } catch (e) { setErr(String(e && e.message || e)) } finally { setBusy('') }
      }
      async function generate() {
        if (genBusy) return
        setGenBusy(true)
        setGenStatus({ kind: 'busy', text: '正在生成日记…' })
        const t0 = Date.now()
        try {
          const r = await call('draft.generate', { force: true })
          const sec = Math.round((Date.now() - t0) / 1000)
          if (r && r.skipped) {
            setGenStatus({ kind: 'ok', text: `这次偷懒了：概率命中，未生成草稿（用时 ${sec}s）` })
            setDialog({ title: '这次偷懒了 😴', lines: ['概率命中，没有生成日记草稿。'], hint: '想补写的话再点一次「立即生成」。' })
          } else {
            const d = r && r.draft ? r.draft : r
            setGenStatus({ kind: 'ok', text: `日记已生成：${(d?.diary || '').length} 字 · ${(d?.memories || []).length} 条候选（用时 ${sec}s）` })
            setDialog({ title: '日记生成成功 ✅', lines: [`字数：${(d?.diary || '').length}`, `候选记忆：${(d?.memories || []).length} 条`, `用时：约 ${sec}s`], hint: '草稿已保存，可以去「日记草稿」里查看。' })
          }
          await load()
        } catch (e) {
          setGenStatus({ kind: 'err', text: '日记生成失败：' + String(e && e.message || e) })
          setDialog({ title: '日记生成失败 ❌', lines: [String(e && e.message || e)], hint: '检查配置/网络后可重试。' })
        } finally { setGenBusy(false) }
      }
      async function toggleDraft(date) {
        if (openDrafts.some(x => x.date === date)) {
          setOpenDrafts(openDrafts.filter(x => x.date !== date))
          return
        }
        try { const d = await call('draft.get', { date }); setOpenDrafts([...openDrafts, d]) }
        catch (e) { setErr(String(e && e.message || e)) }
      }
      async function adopt(date) {
        if (adoptBusy) return
        setAdoptBusy(date)
        setAdoptStatus({ kind: 'busy', text: '正在上传记忆…' })
        const t0 = Date.now()
        try {
          const r = await call('draft.adopt', { date })
          const sec = Math.round((Date.now() - t0) / 1000)
          const safe = r?.safeToDiscard !== false
          const skipped = Number(r?.skippedExisting || 0)
          const remaining = Math.max(0, Number(r?.planned || 0) - Number(r?.written || 0) - skipped)
          const extra = safe
            ? (skipped > 0 ? ` · 已有 ${skipped} 条在库，无需重复写入，可以放心删除草稿` : ' · 已全部写入 prime，可以放心删除草稿')
            : ` · 还有 ${remaining} 条未写入，先别删草稿`
          setAdoptStatus({ kind: safe ? 'ok' : 'err', text: `已上传：新增 ${r?.written ?? 0} 条${skipped ? `（已有 ${skipped} 条）` : ''}，累计 ${r?.total ?? '?'} 条（用时 ${sec}s）${extra}` })
          const lines = [`计划写入：${r?.planned ?? 0} 条`, `本次新增：${r?.written ?? 0} 条`]
          if (skipped > 0) lines.push(`已在库中：${skipped} 条`)
          if (r?.total != null) lines.push(`累计入库：${r.total} 条`)
          lines.push(`用时：约 ${sec}s`)
          if (r?.backup) lines.push(`数据库备份：${r.backup}`)
          setDialog(safe
            ? { title: '上传成功 ✅', lines, hint: '草稿内容已进入记忆库，可以放心删除这份草稿。' }
            : { title: '上传完成（未全部写入）❌', lines: [...lines, `未写入：${remaining} 条`], hint: '还有条目没进记忆库，先别删草稿。' })
          await load()
        } catch (e) {
          setAdoptStatus({ kind: 'err', text: '上传失败：' + String(e && e.message || e) })
          setDialog({ title: '上传失败 ❌', lines: [String(e && e.message || e)], hint: '草稿没有删除，可以稍后重试。' })
        } finally { setAdoptBusy('') }
      }
      function askConfirm(text, onOk) { setConfirmBox({ text, onOk }) }

      function discard(date) {
        askConfirm(`确定删除草稿「${date}」？\n删除后不可恢复。`, async () => {
          try { await call('draft.discard', { date }); setMsg('草稿已删除'); setOpenDrafts(openDrafts.filter(x => x.date !== date)); await load() }
          catch (e) { setErr(String(e && e.message || e)) }
        })
      }

      async function toggleDigest(d) {
        const key = d.date + '::' + d.sessionId
        if (openDigests.some(x => x.date + '::' + x.sessionId === key)) {
          setOpenDigests(openDigests.filter(x => x.date + '::' + x.sessionId !== key))
          return
        }
        try { const dg = await call('digest.get', { date: d.date, sessionId: d.sessionId }); setOpenDigests([...openDigests, dg]) }
        catch (e) { setErr(String(e && e.message || e)) }
      }
      function deleteDigest(d) {
        askConfirm(`确定删除快照「${d.title || d.sessionId}」？\n只删快照文件，不会撤销已提炼的记忆。`, async () => {
        try {
          const r = await call('digest.delete', { date: d.date, sessionId: d.sessionId })
          if (r && r.ok === false) { setErr(r.error || '删除失败'); return }
          setOpenDigests(openDigests.filter(x => !(x.date === d.date && x.sessionId === d.sessionId)))
          setMsg('快照已删除')
          await load()
        } catch (e) { setErr(String(e && e.message || e)) }
        })
      }

      async function refineDigest(target) {
        const dg = target || null
        if (!dg) return
        setBusy('refine'); setJob({ label: '正在上传记忆…' }); setMsg(''); setErr('')
        try {
          const r = await call('digest.refine', { date: dg.date, sessionId: dg.sessionId })
          if (r && r.ok === false) {
            setDialog({ title: '上传失败 ❌', lines: [r.error || '未知错误'], hint: '快照没有删除，可以稍后重试。' })
          } else {
            const written = Number(r?.written || 0)
            const skipped = Number(r?.skippedExisting || 0)
            const planned = Number(r?.planned || 0)
            const remaining = Math.max(0, planned - written - skipped)
            const lines = [`计划写入：${planned} 条`, `本次新增：${written} 条`]
            if (skipped > 0) lines.push(`已在库中：${skipped} 条`)
            if (r?.total != null) lines.push(`该会话累计入库：${r.total} 条`)
            if (r?.backup) lines.push(`数据库备份：${r.backup}`)
            if (r?.bookPath) lines.push(`快照合集：${r.bookPath}`)
            const safe = r?.safeToDiscard !== false && remaining === 0
            setDialog(safe
              ? { title: '上传成功 ✅', lines, hint: skipped > 0 ? '全部条目都已在记忆库中，可以放心删除这条快照。' : '已经写进记忆库，可以放心删除这条快照。' }
              : { title: '上传完成（未全部写入）', lines: [...lines, `未写入：${remaining} 条`], hint: '还有条目未进入记忆库，建议先别删快照。' })
            await load()
          }
        } catch (e) {
          setDialog({ title: '上传失败 ❌', lines: [String(e && e.message || e)], hint: '快照没有删除，可以稍后重试。' })
        } finally { setBusy(''); setJob(null) }
      }
      function digestMarkdown(d) {
        const lines = []
        lines.push(`# 会话快照 · ${d.title || ''}`, '')
        lines.push(`- 日期：${d.date || ''}`)
        lines.push(`- 会话：${d.sessionId || ''}`)
        if (d.pct != null) lines.push(`- 上下文占用：${d.pct}%`)
        lines.push(`- 条目：${(d.items || []).length}`, '')
        lines.push('## 摘要', '', d.summary || '（空）', '')
        lines.push('## 要点', '', '| 类别 | 内容 | 重要度 |', '| --- | --- | --- |')
        for (const it of d.items || []) lines.push(`| ${it.category || ''} | ${String(it.content || '').replace(/\|/g, '\\|')} | ${Number(it.importance || 0).toFixed(2)} |`)
        return lines.join('\n')
      }
      function downloadText(name, text) {
        const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      async function exportDigest(d) {
        try {
          const full = d && Array.isArray(d.items) ? d : await call('digest.get', { date: d.date, sessionId: d.sessionId })
          const sid = String(full.sessionId || d.sessionId || '').slice(-8)
          const name = `prime-diary-snapshot-${full.date || d.date}-${sid}.md`
          downloadText(name, digestMarkdown(full))
          setMsg(`已导出：${name}`)
          setDialog({ title: '导出成功 ✅', lines: [`文件：${name}`], hint: '已保存到浏览器默认下载目录。' })
        } catch (e) { setErr(String(e && e.message || e)) }
      }

      async function setSessionMode(id, mode) {
        const next = { ...(cfg.sessionModes || {}), [id]: mode }
        setCfg({ ...cfg, sessionModes: next })
        try {
          const r = await call('config.set', { patch: { sessionModes: next } })
          if (r && r.config) setCfg(r.config)
        } catch (e) { setErr(String(e && e.message || e)) }
      }

      function deleteArchive(name) {
        askConfirm(`确定删除归档文件？\n${name}\n\n本地文件会一起删除，不可恢复。`, async () => {
          setBusy('archive-del'); setMsg(''); setErr('')
          try { const r = await call('archive.delete', { name }); setMsg(`已删除：${r.removed}`); await load() }
          catch (e) { setErr('删除失败：' + String(e && e.message || e)) }
          finally { setBusy('') }
        })
      }

      async function openDiaryBookDir() {
        try { const r = await call('diarybook.open'); setMsg(`已打开日记合集目录：${r.dir}`) }
        catch (e) { setErr('打开日记合集目录失败：' + String(e && e.message || e)) }
      }

      async function openArchiveDir() {
        try { const r = await call('archive.open'); setMsg(`已打开归档目录：${r.dir}`) }
        catch (e) { setErr('打开归档目录失败：' + String(e && e.message || e)) }
      }

      async function archiveNow(sessionId) {
        setBusy('archive'); setJob({ label: '正在归档完整会话…' }); setMsg(''); setErr('')
        try {
          const r = await call('archive.run', { sessionId })
          const mb = ((r?.bytes || 0) / 1048576).toFixed(2)
          setMsg(`已归档：${r.path}（${r.messages} 条，${mb} MB）`)
          setDialog({ title: '归档成功 ✅', lines: [`消息：${r.messages} 条`, `大小：${mb} MB`, `路径：${r.path}`], hint: '可以去「已生成归档」里查看或删除。' })
          await load()
        } catch (e) { setErr('归档失败：' + String(e && e.message || e)); setDialog({ title: '归档失败 ❌', lines: [String(e && e.message || e)], hint: '可重试，或检查归档目录权限。' }) }
        finally { setBusy(''); setJob(null) }
      }

      async function makeDigest(sessionId, mode) {
        const sess = (ov.sessions || []).find(x => x.id === sessionId)
        const title = sess ? sess.title : String(sessionId).slice(-8)
        setDigestBusy(sessionId)
        setDigestStatus({ kind: 'busy', text: `正在为「${title}」生成快照…` })
        const t0 = Date.now()
        try {
          const r = await call('digest.generate', { sessionId, mode })
          const n = r.digest?.items?.length || 0
          setDigestStatus({ kind: 'ok', text: `快照已生成：${n} 条（用时 ${Math.round((Date.now() - t0) / 1000)}s）` })
          if (r.digest) setOpenDigests(prev => [...prev, r.digest])
          await load()
        } catch (e) {
          setDigestStatus({ kind: 'err', text: '快照生成失败：' + String(e && e.message || e) })
        } finally { setDigestBusy(null) }
      }

      if (!ov || !cfg) return h('div', { style: S.wrap }, err ? h('div', { style: S.err }, err) : '加载中…')

      const included = new Set(Array.isArray(cfg.includedSessions) ? cfg.includedSessions : ov.sessions.filter(s => !s.excluded).map(s => s.id))
      const toggleSession = (id, on) => {
        const next = new Set(included)
        if (on) next.add(id); else next.delete(id)
        save({ includedSessions: Array.from(next) })
      }

      const cfgRow = (label, node) => h('div', { style: S.row }, h('span', { style: S.label }, label), node)

      function draftDetail(dd) {
        return h('div', { key: dd.date, style: { marginTop: 8, marginLeft: 18, paddingLeft: 12, borderLeft: '2px solid rgba(127,127,127,.25)' } },
          h('div', { style: S.title }, `${ov.drafts.findIndex(x => x.date === dd.date) + 1}. ${dd.date} 草稿`),
          h('div', { style: S.pre }, dd.diary || '（空）'),
          h('details', null,
            h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, `重要记忆候选（${(dd.memories || []).length} 条，点此展开）`),
            h('table', { style: S.table },
              h('thead', null, h('tr', null, ['类型', '内容', '重要度'].map((t, i) => h('th', { key: i, style: S.th }, t)))),
              h('tbody', null, (dd.memories || []).map((m, i) => h('tr', { key: i },
                h('td', { style: S.td }, m.type),
                h('td', { style: S.td }, m.content),
                h('td', { style: S.td }, Number(m.importance).toFixed(2))))))))
      }
      function digestDetail(dg) {
        return h('div', { key: dg.date + '::' + dg.sessionId, style: { marginTop: 8, marginLeft: 18, paddingLeft: 12, borderLeft: '2px solid rgba(127,127,127,.25)' } },
          h('div', { style: S.title }, `${dg.title} 快照`),
          h('div', { style: S.pre }, dg.summary || '（空）'),
          h('details', null,
            h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, `要点（${(dg.items || []).length} 条，点此展开）`),
            h('table', { style: S.table },
              h('thead', null, h('tr', null, ['类别', '内容', '重要度'].map((t, i) => h('th', { key: i, style: S.th }, t)))),
              h('tbody', null, (dg.items || []).map((it, i) => h('tr', { key: i },
                h('td', { style: S.td }, it.category),
                h('td', { style: S.td }, it.content),
                h('td', { style: S.td }, Number(it.importance).toFixed(2))))))))
      }

      return h('div', { style: S.wrap },

        adoptStatus ? h('div', { style: { ...S.card, marginBottom: 12 } },
          h('div', { style: adoptStatus.kind === 'err' ? S.err : adoptStatus.kind === 'ok' ? S.ok : S.muted }, adoptStatus.text),
          adoptBusy ? h('div', { style: { height: 6, background: 'rgba(127,127,127,.18)', borderRadius: 3, overflow: 'hidden', marginTop: 8 } },
            h('div', { style: { height: '100%', width: `${Math.min(95, 10 + adoptElapsed * 4)}%`, background: '#4f8cff', transition: 'width 1s linear' } })) : null,
          adoptBusy ? h('div', { style: { ...S.muted, marginTop: 6 } }, `已等待 ${adoptElapsed}s，正在备份并上传记忆…`) : null) : null,

        job ? h('div', { style: { ...S.card, marginBottom: 12 } },
          h('div', { style: S.muted }, job.label),
          h('div', { style: { height: 6, background: 'rgba(127,127,127,.18)', borderRadius: 3, overflow: 'hidden', marginTop: 8 } },
            h('div', { style: { height: '100%', width: `${Math.min(95, 8 + jobElapsed * 3)}%`, background: '#4f8cff', transition: 'width 1s linear' } })),
          h('div', { style: { ...S.muted, marginTop: 6 } }, `已等待 ${jobElapsed}s`)) : null,

        genStatus ? h('div', { style: { ...S.card, marginBottom: 12 } },
          h('div', { style: genStatus.kind === 'err' ? S.err : genStatus.kind === 'ok' ? S.ok : S.muted }, genStatus.text),
          genBusy ? h('div', { style: { height: 6, background: 'rgba(127,127,127,.18)', borderRadius: 3, overflow: 'hidden', marginTop: 8 } },
            h('div', { style: { height: '100%', width: `${Math.min(95, 8 + genElapsed * 2)}%`, background: '#4f8cff', transition: 'width 1s linear' } })) : null,
          genBusy ? h('div', { style: { ...S.muted, marginTop: 6 } }, `已等待 ${genElapsed}s，通常需要 30–90 秒；完成后这里会显示结果`) : null) : null,

        digestStatus ? h('div', { style: { ...S.card, marginBottom: 12 } },
          h('div', { style: digestStatus.kind === 'err' ? S.err : digestStatus.kind === 'ok' ? S.ok : S.muted }, digestStatus.text),
          digestBusy ? h('div', { style: { height: 6, background: 'rgba(127,127,127,.18)', borderRadius: 3, overflow: 'hidden', marginTop: 8 } },
            h('div', { style: { height: '100%', width: `${Math.min(95, 8 + digestElapsed * 2)}%`, background: '#4f8cff', transition: 'width 1s linear' } })) : null,
          digestBusy ? h('div', { style: { ...S.muted, marginTop: 6 } }, `已等待 ${digestElapsed}s，通常需要 30–90 秒；完成后这里会显示结果`) : null) : null,

        h('div', { style: { display: 'flex', gap: 16, alignItems: 'stretch', flexWrap: 'wrap' } },
        h('div', { style: { ...S.card, flex: '1 1 420px', minWidth: 340, marginBottom: 16 } },
          h('details', null, h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, '每日日记（点此展开）'),
          h('div', { style: S.row },
            h('span', { style: S.muted }, `下次生成：${fmtTime(ov.state.nextAt)}　上次：${fmtTime(ov.state.lastRunAt)}${ov.state.lastSkip ? '　最近偷懒：' + fmtTime(ov.state.lastSkip) : ''}`),
            h('button', { style: S.btnPrimary, disabled: genBusy || !!busy, onClick: generate }, genBusy ? '生成中…' : '立即生成')),
          ov.state.lastError ? h('div', { style: S.err }, '最近错误：' + ov.state.lastError) : null,
          cfgRow('生成间隔（天）', h('select', { style: S.input, value: cfg.intervalDays, onChange: e => setCfg({ ...cfg, intervalDays: Number(e.target.value) }) },
            [1, 2, 3, 4, 5, 6, 7].map(n => h('option', { key: n, value: n }, n)))),
          cfgRow('固定生成时间', h('span', null,
            h('input', { style: S.input, type: 'time', value: cfg.dailyAt || '23:00', onChange: e => setCfg({ ...cfg, dailyAt: e.target.value }) }),
            h('span', { style: S.muted }, '　每 N 天在这一刻生成；改完保存会以今天为新锚点'))),
          cfgRow('偷懒概率', h('input', { style: S.input, type: 'number', step: 0.05, value: cfg.skipProbability, onChange: e => setCfg({ ...cfg, skipProbability: Number(e.target.value) }) })),
          cfgRow('字数范围', h('span', null,
            h('input', { style: S.input, type: 'number', value: cfg.minChars, onChange: e => setCfg({ ...cfg, minChars: Number(e.target.value) }) }),
            ' – ',
            h('input', { style: S.input, type: 'number', value: cfg.maxChars, onChange: e => setCfg({ ...cfg, maxChars: Number(e.target.value) }) }))),
          cfgRow('项目入库门槛', h('input', { style: S.input, type: 'number', step: 0.05, min: 0, max: 1, value: cfg.importanceThresholdProject, onChange: e => setCfg({ ...cfg, importanceThresholdProject: Number(e.target.value) }) })),
          cfgRow('闲聊入库门槛', h('input', { style: S.input, type: 'number', step: 0.05, min: 0, max: 1, value: cfg.importanceThresholdChat, onChange: e => setCfg({ ...cfg, importanceThresholdChat: Number(e.target.value) }) })),
          cfgRow('日记的重要候选上限（快照没有上限）', h('input', { style: S.input, type: 'number', min: 2, max: 30, value: cfg.diaryCandidateLimit, onChange: e => setCfg({ ...cfg, diaryCandidateLimit: Number(e.target.value) }) })),
          cfgRow('日记草稿自动上传记忆', h('input', { type: 'checkbox', checked: !!cfg.autoAdopt, onChange: e => setCfg({ ...cfg, autoAdopt: e.target.checked }) })),
          cfgRow('自动整合日记', h('input', { type: 'checkbox', checked: cfg.diaryBookEnabled !== false, onChange: e => setCfg({ ...cfg, diaryBookEnabled: e.target.checked }) })),
          cfgRow('日记合集目录', h('input', { style: { ...S.input, width: 360 }, type: 'text', placeholder: '默认 ~/.dsh/prime-diary/diary-book', value: cfg.diaryBookDir || '', onChange: e => setCfg({ ...cfg, diaryBookDir: e.target.value }) })),
          h('div', { style: S.row }, h('button', { style: S.btn, disabled: !!busy, onClick: () => save() }, busy === 'save' ? '保存中…' : '保存配置')),
          msg ? h('div', { style: S.ok }, msg) : null,
          err ? h('div', { style: S.err }, err) : null)),

        h('div', { style: { ...S.card, flex: '1 1 420px', minWidth: 340, marginBottom: 16 } },
          h('details', null, h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, '会话自动化快照与归档（点此展开）'),
          cfgRow('自动化的上下文阈值 %', h('input', { style: S.input, type: 'number', value: cfg.contextThreshold, onChange: e => setCfg({ ...cfg, contextThreshold: Number(e.target.value) }) })),
          cfgRow('自动化上下文检查间隔（分钟）', h('input', { style: S.input, type: 'number', min: 1, max: 1440, value: cfg.contextCheckMinutes, onChange: e => setCfg({ ...cfg, contextCheckMinutes: Number(e.target.value) }) })),
          cfgRow('自动快照类型', h('select', { style: S.input, value: cfg.autoDigestMode || '项目', onChange: e => setCfg({ ...cfg, autoDigestMode: e.target.value }) },
            ['项目', '闲聊', '全部'].map(m => h('option', { key: m, value: m }, m)))),
          cfgRow('自动快照（阈值触发）', h('input', { type: 'checkbox', checked: cfg.autoSnapshot !== false, onChange: e => setCfg({ ...cfg, autoSnapshot: e.target.checked }) })),
          cfgRow('快照后自动上传记忆', h('input', { type: 'checkbox', checked: cfg.autoRefine === true, onChange: e => setCfg({ ...cfg, autoRefine: e.target.checked }) })),
          cfgRow('自动归档完整会话', h('input', { type: 'checkbox', checked: cfg.archiveEnabled !== false, onChange: e => setCfg({ ...cfg, archiveEnabled: e.target.checked }) })),
          cfgRow('归档合集目录', h('input', { style: { ...S.input, width: 360 }, type: 'text', placeholder: '默认 ~/.dsh/prime-diary/archives', value: cfg.archiveDir || '', onChange: e => setCfg({ ...cfg, archiveDir: e.target.value }) })),
          cfgRow('快照合集目录', h('input', { style: { ...S.input, width: 360 }, type: 'text', placeholder: '默认 ~/.dsh/prime-diary/snapshot-books', value: cfg.snapshotBookDir || '', onChange: e => setCfg({ ...cfg, snapshotBookDir: e.target.value }) })),
          h('div', { style: S.row }, h('button', { style: S.btn, disabled: !!busy, onClick: () => save() }, busy === 'save' ? '保存中…' : '保存快照设置')),
          msg ? h('div', { style: S.ok }, msg) : null,
          err ? h('div', { style: S.err }, err) : null))
        ),
        h('div', { style: S.card },
          h('details', null, h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, '会话素材（勾选 = 纳入日记）（点此展开）'),
          h('div', { style: { ...S.row, marginTop: 6 } }, h('button', { style: S.btn, onClick: () => save({ hideArchived: !cfg.hideArchived }) }, cfg.hideArchived ? '显示全部会话' : '隐藏已归档')),
          h('table', { style: S.table },
            h('thead', null, h('tr', null, ['纳入', '会话', '工作区', '消息', '字符', '最后活动', '快照'].map((t, i) => h('th', { key: i, style: S.th }, t)))),
            h('tbody', null, ov.sessions.map(s => h('tr', { key: s.id },
              h('td', { style: S.td }, h('input', { type: 'checkbox', checked: included.has(s.id), onChange: e => toggleSession(s.id, e.target.checked) })),
              h('td', { style: S.td, title: s.id }, s.title + (s.archived ? '（已归档）' : '')),
              h('td', { style: S.td, title: s.workspace }, s.workspace.replace(/^--|--$/g, '').slice(0, 28)),
              h('td', { style: S.td }, s.messages),
              h('td', { style: S.td }, s.chars),
              h('td', { style: S.td }, fmtTime(s.lastAt)),
              h('td', { style: S.td }, h('select', { style: { ...S.input, width: 76, height: 28 }, value: (cfg.sessionModes && cfg.sessionModes[s.id]) || cfg.autoDigestMode || '项目', onChange: e => setSessionMode(s.id, e.target.value) },
                ['项目', '闲聊', '全部'].map(m => h('option', { key: m, value: m }, m))),
                h('button', { style: S.btn, disabled: !!digestBusy || !!busy, onClick: () => makeDigest(s.id, (cfg.sessionModes && cfg.sessionModes[s.id]) || cfg.autoDigestMode || '项目') }, digestBusy === s.id ? '生成中…' : '快照'), h('button', { style: S.btn, disabled: !!busy, onClick: () => archiveNow(s.id) }, busy === 'archive' ? '归档中…' : '归档')))))))),

        h('div', { style: S.card },
          h('details', null, h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, `已生成归档（${(ov.archives || []).length} 份，点此展开）`),
          h('div', { style: { ...S.muted, marginTop: 6, marginBottom: 8, lineHeight: 1.7 } }, `归档用于储存完整的会话记录，方便随时恢复记忆。由于数据量太大，它不会自动写入记忆库，只作为恢复记忆的最后保障。`),
          h('div', { style: { ...S.row, marginTop: 6 } },
            h('button', { style: S.btn, onClick: () => openArchiveDir() }, '打开归档目录'),
            h('span', { style: { ...S.muted, marginLeft: 8 } }, ov.archiveDirResolved || '')),
          (ov.archives || []).length === 0 ? h('div', { style: S.muted }, '还没有归档。') : null,
          h('table', { style: S.table },
            h('thead', null, h('tr', null, ['文件名', '大小', '归档时间', ''].map((t, i) => h('th', { key: i, style: S.th }, t)))),
            h('tbody', null, (ov.archives || []).map(a => h('tr', { key: a.name },
              h('td', { style: S.td, title: a.name }, a.name),
              h('td', { style: S.td }, (a.size / 1024).toFixed(0) + ' KB'),
              h('td', { style: S.td }, fmtTime(a.mtime)),
              h('td', { style: S.td }, h('button', { style: S.btn, disabled: !!busy, onClick: () => deleteArchive(a.name) }, '删除')))))))),

        h('div', { style: S.card },
          h('details', null, h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, `日记草稿（${ov.drafts.length} 份，点此展开）`),
          h('div', { style: { ...S.muted, marginTop: 6, marginBottom: 8, lineHeight: 1.7 } }, `日记会生成每日的信息，采纳后自动储存到记忆库；同一天可以多次生成，日记重要条目还要通过入库阈值，达到阈值才会储存到记忆中。`),
          h('div', { style: { ...S.row, marginTop: 6 } }, h('button', { style: S.btn, onClick: () => openDiaryBookDir() }, '打开日记合集目录'), h('span', { style: { ...S.muted, marginLeft: 8 } }, ov.diaryBookResolved || '')),
          ov.drafts.length === 0 ? h('div', { style: S.muted }, '还没有草稿，点「立即生成」。') : null,
          ov.drafts.map((d, idx) => {
            const open = openDrafts.find(x => x.date === d.date)
            return h('div', { key: d.date },
              h('div', { style: { ...S.row, borderBottom: '1px solid rgba(127,127,127,.12)', paddingBottom: 6 } },
                h('button', { style: { ...S.btn, width: 26, padding: 0, textAlign: 'center' }, onClick: () => toggleDraft(d.date) }, open ? '▾' : '▸'),
                h('b', null, `${idx + 1}. ${d.date}`),
                h('span', { style: S.muted }, `${d.chars} 字 · ${d.memories} 条候选${d.adopted ? ' · 已采纳' : ''}`),
                h('button', { style: S.btnPrimary, disabled: !!busy || !!adoptBusy, onClick: () => adopt(d.date) }, adoptBusy === d.date ? '上传中…' : '上传记忆'),
                h('button', { style: S.btn, onClick: () => discard(d.date) }, '删除')),
              open ? draftDetail(open) : null)
          }))),

        h('div', { style: S.card },
          h('details', null, h('summary', { style: { ...S.title, cursor: 'pointer', userSelect: 'none' } }, `已生成的快照（${(ov.digests || []).length} 份，点此展开）`),
          h('div', { style: S.row }, h('button', { style: S.btn, onClick: async () => { try { const r = await call('books.openDir'); setMsg('已打开快照合集目录：' + r.path) } catch (e) { setErr('打开失败：' + String(e && e.message || e)) } } }, '打开快照合集目录')),
          h('div', { style: { ...S.muted, marginTop: 6, marginBottom: 8, lineHeight: 1.7 } }, `快照会从整段会话中精炼出重要内容，是整个会话的精炼版本。支持【项目】【闲聊】【全部】三种精炼方式，方便提取真正想要的内容；精炼出的条目还要通过入库阈值，达到阈值才会储存到记忆中。`),
          ov.state.lastArchive ? h('div', { style: { ...S.muted, marginTop: 6 } }, `最近归档：${ov.state.lastArchive.path}（${ov.state.lastArchive.messages} 条）`) : null,
          (ov.digests || []).length === 0 ? h('div', { style: S.muted }, '还没有快照。阈值触发或点会话行的「快照」手动生成。') : null,
          (ov.digests || []).map((d, idx) => {
            const key = d.date + '::' + d.sessionId
            const open = openDigests.find(x => x.date + '::' + x.sessionId === key)
            return h('div', { key },
              h('div', { style: { ...S.row, borderBottom: '1px solid rgba(127,127,127,.12)', paddingBottom: 6 } },
                h('button', { style: { ...S.btn, width: 26, padding: 0, textAlign: 'center' }, onClick: () => toggleDigest(d) }, open ? '▾' : '▸'),
                h('b', null, `${idx + 1}. ${d.date}`),
                h('span', { style: S.muted }, `[${d.mode || '项目'}] ${d.title} · ${d.pct}% · ${d.items} 条`),
                h('button', { style: S.btnPrimary, disabled: !!busy, onClick: () => refineDigest(d) }, busy === 'refine' ? '上传中…' : '上传记忆'),
                h('button', { style: S.btn, onClick: () => deleteDigest(d) }, '删除')),
              open ? digestDetail(open) : null)
          }),))

        ,confirmBox ? h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 } },
          h('div', { style: { minWidth: 320, maxWidth: 520, background: '#252526', color: '#eee', border: '1px solid rgba(127,127,127,.35)', borderRadius: 12, padding: 18, boxShadow: '0 12px 40px rgba(0,0,0,.45)' } },
            h('div', { style: { fontWeight: 600, fontSize: 16, marginBottom: 10 } }, '请确认'),
            h('div', { style: { fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, confirmBox.text),
            h('div', { style: { marginTop: 16, display: 'flex', gap: 10, justifyContent: 'flex-end' } },
              h('button', { style: S.btn, onClick: () => setConfirmBox(null) }, '取消'),
              h('button', { style: S.btnPrimary, onClick: () => { const f = confirmBox.onOk; setConfirmBox(null); if (f) f() } }, '确认')))) : null
        ,dialog ? h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 } },
          h('div', { style: { minWidth: 340, maxWidth: 560, background: '#252526', color: '#eee', border: '1px solid rgba(127,127,127,.35)', borderRadius: 12, padding: 18, boxShadow: '0 12px 40px rgba(0,0,0,.45)' } },
            h('div', { style: { fontWeight: 600, fontSize: 16, marginBottom: 10 } }, dialog.title),
            dialog.lines.map((x, i) => h('div', { key: i, style: { fontSize: 13, lineHeight: 1.7, wordBreak: 'break-all' } }, x)),
            h('div', { style: { marginTop: 10, fontSize: 13, opacity: .85 } }, dialog.hint),
            h('div', { style: { marginTop: 14, textAlign: 'right' } }, h('button', { style: S.btnPrimary, onClick: () => setDialog(null) }, '知道了')))) : null
      )
    }

    const inject = ['slots', 'connection']

    function apply(ctx) {
      const conn = ctx.get('connection')
      if (!conn || !conn.rpc) return
      const call = async (endpoint, payload) => {
        const r = await conn.rpc.call('/prime-diary', endpoint, payload)
        if (r && r.ok === false) throw new Error(r.error?.message || 'rpc error')
        return r && typeof r === 'object' && 'value' in r ? r.value : r
      }
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'prime-diary',
        order: 30,
        label: () => '日记',
        inject: () => ({ call }),
      }, Section))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
