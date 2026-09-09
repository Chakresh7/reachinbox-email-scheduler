import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodType } from "zod";
import { badRequest } from "../lib/errors";

type Source = "body" | "query" | "params";

export function validate(schema: ZodType, source: Source = "body") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) {
      next(
        parsed.error instanceof ZodError
          ? parsed.error
          : badRequest("Request validation failed"),
      );
      return;
    }
    req[source] = parsed.data as Request[typeof source];
    next();
  };
}
