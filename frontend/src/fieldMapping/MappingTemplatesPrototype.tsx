import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'

export function MappingTemplatesPrototype() {
  return (
    <div className="flex min-h-0 flex-col p-[22px]">
      <div className="mb-5 shrink-0">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-il-page-title font-semibold text-text">{t.fieldMappingUi.templatesPageTitle}</span>
          <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-il-soon text-accent-mid">
            {t.fieldMappingUi.prototypeBadge}
          </span>
        </div>
        <p className="max-w-3xl text-il-page-desc leading-relaxed text-text-2">
          {t.fieldMappingUi.templatesPageBody}
        </p>
      </div>

      <div className="mb-4 shrink-0 rounded-[10px] border border-border-light bg-[#fafbfc] px-4 py-3 text-il-meta leading-relaxed text-text-2">
        {t.fieldMappingUi.templatesInfoBanner}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {t.fieldMappingUi.templateCards.map((card) => (
          <Card key={card.id} title={card.title} className="flex flex-col" bodyClassName="flex flex-1 flex-col gap-3">
            <p className="flex-1 text-il-meta leading-relaxed text-text-2">{card.desc}</p>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-text-3">
              <span className="rounded border border-border-light bg-white px-1.5 py-0.5">{card.scope}</span>
              <span className="rounded border border-border-light bg-white px-1.5 py-0.5">{card.version}</span>
              <span className="rounded border border-border-light bg-white px-1.5 py-0.5">{card.updated}</span>
            </div>
            <div className="flex flex-wrap gap-2 border-t border-border-light pt-3">
              <button
                type="button"
                disabled
                className="rounded-[7px] border border-accent bg-white px-2.5 py-1 text-il-btn font-medium text-accent opacity-50"
                title={t.fieldMappingUi.templateActionSoon}
              >
                {t.fieldMappingUi.downloadSample}
              </button>
              <button
                type="button"
                disabled
                className="rounded-[7px] border border-border bg-white px-2.5 py-1 text-il-btn text-text-2 opacity-50"
                title={t.fieldMappingUi.templateActionSoon}
              >
                {t.fieldMappingUi.applyTemplate}
              </button>
            </div>
          </Card>
        ))}
      </div>

      <Card title={t.fieldMappingUi.uploadPackTitle} className="mt-6 shrink-0">
        <p className="mb-3 text-il-meta text-text-3">{t.fieldMappingUi.uploadPackDesc}</p>
        <div className="rounded-[10px] border-2 border-dashed border-border bg-[#fafbfc] px-4 py-8 text-center text-il-meta text-text-3">
          {t.fieldMappingUi.uploadPackPlaceholder}
        </div>
      </Card>
    </div>
  )
}
