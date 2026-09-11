import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(securityHeaders);
app.use(sanitizeInput);
app.use(requestSizeLimiter(10240));
app.use(requestLogger);

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use('/api', routes);

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
