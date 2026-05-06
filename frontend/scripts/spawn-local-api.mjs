/**
 * 从 frontend/ 目录拉起仓库根目录的 Local API（8765），供 npm run dev:with-api 使用。
 * 避免「只开 Vite、未开 Python」导致 /api 代理 ECONNREFUSED 反复出现。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')
const py = process.env.PYTHON ?? 'python'
const env = {
  ...process.env,
  INVOICELENS_LOCAL_API_HOST: process.env.INVOICELENS_LOCAL_API_HOST || '127.0.0.1',
  INVOICELENS_LOCAL_API_PORT: process.env.INVOICELENS_LOCAL_API_PORT || '8765',
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  PYTHONLEGACYWINDOWSSTDIO: 'utf-8',
}

const child = spawn(py, ['-m', 'src.local_api.sheet_mapping_server'], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
})

child.on('error', (err) => {
  console.error(
    '\n[InvoiceLens] 无法启动 Local API：',
    err.message,
    '\n请确认：1) 已在仓库根执行 pip install -r requirements.txt  2) 命令 python 可用\n',
  )
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) process.exit(1)
  process.exit(code ?? 1)
})
