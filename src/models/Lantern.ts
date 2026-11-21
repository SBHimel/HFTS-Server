import { Schema, model, type Document } from "mongoose";

export const LANTERN_COLORS = ["gold", "ruby", "cyan", "violet"] as const;
export type LanternColor = (typeof LANTERN_COLORS)[number];

export const LANTERN_STATUSES = ["active", "archived", "hidden"] as const;
export type LanternStatus = (typeof LANTERN_STATUSES)[number];

export interface ILantern extends Document {
  senderName: string;
  recipientName?: string | undefined;
  message: string;
  color: LanternColor;
  targetYear: number;
  isLocked: boolean;
  unlockAt?: Date | undefined;
  sparks: number;
  userId: string | null;
  isFeatured: boolean;
  featuredIndex?: number | undefined;
  status: LanternStatus;
  createdAt: Date;
}

const lanternSchema = new Schema<ILantern>(
  {
    senderName: {
      type: String,
      required: true,
      trim: true,
    },
    recipientName: {
      type: String,
      required: false,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    color: {
      type: String,
      enum: LANTERN_COLORS,
      default: "gold",
    },
    targetYear: {
      type: Number,
      required: true,
      index: true,
    },
    isLocked: {
      type: Boolean,
      default: false,
    },
    unlockAt: {
      type: Date,
      required: false,
    },
    sparks: {
      type: Number,
      default: 0,
    },
    userId: {
      type: String,
      default: null,
      index: true,
    },
    isFeatured: {
      type: Boolean,
      default: false,
      index: true,
    },
    featuredIndex: {
      type: Number,
      required: false,
    },
    status: {
      type: String,
      enum: LANTERN_STATUSES,
      default: "active",
      index: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: false,
  }
);

// ── Compound & Performance Indexes ──────────────────────────────────────────

// 1. Globally unique featuredIndex (1..10) for the 10 permanent Global Featured Lanterns
lanternSchema.index(
  { featuredIndex: 1 },
  { unique: true, sparse: true }
);

// 2. High-performance index for global featured lanterns query
lanternSchema.index(
  { isFeatured: 1, status: 1, featuredIndex: 1, createdAt: 1 }
);

// 3. High-performance index for public sky query: active non-featured lanterns by targetYear (latest 20)
lanternSchema.index(
  { targetYear: 1, isFeatured: 1, status: 1, createdAt: -1 }
);

// 4. Index for user ownership lookup
lanternSchema.index(
  { userId: 1, createdAt: -1 }
);

export const Lantern = model<ILantern>("Lantern", lanternSchema);
export default Lantern;
