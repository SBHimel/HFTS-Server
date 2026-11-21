import { Router, type Request, type Response } from "express";
import { Lantern, type LanternStatus } from "../models/Lantern.js";
import { requireAuth } from "../middleware/authMiddleware.js";

const router = Router();

/** Helper to validate 24-char MongoDB ObjectId */
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
function isValidObjectId(s: unknown): s is string {
  return typeof s === "string" && OBJECT_ID_RE.test(s);
}

// ── GET / ─────────────────────────────────────────────────────────────────
// Public sky API: returns at most 30 lanterns per requested year:
// 1. The 10 permanent Global Featured Lanterns across the entire collection
//    (appear in every year's sky regardless of their targetYear)
// 2. Up to 20 latest active non-featured lanterns for the requested targetYear
// Hidden lanterns (moderated by admin) are excluded from the public sky.
// Slicing and filtering are strictly enforced at the database query level.
router.get("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const yearQuery = req.query.year;
    const targetYear = yearQuery && !isNaN(Number(yearQuery)) ? Number(yearQuery) : 2027;

    const [globalFeaturedLanterns, recentActiveLanterns] = await Promise.all([
      // 1. Fetch 10 permanent Global Featured Lanterns (all years)
      Lantern.find({
        isFeatured: true,
        status: { $ne: "hidden" },
      })
        .sort({ featuredIndex: 1, createdAt: 1 })
        .limit(10)
        .lean(),

      // 2. Fetch latest active non-featured lanterns for the requested year (at most 20)
      Lantern.find({
        targetYear,
        isFeatured: false,
        status: "active",
      })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
    ]);

    // Combined: 10 global featured + up to 20 recent active for the requested year (at most 30 total)
    const skyLanterns = [...globalFeaturedLanterns, ...recentActiveLanterns];
    res.json(skyLanterns);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch lanterns",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ── POST / ────────────────────────────────────────────────────────────────
// Create lantern (auth or guest).
// - The first 10 lanterns across the entire MongoDB collection claim permanent
//   Global Featured slots (1–10), safely handling concurrent submissions.
// - Subsequent lanterns become active non-featured.
// - For non-featured lanterns: keeps only the latest 20 active lanterns per targetYear;
//   older non-featured lanterns become archived (never deleted).
router.post("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      senderName,
      recipientName,
      message,
      color,
      targetYear,
      isLocked,
      unlockAt,
    } = req.body;

    if (!senderName || typeof senderName !== "string" || !senderName.trim()) {
      res.status(400).json({ message: "senderName is required" });
      return;
    }

    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400).json({ message: "message is required" });
      return;
    }

    if (targetYear === undefined || targetYear === null || isNaN(Number(targetYear))) {
      res.status(400).json({ message: "targetYear is required and must be a valid number" });
      return;
    }

    const yearNum = Number(targetYear);
    const userId = req.user?.id ?? null;

    const baseData = {
      senderName: senderName.trim().slice(0, 50),
      recipientName: typeof recipientName === "string" ? recipientName.trim().slice(0, 50) : undefined,
      message: message.trim().slice(0, 300),
      color: color || "gold",
      targetYear: yearNum,
      isLocked: Boolean(isLocked),
      unlockAt: unlockAt ? new Date(unlockAt) : undefined,
      userId,
    };

    let createdLantern = null;

    // 1. Attempt to claim one of the 10 permanent Global Featured slots (1..10)
    const currentGlobalFeaturedCount = await Lantern.countDocuments({
      isFeatured: true,
    });

    if (currentGlobalFeaturedCount < 10) {
      // Find which slot numbers (1..10) are currently taken
      const takenSlots = await Lantern.distinct("featuredIndex", {
        isFeatured: true,
        featuredIndex: { $exists: true, $ne: null },
      });
      const takenSet = new Set(takenSlots.map(Number));

      // Attempt to claim an open slot from 1 to 10
      for (let slot = 1; slot <= 10; slot++) {
        if (takenSet.has(slot)) continue;

        try {
          createdLantern = await Lantern.create({
            ...baseData,
            isFeatured: true,
            featuredIndex: slot,
            status: "active",
          });
          break; // Claimed successfully!
        } catch (err: any) {
          // If duplicate key error on featuredIndex_1, another concurrent request claimed this slot
          if (err.code === 11000 && (err.keyPattern?.featuredIndex || String(err.message).includes("featuredIndex"))) {
            takenSet.add(slot);
            continue; // Try next available slot
          }
          throw err;
        }
      }
    }

    // 2. If all 10 global featured slots are claimed (or filled concurrently), create as non-featured active
    if (!createdLantern) {
      createdLantern = await Lantern.create({
        ...baseData,
        isFeatured: false,
        status: "active",
      });

      // 3. Maintain per-year lifecycle: keep only the latest 20 non-featured active lanterns per targetYear.
      // Older non-featured lanterns become archived (never deleted). Global featured are untouched.
      const overflowLanterns = await Lantern.find({
        targetYear: yearNum,
        isFeatured: false,
        status: "active",
      })
        .sort({ createdAt: -1 })
        .skip(20)
        .select("_id")
        .lean();

      if (overflowLanterns.length > 0) {
        const idsToArchive = overflowLanterns.map((l) => l._id);
        await Lantern.updateMany(
          { _id: { $in: idsToArchive } },
          { $set: { status: "archived" } }
        );
      }
    }

    res.status(201).json(createdLantern);
  } catch (error) {
    res.status(500).json({
      message: "Failed to create lantern",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ── PATCH /:id/spark ──────────────────────────────────────────────────────
// Atomically increment sparks by 1 and return updated lantern.
router.patch("/:id/spark", async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !isValidObjectId(id)) {
      res.status(400).json({ message: "Invalid lantern ID" });
      return;
    }

    const lantern = await Lantern.findByIdAndUpdate(
      id,
      { $inc: { sparks: 1 } },
      { new: true }
    );

    if (!lantern) {
      res.status(404).json({ message: "Lantern not found" });
      return;
    }

    res.json(lantern);
  } catch (error) {
    res.status(500).json({
      message: "Failed to spark lantern",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ── PATCH /:id/status ─────────────────────────────────────────────────────
// Moderation: hide or unhide lanterns in the public sky.
// - Admin: Can Hide/Unhide any lantern.
// - Moderator: Can Hide/Unhide any public lantern, including Global Featured lanterns.
// - User / Guest: Cannot moderate lanterns.
router.patch("/:id/status", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !isValidObjectId(id)) {
      res.status(400).json({ message: "Invalid lantern ID" });
      return;
    }

    const isAdmin = req.user?.role === "admin";
    const isModerator = req.user?.role === "moderator";

    // Only admin and moderator can moderate lantern status
    if (!isAdmin && !isModerator) {
      res.status(403).json({ message: "Forbidden: Only admins and moderators can moderate lantern visibility" });
      return;
    }

    const { status } = req.body;
    const allowedStatuses: LanternStatus[] = ["active", "archived", "hidden"];
    if (!status || !allowedStatuses.includes(status)) {
      res.status(400).json({ message: "Valid status ('active', 'archived', 'hidden') is required" });
      return;
    }

    // Moderator can only hide or unhide (active / hidden)
    if (!isAdmin && status === "archived") {
      res.status(403).json({ message: "Forbidden: Moderators can only hide or unhide lanterns" });
      return;
    }

    const lantern = await Lantern.findById(id);
    if (!lantern) {
      res.status(404).json({ message: "Lantern not found" });
      return;
    }

    // Only update status — preserves ownership, featuredIndex, and all other metadata
    lantern.status = status;
    await lantern.save();

    res.json(lantern);
  } catch (error) {
    res.status(500).json({
      message: "Failed to update lantern status",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────
// Permission rules:
// - Admin: Can Delete any lantern.
// - User: Can Delete only their own lantern.
// - Moderator: Cannot Delete any lantern.
// - Guest: No delete actions (blocked by requireAuth).
router.delete("/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id || !isValidObjectId(id)) {
      res.status(400).json({ message: "Invalid lantern ID" });
      return;
    }

    const lantern = await Lantern.findById(id);
    if (!lantern) {
      res.status(404).json({ message: "Lantern not found" });
      return;
    }

    const isAdmin = req.user?.role === "admin";
    const isUser = req.user?.role === "user";
    const isOwner = Boolean(lantern.userId && req.user?.id && lantern.userId === req.user.id);

    // Admin can delete any lantern; User can delete only their own.
    // Moderators cannot delete any lantern.
    if (!isAdmin && !(isUser && isOwner)) {
      res.status(403).json({ message: "Forbidden: You are not authorized to delete this lantern" });
      return;
    }

    await Lantern.findByIdAndDelete(id);
    res.json({ message: "Lantern deleted successfully", id });
  } catch (error) {
    res.status(500).json({
      message: "Failed to delete lantern",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
