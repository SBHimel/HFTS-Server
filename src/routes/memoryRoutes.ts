import { Router, type Request, type Response } from "express";
import { Memory } from "../models/Memory.js";
import { Collection } from "../models/Collection.js";
import { requireAuth, hasMinimumRole } from "../middleware/authMiddleware.js";

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────

/** Escape special regex metacharacters to prevent ReDoS. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Return true only when s is a 24-character lowercase hex MongoDB ObjectId. */
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
function isValidObjectId(s: unknown): s is string {
  return typeof s === "string" && OBJECT_ID_RE.test(s);
}

/** Clamp a year to a sane range. */
const YEAR_MIN = 2000;
const YEAR_MAX = 2100;

function clampYear(raw: unknown): number | null {
  const n = Number(raw);
  if (isNaN(n) || n < YEAR_MIN || n > YEAR_MAX) return null;
  return Math.floor(n);
}

// ── GET / ─────────────────────────────────────────────────────────────────
// Visibility rules enforced at database query level:
// 1. Guests: public approved memories only.
// 2. Regular authenticated users: public approved memories + their own private memories.
// 3. Admin/Moderator: all public memories (approved or unapproved for moderation) + their own private memories.
// 4. In ALL cases: private memories of OTHER users are NEVER returned to anyone (including admins/moderators).
router.get("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const filter: Record<string, any> = {};

    const isModeratorOrAdmin = req.user?.id ? hasMinimumRole(req.user.role, "moderator") : false;

    // ① Base Visibility / ownership filter
    if (req.query.visibility === "private") {
      // If client explicitly requests private memories:
      // Guests cannot view private memories.
      if (!req.user?.id) {
        res.json({ memories: [], total: 0, page: 1, limit: 12, totalPages: 0, hasMore: false });
        return;
      }
      // Authenticated users (including admins/moderators) can ONLY see their OWN private memories.
      filter.userId = req.user.id;
      filter.visibility = "private";
    } else if (req.query.visibility === "public") {
      // If client explicitly requests public memories:
      filter.visibility = "public";
      if (!isModeratorOrAdmin) {
        filter.isApproved = true;
      }
    } else {
      // Default: browse all accessible memories
      if (isModeratorOrAdmin) {
        filter.$or = [
          { visibility: "public" },
          { userId: req.user!.id, visibility: "private" },
        ];
      } else if (req.user?.id) {
        filter.$or = [
          { visibility: "public", isApproved: true },
          { userId: req.user.id },
        ];
      } else {
        filter.visibility = "public";
        filter.isApproved = true;
      }
    }

    // ② Moderation filter for isApproved (moderators/admins only, public memories only)
    if (req.query.isApproved !== undefined && req.query.isApproved !== "") {
      if (isModeratorOrAdmin) {
        const approvedVal = req.query.isApproved === "true";
        const approvalCondition = { visibility: "public", isApproved: approvedVal };
        if (filter.$or) {
          filter.$and = [{ $or: filter.$or }, approvalCondition];
          delete filter.$or;
        } else if (filter.$and) {
          filter.$and.push(approvalCondition);
        } else {
          filter.isApproved = approvedVal;
          filter.visibility = "public";
        }
      }
    }

    // ③ Year filter — validate and clamp range
    if (req.query.year !== undefined && req.query.year !== "") {
      const yearNum = clampYear(req.query.year);
      if (yearNum === null) {
        res.status(400).json({ message: "year must be a number between 2000 and 2100" });
        return;
      }
      filter.year = yearNum;
    }

    // ④ Search — escape regex metacharacters (ReDoS prevention)
    if (req.query.search && typeof req.query.search === "string" && req.query.search.trim()) {
      const term = escapeRegex(req.query.search.trim().slice(0, 200)); // cap length
      const searchRegex = { $regex: term, $options: "i" };
      const searchCondition = [
        { title: searchRegex },
        { story: searchRegex },
        { authorName: searchRegex },
      ];
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: searchCondition }];
        delete filter.$or;
      } else if (filter.$and) {
        filter.$and.push({ $or: searchCondition });
      } else {
        filter.$or = searchCondition;
      }
    }

    // ⑤ collectionId filter
    // Collections are private to their owners:
    // - "all" → no extra filter
    // - "uncategorized" → collectionId: null
    // - specific ID → validate format & strictly require that caller owns the collection
    if (req.query.collectionId && typeof req.query.collectionId === "string") {
      const col = req.query.collectionId.trim();
      if (col === "uncategorized") {
        filter.collectionId = null;
      } else if (col !== "all") {
        if (!isValidObjectId(col)) {
          res.status(400).json({ message: "Invalid collectionId format" });
          return;
        }
        // Guests have no collections, and users cannot filter by another user's collection.
        if (!req.user?.id) {
          res.json({ memories: [], total: 0, page: 1, limit: 12, totalPages: 0, hasMore: false });
          return;
        }
        const colDoc = await Collection.findById(col).lean();
        if (!colDoc || colDoc.userId !== req.user.id) {
          res.json({ memories: [], total: 0, page: 1, limit: 12, totalPages: 0, hasMore: false });
          return;
        }
        filter.collectionId = col;
      }
    }

    // ⑥ Pagination — safe defaults and hard cap
    const rawPage = Number(req.query.page);
    const rawLimit = Number(req.query.limit);
    const page = isNaN(rawPage) || rawPage < 1 ? 1 : Math.floor(rawPage);
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 12 : Math.min(Math.floor(rawLimit), 50);
    const skip = (page - 1) * limit;

    const [memories, total] = await Promise.all([
      Memory.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Memory.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit);
    const hasMore = page < totalPages;

    res.json({ memories, total, page, limit, totalPages, hasMore });
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch memories",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ── GET /mine ─────────────────────────────────────────────────────────────
// requireAuth: return all memories created by req.user.id
router.get("/mine", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const memories = await Memory.find({ userId: req.user!.id }).sort({ createdAt: -1 });
    res.json(memories);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch user memories",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ── GET /:id ──────────────────────────────────────────────────────────────
// Fetch a single memory by ID with strict visibility rules:
// - Private memories: ONLY the owner can view. (Admins/mods CANNOT bypass)
// - Public approved memories: anyone can view.
// - Public unapproved memories: only owner and admin/moderator can view.
router.get("/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    if (!id || !isValidObjectId(id)) {
      res.status(400).json({ message: "Invalid memory ID" });
      return;
    }

    const memory = await Memory.findById(id);
    if (!memory) {
      res.status(404).json({ message: "Memory not found" });
      return;
    }

    const isOwner = Boolean(req.user?.id && memory.userId === req.user.id);
    const isModeratorOrAdmin = req.user?.id ? hasMinimumRole(req.user.role, "moderator") : false;

    // 1. Private memory: STRICTLY owner only.
    if (memory.visibility === "private") {
      if (!isOwner) {
        res.status(404).json({ message: "Memory not found" });
        return;
      }
    } else {
      // 2. Public memory: if unapproved, only owner or moderator/admin can view.
      if (!memory.isApproved && !isOwner && !isModeratorOrAdmin) {
        res.status(404).json({ message: "Memory not found" });
        return;
      }
    }

    res.json(memory);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch memory",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ── POST /upload ──────────────────────────────────────────────────────────
// requireAuth: proxy device image upload to ImgBB using server-side API key
router.post("/upload", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { image } = req.body;
    if (!image || typeof image !== "string") {
      res.status(400).json({ message: "Image base64 data is required" });
      return;
    }

    const apiKey = process.env.IMGBB_API_KEY;
    if (!apiKey) {
      res.status(500).json({ message: "IMGBB_API_KEY is not configured on server" });
      return;
    }

    // Strip data URI prefix if provided (e.g. data:image/png;base64,...)
    const base64Data = image.includes(",") ? image.split(",")[1]! : image;

    const formData = new FormData();
    formData.append("image", base64Data);

    const imgbbRes = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
      method: "POST",
      body: formData,
    });

    const imgbbData = (await imgbbRes.json()) as any;

    if (!imgbbRes.ok || !imgbbData.success) {
      res.status(502).json({
        message: imgbbData?.error?.message || "Failed to upload image to storage service",
      });
      return;
    }

    res.json({
      url: imgbbData.data.url,
      display_url: imgbbData.data.display_url,
      thumb: imgbbData.data.thumb?.url,
      delete_url: imgbbData.data.delete_url,
    });
  } catch (error) {
    res.status(500).json({
      message: "Image upload failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ── POST / ────────────────────────────────────────────────────────────────
// requireAuth: create memory — userId, authorName and isApproved come from
// the server session, never from client request body.
router.post("/", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { title, story, imageUrl, year, visibility, collectionId } = req.body;

    if (!title || typeof title !== "string" || !title.trim()) {
      res.status(400).json({ message: "title is required" });
      return;
    }
    if (!story || typeof story !== "string" || !story.trim()) {
      res.status(400).json({ message: "story is required" });
      return;
    }
    if (!imageUrl || typeof imageUrl !== "string" || !imageUrl.trim()) {
      res.status(400).json({ message: "imageUrl is required" });
      return;
    }

    const yearNum = clampYear(year);
    if (yearNum === null) {
      res.status(400).json({ message: `year must be a number between ${YEAR_MIN} and ${YEAR_MAX}` });
      return;
    }

    // ① Validate and verify ownership of collectionId before assigning
    let resolvedCollectionId: string | null = null;
    if (collectionId && typeof collectionId === "string" && collectionId.trim()) {
      const colId = collectionId.trim();
      if (!isValidObjectId(colId)) {
        res.status(400).json({ message: "Invalid collectionId format" });
        return;
      }
      const colDoc = await Collection.findById(colId).lean();
      if (!colDoc || colDoc.userId !== req.user!.id) {
        res.status(403).json({ message: "Forbidden: You do not own the specified collection" });
        return;
      }
      resolvedCollectionId = colId;
    }

    // ② Always derive identity from the verified session
    const authorName = req.user!.name || req.user!.email || "Anonymous";

    const memory = await Memory.create({
      title: title.trim(),
      story: story.trim(),
      imageUrl: imageUrl.trim(),
      year: yearNum,
      visibility: visibility === "private" ? "private" : "public",
      collectionId: resolvedCollectionId,
      userId: req.user!.id,       // from session — never body
      authorName,                  // from session — never body
      isApproved: true,            // server-controlled default
    });

    res.status(201).json(memory);
  } catch (error) {
    res.status(500).json({
      message: "Failed to create memory",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ── PATCH /:id ────────────────────────────────────────────────────────────
// - Private memories: ONLY the owner may edit. (Admins/mods CANNOT edit private memories).
// - Public memories: Owner or moderator/admin may edit.
//   - Owner: can edit title, story, imageUrl, year, visibility, collectionId.
//   - Moderator/Admin: can moderate public memories (update isApproved, title, story, imageUrl, year).
//     Moderator/Admin cannot alter visibility to private or reassign collection.
router.patch("/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    if (!id || !isValidObjectId(id)) {
      res.status(400).json({ message: "Invalid memory ID" });
      return;
    }

    const memory = await Memory.findById(id);
    if (!memory) {
      res.status(404).json({ message: "Memory not found" });
      return;
    }

    const isOwner = memory.userId === req.user!.id;
    const isModeratorOrAdmin = hasMinimumRole(req.user!.role, "moderator");

    // ① Check authorization based on memory visibility
    if (memory.visibility === "private") {
      // Private memory: ONLY the owner can edit.
      // Admin and moderator must NEVER bypass private memory ownership checks!
      if (!isOwner) {
        res.status(403).json({ message: "Forbidden: Only the owner can edit a private memory" });
        return;
      }
    } else {
      // Public memory: owner or moderator/admin
      if (!isOwner && !isModeratorOrAdmin) {
        res.status(403).json({ message: "Forbidden: You are not authorized to edit this memory" });
        return;
      }
    }

    const { title, story, imageUrl, year, visibility, collectionId, isApproved } = req.body;

    // ② Apply content edits
    if (title && typeof title === "string" && title.trim()) memory.title = title.trim();
    if (story && typeof story === "string" && story.trim()) memory.story = story.trim();
    if (imageUrl && typeof imageUrl === "string" && imageUrl.trim()) memory.imageUrl = imageUrl.trim();

    if (year !== undefined) {
      const yearNum = clampYear(year);
      if (yearNum === null) {
        res.status(400).json({ message: `year must be a number between ${YEAR_MIN} and ${YEAR_MAX}` });
        return;
      }
      memory.year = yearNum;
    }

    // ③ Visibility changes: ONLY the owner can change visibility!
    // A moderator/admin cannot change the visibility of someone else's memory.
    if (visibility !== undefined) {
      if (!isOwner) {
        res.status(403).json({ message: "Forbidden: Only the owner can change memory visibility" });
        return;
      }
      if (visibility === "public" || visibility === "private") {
        memory.visibility = visibility;
      }
    }

    // ④ Collection assignment: ONLY the owner can change collection!
    if (collectionId !== undefined) {
      if (!isOwner) {
        res.status(403).json({ message: "Forbidden: Only the owner can assign or change collections" });
        return;
      }
      if (!collectionId || collectionId === null) {
        memory.collectionId = null;
      } else if (typeof collectionId === "string" && collectionId.trim()) {
        const colId = collectionId.trim();
        if (!isValidObjectId(colId)) {
          res.status(400).json({ message: "Invalid collectionId format" });
          return;
        }
        const colDoc = await Collection.findById(colId).lean();
        if (!colDoc || colDoc.userId !== memory.userId) {
          res.status(403).json({ message: "Forbidden: The specified collection does not belong to you" });
          return;
        }
        memory.collectionId = colId;
      }
    }

    // ⑤ Moderation approval status: ONLY moderator/admin can change isApproved!
    // Owner cannot approve their own memory if it was unapproved.
    if (isApproved !== undefined) {
      if (!isModeratorOrAdmin) {
        res.status(403).json({ message: "Forbidden: Only moderators and admins can change approval status" });
        return;
      }
      if (memory.visibility === "private") {
        res.status(400).json({ message: "Bad Request: Private memories cannot be moderated" });
        return;
      }
      memory.isApproved = Boolean(isApproved);
    }

    await memory.save();
    res.json(memory);
  } catch (error) {
    res.status(500).json({
      message: "Failed to update memory",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────
// - Private memories: ONLY the owner may delete. (Admins/mods CANNOT delete private memories).
// - Public memories: Owner or moderator/admin may delete.
router.delete("/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    if (!id || !isValidObjectId(id)) {
      res.status(400).json({ message: "Invalid memory ID" });
      return;
    }

    const memory = await Memory.findById(id);
    if (!memory) {
      res.status(404).json({ message: "Memory not found" });
      return;
    }

    const isOwner = req.user!.id === memory.userId;
    const isModeratorOrAdmin = hasMinimumRole(req.user!.role, "moderator");

    // 1. Private memory: strictly owner-only.
    // Admin and moderator must NEVER bypass private memory ownership checks!
    if (memory.visibility === "private") {
      if (!isOwner) {
        res.status(403).json({ message: "Forbidden: Only the owner can delete a private memory" });
        return;
      }
    } else {
      // 2. Public memory: owner or moderator/admin may delete
      if (!isOwner && !isModeratorOrAdmin) {
        res.status(403).json({ message: "Forbidden: You are not authorized to delete this memory" });
        return;
      }
    }

    await Memory.findByIdAndDelete(id);
    res.json({ message: "Memory deleted successfully", id });
  } catch (error) {
    res.status(500).json({
      message: "Failed to delete memory",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
