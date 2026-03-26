import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

export default defineConfig({
  plugins: [
    {
      name: 'records-route-rewrite',
      configureServer(server) {
        // dev時: /records/{username} を records.html にルーティング
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?', 1)[0];
          const serveRecordsHtml = (filePath) => {
            try {
              const html = fs.readFileSync(filePath, 'utf-8');
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
              res.end(html);
              return true;
            } catch (e) {
              next(e);
              return true;
            }
          };
          if (req.method === 'GET') {
            if (url === '/' || url === '') {
              if (serveRecordsHtml(path.resolve(process.cwd(), 'records.html'))) return;
            }
            if (/^\/records\/[^/]+\/?$/.test(url)) {
              // /records/me は FastAPI のリダイレクト（プロキシへ回す）
              if (url === '/records/me' || url === '/records/me/') {
                return next();
              }
              if (serveRecordsHtml(path.resolve(process.cwd(), 'records.html'))) return;
            }
          }
          next();
        });
      },
      configurePreviewServer(server) {
        // preview時: /records/{username} を dist/records.html にルーティング
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?', 1)[0];
          const serveRecordsHtml = (filePath) => {
            try {
              const html = fs.readFileSync(filePath, 'utf-8');
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
              res.end(html);
              return true;
            } catch (e) {
              next(e);
              return true;
            }
          };
          const distRecords = path.resolve(process.cwd(), 'dist', 'records.html');
          if (req.method === 'GET') {
            if (url === '/' || url === '') {
              if (serveRecordsHtml(distRecords)) return;
            }
            if (/^\/records\/[^/]+\/?$/.test(url)) {
              if (url === '/records/me' || url === '/records/me/') {
                return next();
              }
              if (serveRecordsHtml(distRecords)) return;
            }
          }
          next();
        });
      },
    },
  ],
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
        admin_users: path.resolve(process.cwd(), 'admin-users.html'),
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
      '^/ocr$': { target: 'http://192.168.0.180:8000', changeOrigin: true },
      '/api': { target: 'http://192.168.0.180:8000', changeOrigin: true },
      // dev時: /records/{username} は FastAPI 側で配信する
      '^/records/': { target: 'http://192.168.0.180:8000', changeOrigin: true },
      // dev時: /admin/* も FastAPI 側で配信する
      '^/admin/': { target: 'http://192.168.0.180:8000', changeOrigin: true },
    },
  },
});
