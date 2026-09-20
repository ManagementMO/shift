import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    optimizeDeps: { exclude: ['maplibre-gl'] },
    server: {
      port: Number(env.CITYSHIFT_WEB_PORT || 5174),
      proxy: { '/api': { target: env.CITYSHIFT_API_URL || 'http://127.0.0.1:8000', changeOrigin: true } },
    },
  }
})
