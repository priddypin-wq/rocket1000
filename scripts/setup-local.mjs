import { mkdir, writeFile, access } from "node:fs/promises";

try {
  await access(".env.local");
  console.log(".env.local already exists; preserved.");
} catch {
  await mkdir("work", { recursive: true });
  await writeFile(
    ".env.local",
    `ROCKET_DASHBOARD_URL=http://localhost:3000\nSQLITE_PATH=work/rocket1000.sqlite\n# Set ROCKET_BACKEND_URL after deploying a production HTTPS backend.\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    "Created local settings. No login credentials are needed. Downloads require a configured production HTTPS backend.",
  );
}
