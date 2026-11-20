import { Router, type Request, type Response } from "express";
import { Memory } from "../models/Memory.js";
import { requireAuth } from "../middleware/authMiddleware.js";

const router = Router();

// GET / - filter by optional year, search query, collectionId; public + user's own private (if auth) or only public approved (if guest)
router.get("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const filter: Record<string, any> = {};

    if (req.user?.id) {
      filter.$or = [
        { visibility: "public", isApproved: true },
        { userId: req.user.id },
      ];
    } else {
      filter.visibility = "public";
      filter.isApproved = true;
    }

    if (req.query.year) {
      const yearNum = Number(req.query.year);
      if (!isNaN(yearNum)) {
        filter.year = yearNum;
      }
    }

    // Search by title, story or authorName
    if (req.query.search && typeof req.query.search === "string" && req.query.search.trim()) {
      const term = req.query.search.trim();
      const searchRegex = { $regex: term, $options: "i" };
      const searchCondition = [
        { title: searchRegex },
        { story: searchRegex },
        { authorName: searchRegex },
      ];
      if (filter.$or) {
        filter.$and = [
          { $or: filter.$or },
          { $or: searchCondition },
        ];
        delete filter.$or;
      } else {
        filter.$or = searchCondition;
      }
    }

    // Filter by collection
    if (req.query.collectionId && typeof req.query.collectionId === "string") {
      const col = req.query.collectionId.trim();
      if (col === "uncategorized") {
        filter.collectionId = null;
      } else if (col !== "all") {
        filter.collectionId = col;
      }
    }

    // Pagination
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 12));
    const skip = (page - 1) * limit;

    const [memories, total] = await Promise.all([
      Memory.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Memory.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit);
    const hasMore = page < totalPages;

    res.json({
      memories,
      total,
      page,
      limit,
      totalPages,
      hasMore,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch memories",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// GET /mine - requireAuth: return all memories created by req.user.id
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

// POST /upload - upload device image to ImgBB using server-side API key
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

// POST / - requireAuth: create memory with userId & authorName
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

    if (year === undefined || year === null || isNaN(Number(year))) {
      res.status(400).json({ message: "year is required and must be a valid number" });
      return;
    }

    const authorName = req.user?.name || req.user?.email || "Anonymous";

    const memory = await Memory.create({
      title: title.trim(),
      story: story.trim(),
      imageUrl: imageUrl.trim(),
      year: Number(year),
      visibility: visibility === "private" ? "private" : "public",
      collectionId: collectionId ? String(collectionId).trim() : null,
      userId: req.user!.id,
      authorName,
      isApproved: true,
    });

    res.status(201).json(memory);
  } catch (error) {
    res.status(500).json({
      message: "Failed to create memory",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// PATCH /:id - requireAuth: allow updating own memory
router.patch("/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ message: "Memory ID is required" });
      return;
    }

    const memory = await Memory.findById(id);
    if (!memory) {
      res.status(404).json({ message: "Memory not found" });
      return;
    }

    if (memory.userId !== req.user!.id) {
      res.status(403).json({ message: "Forbidden: You are not authorized to edit this memory" });
      return;
    }

    const { title, story, imageUrl, year, visibility, collectionId } = req.body;

    if (title && typeof title === "string" && title.trim()) memory.title = title.trim();
    if (story && typeof story === "string" && story.trim()) memory.story = story.trim();
    if (imageUrl && typeof imageUrl === "string" && imageUrl.trim()) memory.imageUrl = imageUrl.trim();
    if (year !== undefined && !isNaN(Number(year))) memory.year = Number(year);
    if (visibility === "public" || visibility === "private") memory.visibility = visibility;
    if (collectionId !== undefined) {
      memory.collectionId = collectionId ? String(collectionId).trim() : null;
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

// DELETE /:id - requireAuth: allow if owner or req.user.role === "admin"
router.delete("/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ message: "Memory ID is required" });
      return;
    }

    const memory = await Memory.findById(id);

    if (!memory) {
      res.status(404).json({ message: "Memory not found" });
      return;
    }

    const isOwner = Boolean(req.user?.id && memory.userId === req.user.id);
    const isAdmin = req.user?.role === "admin";

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
