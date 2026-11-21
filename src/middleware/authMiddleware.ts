import type { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";

// ── Role system ────────────────────────────────────────────────────────────

/** The three application roles, ordered from lowest to highest privilege. */
export const APP_ROLES = ["user", "moderator", "admin"] as const;
export type AppRole = (typeof APP_ROLES)[number];

/** Hierarchy map — higher number = more privilege. */
const ROLE_RANK: Record<AppRole, number> = { user: 0, moderator: 1, admin: 2 };

/** Type-guard: is the value a known role string? */
export function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && APP_ROLES.includes(value as AppRole);
}

/** True when `userRole` is at least as privileged as `minimumRole`. */
export function hasMinimumRole(userRole: string | undefined, minimumRole: AppRole): boolean {
  if (!userRole || !isAppRole(userRole)) return false;
  return ROLE_RANK[userRole] >= ROLE_RANK[minimumRole];
}

// ── Shared types ───────────────────────────────────────────────────────────

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

// ── Shared session resolver ────────────────────────────────────────────────

/** Lazily resolve the Better Auth session onto `req.user` / `req.session`. */
async function resolveSession(req: Request): Promise<void> {
  if (req.user !== undefined) return; // already resolved by authMiddleware
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
  } catch {
    req.user = null;
    req.session = null;
  }
}

// ── Middleware: attach session (non-blocking) ──────────────────────────────

/**
 * Attach session & user to `req` if present.
 * Does NOT reject unauthenticated requests — use `requireAuth` for that.
 */
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

// ── Middleware: require authenticated user ──────────────────────────────────

/**
 * Reject with 401 if the request does not carry a valid session.
 */
export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    await resolveSession(req);

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

// ── Middleware factory: require one or more roles ───────────────────────────

/**
 * Returns middleware that first ensures the user is authenticated, then checks
 * that `req.user.role` is one of the allowed roles.
 *
 * Usage:
 *   router.delete("/:id", requireRole("admin"), handler);
 *   router.patch("/:id", requireRole("admin", "moderator"), handler);
 */
export function requireRole(...allowedRoles: AppRole[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await resolveSession(req);

      if (!req.user) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }

      const userRole = req.user.role;
      if (!userRole || !allowedRoles.includes(userRole as AppRole)) {
        res.status(403).json({ message: "Forbidden: Insufficient permissions" });
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
}

// ── Middleware factory: require a minimum role level ────────────────────────

/**
 * Returns middleware that ensures the user's role is at or above `minimumRole`
 * in the hierarchy: user < moderator < admin.
 *
 * Usage:
 *   router.get("/reports", requireMinRole("moderator"), handler);
 *   // → allows moderator AND admin
 */
export function requireMinRole(minimumRole: AppRole) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await resolveSession(req);

      if (!req.user) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }

      if (!hasMinimumRole(req.user.role, minimumRole)) {
        res.status(403).json({ message: "Forbidden: Insufficient permissions" });
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
}

// ── Backward-compatible alias ──────────────────────────────────────────────

/**
 * @deprecated Use `requireRole("admin")` or `requireMinRole("admin")` instead.
 * Kept for backward compatibility with existing route files.
 */
export const requireAdmin = requireRole("admin");
