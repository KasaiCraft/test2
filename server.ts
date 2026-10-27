import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { fileURLToPath } from 'url';
import { 
  getAdminAuth, 
  hasAdminCredentials 
} from './netlify/functions/lib/firebaseAdmin.ts';
import { 
  getTenantVault, 
  saveTenantVault,
  getWorkerBinding,
  ensureVaultHydrated,
} from './netlify/functions/lib/tenantVault.ts';
import { NEXTGEN_CAFE_BUSINESS_ID } from './netlify/functions/lib/types.ts';
import { cafeDatabaseManager } from './server/cafeDatabaseManager.ts';
import { getVerifiedUser } from './netlify/functions/lib/authMiddleware.ts';

import { handler as systemStatusHandler } from './netlify/functions/system-status.ts';
import { handler as driveAuthHandler } from './netlify/functions/drive-auth.ts';
import { handler as driveDisconnectHandler } from './netlify/functions/drive-disconnect.ts';
import { handler as tenantVaultStatusHandler } from './netlify/functions/tenant-vault-status.ts';
import { handler as provisionWorkerHandler } from './netlify/functions/provision-worker.ts';
import { handler as driveDatabaseHandler } from './netlify/functions/drive-database.ts';
import { handler as authCredentialSyncHandler } from './netlify/functions/auth-credential-sync.ts';

// Global process error handlers to capture crashes that might cause 502s
process.on('unhandledRejection', (reason, promise) => {
  console.error('[server] UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[server] UNCAUGHT EXCEPTION:', err?.message || String(err));
  if (err.stack) console.error(err.stack);
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Support large database sync payloads (up to 50MB) for Excel XLSX and database records
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // Graceful payload limit error handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413 || err.name === 'PayloadTooLargeError')) {
      console.warn('[server] Payload too large error intercepted:', err.message);
      return res.status(413).json({
        success: false,
        error: 'Request payload too large. Maximum supported payload size is 50MB.',
      });
    }
    next(err);
  });

  // Use a reliable path for the production dist folder
  const distPath = path.resolve(process.cwd(), 'dist');

  // Helper to extract verified tenant and owner context from incoming request
  async function resolveRequestContext(req: express.Request): Promise<{ businessId: string; ownerUid: string; uid?: string }> {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const event = {
          headers: req.headers as any,
          httpMethod: req.method,
        } as any;
        const verified = await getVerifiedUser(event);
        const ownerUid = verified.ownerUid || verified.uid;
        const businessId = verified.businessId || `user_${ownerUid}`;
        return { businessId, ownerUid, uid: verified.uid };
      } catch {
        // Fall back to query or body below
      }
    }

    const queryUid = req.query.uid as string;
    const queryBiz = req.query.businessId as string;
    const bodyBiz = (req.body?.businessId as string) || (req.body?.database?.businessId as string);
    const bodyUid = req.body?.uid as string;

    const resolvedUid = queryUid || bodyUid || (queryBiz && queryBiz.startsWith('user_') ? queryBiz.replace(/^user_/, '') : '');
    const resolvedBiz = queryBiz || bodyBiz || (resolvedUid ? `user_${resolvedUid}` : NEXTGEN_CAFE_BUSINESS_ID);
    return { businessId: resolvedBiz, ownerUid: resolvedUid };
  }

  // 1. System Status
  app.all('/api/system-status', async (req, res) => {
    try {
      const event = {
        httpMethod: req.method,
        queryStringParameters: req.query,
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : (v || '')])
        ) as any
      };
      const result = await (systemStatusHandler as any)(event, {});
      if (result.headers) {
        Object.entries(result.headers).forEach(([k, v]) => res.setHeader(k, v as string));
      }
      res.status(result.statusCode || 200).send(result.body);
    } catch (err: any) {
      console.error('[server] System status proxy error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 2. Tenant Claim (Auto-role for login with UID workspace isolation)
  app.post('/api/tenant-claim', async (req, res) => {
    try {
      const { uid, email, name } = req.body;
      if (!uid) return res.status(400).json({ success: false, error: 'User UID is required' });

      const adminAuth = getAdminAuth();
      const userBizId = `user_${uid}`;

      // Check if user is a bound worker under an owner
      const workerBinding = await getWorkerBinding(uid);
      if (workerBinding) {
        const ownerUid = workerBinding.ownerUid;
        const bizId = workerBinding.businessId || `user_${ownerUid}`;
        await adminAuth.setCustomUserClaims(uid, { role: 'worker', businessId: bizId, ownerUid });
        return res.json({ success: true, data: { role: 'worker', businessId: bizId, ownerUid } });
      }

      // User is the admin/owner of their own isolated gaming cafe workspace
      await adminAuth.setCustomUserClaims(uid, { role: 'admin', businessId: userBizId, ownerUid: uid });
      return res.json({ success: true, data: { role: 'admin', businessId: userBizId, ownerUid: uid } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 3. Provision Worker
  app.post('/api/provision-worker', async (req, res) => {
    try {
      const { workerEmail, workerName, temporaryPassword } = req.body;
      if (!workerEmail) return res.status(400).json({ success: false, error: 'workerEmail is required' });

      const adminAuth = getAdminAuth();
      let userRecord;
      try {
        userRecord = await adminAuth.getUserByEmail(workerEmail);
        if (temporaryPassword) {
          await adminAuth.updateUser(userRecord.uid, {
            password: temporaryPassword,
            displayName: workerName || userRecord.displayName,
          });
        }
      } catch {
        userRecord = await adminAuth.createUser({
          email: workerEmail,
          password: temporaryPassword || 'NextGen#2024',
          displayName: workerName,
        });
      }

      await adminAuth.setCustomUserClaims(userRecord.uid, {
        role: 'worker',
        businessId: NEXTGEN_CAFE_BUSINESS_ID
      });

      res.json({ success: true, data: { workerUid: userRecord.uid } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 3.1 Auth Credential Sync (fixes invalid email/password when account credentials need sync)
  app.all('/api/auth-credential-sync', async (req, res) => {
    try {
      const event = {
        httpMethod: req.method,
        queryStringParameters: req.query,
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : (v || '')])
        ) as any
      };
      const result = await (authCredentialSyncHandler as any)(event, {});
      if (result.headers) {
        Object.entries(result.headers).forEach(([k, v]) => res.setHeader(k, v as string));
      }
      res.status(result.statusCode || 200).send(result.body);
    } catch (err: any) {
      console.error('[server] Auth credential sync proxy error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 3.5. Centralized Multi-Staff Shared Business Database (Shared Authoritative Source of Truth)
  // Real-Time Server-Sent Events (SSE) stream for instant synchronization across all devices and browsers
  app.get('/api/cafe-database/stream', async (req, res) => {
    const { businessId, ownerUid } = await resolveRequestContext(req);
    await cafeDatabaseManager.registerSseClient(req, res, businessId, ownerUid);
  });

  // Fast revision check endpoint for polling and validation
  app.get('/api/cafe-database/revision', async (req, res) => {
    const { businessId, ownerUid } = await resolveRequestContext(req);
    const { revision, lastModified } = cafeDatabaseManager.getDatabase(businessId, ownerUid);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({
      success: true,
      revision,
      lastModified,
    });
  });

  // Authoritative shared database read strictly for the requesting tenant
  app.get('/api/cafe-database', async (req, res) => {
    try {
      const { businessId, ownerUid } = await resolveRequestContext(req);
      let status = cafeDatabaseManager.getDatabase(businessId, ownerUid);
      if (!status.isDriveConnected || !status.data) {
        // Attempt on-demand sync from Google Drive if vault has credentials
        await cafeDatabaseManager.syncFromGoogleDrive(businessId, ownerUid).catch(() => {});
        status = cafeDatabaseManager.getDatabase(businessId, ownerUid);
      }

      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.json({
        success: status.success,
        isDriveConnected: status.isDriveConnected,
        revision: status.revision,
        lastModified: status.lastModified,
        data: status.data,
        error: status.error,
        folderName: status.folderName,
        fileName: status.fileName,
      });
    } catch (err: any) {
      console.error('[server] Error reading authoritative shared database:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Atomic smart non-destructive mutation (strictly scoped to the requesting tenant)
  app.post('/api/cafe-database', async (req, res) => {
    try {
      const payload = req.body;
      if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ success: false, error: 'Invalid database payload' });
      }

      const { businessId, ownerUid } = await resolveRequestContext(req);
      const options = {
        action: payload.action,
        deleteInfo: payload.deleteInfo,
        forceOverwrite: payload.forceOverwrite,
      };

      const result = await cafeDatabaseManager.applyMutation(businessId, payload, options, ownerUid);
      return res.json({
        success: true,
        revision: result.revision,
        lastModified: result.lastModified,
        data: result.data,
      });
    } catch (err: any) {
      console.error('[server] Error persisting shared cafe database:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });
  
  // 4. Google Drive Database Sync
  app.all('/api/drive-database', async (req, res) => {
    try {
      const event = {
        httpMethod: req.method,
        queryStringParameters: req.query as any,
        body: req.method === 'GET' || req.method === 'HEAD' ? null : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)),
        headers: req.headers as any
      };
      
      const result = await (driveDatabaseHandler as any)(event, {});
      
      if (result.headers) {
        Object.entries(result.headers).forEach(([k, v]) => res.setHeader(k, v as string));
      }
      res.status(result.statusCode || 200).send(result.body);
    } catch (err: any) {
      console.error('[server] Drive database proxy error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 5. Google Drive Auth & Disconnect
  app.all('/api/drive-auth', async (req, res) => {
    const start = Date.now();
    const requestId = Math.random().toString(36).substring(7);
    console.log(`[server] [${requestId}] [${new Date().toISOString()}] Incoming ${req.method} /api/drive-auth`);
    
    // Safety timeout to prevent Nginx 502/504
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Handler timeout after 30s')), 30000)
    );

    try {
      const body = req.body || {};
      console.log(`[server] [${requestId}] Request body keys: ${Object.keys(body).join(', ')}`);

      const event = {
        httpMethod: req.method,
        queryStringParameters: req.query,
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : (v || '')])
        ) as any
      };

      console.log(`[server] [${requestId}] Calling drive-auth handler...`);
      const result = await Promise.race([
        (driveAuthHandler as any)(event, { requestId }),
        timeoutPromise
      ]) as any;

      if (!result) {
        throw new Error('Handler returned no result (null or undefined)');
      }

      const duration = Date.now() - start;
      console.log(`[server] [${requestId}] Handler finished in ${duration}ms with status: ${result.statusCode || 200}`);

      if (result.statusCode === 200 && result.body) {
        try {
          const parsed = JSON.parse(result.body);
          if (parsed.success) {
            const authBiz = parsed.data?.businessId || (parsed.data?.ownerUid ? `user_${parsed.data.ownerUid}` : NEXTGEN_CAFE_BUSINESS_ID);
            const authOwnerUid = parsed.data?.ownerUid;
            console.log(`[server] [${requestId}] Auth successful reported in body, triggering background sync for ${authBiz}...`);
            cafeDatabaseManager.syncFromGoogleDrive(authBiz, authOwnerUid).catch((e) => 
              console.warn(`[server] [${requestId}] Post-auth sync notice (non-blocking):`, e?.message || String(e))
            );
          }
        } catch (parseErr) {
          console.warn(`[server] [${requestId}] Failed to parse successful handler body for background sync trigger`);
        }
      }

      if (result.headers) {
        Object.entries(result.headers).forEach(([k, v]) => {
          try {
            res.setHeader(k, String(v));
          } catch (headerErr) {
            console.warn(`[server] [${requestId}] Failed to set header ${k}:`, headerErr);
          }
        });
      }
      res.status(result.statusCode || 200).send(result.body);
    } catch (err: any) {
      const duration = Date.now() - start;
      const errorMsg = err?.message || String(err);
      console.error(`[server] [${requestId}] FATAL error in /api/drive-auth after ${duration}ms:`, errorMsg);
      if (err.stack) console.error(err.stack);
      
      const statusCode = errorMsg.includes('timeout') ? 504 : 500;
      res.status(statusCode).json({ 
        success: false, 
        error: errorMsg,
        code: 'SERVER_ERROR',
        requestId
      });
    }
  });

  app.all('/api/drive-disconnect', async (req, res) => {
    try {
      const event = {
        httpMethod: req.method,
        queryStringParameters: req.query,
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : (v || '')])
        ) as any
      };
      const result = await (driveDisconnectHandler as any)(event, {});
      if (result.statusCode === 200) {
        const { businessId, ownerUid } = await resolveRequestContext(req);
        cafeDatabaseManager.onDriveDisconnected(businessId, ownerUid);
      }
      if (result.headers) {
        Object.entries(result.headers).forEach(([k, v]) => res.setHeader(k, v as string));
      }
      res.status(result.statusCode || 200).send(result.body);
    } catch (err: any) {
      console.error('[server] Drive disconnect proxy error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 5.5. Google OAuth redirect callback routes (supports popup postMessage & standard callback)
  app.get(['/oauth2callback', '/auth/callback', '/api/drive-auth/callback'], (req, res) => {
    const code = req.query.code || '';
    const error = req.query.error || '';
    const state = req.query.state || '';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Google Drive Authentication</title>
</head>
<body style="background:#090d16;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="text-align:center;padding:2rem;">
    <h2 style="color:#06b6d4;margin-bottom:0.5rem;">Google Drive Connected</h2>
    <p style="color:#94a3b8;font-size:0.875rem;">Completing secure connection and returning to NextGen Gaming Cafe...</p>
  </div>
  <script>
    try {
      var code = ${JSON.stringify(code)};
      var error = ${JSON.stringify(error)};
      var state = ${JSON.stringify(state)};
      if (window.opener) {
        window.opener.postMessage({ code: code, error: error, state: state }, window.location.origin);
        setTimeout(function() { window.close(); }, 300);
      } else {
        window.location.href = '/' + window.location.search;
      }
    } catch (e) {
      console.error('Callback error:', e);
    }
  </script>
</body>
</html>`);
  });

  // 6. Tenant Vault Status
  app.all('/api/tenant-vault-status', async (req, res) => {
    try {
      const event = {
        httpMethod: req.method,
        queryStringParameters: req.query,
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : (v || '')])
        ) as any
      };
      const result = await (tenantVaultStatusHandler as any)(event, {});
      if (result.headers) {
        Object.entries(result.headers).forEach(([k, v]) => res.setHeader(k, v as string));
      }
      res.status(result.statusCode || 200).send(result.body);
    } catch (err: any) {
      console.error('[server] Tenant vault status proxy error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 7. Generic Netlify Functions Proxy (Dual routing parity for /.netlify/functions/*)
  app.all('/.netlify/functions/:fn', async (req, res) => {
    const fnName = req.params.fn;
    try {
      const fnModule = await import(`./netlify/functions/${fnName}.ts`);
      const event = {
        httpMethod: req.method,
        queryStringParameters: req.query,
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : (v || '')])
        ) as any
      };
      const result = await (fnModule.handler as any)(event, {});
      if (result.headers) {
        Object.entries(result.headers).forEach(([k, v]) => res.setHeader(k, v as string));
      }
      res.status(result.statusCode || 200).send(result.body);
    } catch (err: any) {
      console.error(`[server] Netlify function proxy error for ${fnName}:`, err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // --- VITE MIDDLEWARE / STATIC FILES ---

  const publicPath = path.resolve(process.cwd(), 'public');
  app.use(express.static(publicPath));

  // Fallback route if /app-logo.png is requested
  app.get('/app-logo.png', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.sendFile(path.resolve(publicPath, 'app-logo.svg'));
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve from the resolved distPath with strict cache control for HTML files
    app.use(express.static(distPath, {
      setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        }
      }
    }));
    
    // Explicitly handle index.html for SPA routing with strict cache control
    app.get('*', (req, res) => {
      const indexPath = path.join(distPath, 'index.html');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.sendFile(indexPath, (err) => {
        if (err) {
          console.error('Error sending index.html:', err);
          res.status(500).send('Internal Server Error: Missing frontend assets');
        }
      });
    });
  }

  // Hydrate tenant vault from persistent remote Firestore before binding HTTP listeners
  try {
    await ensureVaultHydrated();
  } catch (hydrateErr: any) {
    console.warn('[server] ensureVaultHydrated notice:', hydrateErr?.message || hydrateErr);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Next Gen Gaming Terminal running on port ${PORT} (${process.env.NODE_ENV || 'development'} mode)`);
  });
}

startServer().catch((err) => {
  console.error('[CRITICAL] Failed to start server:', err);
  process.exit(1);
});
