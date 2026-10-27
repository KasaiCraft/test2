import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, Plugin} from 'vite';

// LINT.IfChange(aistudio_media_plugin)
function aistudioMediaPlugin(): Plugin {
  return {
    name: 'vite-plugin-aistudio-media',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/assets/aistudio/')) {
          const rawPath = req.url.split('?')[0].split('#')[0];
          try {
            const decodedPath = decodeURIComponent(rawPath);
            const relativePath = decodedPath.replace(/^\//, '');
            const aistudioDir = path.resolve(
              __dirname,
              'public',
              'assets',
              'aistudio',
            );
            const filePath = path.resolve(__dirname, 'public', relativePath);
            if (
              filePath.startsWith(aistudioDir + path.sep) &&
              fs.existsSync(filePath) &&
              fs.statSync(filePath).isFile()
            ) {
              const ext = path.extname(filePath).toLowerCase();
              const mimeMap: Record<string, string> = {
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
                '.svg': 'image/svg+xml',
                '.bmp': 'image/bmp',
                '.ico': 'image/x-icon',
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.ogv': 'video/ogg',
                '.mp3': 'audio/mpeg',
                '.wav': 'audio/wav',
                '.ogg': 'audio/ogg',
                '.pdf': 'application/pdf',
              };
              res.setHeader(
                'Content-Type',
                mimeMap[ext] || 'application/octet-stream',
              );
              res.setHeader('Cache-Control', 'no-cache');
              fs.createReadStream(filePath).pipe(res);
              return;
            }
          } catch {
            // Fall through if URI decoding or file access fails
          }
        }
        next();
      });
    },
  };
}
// LINT.ThenChange(//depot/google3/java/com/google/alkali/boq/makersuite/applet_dev_service/templates/initializers/react_theme/vite.config.ts:aistudio_media_plugin)

function netlifyFunctionsDevPlugin(): Plugin {
  return {
    name: 'vite-plugin-netlify-functions-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || (!req.url.startsWith('/api/') && !req.url.startsWith('/.netlify/functions/'))) {
          return next();
        }

        const urlParts = req.url.split('?');
        const pathname = urlParts[0];
        const search = urlParts[1] || '';
        const fnName = pathname.replace(/^\/(api|\.netlify\/functions)\//, '').split('/')[0];
        const fnFilePath = path.resolve(__dirname, 'netlify', 'functions', `${fnName}.ts`);

        if (!fs.existsSync(fnFilePath)) {
          return next();
        }

        try {
          // Read request body
          const chunks: any[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const rawBody = Buffer.concat(chunks).toString('utf-8');

          const queryParams: Record<string, string> = {};
          if (search) {
            const sp = new URLSearchParams(search);
            sp.forEach((val, key) => {
              queryParams[key] = val;
            });
          }

          const event = {
            rawUrl: `http://${req.headers.host || 'localhost:3000'}${req.url}`,
            path: pathname,
            httpMethod: req.method || 'GET',
            headers: req.headers as Record<string, string>,
            queryStringParameters: queryParams,
            body: rawBody || null,
            isBase64Encoded: false,
          };

          const mod = await server.ssrLoadModule(fnFilePath);
          if (typeof mod.handler !== 'function') {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: `No handler exported from ${fnName}.ts` }));
            return;
          }

          const response = await mod.handler(event, {});
          res.statusCode = response.statusCode || 200;
          if (response.headers) {
            for (const [k, v] of Object.entries(response.headers)) {
              res.setHeader(k, String(v));
            }
          }
          res.end(response.body || '');
        } catch (err: any) {
          console.error(`Error executing Netlify function ${fnName}:`, err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: err?.message || 'Function execution error' }));
        }
      });
    },
  };
}

export default defineConfig(() => {
  let appletConfig: any = {};
  try {
    const configPath = path.resolve(__dirname, 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      appletConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch {}

  const googleDriveClientId =
    process.env.VITE_GOOGLE_DRIVE_CLIENT_ID ||
    process.env.GOOGLE_DRIVE_CLIENT_ID ||
    appletConfig?.oAuthClientId ||
    process.env.VITE_GOOGLE_CLIENT_ID ||
    process.env.GOOGLE_CLIENT_ID ||
    '90141512998-i9f9om5j7fi1oll0r5j5913vvi7e76vs.apps.googleusercontent.com';

  const googleClientId =
    process.env.VITE_GOOGLE_CLIENT_ID ||
    process.env.GOOGLE_CLIENT_ID ||
    appletConfig?.oAuthClientId ||
    '90141512998-i9f9om5j7fi1oll0r5j5913vvi7e76vs.apps.googleusercontent.com';

  return {
    define: {
      'import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID': JSON.stringify(googleDriveClientId),
      'import.meta.env.VITE_GOOGLE_CLIENT_ID': JSON.stringify(googleClientId),
      'import.meta.env.VITE_APP_URL': JSON.stringify(process.env.APP_URL || process.env.URL || ''),
    },
    plugins: [react(), tailwindcss(), aistudioMediaPlugin(), netlifyFunctionsDevPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
