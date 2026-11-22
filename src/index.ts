import "dotenv/config";
import { app } from "./app.js";
import { connectDB } from "./config/db.js";
import { bootstrapAdmin } from "./lib/bootstrapAdmin.js";
import { initializeLanternLifecycle } from "./lib/lanternLifecycle.js";

const PORT = process.env.PORT || 5000;

// Database connection and local server initialization
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

export { app };
export default app;
