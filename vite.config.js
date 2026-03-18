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
    // records.html もビルド出力に含める（preview で必要）
    rollupOptions: {
      input: {
        index: path.resolve(process.cwd(), 'index.html'),
        records: path.resolve(process.cwd(), 'records.html'),
      },
    },
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
        const url = (req.url || '').split('?', 1)[0];
        if (/^\/records\/[^/]+\/?$/.test(url)) {
          const filePath = path.resolve(process.cwd(), 'records.html');
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

  preview: {
    // preview時も /records/{username} を dist/records.html にルーティング
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?', 1)[0];
        if (/^\/records\/[^/]+\/?$/.test(url)) {
          const filePath = path.resolve(process.cwd(), 'dist', 'records.html');
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
