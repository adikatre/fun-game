import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds to a single self-contained index.html (JS + CSS inlined) so the bundle
// can be dropped straight into a CrazyGames-style static host with no runtime calls.
// `base: './'` keeps asset references relative for that kind of host.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    // es2022 for top-level await (boot blocks on CrazyGames SDK init before
    // reading cloud saves). Fine for CrazyGames' browser matrix (Chrome/Edge).
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000,
  },
});
