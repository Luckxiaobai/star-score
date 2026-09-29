import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 星谱识音 StarScore
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 开发模式自动打开浏览器，方便"一打开就能用"
  server: {
    open: true,
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
})
