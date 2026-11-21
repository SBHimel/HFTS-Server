import { Router, type Request, type Response } from "express";
import { ObjectId, type Filter } from "mongodb";
import { db } from "../lib/auth.js";
import { requireRole } from "../middleware/authMiddleware.js";

const router = Router();

// Enforce Admin-only access across all /api/admin routes
router.use(requireRole("admin"));

interface UserDoc {
  _id: string | ObjectId;
  name?: string;
  email: string;
  role?: string;
  image?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  [key: string]: any;
}

/** Escape special regex metacharacters to prevent ReDoS. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a safe query filter for user IDs supporting both string and ObjectId */
function buildUserIdFilter(id: string): Filter<UserDoc> {
  const trimmed = id.trim();
  if (ObjectId.isValid(trimmed) && new ObjectId(trimmed).toString() === trimmed) {
    return {
      $or: [
        { _id: new ObjectId(trimmed) },
        { _id: trimmed },
      ],
    };
  }
  return { _id: trimmed };
}

// ── GET /users ────────────────────────────────────────────────────────────
// Paginated list of users with search by name or email.
// Never exposes passwords, tokens, or sensitive account credentials.
router.get("/users", async (req: Request, res: Response): Promise<void> => {
  try {
    const filter: Record<string, any> = {};

    // Search query parameter (name or email)
    if (typeof req.query.search === "string" && req.query.search.trim()) {
      const term = escapeRegex(req.query.search.trim().slice(0, 100));
      const searchRegex = { $regex: term, $options: "i" };
      filter.$or = [{ name: searchRegex }, { email: searchRegex }];
    }

    // Pagination parameters
    const rawPage = Number(req.query.page);
    const rawLimit = Number(req.query.limit);
    const page = isNaN(rawPage) || rawPage < 1 ? 1 : Math.floor(rawPage);
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 10 : Math.min(Math.floor(rawLimit), 50);
    const skip = (page - 1) * limit;

    const usersCollection = db.collection<UserDoc>("user");

    const [users, total] = await Promise.all([
      usersCollection
        .find(filter, {
          projection: {
            _id: 1,
            name: 1,
            email: 1,
            role: 1,
            image: 1,
            createdAt: 1,
          },
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      usersCollection.countDocuments(filter),
    ]);

    // Sanitize output strictly to requested public profile fields
    const sanitizedUsers = users.map((u) => ({
      id: u._id.toString(),
      name: u.name || "",
      email: u.email,
      role: u.role || "user",
      image: u.image || null,
      createdAt: u.createdAt,
    }));

    const totalPages = Math.ceil(total / limit) || 1;

    res.json({
      users: sanitizedUsers,
      total,
      page,
      limit,
      totalPages,
      hasMore: page < totalPages,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch users",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ── PATCH /users/:id/role ─────────────────────────────────────────────────
// Update user role between 'user' and 'moderator'.
// - Cannot assign or change to 'admin'.
// - Cannot modify an existing 'admin' user.
// - Admin cannot change their own role.
router.patch("/users/:id/role", async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string" || !id.trim()) {
      res.status(400).json({ message: "Invalid user ID" });
      return;
    }

    const { role } = req.body;
    const ALLOWED_TARGET_ROLES = ["user", "moderator"] as const;
    if (!role || !ALLOWED_TARGET_ROLES.includes(role)) {
      res.status(400).json({
        message: "Invalid role. Role must be 'user' or 'moderator'",
      });
      return;
    }

    const usersCollection = db.collection<UserDoc>("user");
    const idFilter = buildUserIdFilter(id);

    const targetUser = await usersCollection.findOne(idFilter);
    if (!targetUser) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    const targetUserIdStr = targetUser._id.toString();

    // Prevent an admin from changing their own role
    if (req.user?.id && (targetUserIdStr === req.user.id || id.trim() === req.user.id)) {
      res.status(400).json({ message: "Admins cannot change their own role" });
      return;
    }

    // Do not allow changing the role of an existing admin
    if (targetUser.role === "admin") {
      res.status(403).json({ message: "Cannot modify the role of an admin user" });
      return;
    }

    const now = new Date();
    await usersCollection.updateOne(
      { _id: targetUser._id },
      {
        $set: {
          role,
          updatedAt: now,
        },
      }
    );

    res.json({
      message: `User role successfully updated to '${role}'`,
      user: {
        id: targetUserIdStr,
        name: targetUser.name || "",
        email: targetUser.email,
        role,
        image: targetUser.image || null,
        createdAt: targetUser.createdAt,
      },
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to update user role",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
