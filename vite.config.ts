import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Production-only CSP for the renderer window. The built app does no
// fetch/XHR/websocket/worker/blob loading at all (every cross-boundary call
// goes through the contextBridge IPC), so everything except styles can be
// strict 'self'; React's style attributes are the one inline exception.
// Injected via transformIndexHtml (build only) because Vite's dev server
// needs its inline module-preamble script.
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

function rendererCsp(): Plugin {
  return {
    name: 'opbs-renderer-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: RENDERER_CSP },
            injectTo: 'head-prepend'
          }
        ]
      };
    }
  };
}

export default defineConfig({
  plugins: [react(), rendererCsp()],
  base: './',
  root: 'src/renderer',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer')
    }
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
