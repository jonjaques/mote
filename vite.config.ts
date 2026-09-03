import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'

import tailwindcss from '@tailwindcss/vite'

function sendMissing(
  response: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void },
  relativePath: string,
) {
  // Vite's HTML fallback would cache as a "successful" config fetch and break reload().
  response.statusCode = 404
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({ error: 'Model artifact not found', path: relativePath }))
}

function serveModels(): Plugin {
  const modelsRoot = path.resolve(import.meta.dirname, 'models')

  return {
    name: 'serve-local-webllm-models',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.method !== 'GET' || !request.url?.startsWith('/models/')) {
          next()
          return
        }

        let filePath: string
        let relativePath: string
        try {
          const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
          relativePath = pathname
            .slice('/models/'.length)
            .replace('/resolve/main/', '/')
          filePath = path.resolve(modelsRoot, relativePath)
        } catch {
          response.statusCode = 400
          response.end('Invalid model path')
          return
        }

        // The mirror contains multi-gigabyte weights, so stream from outside public/ rather
        // than letting every Vite build copy the directory into dist.
        if (!filePath.startsWith(`${modelsRoot}${path.sep}`)) {
          response.statusCode = 403
          response.end('Model path escapes the mirror')
          return
        }

        void stat(filePath)
          .then((info) => {
            if (!info.isFile()) {
              sendMissing(response, relativePath)
              return
            }

            response.setHeader('Content-Length', info.size)
            response.setHeader(
              'Content-Type',
              filePath.endsWith('.wasm')
                ? 'application/wasm'
                : filePath.endsWith('.json')
                  ? 'application/json'
                  : 'application/octet-stream',
            )
            createReadStream(filePath).pipe(response)
          })
          .catch(() => sendMissing(response, relativePath))
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    serveModels(),
    tailwindcss(),
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
