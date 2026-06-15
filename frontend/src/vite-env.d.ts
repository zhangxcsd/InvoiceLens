/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string
  readonly VITE_LOCAL_API_BASE?: string
  readonly VITE_MAX_IMPORT_FILE_MB?: string
  readonly VITE_IMPORT_SIM_ON_FAIL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
