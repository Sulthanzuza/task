import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { ValidationError } from '../lib/errors';

/** Turns a Zod failure into the details the API contract promises. */
function toDetails(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

export function parseOrThrow<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError('The request did not pass validation.', toDetails(result.error));
  }
  return result.data;
}

/**
 * Validates and replaces req.body / req.params / req.query with the parsed values,
 * so handlers always see coerced, trusted data.
 */
export function validate(schemas: {
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
}): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.params) req.params = parseOrThrow(schemas.params, req.params);
      if (schemas.query) {
        // Express 5 makes req.query a getter; assign onto a held reference instead.
        Object.defineProperty(req, 'query', {
          value: parseOrThrow(schemas.query, req.query),
          writable: true,
          configurable: true,
        });
      }
      if (schemas.body) req.body = parseOrThrow(schemas.body, req.body);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function handler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
