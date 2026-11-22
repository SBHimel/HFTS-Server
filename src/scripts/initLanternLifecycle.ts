import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { initializeLanternLifecycle } from "../lib/lanternLifecycle.js";

async function main() {
  try {
    console.log("[Migration] Connecting to MongoDB...");
    await connectDB();
    console.log("[Migration] Running initializeLanternLifecycle()...");
    await initializeLanternLifecycle();
    console.log("[Migration] Lantern lifecycle initialization completed successfully.");
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("[Migration] Error during lantern lifecycle initialization:", error);
    process.exit(1);
  }
}

main();
