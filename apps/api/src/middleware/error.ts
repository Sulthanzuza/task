import type { NextFunction, Request, Response } from 'express';
import { ERROR_CODES } from '@tm/shared';
import { ZodError } from 'zod';
import { AppError, isAppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { isProduction } from '../config/env';

interface PostgresError {
  code: string;
  constraint?: string;
  detail?: string;
}

function isPostgresError(error: unknown): error is PostgresError {
  return typeof error === 'object' && error !== null && typeof (error as PostgresError).code === 'string';
}

/** Database constraints that map to a clear message rather than a 500. */
function fromPostgres(error: PostgresError): AppError | null {
  switch (error.code) {
    case '23505': // unique_violation
      return new AppError(409, ERROR_CODES.CONFLICT, 'That already exists.', {
        constraint: error.constraint,
      });
    case '23503': // foreign_key_violation
      return new AppError(409, ERROR_CODES.CONFLICT, 'That refers to something which does not exist.', {
        constraint: error.constraint,
      });
    case '23514': // check_violation
      return new AppError(400, ERROR_CODES.VALIDATION_FAILED, 'That value is not allowed.', {
        constraint: error.constraint,
      });
    case '22P02': // invalid_text_representation
      return new AppError(400, ERROR_CODES.VALIDATION_FAILED, 'One of the values is malformed.');
    default:
      return null;
  }
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: ERROR_CODES.NOT_FOUND,
      message: 'No route matches ' + req.method + ' ' + req.originalUrl + '.',
    },
  });
}

/** The single place an error becomes a response body. */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) return next(error);

  let appError: AppError;

  if (isAppError(error)) {
    appError = error;
  } else if (error instanceof ZodError) {
    appError = new AppError(400, ERROR_CODES.VALIDATION_FAILED, 'The request did not pass validation.', {
      issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  } else if (isPostgresError(error) && fromPostgres(error)) {
    appError = fromPostgres(error) as AppError;
  } else if (error instanceof SyntaxError && 'body' in error) {
    appError = new AppError(400, ERROR_CODES.VALIDATION_FAILED, 'The request body is not valid JSON.');
  } else {
    appError = new AppError(500, ERROR_CODES.INTERNAL, 'Something went wrong on our side.');
  }

  if (appError.status >= 500) {
    logger.error({ err: error, path: req.originalUrl, method: req.method }, 'Request failed.');
  } else {
    logger.debug({ code: appError.code, path: req.originalUrl }, appError.message);
  }

  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      // Internal details are never leaked to clients in production.
      ...(appError.details !== undefined && (!isProduction || appError.status < 500)
        ? { details: appError.details }
        : {}),
    },
  });
}
