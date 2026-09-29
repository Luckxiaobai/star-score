import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { bootstrapBackend } from './core/audio/backendConfig'

// 启动时把持久化的后端地址同步到 GAME / HOMR 引擎
bootstrapBackend()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
