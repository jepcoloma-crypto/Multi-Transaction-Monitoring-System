import { Request, Response, NextFunction } from 'express';
import { AppError } from '../types';

export function createError(statusCode: number, message: string): AppError {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  error.isOperational = true;
  return error;
}

export function errorHandler(
  err: AppError | Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if ('statusCode' in err && err.isOperational) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        message: err.message,
        code: err.statusCode,
      },
    });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: {
      message: 'Internal server error',
      code: 500,
    },
  });
}
