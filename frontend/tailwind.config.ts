import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontSize: {
        // Typography scale aligned to invoicelens.html
        'il-login-brand': ['22px', { lineHeight: '1.2', letterSpacing: '-.3px' }],
        'il-page-title': ['17px', { lineHeight: '1.35' }],
        'il-page-desc': ['12px', { lineHeight: '1.5' }],
        'il-topbar': ['12px', { lineHeight: '1.5' }],
        'il-pill': ['12px', { lineHeight: '1.2' }],
        'il-btn': ['12px', { lineHeight: '1.2' }],
        'il-input': ['10px', { lineHeight: '1.5' }],
        'il-label': ['9px', { lineHeight: '1.2' }],
        'il-card-title': ['12px', { lineHeight: '1.2' }],
        'il-sidebar-parent': ['12px', { lineHeight: '1.2' }],
        'il-sidebar-child': ['11px', { lineHeight: '1.2' }],
        'il-sidebar-grand': ['10px', { lineHeight: '1.2' }],
        'il-meta': ['11px', { lineHeight: '1.2' }],
        'il-soon': ['9px', { lineHeight: '1.2' }],
      },
      colors: {
        accent: '#0072D1',
        'accent-mid': '#185FA5',
        danger: '#E24B4A',
        warn: '#BA7517',
        green: '#1D9E75',
        bg: '#F5F7FA',
        border: '#E2E6EE',
        'border-light': '#EEF1F6',
        text: '#1A1D23',
        'text-2': '#5A6070',
        'text-3': '#9AA0AD',
      },
      borderRadius: {
        sm: '7px',
        DEFAULT: '10px',
      },
      fontFamily: {
        sans: [
          'PingFang SC',
          'Microsoft YaHei',
          '-apple-system',
          'BlinkMacSystemFont',
          'system-ui',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
      boxShadow: {
        card: '0 20px 60px rgba(0,102,204,.12)',
      },
    },
  },
  plugins: [],
} satisfies Config

