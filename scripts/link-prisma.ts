import { rmSync, symlinkSync, lstatSync } from "fs";
import { join, resolve } from "path";

const generatedDir = join("apps", "api", "src", "generated");
const linkPath = join(generatedDir, "prisma");

try {
  lstatSync(linkPath);
  rmSync(linkPath, { recursive: true, force: true });
} catch {
  // Link doesn't exist yet — that's fine
}

if (process.platform === "win32") {
  // Junctions work without admin privileges and require absolute target paths
  symlinkSync(resolve(generatedDir, "prisma-pg"), linkPath, "junction");
} else {
  symlinkSync("prisma-pg", linkPath);
}
