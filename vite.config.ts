import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 使用相对路径，便于部署到 GitHub Pages 的任意子路径
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 900,
  },
})
