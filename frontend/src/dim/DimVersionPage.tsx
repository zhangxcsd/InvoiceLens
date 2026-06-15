import { useCallback, useEffect, useMemo, useState } from 'react'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchDimCaliberVersions,
  postDimCaliberVersionArchive,
  postDimCaliberVersionCreateDraft,
  postDimCaliberVersionPublish,
  postDimCaliberVersionRollback,
  postDimCaliberVersionSaveDraft,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import type { DetailTab, DimVersion } from './version/types'
import { VersionActionBar } from './version/VersionActionBar'
import { VersionDetailTabs } from './version/VersionDetailTabs'
import { VersionHeader } from './version/VersionHeader'
import { VersionListPanel } from './version/VersionListPanel'

export function DimVersionPage() {
  const ui = t.dimVersionUi
  const [allVersions, setAllVersions] = useState<DimVersion[]>([])
  const [statYear, setStatYear] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [activeTab, setActiveTab] = useState<DetailTab>('definition')
  const [banner, setBanner] = useState('')
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    const res = await fetchDimCaliberVersions()
    if (!res.ok) {
      setLoadError(res.error?.message ?? ui.loadFailed)
      setAllVersions([])
      setLoading(false)
      return
    }
    const versions = (res.versions ?? []) as DimVersion[]
    setAllVersions(versions)
    const years = res.stat_years?.length
      ? res.stat_years
      : Array.from(new Set(versions.map((v) => v.statYear))).sort((a, b) => Number(b) - Number(a))
    setStatYear((prev) => {
      if (prev && years.includes(prev)) return prev
      return years[0] ?? String(new Date().getFullYear())
    })
    setSelectedId((prev) => {
      if (prev && versions.some((v) => v.id === prev)) return prev
      const y = years[0] ?? String(new Date().getFullYear())
      const top = versions.filter((v) => v.statYear === y).sort((a, b) => b.versionNo - a.versionNo)[0]
      return top?.id ?? ''
    })
    setLoading(false)
  }, [ui.loadFailed])

  useEffect(() => {
    void reload()
  }, [reload])

  const yearOptions = useMemo(
    () => Array.from(new Set(allVersions.map((v) => v.statYear))).sort((a, b) => Number(b) - Number(a)),
    [allVersions],
  )
  const yearVersions = useMemo(
    () => allVersions.filter((v) => v.statYear === statYear).sort((a, b) => b.versionNo - a.versionNo),
    [allVersions, statYear],
  )

  const selected = useMemo(
    () => yearVersions.find((v) => v.id === selectedId) ?? yearVersions[0] ?? null,
    [selectedId, yearVersions],
  )

  const currentVersion = useMemo(
    () => yearVersions.find((v) => v.isCurrent && v.status === 'published') ?? null,
    [yearVersions],
  )

  const previousPublished = useMemo(() => {
    if (!selected) return null
    return (
      yearVersions.find((v) => v.status === 'published' && v.id !== selected.id && v.versionNo < selected.versionNo) ??
      null
    )
  }, [selected, yearVersions])

  const diffRows = useMemo(() => {
    if (!selected || !previousPublished) return []
    return [
      { metric: ui.diffMetricTotal, prev: previousPublished.kpis.subjectTotal, curr: selected.kpis.subjectTotal },
      {
        metric: ui.diffMetricEnterpriseRatio,
        prev: previousPublished.kpis.enterpriseRatio,
        curr: selected.kpis.enterpriseRatio,
      },
      {
        metric: ui.diffMetricCoverage,
        prev: previousPublished.kpis.mappingCoverage,
        curr: selected.kpis.mappingCoverage,
      },
      { metric: ui.diffMetricUnmatched, prev: previousPublished.kpis.unmatchedCount, curr: selected.kpis.unmatchedCount },
    ]
  }, [previousPublished, selected, ui])

  const selectVersion = (id: string) => {
    setSelectedId(id)
    setActiveTab('definition')
  }

  const onStatYearChange = (year: string) => {
    setStatYear(year)
    const top = allVersions.filter((v) => v.statYear === year).sort((a, b) => b.versionNo - a.versionNo)[0]
    if (top) setSelectedId(top.id)
  }

  const createDraftFromCurrent = async () => {
    if (!statYear || busy) return
    setBusy(true)
    setBanner('')
    const res = await postDimCaliberVersionCreateDraft(statYear)
    setBusy(false)
    if (!res.ok) {
      setLoadError(res.error?.message ?? ui.actionFailed)
      return
    }
    await reload()
    if (res.version?.id) setSelectedId(res.version.id)
    setBanner(ui.bannerDraftCreated.replace('{version}', `v${res.version?.versionNo ?? ''}`))
  }

  const publishSelected = async () => {
    if (!selected || selected.status !== 'draft' || busy) return
    setBusy(true)
    const res = await postDimCaliberVersionPublish(selected.id)
    setBusy(false)
    if (!res.ok) {
      setLoadError(res.error?.message ?? ui.actionFailed)
      return
    }
    await reload()
    setBanner(ui.bannerPublished.replace('{version}', `v${selected.versionNo}`))
  }

  const rollbackToPrevious = async () => {
    if (!selected || selected.status !== 'published' || !previousPublished || busy) return
    setBusy(true)
    const res = await postDimCaliberVersionRollback(selected.id)
    setBusy(false)
    if (!res.ok) {
      setLoadError(res.error?.message ?? ui.actionFailed)
      return
    }
    await reload()
    if (res.version?.id) setSelectedId(res.version.id)
    setBanner(ui.bannerRollback.replace('{version}', `v${res.version?.versionNo ?? previousPublished.versionNo}`))
  }

  const archiveSelected = async () => {
    if (!selected || selected.status === 'archived' || busy) return
    setBusy(true)
    const res = await postDimCaliberVersionArchive(selected.id)
    setBusy(false)
    if (!res.ok) {
      setLoadError(res.error?.message ?? ui.actionFailed)
      return
    }
    await reload()
    setBanner(ui.bannerArchived.replace('{version}', `v${selected.versionNo}`))
  }

  const saveDraft = async () => {
    if (!selected || selected.status !== 'draft' || busy) return
    setBusy(true)
    const res = await postDimCaliberVersionSaveDraft(selected.id)
    setBusy(false)
    if (!res.ok) {
      setLoadError(res.error?.message ?? ui.actionFailed)
      return
    }
    setBanner(ui.bannerSaved)
  }

  const canPublish = selected?.status === 'draft'
  const canRollback = selected?.status === 'published' && !!previousPublished
  const canArchive = !!selected && selected.status !== 'archived'

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader
        title={ui.pageTitle}
        description={ui.pageNote}
        note={ui.pageDesc}
        noteTone="plain"
        actions={
          <button
            type="button"
            className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text transition-colors hover:bg-[#f8fafc] disabled:opacity-50"
            disabled={busy || loading || !currentVersion}
            onClick={() => void createDraftFromCurrent()}
          >
            {ui.createDraftBtn}
          </button>
        }
      />

      <div className="mb-4 rounded-sm border border-border-light bg-[#fafbfd] px-4 py-3 text-il-page-desc text-text-2">
        <div className="font-semibold text-text">{ui.scopeCardTitle}</div>
        <p className="mt-1.5 text-il-meta leading-relaxed">{ui.scopeCardLead}</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-il-meta text-text-2">
          <li>{ui.scopeBullet1}</li>
          <li>{ui.scopeBullet2}</li>
          <li>{ui.scopeBullet3}</li>
        </ul>
      </div>

      {loadError ? (
        <div className="mb-4 rounded-sm border border-danger/30 bg-[#fff5f5] px-3 py-2 text-il-meta text-danger">{loadError}</div>
      ) : null}
      {banner ? (
        <div className="mb-4 rounded-sm border border-[#c8e6d0] bg-[#f4fbf6] px-3 py-2 text-il-meta text-[#1b6b3a]">{banner}</div>
      ) : null}

      {loading ? (
        <div className="py-8 text-center text-il-meta text-text-3">{ui.loading}</div>
      ) : (
        <>
          <VersionHeader
            ui={ui}
            statYear={statYear}
            yearOptions={yearOptions.length ? yearOptions : [statYear || String(new Date().getFullYear())]}
            onStatYearChange={onStatYearChange}
            currentVersion={currentVersion}
            selected={selected}
          />

          <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
            <VersionListPanel ui={ui} yearVersions={yearVersions} selected={selected} onSelectVersion={selectVersion} />
            <VersionDetailTabs ui={ui} selected={selected} activeTab={activeTab} onTabChange={setActiveTab} diffRows={diffRows} />
          </div>

          <VersionActionBar
            ui={ui}
            canPublish={!!canPublish}
            canRollback={!!canRollback}
            canArchive={!!canArchive}
            onSaveDraft={() => void saveDraft()}
            onPublish={() => void publishSelected()}
            onRollback={() => void rollbackToPrevious()}
            onArchive={() => void archiveSelected()}
            onExport={() => setBanner(ui.bannerExported)}
          />
        </>
      )}
    </div>
  )
}
