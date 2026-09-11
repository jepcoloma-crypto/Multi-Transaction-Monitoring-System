import { Request, Response, NextFunction } from 'express';

export function sanitizeInput(req: Request, _res: Response, next: NextFunction) {
  if (req.body && typeof req.body === 'object') {
    sanitizeObject(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    Object.keys(req.query).forEach(key => {
      if (typeof (req.query as any)[key] === 'string') {
        (req.query as any)[key] = (req.query as any)[key].replace(/<[^>]*>/g, '').trim();
      }
    });
  }
  next();
}

function sanitizeObject(obj: any) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'string') {
      obj[key] = obj[key].replace(/<script[^>]*>.*?<\/script>/gi, '').replace(/<[^>]*>/g, '').trim();
    } else if (typeof obj[key] === 'object') {
      sanitizeObject(obj[key]);
    }
  }
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}

export function requestSizeLimiter(maxSizeKB: number = 1024) {
  return (req: Request, res: Response, next: NextFunction) => {
    const contentLength = parseInt(req.headers['content-length'] || '0');
    if (contentLength > maxSizeKB * 1024) {
      return res.status(413).json({ success: false, error: { message: `Request too large. Max: ${maxSizeKB}KB` } });
    }
    next();
  };
}
