import { MongoClient } from "mongodb";

/**
 * Bootstrap the initial admin user.
 *
 * On every server start, checks whether the email in `ADMIN_EMAIL` env var
 * exists in the `user` collection. If found and their role is not already
 * "admin", it is promoted. This is idempotent and safe to run repeatedly.
 *
 * - If ADMIN_EMAIL is not set, the function silently returns (no admin bootstrap).
 * - If the user has not yet registered, nothing happens — they will be
 *   bootstrapped on the next server restart after they sign up.
 * - The env var is never exposed to the client.
 */

export async function bootstrapAdmin(): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!adminEmail) {
    console.log("[RBAC] ADMIN_EMAIL not set — skipping admin bootstrap.");
    return;
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.warn("[RBAC] MONGODB_URI not set — cannot bootstrap admin.");
    return;
  }

  try {
    const client = new MongoClient(mongoUri);
    await client.connect();
    const db = client.db("hfts_horizon");

    // Better Auth stores users in the "user" collection by default
    const usersCollection = db.collection("user");

    const user = await usersCollection.findOne({
      email: adminEmail,
    });

    if (!user) {
      console.log(
        `[RBAC] Admin email "${adminEmail}" not found in user collection. ` +
          `The user will be promoted to admin on next restart after registration.`
      );
      await client.close();
      return;
    }

    if (user.role === "admin") {
      console.log(`[RBAC] User "${adminEmail}" is already admin.`);
      await client.close();
      return;
    }

    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { role: "admin" } }
    );

    console.log(`[RBAC] ✓ Promoted "${adminEmail}" to admin.`);
    await client.close();
  } catch (error) {
    console.error("[RBAC] Admin bootstrap error:", error);
    // Non-fatal — the server continues without promoting
  }
}
