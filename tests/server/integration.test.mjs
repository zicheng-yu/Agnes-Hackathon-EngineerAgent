import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicAssetPath, loadCatalog } from "../../server/catalog.mjs";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:4310";
test('corrupt documents are rejected before they can become task input',async()=>{
 const form=new FormData();form.append('file',new Blob(['not a valid PDF'],{type:'application/pdf'}),'corrupt-verification.pdf');
 const response=await fetch(base+'/api/documents',{method:'POST',body:form});assert.equal(response.status,422);assert.match((await response.json()).error,/无法读取/);
});
test('history summary endpoint is paginated and does not leak complete event bodies',async()=>{
 const response=await fetch(base+'/api/tasks?summary=1&offset=0&limit=2');assert.equal(response.status,200);const result=await response.json();assert.ok(Array.isArray(result.items));assert.ok(result.items.length<=2);
 for(const task of result.items){assert.equal(task.events,undefined);assert.equal(task.result?.answer,undefined);}
});
test("catalog has unique usable assets and all local preview files exist", async () => {
  const items = await loadCatalog(root);
  assert.ok(items.length >= 24);
  assert.equal(items.length, new Set(items.map((x) => x.id)).size);
  for (const asset of items) {
    assert.ok(asset.modelUrl?.startsWith("/assets/"), asset.id);
    await fs.access(
      path.join(root, decodeURIComponent(asset.modelUrl.slice(1))),
    );
  }
  assert.ok(
    items
      .filter((x) => x.sourceType === "public-open-hardware")
      .every((x) => x.sourceUrl && x.license),
  );
});
test("asset path conversion does not expose outside files", () => {
  assert.equal(publicAssetPath(root, "/etc/passwd"), undefined);
  assert.equal(publicAssetPath(root, "../../private.key"), undefined);
});
test("configuration never returns credentials and invalid tasks do not start a model", async () => {
  const s = await (await fetch(base + "/api/settings")).json();
  assert.equal("apiKey" in s, false);
  const r = await fetch(base + "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "reconstruct" }),
  });
  assert.ok([400,401,403,409].includes(r.status));
});
test("cross-origin state changes and private workspace paths are rejected", async () => {
  const r = await fetch(base + "/api/settings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://untrusted.example",
    },
    body: "{}",
  });
  assert.equal(r.status, 403);
  assert.equal((await fetch(base + "/data/settings.json")).status, 403);
});
test("CAD API builds a real body and returns verified dimensions and artifacts", async () => {
  const response = await fetch(base + "/api/geometry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operation: "build",
      input: {
        id: "api-verification",
        features: [{ id: "block", op: "box", size: [23, 31, 7] }],
        checks: [
          { kind: "volume", expected: 4991, tolerance: 0.001 },
          { kind: "bbox", axis: "z", expected: 7, tolerance: 0.001 },
        ],
      },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  assert.equal(result.manifest.measurements.solids, 1);
  for (const key of ["step", "glb", "front"])
    assert.equal(
      (await fetch(base + result.artifacts[key], { method: "HEAD" })).status,
      200,
      key,
    );
});
test("comparison reports mismatch without calling it verified and produces an overlay", async () => {
  const input = JSON.parse(
    await fs.readFile(
      path.join(root, "tools/cad/examples/compare-hole-before.json"),
      "utf8",
    ),
  );
  const response = await fetch(base + "/api/geometry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "compare_views", input }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, true);
  assert.equal(result.verified, false);
  assert.equal(
    (await fetch(base + result.artifacts.overlay, { method: "HEAD" })).status,
    200,
  );
  const forbidden = structuredClone(input);
  forbidden.source.path = "/etc/passwd";
  const rejected = await fetch(base + "/api/geometry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "compare_views", input: forbidden }),
  });
  assert.equal(rejected.status, 422);
});

test("project returns only existing files and never advertises comparison evidence", async()=>{
 const response=await fetch(base+"/api/geometry",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({operation:"project",input:{id:"projection-links",features:[{id:"body",op:"box",size:[10,20,5]}]}})});
 const result=await response.json();assert.equal(result.success,true);assert.equal(result.artifacts.overlay,undefined);assert.equal(result.artifacts.metrics,undefined);assert.equal(result.artifacts.step,undefined);assert.ok(result.artifacts.front);
 for(const [key,url] of Object.entries(result.artifacts))if(key!=="base")assert.equal((await fetch(base+url,{method:"HEAD"})).status,200);
});
