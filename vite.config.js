import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/BrainrotTCG/',
  plugins: [react()],
  server: {
    proxy: {
      '/api/eleven': {
        target: 'https://api.elevenlabs.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/eleven/, ''),
      },
    },
  },
})
