import React from 'react'

export type BadgeTone = 'high' | 'medium' | 'low' | 'blue' | 'gray' | 'purple'

const toneClass: Record<BadgeTone, string> = {
  high: 'bg-[#FCEBEB] text-[#791F1F]',
  medium: 'bg-[#FAEEDA] text-[#633806]',
  low: 'bg-[#E1F5EE] text-[#085041]',
  blue: 'bg-[#EBF4FF] text-[#185FA5]',
  gray: 'bg-[#F1EFE8] text-[#444441]',
  purple: 'bg-[#EEEDFE] text-[#26215C]',
}

export function Badge(props: { tone: BadgeTone; children: React.ReactNode }) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-full px-2 py-[2px]',
        'text-il-meta font-medium',
        toneClass[props.tone],
      ].join(' ')}
    >
      <span className="h-[5px] w-[5px] rounded-full bg-current opacity-90" />
      {props.children}
    </span>
  )
}

