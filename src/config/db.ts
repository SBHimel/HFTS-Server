import "dotenv/config";
import mongoose from "mongoose";

export const connectDB = async (): Promise<typeof mongoose> => {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    console.error("MongoDB connection error: MONGODB_URI is not defined in environment variables");
    process.exit(1);
  }

  try {
    const conn = await mongoose.connect(mongoUri, {
  dbName: "hfts_horizon",
});
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
};

export default connectDB;
