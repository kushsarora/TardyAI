/*
 * Copyright 2009-2025 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 * This material, including without limitation any software, is the confidential trade secret and proprietary
 * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is
 * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.
 * This material may be covered by one or more patents or pending patent applications.
 */

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import * as path from "path";
import { readFileSync } from "node:fs";
import eslint from "vite-plugin-eslint2";
import tailwindcss from "@tailwindcss/vite";


// Browsers send a more-specific same-name cookie before its parent-path cookie.
// Forward only the parent c3auth value so an invalid uiservice cookie cannot
// shadow the refreshed environment cookie.
function preferParentC3AuthCookie(cookieHeader: string): string {
  const cookies = cookieHeader.split(";").map((cookie) => cookie.trim());
  const c3authCookies = cookies.filter((cookie) => cookie.startsWith("c3auth="));
  if (c3authCookies.length <= 1) {
    return cookieHeader;
  }

  return [
    ...cookies.filter((cookie) => cookie && !cookie.startsWith("c3auth=")),
    c3authCookies[c3authCookies.length - 1],
  ].join("; ");
}

// Helper to create proxy config that forwards per-user auth from the incoming request.
// Falls back to a static token (VITE_C3_AUTH_TOKEN) for local development outside the container.
function createProxyConfig(target: string, fallbackToken?: string) {
  return {
    target,
    changeOrigin: true,
    configure: (proxy: any, _options: any) => {
      proxy.on("proxyReq", (proxyReq: any, req: any, _res: any) => {
        const incomingAuth = req.headers['authorization'];
        const incomingCookie = req.headers['cookie'];
        if (incomingAuth) {
          proxyReq.setHeader("Authorization", incomingAuth);
        } else if (incomingCookie) {
          proxyReq.setHeader("Cookie", preferParentC3AuthCookie(incomingCookie));
        } else if (fallbackToken) {
          proxyReq.setHeader("Authorization", `c3auth=${fallbackToken}`);
        }
      });
    },
  };
}

// ===== Vite Config =====
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const port = parseInt(env.VITE_DEV_SERVER_PORT || '9000', 10);
  const pkgName = env.VITE_C3_PKG || 'pkgbc231600';
  const authAuth = env.VITE_C3_AUTH_TOKEN;
  const appUrl = `${env.VITE_C3_BASE_URL}/${env.VITE_C3_ENV}/${env.VITE_C3_APP}/`;
  const base = command === 'serve' && env.VITE_C3_ENV && env.VITE_C3_APP ? `/${env.VITE_C3_ENV}/${env.VITE_C3_APP}/uiservice/` : './';



  if (command === 'build' && mode === 'production' && env.VITE_C3_AUTH_TOKEN) {
    throw new Error('❌ BUILD FAILED: VITE_C3_AUTH_TOKEN must not be set in production builds.');
  }

  return {
    plugins: [
      {
        name: 'tardy-demo-router',
        resolveId(id) { if (id === 'virtual:tardy-demo') return '\0virtual:tardy-demo'; },
        load(id) {
          if (id !== '\0virtual:tardy-demo') return;
          const packageRoot = path.resolve(__dirname, '../..');
          const read = (file: string) => {
            const filename = path.join(packageRoot, 'data', file);
            this.addWatchFile(filename);
            return JSON.parse(readFileSync(filename, 'utf8'));
          };
          this.addWatchFile(path.join(packageRoot, 'src/NavRouter.js'));
          const floors = read('Floor/Floor.json');
          const nodes = read('MapNode/MapNode.json').map((n: any) => ({ ...n, floor: floors.find((f: any) => f.id === n.floor.id) }));
          return `
            const floors = ${JSON.stringify(floors)};
            const nodes = ${JSON.stringify(nodes)};
            const edges = ${JSON.stringify(read('NavEdge/NavEdge.json'))};
            const buildings = ${JSON.stringify(read('Building/grainger.json'))};
            const getPath = (row, key) => key.split('.').reduce((v, k) => v?.[k], row);
            const Filter = { eq: (key, value) => ({ key, value }) };
            const fetchRows = (rows, spec) => ({ objs: rows.filter(row => getPath(row, spec.filter.key) === spec.filter.value).slice(0, spec.limit > 0 ? spec.limit : undefined) });
            const MapNode = { fetch: spec => fetchRows(nodes, spec) };
            const NavEdge = { fetch: spec => fetchRows(edges.map(e => ({ ...e, fromNode: nodes.find(n => n.id === e.fromNode.id) })), spec) };
            ${readFileSync(path.join(packageRoot, 'src/NavRouter.js'), 'utf8')}
            export async function demoAction(type, action, args) {
              if (type === 'Building') return { objs: buildings };
              if (type === 'Floor') return { objs: floors };
              const actions = { findRoute, nearestNode, searchRooms, graphForBuilding };
              if (!actions[action]) throw new Error('This feature requires a connected C3 backend.');
              return actions[action](...args);
            }
          `;
        },
      },
      tailwindcss(),
      react(),
      // Single eslint2 instance with valid options
      eslint({
        lintOnStart: true,
        cache: false,
        include: ["src/**/*.{ts,tsx,js,jsx}"],
        // Exclude tests and build artifacts from dev-time linting to prevent Vite startup failures
        exclude: [
          "node_modules/**",
          "dist/**",
          "build/**",
          "coverage/**",
          "assets/**",
          "src/**/__tests__/**",
          "src/**/*.test.{ts,tsx,js,jsx}",
        ]
      }),
    ],
    resolve: {
      // `@` maps to `src/`. This template does not ship a `resources/examples/`
      // tree, so there is no `@/shared` alias (the design-system components live
      // under `src/components/ui` and are imported via `@/components/ui/...`).
      alias: [{ find: "@", replacement: path.resolve(__dirname, "./src") }],
    },
    server: {
      host: true,
      allowedHosts: true,
      port: port,
      strictPort: true,
      proxy: {
        "^/api": createProxyConfig(appUrl, authAuth),
        "^/remote": createProxyConfig(appUrl, authAuth),
        "^/thirdparty": createProxyConfig(appUrl, authAuth),
        "^/typesys": createProxyConfig(appUrl, authAuth)
      },
    },
    base: base,
    build: {
      outDir: `../content/${pkgName}`,
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          assetFileNames: "assets/[name][extname]",
          chunkFileNames: "assets/[name].js",
          entryFileNames: "assets/[name].js",
        },
        onwarn: (warning, warn) => {
          if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
          warn(warning);
        },
      },
    },
  };
});
