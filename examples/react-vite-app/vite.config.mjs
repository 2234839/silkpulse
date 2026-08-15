import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

/** 单文件产物：方便直接拷到 server/public 静态 serve（无需资源目录） */
export default defineConfig({
  plugins: [react(), viteSingleFile()],
})
