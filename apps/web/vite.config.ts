/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defineConfig, loadEnv } from 'vite'
import solid from 'vite-plugin-solid'
import solidSvg from 'vite-plugin-solid-svg'
import tailwindcss from '@tailwindcss/vite'
import typegpu from 'unplugin-typegpu/vite'
import { resolve } from 'path'
import pkg from '../../package.json'

export default defineConfig(({ mode }) => {
  // The desktop app bundles this build. Without the client env there is no
  // Diffusion Studio account, and so no generated images, video, voice or
  // transcription — but the editor and its agent never needed one, so this
  // says what is missing rather than refusing to build. A fork that does not
  // want the hosted backend is a supported thing to be.
  if (mode === 'desktop') {
    const env = loadEnv(mode, __dirname, '')
    const missing = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'].filter((key) => !env[key])
    if (missing.length) {
      console.warn(
        `[build] ${missing.join(' and ')} not set: this build ships without a Diffusion Studio account, ` +
          `so generated media and transcription are unavailable. Copy apps/web/.env.example to apps/web/.env to include them.`,
      )
    }
  }

  return {
    plugins: [
      solid(),
      tailwindcss(),
      solidSvg({ defaultAsComponent: true }),
      typegpu(),
    ],
    define: {
      APP_VERSION: JSON.stringify(pkg.version),
    },
    server: {
      port: 5173,
      strictPort: true,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "./src"),
        "@desktop": resolve(__dirname, "../desktop/src"),
      }
    }
  }
})
