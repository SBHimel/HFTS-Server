import type { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";

export interface AuthUser {
  id: string;
  email: string;
  name?: string | undefined;
  role?: string | undefined;
  [key: string]: any;
}

export interface AuthSession {
  id: string;
  userId: string;
  [key: string]: any;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser | null | undefined;
      session?: AuthSession | null | undefined;
    }
  }
}

export const authMiddleware = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (session) {
      req.user = session.user as unknown as AuthUser;
      req.session = session.session as unknown as AuthSession;
    } else {
      req.user = null;
      req.session = null;
    }
    next();
  } catch (_error) {
    req.user = null;
    req.session = null;
    next();
  }
};

export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (req.user === undefined) {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });
      if (session) {
        req.user = session.user as unknown as AuthUser;
        req.session = session.session as unknown as AuthSession;
      } else {
        req.user = null;
        req.session = null;
      }
    }

    if (!req.user) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    next();
  } catch (error) {
    res.status(401).json({
      message: "Authentication failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const requireAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (req.user === undefined) {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });
      if (session) {
        req.user = session.user as unknown as AuthUser;
        req.session = session.session as unknown as AuthSession;
      } else {
        req.user = null;
        req.session = null;
      }
    }

    if (!req.user) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    if (req.user.role !== "admin") {
      res.status(403).json({ message: "Forbidden: Admin access required" });
      return;
    }

    next();
  } catch (error) {
    res.status(500).json({
      message: "Authorization failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
