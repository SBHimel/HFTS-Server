import { Router, type Request, type Response } from "express";
import { Lantern } from "../models/Lantern.js";
import { requireAuth } from "../middleware/authMiddleware.js";

const router = Router();

// GET / - filter by optional year, return latest lanterns
router.get("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const filter: Record<string, any> = {};

    if (req.query.year) {
      const yearNum = Number(req.query.year);
      if (!isNaN(yearNum)) {
        filter.targetYear = yearNum;
      }
    }

    const lanterns = await Lantern.find(filter).sort({ createdAt: -1 });
    res.json(lanterns);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch lanterns",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// POST / - create lantern (auth or guest)
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

    const userId = req.user?.id ?? null;

    const lantern = await Lantern.create({
      senderName: senderName.trim(),
      recipientName: typeof recipientName === "string" ? recipientName.trim() : undefined,
      message: message.trim(),
      color: color || "gold",
      targetYear: Number(targetYear),
      isLocked: Boolean(isLocked),
      unlockAt: unlockAt ? new Date(unlockAt) : undefined,
      userId,
    });

    res.status(201).json(lantern);
  } catch (error) {
    res.status(500).json({
      message: "Failed to create lantern",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// PATCH /:id/spark - increment sparks by 1 and return updated lantern
router.patch("/:id/spark", async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ message: "Lantern ID is required" });
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

// DELETE /:id - requireAuth: allow if owner userId === req.user.id or req.user.role === "admin"
router.delete("/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ message: "Lantern ID is required" });
      return;
    }

    const lantern = await Lantern.findById(id);

    if (!lantern) {
      res.status(404).json({ message: "Lantern not found" });
      return;
    }

    const isOwner = Boolean(lantern.userId && req.user?.id && lantern.userId === req.user.id);
    const isAdmin = req.user?.role === "admin";

    if (!isOwner && !isAdmin) {
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
