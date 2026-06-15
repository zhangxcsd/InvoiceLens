import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')) as { version?: string }
const appVersion = String(pkg.version ?? '0.0.0')

function writeBuildMetaPlugin(): Plugin {
  return {
    name: 'invoicelens-write-build-meta',
    buildStart() {
      const buildTime = new Date().toISOString()
      const meta = { app_version: appVersion, build_time: buildTime }
      const configPath = path.resolve(__dirname, '../config/build_meta.json')
      fs.writeFileSync(configPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8')
    },
  }
}

function localApiProxyErrorBanner(err: NodeJS.ErrnoException): void {
  const code = err.code ?? ''
  const msg = String(err.message ?? err)
  const lines = [
    '',
    '========== InvoiceLens /api 代理失败 ==========',
    `原因: ${code || 'unknown'} — ${msg}`,
  ]
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(msg)) {
    lines.push(
      '说明: 127.0.0.1:8765 上没有 Local API（Python sheet_mapping_server）在监听。',
      '处理（任选其一）:',
      '  • 推荐：在仓库根目录双击 dev.bat（单窗口同时起 API + Vite）',
      '  • 或：仓库根目录执行 dev.bat api；或 frontend 下 npm run dev:with-api',
      '  • 若你只用了 npm run dev：必须先有进程监听 8765，否则会反复出现本错误',
    )
  } else {
    lines.push('说明: 上游 Local API 异常或无响应；查看 API 窗口内的 Python 报错。')
  }
  lines.push('===============================================', '')
  console.error(lines.join('\n'))
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), writeBuildMetaPlugin()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
  },
  server: {
    // 开发时走同源 /api，避免 fetch 直连 127.0.0.1:8765 与页面 localhost:5173 跨域/混合源问题
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
        // DWD 构建可能较长；默认代理超时过短会表现为 HTTP 502（浏览器仅见网关错误）
        timeout: 3_600_000,
        proxyTimeout: 3_600_000,
        configure(proxy) {
          proxy.on('error', (err: NodeJS.ErrnoException) => {
            localApiProxyErrorBanner(err)
          })
        },
      },
    },
  },
})
