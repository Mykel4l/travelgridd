import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// This config is primarily for Cloudflare Pages compatibility.
// It points Vite to the client directory where the actual application
// and its full configuration (client/vite.config.js) are located.
export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
})
