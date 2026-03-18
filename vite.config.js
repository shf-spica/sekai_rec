import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

export default defineConfig({
  // ONNX Runtime Web: Viteのesbuildプリバンドルを除外（WASMバイナリが壊れるのを防ぐ）
  optimizeDeps: {
    exclude: ['onnxruntime-web', 'onnxruntime-web/wasm', 'onnxruntime-web/webgpu'],
  },

  // WASMとONNXファイルをアセットとして認識
  assetsInclude: ['**/*.wasm', '**/*.onnx'],

  build: {
    target: 'esnext',
  },

  // Web WorkerをES moduleフォーマットで出力
  worker: {
    format: 'es',
  },

  server: {
    host: true,
    proxy: {
      '^/ocr$': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
    configureServer(server) {
      // dev時も /records/{username} を records.html にルーティングする（ViteのSPAフォールバック回避）
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        if (/^\/records\/[^/?#]+\/?$/.test(url)) {
          const filePath = path.resolve(new URL('.', import.meta.url).pathname, 'records.html');
          try {
            const html = fs.readFileSync(filePath, 'utf-8');
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(html);
            return;
          } catch (e) {
            next(e);
            return;
          }
        }
        next();
      });
    },
  },
});
