/** 统计年度：当前年 +1（预编下年）至当前年往回 11 年，并与 API 返回年度合并。 */
export function buildStatYearOptions(apiYears: string[]): string[] {
  const cy = new Date().getFullYear()
  const fallback = Array.from({ length: 12 }, (_, i) => String(cy + 1 - i))
  const s = new Set<string>([...fallback, ...apiYears.map((x) => String(x ?? '').trim()).filter(Boolean)])
  return Array.from(s).sort((a, b) => Number(b) - Number(a))
}

/** 实务默认年度：当前自然年（跨年自动变为新年份）。 */
export function defaultPracticeStatYear(yearOptions: string[], apiDefault?: string | null): string {
  const cy = String(new Date().getFullYear())
  if (yearOptions.includes(cy)) return cy
  const d = (apiDefault ?? '').trim()
  if (d && yearOptions.includes(d)) return d
  return yearOptions[0] ?? cy
}
