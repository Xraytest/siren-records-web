import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 使用相对路径，便于部署到 GitHub Pages 的任意子路径
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    // 开发时把 /api 转发到本地后端（npm run server）
    proxy: {
      '/api': { target: process.env.API_PROXY || 'http://127.0.0.1:8090', changeOrigin: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 900,
  },
})
