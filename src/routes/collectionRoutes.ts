import { Router, type Request, type Response } from "express";
import { Collection } from "../models/Collection.js";
import { Memory } from "../models/Memory.js";
import { requireAuth } from "../middleware/authMiddleware.js";

const router = Router();

// GET / - fetch collections owned by the authenticated user
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

// POST / - create a new collection
router.post("/", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ message: "Collection name is required" });
      return;
    }

    const collection = await Collection.create({
      name: name.trim(),
      userId: req.user!.id,
    });

    res.status(201).json(collection);
  } catch (error) {
    res.status(500).json({
      message: "Failed to create collection",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// PATCH /:id - rename a collection (ownership enforced)
router.patch("/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!id) {
      res.status(400).json({ message: "Collection ID is required" });
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

    if (collection.userId !== req.user!.id) {
      res.status(403).json({ message: "Forbidden: You do not own this collection" });
      return;
    }

    collection.name = name.trim();
    await collection.save();

    res.json(collection);
  } catch (error) {
    res.status(500).json({
      message: "Failed to update collection",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// DELETE /:id - delete a collection and uncategorize its memories
router.delete("/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: "Collection ID is required" });
      return;
    }

    const collection = await Collection.findById(id);
    if (!collection) {
      res.status(404).json({ message: "Collection not found" });
      return;
    }

    if (collection.userId !== req.user!.id) {
      res.status(403).json({ message: "Forbidden: You do not own this collection" });
      return;
    }

    // Uncategorize all memories previously belonging to this collection
    await Memory.updateMany(
      { collectionId: id, userId: req.user!.id },
      { $set: { collectionId: null } }
    );

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
