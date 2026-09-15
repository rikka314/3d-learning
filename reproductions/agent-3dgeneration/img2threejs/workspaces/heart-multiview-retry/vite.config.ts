import { defineConfig } from 'vite';

export default defineConfig({
  server: { watch: { ignored: ['**/output/**', '**/.img2threejs/**', '**/material-evidence/**'] } },
});
