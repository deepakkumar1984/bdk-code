// scripts/build-bundle.ts
// Usage: bun scripts/build-bundle.ts [--watch] [--minify] [--no-sourcemap]
//
// Production build: bun scripts/build-bundle.ts --minify
// Dev build:        bun scripts/build-bundle.ts
// Watch mode:       bun scripts/build-bundle.ts --watch

import * as esbuild from 'esbuild'
import { resolve, dirname } from 'path'
import { chmodSync, readFileSync, existsSync, statSync } from 'fs'
import { fileURLToPath } from 'url'

// Bun: import.meta.dir — Node 21+: import.meta.dirname — fallback
const __dir: string =
  (import.meta as any).dir ??
  (import.meta as any).dirname ??
  dirname(fileURLToPath(import.meta.url))

const ROOT = resolve(__dir, '..')
const watch = process.argv.includes('--watch')
const minify = process.argv.includes('--minify')
const noSourcemap = process.argv.includes('--no-sourcemap')

// Read version from package.json for MACRO injection
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))
const version = pkg.version || '0.0.0-dev'

// ── Plugin: resolve bare 'src/' imports (tsconfig baseUrl: ".") ──
// The codebase uses `import ... from 'src/foo/bar.js'` which relies on
// TypeScript's baseUrl resolution. This plugin maps those to real TS files.
const srcResolverPlugin: esbuild.Plugin = {
  name: 'src-resolver',
  setup(build) {
    build.onResolve({ filter: /^src\// }, (args) => {
      const basePath = resolve(ROOT, args.path)

      // Already exists as-is
      if (existsSync(basePath)) {
        return { path: basePath }
      }

      // Strip .js/.jsx and try TypeScript extensions
      const withoutExt = basePath.replace(/\.(js|jsx)$/, '')
      for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
        const candidate = withoutExt + ext
        if (existsSync(candidate)) {
          return { path: candidate }
        }
      }

      // Try as directory with index file
      const dirPath = basePath.replace(/\.(js|jsx)$/, '')
      for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
        const candidate = resolve(dirPath, 'index' + ext)
        if (existsSync(candidate)) {
          return { path: candidate }
        }
      }

      // Stub missing src/ files — these are Anthropic-internal modules not
      // present in this source tree (feature-gated at runtime).
      return { path: args.path, namespace: 'missing-stub' }
    })

    build.onLoad({ filter: /.*/, namespace: 'missing-stub' }, (args) => {
      console.warn(`[stub] Missing module: ${args.path}`)
      return { contents: 'module.exports = {}', loader: 'js' }
    })
  },
}

// ── Plugin: stub missing relative imports ──
// Some source files import modules that are Anthropic-internal and not
// present in this tree. All such imports are feature-gated at runtime so
// they are never actually called in an external build. We return an empty
// stub so the bundle can complete without errors.
function resolveRelative(importer: string, importPath: string): string | undefined {
  const base = resolve(dirname(importer), importPath)

  if (existsSync(base)) return base

  // Strip .js/.jsx and try TypeScript extensions
  const withoutExt = base.replace(/\.(js|jsx|d\.ts)$/, '')
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const candidate = withoutExt + ext
    if (existsSync(candidate)) return candidate
  }

  // Try as directory with index file
  const dirPath = base.replace(/\.(js|jsx)$/, '')
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const candidate = resolve(dirPath, 'index' + ext)
    if (existsSync(candidate)) return candidate
  }

  return undefined
}

// ── Plugin: resolve CJS directory requires ──
// Some CJS packages do `require("./some-dir")` expecting Node's automatic
// index.js resolution. esbuild doesn't do this by default when it encounters
// a directory path, so we resolve it ourselves.
const cjsDirectoryResolverPlugin: esbuild.Plugin = {
  name: 'cjs-directory-resolver',
  setup(build) {
    build.onResolve({ filter: /^\./ }, (args) => {
      if (!args.importer) return undefined
      const candidate = resolve(dirname(args.importer), args.path)
      let stat: ReturnType<typeof statSync> | undefined
      try { stat = statSync(candidate) } catch { return undefined }
      if (!stat?.isDirectory()) return undefined

      // The bare path resolves to a directory. First try the path as a file
      // with common extensions (handles cases where a same-named file exists
      // alongside the directory, e.g. terminal.js next to terminal/).
      for (const ext of ['.js', '.cjs', '.mjs', '.ts', '.tsx']) {
        const asFile = candidate + ext
        if (existsSync(asFile)) return { path: asFile }
      }

      // Then try directory index files
      for (const ext of ['.js', '.cjs', '.mjs', '.ts', '.tsx']) {
        const idx = resolve(candidate, 'index' + ext)
        if (existsSync(idx)) return { path: idx }
      }
      return undefined
    })
  },
}

const missingModuleStubPlugin: esbuild.Plugin = {
  name: 'missing-module-stub',
  setup(build) {
    // Intercept all relative imports before esbuild resolves them
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      const resolved = resolveRelative(args.importer, args.path)
      if (resolved) {
        // File exists — let esbuild handle it normally
        return { path: resolved }
      }
      // File is missing — return a stub namespace
      return { path: args.path, namespace: 'missing-stub' }
    })

    build.onLoad({ filter: /.*/, namespace: 'missing-stub' }, (args) => {
      console.warn(`[stub] Missing module: ${args.path}`)
      return { contents: 'module.exports = {}', loader: 'js' }
    })
  },
}

const buildOptions: esbuild.BuildOptions = {
  entryPoints: [resolve(ROOT, 'src/entrypoints/cli.tsx')],
  bundle: true,
  platform: 'node',
  target: ['node20', 'es2022'],
  format: 'esm',
  outdir: resolve(ROOT, 'dist'),
  outExtension: { '.js': '.mjs' },

  // Single-file output — no code splitting for CLI tools
  splitting: false,

  plugins: [srcResolverPlugin, cjsDirectoryResolverPlugin, missingModuleStubPlugin],

  // Use tsconfig for baseUrl / paths resolution (complements plugin above)
  tsconfig: resolve(ROOT, 'tsconfig.json'),

  // Alias bun:bundle to our runtime shim
  alias: {
    'bun:bundle': resolve(ROOT, 'src/shims/bun-bundle.ts'),
  },

  // Don't bundle node built-ins or problematic native packages
  external: [
    // Node built-ins (with and without node: prefix)
    'fs', 'path', 'os', 'crypto', 'child_process', 'http', 'https',
    'net', 'tls', 'url', 'util', 'stream', 'events', 'buffer',
    'querystring', 'readline', 'zlib', 'assert', 'tty', 'worker_threads',
    'perf_hooks', 'async_hooks', 'dns', 'dgram', 'cluster',
    'string_decoder', 'module', 'vm', 'constants', 'domain',
    'console', 'process', 'v8', 'inspector',
    'node:*',
    // Native addons that can't be bundled
    'fsevents',
    'sharp',
    'image-processor-napi',
    'audio-capture-napi',
    'color-diff-napi',
    'modifiers-napi',
    // Anthropic-internal packages (not published externally)
    '@anthropic-ai/sandbox-runtime',
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/bedrock-sdk',
    '@anthropic-ai/foundry-sdk',
    '@anthropic-ai/mcpb',
    '@anthropic-ai/vertex-sdk',
    // Anthropic-internal (@ant/) packages — gated behind USER_TYPE === 'ant'
    '@ant/*',
    // AWS SDK + Smithy — CJS packages with directory requires; mark external
    '@aws-sdk/*',
    '@smithy/*',
    // Azure / Google cloud auth
    '@azure/*',
    'google-auth-library',
    // OpenTelemetry exporters — optional telemetry feature
    '@opentelemetry/exporter-*',
    '@opentelemetry/resources',
    '@opentelemetry/semantic-conventions',
  ],

  jsx: 'automatic',

  // Source maps for production debugging (external .map files)
  sourcemap: noSourcemap ? false : 'external',

  // Minification for production
  minify,

  // Tree shaking (on by default, explicit for clarity)
  treeShaking: true,

  // Define replacements — inline constants at build time
  // MACRO.* — originally inlined by Bun's bundler at compile time
  // process.env.USER_TYPE — eliminates 'ant' (Anthropic-internal) code branches
  define: {
    'MACRO.VERSION': JSON.stringify(version),
    'MACRO.PACKAGE_URL': JSON.stringify('@anthropic-ai/claude-code'),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify(
      'report issues at https://github.com/anthropics/claude-code/issues'
    ),
    'process.env.USER_TYPE': '"external"',
    'process.env.NODE_ENV': minify ? '"production"' : '"development"',
  },

  // Banner: shebang for direct CLI execution
  banner: {
    js: '#!/usr/bin/env node\n',
  },

  // Handle the .js → .ts resolution that the codebase uses
  resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],

  logLevel: 'info',

  // Metafile for bundle analysis
  metafile: true,
}

async function main() {
  if (watch) {
    const ctx = await esbuild.context(buildOptions)
    await ctx.watch()
    console.log('Watching for changes...')
  } else {
    const startTime = Date.now()
    const result = await esbuild.build(buildOptions)

    if (result.errors.length > 0) {
      console.error('Build failed')
      process.exit(1)
    }

    // Make the output executable
    const outPath = resolve(ROOT, 'dist/cli.mjs')
    try {
      chmodSync(outPath, 0o755)
    } catch {
      // chmod may fail on some platforms, non-fatal
    }

    const elapsed = Date.now() - startTime

    // Print bundle size info
    if (result.metafile) {
      const text = await esbuild.analyzeMetafile(result.metafile, { verbose: false })
      const outFiles = Object.entries(result.metafile.outputs)
      for (const [file, info] of outFiles) {
        if (file.endsWith('.mjs')) {
          const sizeMB = ((info as { bytes: number }).bytes / 1024 / 1024).toFixed(2)
          console.log(`\n  ${file}: ${sizeMB} MB`)
        }
      }
      console.log(`\nBuild complete in ${elapsed}ms → dist/`)

      // Write metafile for further analysis
      const { writeFileSync } = await import('fs')
      writeFileSync(
        resolve(ROOT, 'dist/meta.json'),
        JSON.stringify(result.metafile),
      )
      console.log('  Metafile written to dist/meta.json')
    }
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
