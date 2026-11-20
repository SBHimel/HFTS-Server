import { Schema, model, type Document } from "mongoose";

export interface ICollection extends Document {
  name: string;
  userId: string;
  createdAt: Date;
}

const collectionSchema = new Schema<ICollection>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
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

export const Collection = model<ICollection>("Collection", collectionSchema);
export default Collection;
