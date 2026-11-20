import { Schema, model, type Document } from "mongoose";

export const LANTERN_COLORS = ["gold", "ruby", "cyan", "violet"] as const;
export type LanternColor = (typeof LANTERN_COLORS)[number];

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

export const Lantern = model<ILantern>("Lantern", lanternSchema);
export default Lantern;
