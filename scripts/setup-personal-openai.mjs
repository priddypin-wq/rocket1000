import { randomBytes } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import nextEnv from "@next/env";

async function configure() {
  nextEnv.loadEnvConfig(process.cwd(), true);
  const env = process.env;
  const origin = new URL(env.ROCKET_DASHBOARD_URL || "https://localhost:3000");
  if (
    env.VERCEL ||
    env.NODE_ENV === "production" ||
    env.DATABASE_URL ||
    env.ROCKET_REQUIRE_POSTGRES === "1" ||
    !["localhost", "127.0.0.1"].includes(origin.hostname)
  ) {
    throw Error(
      "For a shared backend, set ROCKET_OPENAI_PERSONAL_WORKSPACE and the vault secret on the server and worker. This setup is for a local SQLite installation.",
    );
  }
  if (
    env.ROCKET_SUBSCRIPTIONS_REQUIRED === "1" &&
    !env.ROCKET_OPENAI_PERSONAL_WORKSPACE
  )
    throw Error(
      "Set ROCKET_OPENAI_PERSONAL_WORKSPACE to your signed-in workspace reference first. Subscription checks still apply.",
    );

  origin.protocol = "https:";
  const additions = [];
  if (env.ROCKET_DASHBOARD_URL !== origin.origin)
    additions.push("ROCKET_DASHBOARD_URL=" + origin.origin);
  if (
    !env.ROCKET_OPENAI_PERSONAL_WORKSPACE &&
    env.ROCKET_OPENAI_SERVER_MANAGED !== "0"
  )
    additions.push("ROCKET_OPENAI_SERVER_MANAGED=0");

  if (env.ROCKET_OPENAI_ENCRYPTION_KEY) {
    const key = Buffer.from(env.ROCKET_OPENAI_ENCRYPTION_KEY, "base64");
    if (
      key.length !== 32 ||
      key.toString("base64") !== env.ROCKET_OPENAI_ENCRYPTION_KEY
    )
      throw Error(
        "ROCKET_OPENAI_ENCRYPTION_KEY must be the original 32-byte vault secret in canonical base64.",
      );
  }
  if (!env.ROCKET_OPENAI_ENCRYPTION_KEY) {
    // Never create replacement encryption material for an existing vault.
    const { getDatabase } = await import("../server/database.mjs");
    const db = getDatabase();
    try {
      const tables = await db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='rocket_openai_credentials'",
      );
      if (
        tables.length &&
        (
          await db.query(
            "SELECT 1 FROM rocket_openai_credentials WHERE ciphertext IS NOT NULL LIMIT 1",
          )
        ).length
      )
        throw Error(
          "Restore the original ROCKET_OPENAI_ENCRYPTION_KEY for this database before continuing.",
        );
    } finally {
      await db.close();
    }
    additions.push(
      "ROCKET_OPENAI_ENCRYPTION_KEY=" + randomBytes(32).toString("base64"),
    );
  }
  if (additions.length) {
    const settings = await open(".env.local", "a", 0o600);
    try {
      if (process.platform !== "win32") await settings.chmod(0o600);
      await settings.writeFile("\n" + additions.join("\n") + "\n");
    } finally {
      await settings.close();
    }
  }

  console.log("Local OpenAI settings ready. Run npm run db:migrate, then:");
  console.log(
    "npm run dev -- --experimental-https --hostname " +
      origin.hostname +
      " --port " +
      (origin.port || "443"),
  );
  console.log(
    "Open " + origin.origin + "/mt5 and enter your key in Connect AI.",
  );
}
await mkdir("work", { recursive: true });
const lockPath = "work/.personal-openai-setup.lock";
const lock = await open(lockPath, "wx", 0o600);
try {
  await configure();
} finally {
  await lock.close();
  await rm(lockPath);
}
