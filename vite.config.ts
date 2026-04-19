import { defineConfig } from 'vite';

// The web UI lives in /web. The Vite dev server / build is rooted there so
// that index.html sits at the URL root, while still being able to import
// modules from ../src.
export default defineConfig({
    root: 'web',
    base: './',
    build: {
        outDir: '../dist-web',
        emptyOutDir: true,
        target: 'es2022',
    },
    server: {
        host: true,
        port: 5173,
    },
});
