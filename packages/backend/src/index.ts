import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { pool } from './database/connection';
import { requestLogger } from './middleware/logging';
import { errorHandler } from './middleware/error';
import { sanitizeInput, securityHeaders, requestSizeLimiter } from './middleware/security';
import routes from './routes';
import { startAlertScheduler } from './services/scheduler';
import { checkSecrets } from './services/configGuard';

const app = express();

// The API is reached at mapi.primeclc.com: the browser calls it directly, since
// Vercel serves only the frontend and its one rewrite is the SPA fallback. That
// hostname is a Cloudflare tunnel (e1d2299e…) whose local cloudflared connector
// is what opens every connection to this process, from loopback.
//
// Express must be told that, or `req.ip` is the connector's address for every
// caller — one shared bucket. That is not cosmetic: `express-rate-limit` keys on
// `req.ip`, so all logins shared a single 20-per-15-minutes budget and every
// /api call shared 500. The logs show the consequence, including a login
// lockout and a 429 on the transaction 3 fee re-post.
//
// 'loopback' rather than a hop count, because the proxy really is the process on
// this box: it stays correct if another local hop is added, and it means a
// request reaching this port directly (it binds every interface) cannot name
// itself a proxy and hand over a forged X-Forwarded-For.
app.set('trust proxy', 'loopback');

app.use(helmet());

app.use(cors({
  origin: config.nodeEnv === 'production'
    ? (process.env.CORS_ORIGIN
      ? (process.env.CORS_ORIGIN === '*' ? true : process.env.CORS_ORIGIN.split(','))
      : false)
    : true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '500'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: 'Too many requests, please try again later' } },
});
app.use('/api', limiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: { message: 'Too many login attempts, please try again later' } },
});
app.use('/api/auth/login', authLimiter);
// The back-dated shift approval (D38) checks a password too, so it gets the
// same protection against guessing that login has — a second door to the same
// lock needs the same limit.
app.use('/api/cash-management/shifts/override-verify', authLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(securityHeaders);
app.use(sanitizeInput);
app.use(requestSizeLimiter(10240));
app.use(requestLogger);

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use('/api', routes);

// The built SPA, served by the same process the API lives in — flow doc §11:
// the site's hostname already tunnels to this port, so /api and /uploads
// above claim their prefixes and everything else that looks like a page gets
// index.html for the client router to draw. A path with a file extension stays
// a 404 rather than being answered with HTML a browser cannot run, and API or
// upload misses keep whatever 404 they had before this block existed. Without
// a bundle on disk nothing registers, and the process serves exactly the
// API-only surface it always has.
const frontendDist = path.resolve(__dirname, '../../frontend/dist');
const spaIndex = path.join(frontendDist, 'index.html');
if (fs.existsSync(spaIndex)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    if (path.extname(req.path)) return next();
    res.sendFile(spaIndex);
  });
}

app.use(errorHandler);

async function startServer() {
  try {
    // Before the database is touched, not after: a refusal here leaves pm2
    // with a failed process to report instead of a running server that is
    // quietly signing tokens with a published constant. Everything is printed
    // first so the reason survives the generic catch below, and no message
    // ever contains a value that could be a real secret.
    const { errors, warnings } = checkSecrets(process.env);
    for (const warning of warnings) console.warn(`Configuration warning: ${warning}`);
    if (errors.length > 0) {
      for (const error of errors) console.error(`Configuration error: ${error}`);
      throw new Error('Refusing to start with an unsafe production configuration');
    }

    const client = await pool.connect();
    console.log('Database connected successfully');
    client.release();

    app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
      console.log(`Environment: ${config.nodeEnv}`);
      console.log(`API available at http://localhost:${config.port}/api`);
    });

    // Started here rather than at module load so a failed database connection
    // exits before anything begins polling it. pm2 runs this app as a single
    // instance, so an in-process interval cannot double-fire — that stops
    // being true if `instances` is ever raised, and the scheduler would then
    // need a lock rather than this comment.
    startAlertScheduler();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

export default app;
