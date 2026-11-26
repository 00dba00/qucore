import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { guidePlugin } from './scripts/vite-guide-plugin'

export default defineConfig({
  main: {
    // msnodesqlv8 je optionalDependency (electron-vite izvlači samo dependencies), a native
    // modul mora ostati u node_modules da ga node-gyp-build nađe.
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts'), external: ['msnodesqlv8'] } }
  },
  preload: {
    build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { minify: true, rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
    // Korisnički vodič (docs/guide) ugrađen u aplikaciju: import 'virtual:guide'.
    plugins: [react(), guidePlugin({ hr: resolve(__dirname, 'docs/guide/README.md'), en: resolve(__dirname, 'docs/guide/README.en.md') })]
  }
})
