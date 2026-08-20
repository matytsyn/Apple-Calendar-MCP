import { access, readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

const paths = [
  "tsconfig.json",
  "tsconfig.base.json",
  "apps/macos-helper/Package.swift",
  "apps/macos-helper/Info.plist",
  "apps/macos-helper/Sources/main.swift",
  "scripts/build-helper-app.sh",
  "scripts/request-helper-permission.sh",
  "scripts/query-helper-bridge.mjs",
  "packages/mcp-server/README.md",
  "packages/mcp-server/src/index.ts",
  "packages/calendar-service/README.md",
  "packages/calendar-service/src/index.ts",
  "packages/sqlite-store/README.md",
  "packages/sqlite-store/src/index.ts",
  "packages/shared/README.md",
  "packages/shared/src/index.ts",
  "docs/README.md",
  "scripts/README.md",
  "SECURITY.md"
];

test("Phase 0 repository structure exists", async () => {
  await Promise.all(paths.map((path) => access(path)));
});

test("root package exposes a runnable test script", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.scripts.test, "npm run build && node --test tests/*.test.mjs");
  assert.equal(packageJson.scripts.typecheck, "tsc -b");
  assert.equal(packageJson.scripts["helper:build"], "swift build --package-path apps/macos-helper");
  assert.equal(packageJson.scripts["helper:bundle"], "bash scripts/build-helper-app.sh");
  assert.equal(packageJson.scripts["helper:permission-request"], "bash scripts/request-helper-permission.sh");
  assert.equal(
    packageJson.scripts["helper:permission-status"],
    "npm run build && npm run helper:bundle && node scripts/query-helper-bridge.mjs permission_status"
  );
  assert.deepEqual(packageJson.workspaces, ["packages/*"]);
});

test("Swift helper embeds Calendar usage Info.plist for TCC", async () => {
  const packageSwift = await readFile("apps/macos-helper/Package.swift", "utf8");
  const infoPlist = await readFile("apps/macos-helper/Info.plist", "utf8");
  const permissionScript = await readFile("scripts/request-helper-permission.sh", "utf8");
  const queryScript = await readFile("scripts/query-helper-bridge.mjs", "utf8");

  assert.match(packageSwift, /__TEXT/);
  assert.match(packageSwift, /__info_plist/);
  assert.match(packageSwift, /Info\.plist/);
  assert.match(infoPlist, /NSCalendarsUsageDescription/);
  assert.match(infoPlist, /NSCalendarsFullAccessUsageDescription/);
  assert.match(infoPlist, /com\.owensuyko\.apple-calendar-mcp\.helper/);
  assert.match(permissionScript, /\/usr\/bin\/open -W -n/);
  assert.match(permissionScript, /--request-permission-and-exit/);
  assert.match(queryScript, /launchMode: "app"/);
  assert.match(queryScript, /permission_status/);
});

test("TypeScript package references preserve Phase 0 package boundaries", async () => {
  const rootConfig = JSON.parse(await readFile("tsconfig.json", "utf8"));
  assert.deepEqual(rootConfig.references, [
    { path: "packages/shared" },
    { path: "packages/sqlite-store" },
    { path: "packages/calendar-service" },
    { path: "packages/mcp-server" }
  ]);

  const serviceConfig = JSON.parse(
    await readFile("packages/calendar-service/tsconfig.json", "utf8")
  );
  assert.deepEqual(serviceConfig.references, [
    { path: "../shared" },
    { path: "../sqlite-store" }
  ]);

  const serverConfig = JSON.parse(
    await readFile("packages/mcp-server/tsconfig.json", "utf8")
  );
  assert.deepEqual(serverConfig.references, [
    { path: "../shared" },
    { path: "../calendar-service" }
  ]);
});

test("Swift helper does not use print for diagnostics", async () => {
  const source = await readFile("apps/macos-helper/Sources/main.swift", "utf8");

  assert.doesNotMatch(source, /\bprint\s*\(/);
});
