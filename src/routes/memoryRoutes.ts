import { Router, type Request, type Response } from "express";
import { Memory } from "../models/Memory.js";
import { Collection } from "../models/Collection.js";
import { requireAuth } from "../middleware/authMiddleware.js";

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
// Public + user's own private (if auth); guests see only public+approved.
router.get("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const filter: Record<string, any> = {};

    // ① Visibility / ownership filter — never trust client
    if (req.user?.id) {
      filter.$or = [
        { visibility: "public", isApproved: true },
        { userId: req.user.id }, // owner sees their own regardless of visibility/approval
      ];
    } else {
      filter.visibility = "public";
      filter.isApproved = true;
    }

    // ② Year filter — validate and clamp range
    if (req.query.year !== undefined && req.query.year !== "") {
      const yearNum = clampYear(req.query.year);
      if (yearNum === null) {
        res.status(400).json({ message: "year must be a number between 2000 and 2100" });
        return;
      }
      filter.year = yearNum;
    }

    // ③ Search — escape regex metacharacters (ReDoS prevention)
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
      } else {
        filter.$or = searchCondition;
      }
    }

    // ④ collectionId filter
    // - "all" → no extra filter
    // - "uncategorized" → collectionId: null
    // - specific ID → validate format; if the caller is authenticated and the
    //   collection exists, it must belong to them (prevents fishing through
    //   another user's private collection using a guessed collection ID).
    if (req.query.collectionId && typeof req.query.collectionId === "string") {
      const col = req.query.collectionId.trim();
      if (col === "uncategorized") {
        filter.collectionId = null;
      } else if (col !== "all") {
        if (!isValidObjectId(col)) {
          res.status(400).json({ message: "Invalid collectionId format" });
          return;
        }
        // If the caller is authenticated, enforce collection ownership so they
        // cannot enumerate another user's collection contents.
        if (req.user?.id) {
          const colDoc = await Collection.findById(col).lean();
          if (!colDoc || colDoc.userId !== req.user.id) {
            // Return empty rather than 403 to avoid leaking existence
            res.json({ memories: [], total: 0, page: 1, limit: 12, totalPages: 0, hasMore: false });
            return;
          }
        }
        filter.collectionId = col;
      }
    }

    // ⑤ Pagination — safe defaults and hard cap
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
// the server session, never from the request body.
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
      isApproved: true,            // server-controlled
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
// requireAuth: owner or admin may edit. userId, authorName and isApproved
// are never updated from the request body.
router.patch("/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    // ① Validate MongoDB ObjectId format
    if (!id || !isValidObjectId(id)) {
      res.status(400).json({ message: "Invalid memory ID" });
      return;
    }

    const memory = await Memory.findById(id);
    if (!memory) {
      res.status(404).json({ message: "Memory not found" });
      return;
    }

    // ② Owner or admin
    const isOwner = memory.userId === req.user!.id;
    const isAdmin = req.user!.role === "admin";
    if (!isOwner && !isAdmin) {
      res.status(403).json({ message: "Forbidden: You are not authorized to edit this memory" });
      return;
    }

    const { title, story, imageUrl, year, visibility, collectionId } = req.body;

    // ③ Apply editable fields — ignore userId / authorName / isApproved from body
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

    if (visibility === "public" || visibility === "private") memory.visibility = visibility;

    // ④ Validate collectionId ownership on update
    if (collectionId !== undefined) {
      if (!collectionId || collectionId === null) {
        memory.collectionId = null;
      } else if (typeof collectionId === "string" && collectionId.trim()) {
        const colId = collectionId.trim();
        if (!isValidObjectId(colId)) {
          res.status(400).json({ message: "Invalid collectionId format" });
          return;
        }
        // The collection must belong to the memory's owner (not the admin
        // acting on behalf of someone else). Use the memory's own userId.
        const colDoc = await Collection.findById(colId).lean();
        if (!colDoc || colDoc.userId !== memory.userId) {
          res.status(403).json({ message: "Forbidden: The specified collection does not belong to this memory's owner" });
          return;
        }
        memory.collectionId = colId;
      }
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
// requireAuth: owner or admin may delete.
router.delete("/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    // ① Validate MongoDB ObjectId format
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
    const isAdmin = req.user!.role === "admin";
    if (!isOwner && !isAdmin) {
      res.status(403).json({ message: "Forbidden: You are not authorized to delete this memory" });
      return;
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
