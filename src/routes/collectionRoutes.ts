import { Router, type Request, type Response } from "express";
import { Collection } from "../models/Collection.js";
import { Memory } from "../models/Memory.js";
import { requireAuth } from "../middleware/authMiddleware.js";

const router = Router();

// ── Helper ─────────────────────────────────────────────────────────────────

/** Return true only when s is a 24-character hex MongoDB ObjectId. */
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
function isValidObjectId(s: unknown): s is string {
  return typeof s === "string" && OBJECT_ID_RE.test(s);
}

const NAME_MAX_LEN = 60; // server-side cap (client shows 40)

// ── GET / ──────────────────────────────────────────────────────────────────
// Fetch only collections owned by the authenticated user.
router.get("/", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const collections = await Collection.find({ userId: req.user!.id }).sort({ createdAt: 1 });
    res.json(collections);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch collections",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ── POST / ─────────────────────────────────────────────────────────────────
// Create a new collection. userId always comes from the session.
router.post("/", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ message: "Collection name is required" });
      return;
    }

    const trimmed = name.trim().slice(0, NAME_MAX_LEN);

    const collection = await Collection.create({
      name: trimmed,
      userId: req.user!.id, // always from session — never from body
    });

    res.status(201).json(collection);
  } catch (error) {
    res.status(500).json({
      message: "Failed to create collection",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ── PATCH /:id ─────────────────────────────────────────────────────────────
// Rename a collection. Only the owner may do this.
router.patch("/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    // ① Validate ObjectId format
    if (!isValidObjectId(id)) {
      res.status(400).json({ message: "Invalid collection ID" });
      return;
    }

    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ message: "Collection name is required" });
      return;
    }

    const collection = await Collection.findById(id);
    if (!collection) {
      res.status(404).json({ message: "Collection not found" });
      return;
    }

    // ② Ownership check
    if (collection.userId !== req.user!.id) {
      res.status(403).json({ message: "Forbidden: You do not own this collection" });
      return;
    }

    collection.name = name.trim().slice(0, NAME_MAX_LEN);
    await collection.save();

    res.json(collection);
  } catch (error) {
    res.status(500).json({
      message: "Failed to update collection",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ── DELETE /:id ─────────────────────────────────────────────────────────────
// Delete a collection and uncategorize ALL memories that reference it
// (regardless of who authored them, since any memory can reference a
// collection by ID).
router.delete("/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    // ① Validate ObjectId format
    if (!id || !isValidObjectId(id)) {
      res.status(400).json({ message: "Invalid collection ID" });
      return;
    }

    const collection = await Collection.findById(id);
    if (!collection) {
      res.status(404).json({ message: "Collection not found" });
      return;
    }

    // ② Ownership check
    if (collection.userId !== req.user!.id) {
      res.status(403).json({ message: "Forbidden: You do not own this collection" });
      return;
    }

    // ③ Cascade: uncategorize every memory pointing at this collection,
    //    not just the owner's, to avoid stale collectionId references.
    await Memory.updateMany({ collectionId: id }, { $set: { collectionId: null } });

    await Collection.findByIdAndDelete(id);

    res.json({ message: "Collection deleted successfully", id });
  } catch (error) {
    res.status(500).json({
      message: "Failed to delete collection",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
