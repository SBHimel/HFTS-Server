import { Lantern } from "../models/Lantern.js";

/**
 * Initializes and migrates the Lantern collection to 10 permanent Global Featured Lanterns:
 * 1. Safely drops any legacy per-year index ({ targetYear: 1, featuredIndex: 1 }).
 * 2. Selects the earliest 10 lanterns globally by `createdAt` across the entire collection.
 * 3. Assigns them permanent Global Featured status (featuredIndex: 1..10, isFeatured: true).
 * 4. Ensures all other lanterns globally are non-featured (isFeatured: false, featuredIndex unset).
 * 5. Safely ensures the new globally unique index on { featuredIndex: 1 } exists.
 * 6. Enforces the per-year rule on remaining non-featured lanterns: latest 20 remain active; older become archived.
 * 7. Preserves manually hidden lanterns (status: "hidden") and never deletes any record.
 *
 * This runs on server startup and is completely idempotent.
 */
export async function initializeLanternLifecycle(): Promise<void> {
  try {
    const collection = Lantern.collection;

    // ── Step 1: Safely drop legacy per-year compound index if present ───────
    try {
      const existingIndexes = await collection.indexes();
      for (const idx of existingIndexes) {
        if (
          idx.name &&
          (idx.name === "targetYear_1_featuredIndex_1" ||
            (idx.key && (idx.key as any).targetYear === 1 && (idx.key as any).featuredIndex === 1))
        ) {
          await collection.dropIndex(idx.name);
          console.log(`[LanternLifecycle] Dropped legacy per-year index: ${idx.name}`);
        }
      }
    } catch (indexDropErr) {
      console.warn("[LanternLifecycle] Note inspecting/dropping legacy index:", indexDropErr);
    }

    // ── Step 2: Select the earliest 10 lanterns globally across MongoDB ─────
    const earliest10Globally = await Lantern.find({})
      .sort({ createdAt: 1 })
      .limit(10);

    const featuredIds = new Set<string>();

    for (let i = 0; i < earliest10Globally.length; i++) {
      const lantern = earliest10Globally[i]!;
      const slot = i + 1;
      featuredIds.add(String(lantern._id));

      const updateFields: Record<string, any> = {
        isFeatured: true,
        featuredIndex: slot,
      };

      // Preserve manually hidden status; if not hidden, ensure active
      if (lantern.status !== "hidden") {
        updateFields.status = "active";
      }

      await Lantern.updateOne(
        { _id: lantern._id },
        { $set: updateFields }
      );
    }

    // ── Step 3: Ensure all other lanterns globally are NOT featured ─────────
    if (featuredIds.size > 0) {
      const featuredIdArray = Array.from(featuredIds);
      await Lantern.updateMany(
        { _id: { $nin: featuredIdArray } },
        {
          $set: { isFeatured: false },
          $unset: { featuredIndex: "" },
        }
      );
    }

    // ── Step 4: Safely ensure the new globally unique and query indexes exist
    try {
      await collection.createIndex(
        { featuredIndex: 1 },
        { unique: true, sparse: true, name: "featuredIndex_1" }
      );
      await collection.createIndex(
        { isFeatured: 1, status: 1, featuredIndex: 1, createdAt: 1 },
        { name: "isFeatured_1_status_1_featuredIndex_1_createdAt_1" }
      );
      await collection.createIndex(
        { targetYear: 1, isFeatured: 1, status: 1, createdAt: -1 },
        { name: "targetYear_1_isFeatured_1_status_1_createdAt_-1" }
      );
    } catch (indexCreateErr) {
      console.warn("[LanternLifecycle] Note ensuring indexes:", indexCreateErr);
    }

    // ── Step 5: Enforce per-year lifecycle on non-featured lanterns ──────────
    // For each targetYear, latest 20 non-featured active remain active; older become archived.
    const distinctYears = await Lantern.distinct("targetYear");

    for (const year of distinctYears) {
      if (!year || isNaN(Number(year))) continue;
      const targetYear = Number(year);

      // Find non-featured lanterns for this targetYear (excluding hidden)
      const nonFeaturedList = await Lantern.find({
        targetYear,
        isFeatured: false,
        status: { $ne: "hidden" },
      })
        .sort({ createdAt: -1 })
        .lean();

      // Top 20 remain active
      const keepActiveIds = nonFeaturedList.slice(0, 20).map((l) => l._id);
      const archiveIds = nonFeaturedList.slice(20).map((l) => l._id);

      if (keepActiveIds.length > 0) {
        await Lantern.updateMany(
          { _id: { $in: keepActiveIds }, status: { $ne: "active" } },
          { $set: { status: "active" } }
        );
      }

      if (archiveIds.length > 0) {
        await Lantern.updateMany(
          { _id: { $in: archiveIds }, status: { $ne: "archived" } },
          { $set: { status: "archived" } }
        );
      }
    }

    console.log(
      `[LanternLifecycle] Successfully aligned ${featuredIds.size} Global Featured Lanterns and enforced per-year active limits.`
    );
  } catch (error) {
    console.error("[LanternLifecycle] Lifecycle initialization note:", error);
  }
}
