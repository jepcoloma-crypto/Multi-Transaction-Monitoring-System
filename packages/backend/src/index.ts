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

const app = express();

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
    const client = await pool.connect();
    console.log('Database connected successfully');
    client.release();

    app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
      console.log(`Environment: ${config.nodeEnv}`);
      console.log(`API available at http://localhost:${config.port}/api`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

export default app;
