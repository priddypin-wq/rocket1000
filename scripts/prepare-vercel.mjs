// Prepare source uploads for the confirmed existing project; never creates a project
// or deployment and never includes environment files, databases or personalized EA config.
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { compiledArtifact } from "../server/provisioning.mjs";

const root = process.cwd();
await compiledArtifact(root);
const paths = [];
async function walk(directory) {
  for (const e of await readdir(resolve(root, directory), {
    withFileTypes: true,
  })) {
    if (e.isSymbolicLink())
      throw Error("Source upload cannot follow symbolic links.");
    const p = directory + "/" + e.name;
    if (e.isDirectory()) await walk(p);
    else if (e.isFile()) paths.push(p);
  }
}
for (const directory of ["app", "lib", "server"]) await walk(directory);
paths.push(
  "scripts/migrate.mjs",
  "ea/ROCKET1000_EA.ex5",
  "ea/ROCKET1000_EA.mq5",
  "ea/build-manifest.json",
  "package.json",
  "package-lock.json",
  "next.config.ts",
  "next-env.d.ts",
  "tsconfig.json",
  "vercel.json",
);
const uploads = [];
for (const file of paths.sort()) {
  if (
    /(^|\/)(\.env[^/]*|\.git|\.vercel|work|node_modules|\.next)(\/|$)|\.sqlite|\.config$/i.test(
      file,
    )
  )
    throw Error("Private/generated source path rejected.");
  const path = resolve(root, file),
    rel = relative(root, path);
  if (rel.startsWith(".." + sep) || rel === "..")
    throw Error("Source file leaves the project.");
  const bytes = await readFile(path);
  uploads.push({
    file,
    sha: createHash("sha1").update(bytes).digest("hex"),
    size: bytes.length,
    data: bytes.toString("base64"),
  });
}
const payload = {
  project: "prj_oTLaK79PdNcNy8dpXiINtTiqlAsC",
  name: "rocket1000",
  productionOrigin: "https://rocket1000.vercel.app",
  files: uploads.map(({ file, sha, size }) => ({ file, sha, size })),
  uploads,
};
await mkdir("work", { recursive: true });
await writeFile("work/vercel-source-files.json", JSON.stringify(payload), {
  mode: 0o600,
});
console.log(
  `Prepared ${uploads.length} verified source files for the existing rocket1000 project. No deployment submitted.`,
);
