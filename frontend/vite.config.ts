import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 开发时走同源 /api，避免 fetch 直连 127.0.0.1:8765 与页面 localhost:5173 跨域/混合源问题
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
        // DWD 构建可能较长；默认代理超时过短会表现为 HTTP 502（浏览器仅见网关错误）
        timeout: 3_600_000,
        proxyTimeout: 3_600_000,
      },
    },
  },
})
