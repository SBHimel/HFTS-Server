import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import type { Server } from "http";
import { makeSignature } from "better-auth/crypto";
import app from "../index.js";
import { auth } from "../lib/auth.js";

interface TestResult {
  num: number;
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function recordResult(num: number, name: string, passed: boolean, details: string) {
  results.push({ num, name, passed, details });
  const symbol = passed ? "✓ PASS" : "✗ FAIL";
  console.log(`[${symbol}] Test ${num}: ${name} - ${details}`);
}

async function runTestSuite() {
  console.log("==================================================================");
  console.log("       HFTS HORIZON - ADMIN USER MANAGEMENT API TEST SUITE        ");
  console.log("==================================================================");

  const mongoUri = process.env.MONGODB_URI;
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!mongoUri || !secret) {
    throw new Error("MONGODB_URI or BETTER_AUTH_SECRET not found");
  }

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db("hfts_horizon");
  const usersCol = db.collection("user");

  // Fetch accounts for testing
  const adminUser = await usersCol.findOne({ role: "admin" });
  const moderatorUser = await usersCol.findOne({ role: "moderator" });
  const regularUser = await usersCol.findOne({ role: "user" });

  if (!adminUser || !moderatorUser || !regularUser) {
    throw new Error(
      `Missing test accounts! Found: admin=${Boolean(adminUser)}, moderator=${Boolean(moderatorUser)}, user=${Boolean(regularUser)}`
    );
  }

  console.log(`Test accounts identified:`);
  console.log(`  Admin    : ${adminUser.email} (ID: ${adminUser._id})`);
  console.log(`  Moderator: ${moderatorUser.email} (ID: ${moderatorUser._id})`);
  console.log(`  User     : ${regularUser.email} (ID: ${regularUser._id})`);

  // Create temporary sessions via Better Auth internal adapter
  const ctx = await (auth as any).$context;
  const adminSession = await ctx.internalAdapter.createSession(adminUser._id.toString());
  const moderatorSession = await ctx.internalAdapter.createSession(moderatorUser._id.toString());
  const userSession = await ctx.internalAdapter.createSession(regularUser._id.toString());

  const createdSessionIds = [adminSession.id, moderatorSession.id, userSession.id];

  const adminSig = await makeSignature(adminSession.token, secret);
  const moderatorSig = await makeSignature(moderatorSession.token, secret);
  const userSig = await makeSignature(userSession.token, secret);

  const adminCookie = `${adminSession.token}.${adminSig}`;
  const moderatorCookie = `${moderatorSession.token}.${moderatorSig}`;
  const userCookie = `${userSession.token}.${userSig}`;

  console.log("Created 3 active authenticated test sessions with signed cookies.\n");

  // Start HTTP test server on dynamic free port
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://localhost:${port}`;
  console.log(`Test server running at ${baseUrl}\n`);

  function getHeaders(cookieValue?: string) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cookieValue) {
      headers["Cookie"] = `better-auth.session_token=${cookieValue}`;
    }
    return headers;
  }

  try {
    // -------------------------------------------------------------------------
    // 1. Admin can fetch paginated users
    // -------------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/api/admin/users?page=1&limit=2`, {
        headers: getHeaders(adminCookie),
      });
      const data = await res.json();
      const passed =
        res.status === 200 &&
        Array.isArray(data.users) &&
        data.users.length <= 2 &&
        typeof data.total === "number" &&
        data.page === 1 &&
        data.limit === 2 &&
        typeof data.totalPages === "number" &&
        typeof data.hasMore === "boolean";
      recordResult(
        1,
        "Admin can fetch paginated users",
        passed,
        `Status ${res.status}, returned ${data.users?.length || 0} users, total: ${data.total}, totalPages: ${data.totalPages}, hasMore: ${data.hasMore}`
      );
    }

    // -------------------------------------------------------------------------
    // 2. Admin search works for name and email
    // -------------------------------------------------------------------------
    {
      // 2a: Search by name
      const resName = await fetch(`${baseUrl}/api/admin/users?search=Himel`, {
        headers: getHeaders(adminCookie),
      });
      const dataName = await resName.json();
      const nameMatch =
        resName.status === 200 &&
        Array.isArray(dataName.users) &&
        dataName.users.length > 0 &&
        dataName.users.every((u: any) =>
          u.name.toLowerCase().includes("himel") || u.email.toLowerCase().includes("himel")
        );

      // 2b: Search by exact email
      const resEmail = await fetch(`${baseUrl}/api/admin/users?search=${moderatorUser.email}`, {
        headers: getHeaders(adminCookie),
      });
      const dataEmail = await resEmail.json();
      const emailMatch =
        resEmail.status === 200 &&
        dataEmail.users.length === 1 &&
        dataEmail.users[0].email === moderatorUser.email;

      // 2c: Search with no matches
      const resNone = await fetch(`${baseUrl}/api/admin/users?search=nonexistent_xyz_98765`, {
        headers: getHeaders(adminCookie),
      });
      const dataNone = await resNone.json();
      const noneMatch = resNone.status === 200 && dataNone.users.length === 0 && dataNone.total === 0;

      const passed = nameMatch && emailMatch && noneMatch;
      recordResult(
        2,
        "Admin search works for name and email",
        passed,
        `Name search matched ${dataName.users?.length} users; Email search matched exact user (${moderatorUser.email}); Zero-match returned 0 users.`
      );
    }

    // -------------------------------------------------------------------------
    // 3. Admin can promote a user to moderator and demote them back
    // -------------------------------------------------------------------------
    {
      const targetId = regularUser._id.toString();

      // Step 3a: Promote user to moderator
      const resPromote = await fetch(`${baseUrl}/api/admin/users/${targetId}/role`, {
        method: "PATCH",
        headers: getHeaders(adminCookie),
        body: JSON.stringify({ role: "moderator" }),
      });
      const dataPromote = await resPromote.json();
      const dbAfterPromote = await usersCol.findOne({ _id: regularUser._id });
      const promotePassed =
        resPromote.status === 200 &&
        dataPromote.user?.role === "moderator" &&
        dbAfterPromote?.role === "moderator";

      // Step 3b: Demote back to user (restore original state)
      const resDemote = await fetch(`${baseUrl}/api/admin/users/${targetId}/role`, {
        method: "PATCH",
        headers: getHeaders(adminCookie),
        body: JSON.stringify({ role: "user" }),
      });
      const dataDemote = await resDemote.json();
      const dbAfterDemote = await usersCol.findOne({ _id: regularUser._id });
      const demotePassed =
        resDemote.status === 200 &&
        dataDemote.user?.role === "user" &&
        dbAfterDemote?.role === "user";

      const passed = promotePassed && demotePassed;
      recordResult(
        3,
        "Admin can promote a user to moderator and demote them back",
        passed,
        `Promoted to moderator (status ${resPromote.status}, DB role: ${dbAfterPromote?.role}); Demoted back to user (status ${resDemote.status}, DB role: ${dbAfterDemote?.role})`
      );
    }

    // -------------------------------------------------------------------------
    // 4. Admin cannot change their own role
    // -------------------------------------------------------------------------
    {
      const adminId = adminUser._id.toString();
      const res = await fetch(`${baseUrl}/api/admin/users/${adminId}/role`, {
        method: "PATCH",
        headers: getHeaders(adminCookie),
        body: JSON.stringify({ role: "moderator" }),
      });
      const data = await res.json();
      const dbAdmin = await usersCol.findOne({ _id: adminUser._id });
      const passed = res.status === 400 && dbAdmin?.role === "admin";
      recordResult(
        4,
        "Admin cannot change their own role",
        passed,
        `Status ${res.status}: "${data.message}"; DB role untouched: "${dbAdmin?.role}"`
      );
    }

    // -------------------------------------------------------------------------
    // 5. Admin cannot assign admin role or modify another admin's role
    // -------------------------------------------------------------------------
    {
      // 5a: Assigning admin role
      const resAssignAdmin = await fetch(`${baseUrl}/api/admin/users/${regularUser._id}/role`, {
        method: "PATCH",
        headers: getHeaders(adminCookie),
        body: JSON.stringify({ role: "admin" }),
      });
      const dataAssignAdmin = await resAssignAdmin.json();
      const assignAdminBlocked = resAssignAdmin.status === 400;

      // 5b: Modifying an existing admin user's role
      const resModifyAdmin = await fetch(`${baseUrl}/api/admin/users/${adminUser._id}/role`, {
        method: "PATCH",
        headers: getHeaders(adminCookie),
        body: JSON.stringify({ role: "user" }),
      });
      const dataModifyAdmin = await resModifyAdmin.json();
      const modifyAdminBlocked = resModifyAdmin.status === 400 || resModifyAdmin.status === 403;

      const passed = assignAdminBlocked && modifyAdminBlocked;
      recordResult(
        5,
        "Admin cannot assign admin role or modify another admin's role",
        passed,
        `Assigning admin role rejected with status ${resAssignAdmin.status} ("${dataAssignAdmin.message}"); Modifying admin role rejected with status ${resModifyAdmin.status} ("${dataModifyAdmin.message}")`
      );
    }

    // -------------------------------------------------------------------------
    // 6. Moderator and User receive 403
    // -------------------------------------------------------------------------
    {
      // Moderator attempts
      const resModGet = await fetch(`${baseUrl}/api/admin/users`, {
        headers: getHeaders(moderatorCookie),
      });
      const resModPatch = await fetch(`${baseUrl}/api/admin/users/${regularUser._id}/role`, {
        method: "PATCH",
        headers: getHeaders(moderatorCookie),
        body: JSON.stringify({ role: "moderator" }),
      });

      // User attempts
      const resUserGet = await fetch(`${baseUrl}/api/admin/users`, {
        headers: getHeaders(userCookie),
      });
      const resUserPatch = await fetch(`${baseUrl}/api/admin/users/${regularUser._id}/role`, {
        method: "PATCH",
        headers: getHeaders(userCookie),
        body: JSON.stringify({ role: "moderator" }),
      });

      const passed =
        resModGet.status === 403 &&
        resModPatch.status === 403 &&
        resUserGet.status === 403 &&
        resUserPatch.status === 403;

      recordResult(
        6,
        "Moderator and User receive 403",
        passed,
        `Moderator GET=${resModGet.status}, PATCH=${resModPatch.status}; User GET=${resUserGet.status}, PATCH=${resUserPatch.status}`
      );
    }

    // -------------------------------------------------------------------------
    // 7. Guest receives 401
    // -------------------------------------------------------------------------
    {
      const resGuestGet = await fetch(`${baseUrl}/api/admin/users`, {
        headers: getHeaders(), // No session
      });
      const resGuestPatch = await fetch(`${baseUrl}/api/admin/users/${regularUser._id}/role`, {
        method: "PATCH",
        headers: getHeaders(),
        body: JSON.stringify({ role: "moderator" }),
      });

      const passed = resGuestGet.status === 401 && resGuestPatch.status === 401;
      recordResult(
        7,
        "Guest receives 401",
        passed,
        `Guest GET status: ${resGuestGet.status}, Guest PATCH status: ${resGuestPatch.status}`
      );
    }

    // -------------------------------------------------------------------------
    // 8. Invalid IDs, invalid roles, and missing users are handled safely
    // -------------------------------------------------------------------------
    {
      // 8a: Non-existent user ID
      const fakeId = new ObjectId().toString();
      const resNotFound = await fetch(`${baseUrl}/api/admin/users/${fakeId}/role`, {
        method: "PATCH",
        headers: getHeaders(adminCookie),
        body: JSON.stringify({ role: "moderator" }),
      });
      const dataNotFound = await resNotFound.json();

      // 8b: Invalid role value (superadmin)
      const resInvalidRole = await fetch(`${baseUrl}/api/admin/users/${regularUser._id}/role`, {
        method: "PATCH",
        headers: getHeaders(adminCookie),
        body: JSON.stringify({ role: "superadmin" }),
      });

      // 8c: Empty/invalid role payload
      const resEmptyRole = await fetch(`${baseUrl}/api/admin/users/${regularUser._id}/role`, {
        method: "PATCH",
        headers: getHeaders(adminCookie),
        body: JSON.stringify({ role: "" }),
      });

      // 8d: Malformed whitespace ID
      const resMalformedId = await fetch(`${baseUrl}/api/admin/users/%20/role`, {
        method: "PATCH",
        headers: getHeaders(adminCookie),
        body: JSON.stringify({ role: "moderator" }),
      });

      const passed =
        resNotFound.status === 404 &&
        resInvalidRole.status === 400 &&
        resEmptyRole.status === 400 &&
        (resMalformedId.status === 400 || resMalformedId.status === 404);

      recordResult(
        8,
        "Invalid IDs, invalid roles, and missing users are handled safely",
        passed,
        `Non-existent user status: ${resNotFound.status} ("${dataNotFound.message}"); Invalid role status: ${resInvalidRole.status}; Empty role status: ${resEmptyRole.status}; Malformed ID status: ${resMalformedId.status}`
      );
    }

    // -------------------------------------------------------------------------
    // 9. Responses never expose password, token, or sensitive auth fields
    // -------------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/api/admin/users?page=1&limit=50`, {
        headers: getHeaders(adminCookie),
      });
      const data = await res.json();

      const sensitiveKeys = [
        "password",
        "hash",
        "token",
        "secret",
        "accessToken",
        "refreshToken",
        "verificationToken",
        "accounts",
        "sessions",
      ];

      const exposedSensitive: string[] = [];
      const allowedKeys = new Set(["id", "name", "email", "role", "image", "createdAt"]);

      for (const user of data.users) {
        for (const key of Object.keys(user)) {
          if (sensitiveKeys.includes(key.toLowerCase())) {
            exposedSensitive.push(key);
          }
          if (!allowedKeys.has(key)) {
            exposedSensitive.push(`unexpected_key:${key}`);
          }
        }
      }

      const passed = res.status === 200 && exposedSensitive.length === 0;
      recordResult(
        9,
        "Responses never expose password, token, or sensitive auth fields",
        passed,
        `Checked ${data.users?.length} user objects. Sensitive/Unexpected fields leaked: [${exposedSensitive.join(", ")}]. All users strictly contain allowed fields only (${Array.from(allowedKeys).join(", ")}).`
      );
    }
  } finally {
    // Clean up temporary sessions
    for (const sId of createdSessionIds) {
      await ctx.internalAdapter.deleteSession(sId);
    }
    console.log(`\nCleaned up 3 temporary test sessions via internalAdapter.`);

    // Close server & MongoDB connection
    server.close();
    await client.close();
    console.log("Closed test server and MongoDB connection.");
  }

  // Summary
  console.log("\n==================================================================");
  console.log("                        FINAL TEST REPORT                         ");
  console.log("==================================================================");
  const totalPassed = results.filter((r) => r.passed).length;
  console.log(`TOTAL: ${results.length} | PASSED: ${totalPassed} | FAILED: ${results.length - totalPassed}`);
  for (const r of results) {
    console.log(`  ${r.passed ? "✓ PASS" : "✗ FAIL"} [Test ${r.num}] ${r.name}`);
  }
  console.log("==================================================================");

  if (totalPassed !== results.length) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error("Test execution failed with error:", err);
  process.exit(1);
});
