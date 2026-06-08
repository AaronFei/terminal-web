import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['web/terminal.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outdir: 'public/dist',
  entryNames: '[name]',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[esbuild] watching for changes...');
} else {
  await esbuild.build(options);
  console.log('[esbuild] build complete -> public/dist/terminal.js, public/dist/terminal.css');
}
