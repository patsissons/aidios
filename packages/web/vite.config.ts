import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/analyze': 'http://localhost:3000',
    },
  },
})
