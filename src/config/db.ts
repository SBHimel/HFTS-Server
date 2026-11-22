import "dotenv/config";
import mongoose from "mongoose";

/**
 * Global connection cache across warm serverless invocations.
 */
let cachedPromise: Promise<typeof mongoose> | null = null;

export const connectDB = async (): Promise<typeof mongoose> => {
  // 1. If already connected, return existing mongoose instance immediately
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  // 2. If a connection is in progress, reuse the pending promise
  if (cachedPromise) {
    return cachedPromise;
  }

  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    const errorMsg = "MongoDB connection error: MONGODB_URI is not defined in environment variables";
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  // 3. Initiate new connection and cache the promise across warm invocations
  cachedPromise = mongoose
    .connect(mongoUri, {
      dbName: "hfts_horizon",
    })
    .then((conn) => {
      console.log(`[MongoDB] Connected: ${conn.connection.host}`);
      return conn;
    })
    .catch((error) => {
      cachedPromise = null;
      console.error("[MongoDB] Connection error:", error);
      throw error;
    });

  return cachedPromise;
};

export default connectDB;
