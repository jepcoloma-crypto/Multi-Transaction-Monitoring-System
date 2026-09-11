import { Router, Request, Response } from 'express';
import { pool, testConnection } from '../database/connection';

const router = Router();

router.get('/health', async (_req: Request, res: Response) => {
  try {
    const dbHealthy = await testConnection();
    const timestamp = new Date().toISOString();

    res.json({
      success: true,
      data: {
        status: dbHealthy ? 'healthy' : 'degraded',
        timestamp,
        uptime: process.uptime(),
        database: dbHealthy ? 'connected' : 'disconnected',
        version: '1.0.0',
      },
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      error: {
        message: 'Service unavailable',
        code: 503,
      },
    });
  }
});

router.get('/health/db', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT NOW() as time, current_database() as database');
    res.json({
      success: true,
      data: {
        connected: true,
        time: result.rows[0].time,
        database: result.rows[0].database,
      },
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      data: {
        connected: false,
      },
    });
  }
});

export default router;
