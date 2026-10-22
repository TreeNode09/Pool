import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { ensureOpencv } from './scripts/fetch-opencv.js'

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [
    vue(),
    {
      name: 'local-opencv',
      buildStart() {
        return ensureOpencv()
      },
    },
  ],
})
