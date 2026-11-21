import "dotenv/config";
import { MongoClient } from "mongodb";

const SOURCE_DB_NAME = "test";
const TARGET_DB_NAME = "hfts_horizon";
const AUTH_COLLECTIONS = ["user", "session", "account", "verification"] as const;

interface CollectionMigrationStats {
  collection: string;
  sourceCount: number;
  targetBeforeCount: number;
  toInsertCount: number;
  skippedConflictCount: number;
  targetAfterCount: number;
  status: "success" | "skipped" | "error";
  error?: string;
}

async function runMigration() {
  const args = process.argv.slice(2);
  const isExecuteMode = args.includes("--execute") || args.includes("--apply");
  const isDryRun = !isExecuteMode;

  console.log("==================================================================");
  console.log("      BETTER AUTH MONGODB DATABASE MIGRATION PROCEDURE           ");
  console.log("==================================================================");
  console.log(`Source Database : "${SOURCE_DB_NAME}" (Read-Only)`);
  console.log(`Target Database : "${TARGET_DB_NAME}"`);
  console.log(`Mode            : ${isDryRun ? ">>> DRY-RUN (No writes performed) <<<" : ">>> LIVE EXECUTION (Writing to target DB) <<<"}`);
  console.log(`Collections     : ${AUTH_COLLECTIONS.join(", ")}`);
  console.log("------------------------------------------------------------------");

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("Error: MONGODB_URI is not set in environment variables.");
    process.exit(1);
  }

  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    console.log("Connected to MongoDB cluster successfully.\n");

    const sourceDb = client.db(SOURCE_DB_NAME);
    const targetDb = client.db(TARGET_DB_NAME);

    // List collections in source DB
    const sourceCollectionsInfo = await sourceDb.listCollections().toArray();
    const sourceCollectionNames = new Set(sourceCollectionsInfo.map((c) => c.name));

    const statsList: CollectionMigrationStats[] = [];

    for (const colName of AUTH_COLLECTIONS) {
      console.log(`--> Checking collection: [${colName}]`);

      if (!sourceCollectionNames.has(colName)) {
        console.log(`    Notice: Collection "${colName}" not found in source database "${SOURCE_DB_NAME}". Skipping.`);
        statsList.push({
          collection: colName,
          sourceCount: 0,
          targetBeforeCount: 0,
          toInsertCount: 0,
          skippedConflictCount: 0,
          targetAfterCount: 0,
          status: "skipped",
        });
        continue;
      }

      const sourceCol = sourceDb.collection(colName);
      const targetCol = targetDb.collection(colName);

      const sourceCount = await sourceCol.countDocuments();
      const targetBeforeCount = await targetCol.countDocuments();

      if (sourceCount === 0) {
        console.log(`    Source collection "${colName}" is empty (0 documents).`);
        statsList.push({
          collection: colName,
          sourceCount: 0,
          targetBeforeCount,
          toInsertCount: 0,
          skippedConflictCount: 0,
          targetAfterCount: targetBeforeCount,
          status: "skipped",
        });
        continue;
      }

      // Fetch all source documents
      const sourceDocs = await sourceCol.find({}).toArray();

      // Find existing IDs in target collection to prevent overwriting
      const sourceIds = sourceDocs.map((doc) => doc._id);
      const existingInTarget = await targetCol
        .find({ _id: { $in: sourceIds } }, { projection: { _id: 1 } })
        .toArray();
      const existingIdSet = new Set(existingInTarget.map((doc) => String(doc._id)));

      const docsToInsert = sourceDocs.filter((doc) => !existingIdSet.has(String(doc._id)));
      const skippedCount = sourceDocs.length - docsToInsert.length;

      console.log(`    Source documents found  : ${sourceCount}`);
      console.log(`    Target existing before  : ${targetBeforeCount}`);
      console.log(`    New documents to insert : ${docsToInsert.length}`);
      console.log(`    Existing / conflicts    : ${skippedCount} (will be preserved, not overwritten)`);

      if (colName === "user") {
        console.log("    User roles in source to be migrated:");
        for (const u of sourceDocs) {
          const email = u.email || "no-email";
          const role = u.role || "user (default)";
          const status = existingIdSet.has(String(u._id)) ? "[Exists in target - Skip]" : "[Will migrate]";
          console.log(`      - ${email} -> role: "${role}" ${status}`);
        }
      }

      let targetAfterCount = targetBeforeCount;

      if (!isDryRun && docsToInsert.length > 0) {
        // Live execution
        const insertResult = await targetCol.insertMany(docsToInsert, { ordered: false });
        console.log(`    ✓ Inserted ${insertResult.insertedCount} document(s) into ${TARGET_DB_NAME}.${colName}`);

        // Mirror source collection indexes (except default _id_) if not already on target
        try {
          const sourceIndexes = await sourceCol.indexes();
          for (const index of sourceIndexes) {
            if (index.name === "_id_") continue;
            const indexKey = index.key;
            const indexOptions: Record<string, any> = {};
            if (index.unique) indexOptions.unique = true;
            if (index.sparse) indexOptions.sparse = true;
            if (index.name) indexOptions.name = index.name;

            await targetCol.createIndex(indexKey, indexOptions);
          }
        } catch (indexErr) {
          console.warn(`    Notice: Non-fatal index creation note for ${colName}:`, indexErr);
        }

        targetAfterCount = await targetCol.countDocuments();
      } else if (isDryRun) {
        targetAfterCount = targetBeforeCount + docsToInsert.length;
      }

      statsList.push({
        collection: colName,
        sourceCount,
        targetBeforeCount,
        toInsertCount: docsToInsert.length,
        skippedConflictCount: skippedCount,
        targetAfterCount: isDryRun ? targetBeforeCount : targetAfterCount,
        status: "success",
      });
      console.log();
    }

    // Print Summary Table
    console.log("==================================================================");
    console.log("                    MIGRATION SUMMARY TABLE                       ");
    console.log("==================================================================");
    console.log(
      "Collection".padEnd(15) +
        "Source (test)".padEnd(16) +
        "Target Before".padEnd(16) +
        (isDryRun ? "Would Insert" : "Inserted").padEnd(16) +
        "Target After".padEnd(14)
    );
    console.log("------------------------------------------------------------------");

    for (const s of statsList) {
      console.log(
        s.collection.padEnd(15) +
          String(s.sourceCount).padEnd(16) +
          String(s.targetBeforeCount).padEnd(16) +
          String(s.toInsertCount).padEnd(16) +
          String(s.targetAfterCount).padEnd(14)
      );
    }
    console.log("==================================================================");

    if (isDryRun) {
      console.log("\n[DRY RUN COMPLETE] No changes were written to the database.");
      console.log("To execute the migration and write to 'hfts_horizon', run:");
      console.log("  npm run migrate:auth -- --execute\n");
    } else {
      console.log("\n[MIGRATION SUCCESS] Better Auth documents safely migrated to 'hfts_horizon'.");
      console.log("Source database 'test' was left completely untouched.\n");
    }
  } catch (error) {
    console.error("Migration failed with error:", error);
    process.exit(1);
  } finally {
    await client.close();
    console.log("Database connection closed.");
  }
}

runMigration();
