import React from 'react'

type IconProps = React.SVGProps<SVGSVGElement>

export function IconUpload(props: IconProps) {
  return (
    <svg viewBox="0 0 15 15" fill="none" {...props}>
      <path
        d="M7.5 1v9M4 7l3.5 3.5L11 7M2 12h11"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconGrid(props: IconProps) {
  return (
    <svg viewBox="0 0 15 15" fill="none" {...props}>
      <rect x="1" y="3" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="9" y="3" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="5" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M3.5 8v2M11.5 8v2M7.5 8v1"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconChartBars(props: IconProps) {
  return (
    <svg viewBox="0 0 15 15" fill="none" {...props}>
      <rect x="1" y="8" width="3" height="6" rx="1" fill="currentColor" opacity=".5" />
      <rect x="6" y="5" width="3" height="9" rx="1" fill="currentColor" opacity=".7" />
      <rect x="11" y="2" width="3" height="12" rx="1" fill="currentColor" />
    </svg>
  )
}

export function IconClock(props: IconProps) {
  return (
    <svg viewBox="0 0 15 15" fill="none" {...props}>
      <circle cx="7.5" cy="7.5" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M7.5 2v5.5l3.5 2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconAlert(props: IconProps) {
  return (
    <svg viewBox="0 0 15 15" fill="none" {...props}>
      <path
        d="M7.5 2v7M7.5 11v2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconNetwork(props: IconProps) {
  return (
    <svg viewBox="0 0 15 15" fill="none" {...props}>
      <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="11" cy="4" r="2" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="7.5" cy="11" r="2" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M6 4h3M5.2 5.5l1.5 4M9.8 5.5l-1.5 4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconCompare(props: IconProps) {
  return (
    <svg viewBox="0 0 15 15" fill="none" {...props}>
      <rect x="1" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="9" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M3.5 7v2M11.5 1v5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconReportDoc(props: IconProps) {
  return (
    <svg viewBox="0 0 15 15" fill="none" {...props}>
      <rect x="2" y="1" width="11" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M5 5h5M5 7.5h5M5 10h3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconUser(props: IconProps) {
  return (
    <svg viewBox="0 0 15 15" fill="none" {...props}>
      <circle cx="7.5" cy="5" r="3" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M1 13.5c0-3.3 2.9-6 6.5-6s6.5 2.7 6.5 6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconSettings(props: IconProps) {
  return (
    <svg viewBox="0 0 15 15" fill="none" {...props}>
      <circle cx="7.5" cy="7.5" r="2" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M7.5 1v1.5M7.5 12.5V14M1 7.5h1.5M12.5 7.5H14M2.6 2.6l1 1M11.4 11.4l1 1M11.4 3.6l-1 1M3.6 11.4l-1 1"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconChevronRight(props: IconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="none" {...props}>
      <path
        d="M4 5l2 2 2-2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconPlusSquare(props: IconProps) {
  return (
    <svg viewBox="0 0 11 11" fill="none" {...props}>
      <rect x="1" y="1" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M4 5.5h3M5.5 4v3"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconMiniClock(props: IconProps) {
  return (
    <svg viewBox="0 0 11 11" fill="none" {...props}>
      <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M5.5 3v2.5l2 1"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconMiniCheck(props: IconProps) {
  return (
    <svg viewBox="0 0 11 11" fill="none" {...props}>
      <path
        d="M2 8.5l2.5-3 2 2.5L9 3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function IconMiniMap(props: IconProps) {
  return (
    <svg viewBox="0 0 11 11" fill="none" {...props}>
      <path
        d="M1 4h4M1 7h4M6 4l4 1.5L6 7"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 分步向导：三节点流程，用于导入向导等多级步骤入口 */
export function IconMiniSteps(props: IconProps) {
  return (
    <svg viewBox="0 0 11 11" fill="none" {...props}>
      <circle cx="2" cy="5.5" r="1.3" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="5.5" cy="5.5" r="1.3" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="9" cy="5.5" r="1.3" stroke="currentColor" strokeWidth="1.1" />
      <path
        d="M3.3 5.5h1.4M6.8 5.5h1.4"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  )
}
