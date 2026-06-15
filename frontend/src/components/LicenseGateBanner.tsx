type Props = {
  hint: string | null
  className?: string
}

/** 试用/过期授权提示条；无 hint 时不渲染。 */
export function LicenseGateBanner({ hint, className }: Props) {
  if (!hint?.trim()) return null
  return (
    <div
      className={[
        'rounded-sm border border-warn/40 bg-warn/5 px-3 py-2 text-sm text-text-2',
        className ?? '',
      ].join(' ')}
    >
      {hint}
    </div>
  )
}
