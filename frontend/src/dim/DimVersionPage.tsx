import { useMemo, useState } from 'react'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { zhCN as t } from '../copy/zh-CN'
import type { DetailTab, DimVersion } from './version/types'
import { versionSeed } from './version/mock'
import { VersionActionBar } from './version/VersionActionBar'
import { VersionDetailTabs } from './version/VersionDetailTabs'
import { VersionHeader } from './version/VersionHeader'
import { VersionListPanel } from './version/VersionListPanel'

export function DimVersionPage() {
  const ui = t.dimVersionUi
  const [allVersions, setAllVersions] = useState<DimVersion[]>(versionSeed)
  const [statYear, setStatYear] = useState('2026')
  const [selectedId, setSelectedId] = useState('2026-v3')
  const [activeTab, setActiveTab] = useState<DetailTab>('definition')
  const [banner, setBanner] = useState('')

  const yearOptions = useMemo(
    () => Array.from(new Set(allVersions.map((v) => v.statYear))).sort((a, b) => Number(b) - Number(a)),
    [allVersions],
  )
  const yearVersions = useMemo(
    () => allVersions.filter((v) => v.statYear === statYear).sort((a, b) => b.versionNo - a.versionNo),
    [allVersions, statYear],
  )

  const selected = useMemo(() => yearVersions.find((v) => v.id === selectedId) ?? yearVersions[0] ?? null, [selectedId, yearVersions])

  const currentVersion = useMemo(
    () => yearVersions.find((v) => v.isCurrent && v.status === 'published') ?? null,
    [yearVersions],
  )

  const previousPublished = useMemo(() => {
    if (!selected) return null
    return (
      yearVersions.find((v) => v.status === 'published' && v.id !== selected.id && v.versionNo < selected.versionNo) ?? null
    )
  }, [selected, yearVersions])

  const diffRows = useMemo(() => {
    if (!selected || !previousPublished) return []
    return [
      { metric: ui.diffMetricTotal, prev: previousPublished.kpis.subjectTotal, curr: selected.kpis.subjectTotal },
      { metric: ui.diffMetricEnterpriseRatio, prev: previousPublished.kpis.enterpriseRatio, curr: selected.kpis.enterpriseRatio },
      { metric: ui.diffMetricCoverage, prev: previousPublished.kpis.mappingCoverage, curr: selected.kpis.mappingCoverage },
      { metric: ui.diffMetricUnmatched, prev: previousPublished.kpis.unmatchedCount, curr: selected.kpis.unmatchedCount },
    ]
  }, [previousPublished, selected, ui])

  const selectVersion = (id: string) => {
    setSelectedId(id)
    setActiveTab('definition')
  }

  const onStatYearChange = (year: string) => {
    setStatYear(year)
    const top = allVersions
      .filter((v) => v.statYear === year)
      .sort((a, b) => b.versionNo - a.versionNo)[0]
    if (top) setSelectedId(top.id)
  }

  const createDraftFromCurrent = () => {
    if (!currentVersion) return
    const nextNo = Math.max(...yearVersions.map((v) => v.versionNo)) + 1
    const draft: DimVersion = {
      ...currentVersion,
      id: `${statYear}-v${nextNo}`,
      versionNo: nextNo,
      status: 'draft',
      isCurrent: false,
      updatedAt: ui.nowMock,
      updatedBy: ui.currentUser,
      publishedAt: undefined,
      publishedBy: undefined,
      changeNote: ui.defaultDraftNote,
    }
    setAllVersions((prev) => [draft, ...prev])
    setSelectedId(draft.id)
    setBanner(ui.bannerDraftCreated.replace('{version}', `v${nextNo}`))
  }

  const publishSelected = () => {
    if (!selected || selected.status !== 'draft') return
    setAllVersions((prev) =>
      prev.map((v) => {
        if (v.statYear !== selected.statYear) return v
        if (v.id === selected.id) {
          return {
            ...v,
            status: 'published',
            isCurrent: true,
            publishedAt: ui.nowMock,
            publishedBy: ui.currentUser,
            updatedAt: ui.nowMock,
            updatedBy: ui.currentUser,
          }
        }
        if (v.isCurrent) return { ...v, isCurrent: false }
        return v
      }),
    )
    setBanner(ui.bannerPublished.replace('{version}', `v${selected.versionNo}`))
  }

  const rollbackToPrevious = () => {
    if (!selected || selected.status !== 'published') return
    if (!previousPublished) return
    setAllVersions((prev) =>
      prev.map((v) => {
        if (v.statYear !== selected.statYear) return v
        if (v.id === previousPublished.id) return { ...v, isCurrent: true, updatedAt: ui.nowMock, updatedBy: ui.currentUser }
        if (v.id === selected.id) return { ...v, isCurrent: false, updatedAt: ui.nowMock, updatedBy: ui.currentUser }
        return v
      }),
    )
    setSelectedId(previousPublished.id)
    setBanner(ui.bannerRollback.replace('{version}', `v${previousPublished.versionNo}`))
  }

  const archiveSelected = () => {
    if (!selected || selected.status === 'archived') return
    setAllVersions((prev) =>
      prev.map((v) => (v.id === selected.id ? { ...v, status: 'archived', isCurrent: false, updatedAt: ui.nowMock, updatedBy: ui.currentUser } : v)),
    )
    setBanner(ui.bannerArchived.replace('{version}', `v${selected.versionNo}`))
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
        badgeText={ui.prototypeBadge}
        actions={
          <button
            type="button"
            className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text transition-colors hover:bg-[#f8fafc]"
            onClick={createDraftFromCurrent}
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

      {banner ? (
        <div className="mb-4 rounded-sm border border-[#c8e6d0] bg-[#f4fbf6] px-3 py-2 text-il-meta text-[#1b6b3a]">{banner}</div>
      ) : null}

      <VersionHeader
        ui={ui}
        statYear={statYear}
        yearOptions={yearOptions}
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
        onSaveDraft={() => setBanner(ui.bannerSaved)}
        onPublish={publishSelected}
        onRollback={rollbackToPrevious}
        onArchive={archiveSelected}
        onExport={() => setBanner(ui.bannerExported)}
      />
    </div>
  )
}
