import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 백엔드가 없는 순수 정적 앱이다. Vercel·Netlify·GitHub Pages 어디에나 그대로 올라간다.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { outDir: 'dist' },
  // 계산 엔진을 ES 모듈 워커로 돌린다
  worker: { format: 'es' }
});
