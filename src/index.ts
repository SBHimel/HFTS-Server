import "dotenv/config";
import express from "express";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import { connectDB } from "./config/db.js";
import { bootstrapAdmin } from "./lib/bootstrapAdmin.js";
import { initializeLanternLifecycle } from "./lib/lanternLifecycle.js";
import { authMiddleware } from "./middleware/authMiddleware.js";
import lanternRoutes from "./routes/lanternRoutes.js";
import memoryRoutes from "./routes/memoryRoutes.js";
import collectionRoutes from "./routes/collectionRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";

const app = express();
const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

// CORS Configuration
app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  })
);

// Better Auth catch-all handler
app.all(["/api/auth", "/api/auth/*splat"], toNodeHandler(auth));

// JSON & URL-encoded Body Parser (supporting base64 image uploads)
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// Attach session & user if available
app.use(authMiddleware);

// Health check route
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Feature Routes
app.use("/api/lanterns", lanternRoutes);
app.use("/api/memories", memoryRoutes);
app.use("/api/collections", collectionRoutes);
app.use("/api/admin", adminRoutes);

// Database connection and server initialization
const startServer = async () => {
  try {
    await connectDB();
    await bootstrapAdmin();
    await initializeLanternLifecycle();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();

export default app;
