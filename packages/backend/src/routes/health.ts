import { Router, Request, Response } from 'express';
import { pool, testConnection } from '../database/connection';
import { buildInfo } from '../services/buildInfo';

const router = Router();

// Read once at startup: the file is written at build time, so it cannot change
// without a restart and there is nothing worth re-reading per health check.
const BUILD = buildInfo();

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
        // `version` above is the application's release number and never moves.
        // These are what is actually running, which is the question worth
        // answering — the field they sit beside used to be the only answer
        // available, and it said the same thing for every deploy.
        commit: BUILD.commit,
        commitShort: BUILD.commitShort,
        branch: BUILD.branch,
        dirty: BUILD.dirty,
        builtAt: BUILD.builtAt,
        node: BUILD.node,
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
