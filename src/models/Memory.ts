import { Schema, model, type Document } from "mongoose";

export const MEMORY_VISIBILITIES = ["public", "private"] as const;
export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];

export interface IMemory extends Document {
  title: string;
  story: string;
  imageUrl: string;
  year: number;
  visibility: MemoryVisibility;
  userId: string;
  authorName: string;
  collectionId?: string | null;
  isApproved: boolean;
  createdAt: Date;
}

const memorySchema = new Schema<IMemory>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    story: {
      type: String,
      required: true,
      trim: true,
    },
    imageUrl: {
      type: String,
      required: true,
      trim: true,
    },
    year: {
      type: Number,
      required: true,
    },
    visibility: {
      type: String,
      enum: MEMORY_VISIBILITIES,
      default: "public",
    },
    userId: {
      type: String,
      required: true,
    },
    authorName: {
      type: String,
      required: true,
      trim: true,
    },
    collectionId: {
      type: String,
      default: null,
      index: true,
    },
    isApproved: {
      type: Boolean,
      default: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
  }
);

export const Memory = model<IMemory>("Memory", memorySchema);
export default Memory;
