import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth, type AuthUser } from "./auth.js";

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

export async function readSession(request: Request) {
  return auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
}

export function authenticatedUser(request: Request): AuthUser {
  if (!request.authUser) throw new Error("Route requires authentication middleware");
  return request.authUser;
}

export function requireAuthentication(request: Request, response: Response, next: NextFunction) {
  readSession(request)
    .then((session) => {
      if (!session?.user) {
        response.status(401).json({ error: "Sign in to continue" });
        return;
      }
      request.authUser = session.user;
      next();
    })
    .catch(next);
}
