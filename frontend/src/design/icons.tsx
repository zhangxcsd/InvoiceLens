import React from 'react'

export function UploadIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" {...props}>
      <rect
        x="4"
        y="8"
        width="32"
        height="26"
        rx="3"
        stroke="#0072D1"
        strokeWidth="1.5"
        strokeDasharray="3"
      />
      <path
        d="M20 16v10M16 20l4-4 4 4"
        stroke="#0072D1"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

