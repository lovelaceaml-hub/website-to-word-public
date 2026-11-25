import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("Manifest V3 declares packaged files", () => {
  const source = new URL("../extension/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", source)));
  assert.equal(manifest.manifest_version, 3);
  for (const name of [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons)]) {
    assert.ok(statSync(fileURLToPath(new URL(name, source))).isFile());
  }
});
