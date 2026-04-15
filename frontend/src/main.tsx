import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { zhCN } from './copy/zh-CN'
import './index.css'
import App from './App.tsx'

document.title = zhCN.shell.documentTitle

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
