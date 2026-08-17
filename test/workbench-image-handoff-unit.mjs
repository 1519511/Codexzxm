import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkbenchImageHandoff } from "../src/workbench-image-handoff.mjs";

const root = path.join(path.resolve(import.meta.dirname, ".."), "test", ".image-handoff-fixture");
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const authorityExecutor = {
  async resolveAuthority({ cwd, access }) {
    assert.equal(access, "readOnly");
    return { effectiveCwd: path.resolve(cwd), trustedAncestor: root, permissionProfile: ":read-only" };
  },
};

try {
  await writeFile(path.join(root, "brief.txt"), "headline\nkeep the logo unchanged\n", "utf8");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");
  await writeFile(path.join(root, "ref.png"), png);

  const handoff = new WorkbenchImageHandoff({ authorityExecutor });
  const result = await handoff.prepare({
    cwd: root,
    goal: "Create a clean 3:4 Chinese social-media cover",
    sourceTextPaths: ["brief.txt"],
    sourceImagePaths: ["ref.png"],
    exactText: ["测试标题"],
    styleNotes: ["mobile screenshot feel"],
    mustKeep: ["logo geometry"],
    mustAvoid: ["watermark"],
    canvas: { width: 1200, height: 1600, aspectRatio: "3:4" },
    outputBasename: "cover-v1",
  });

  assert.equal(result.protocol, "codexzxm-chatgpt-image-handoff-v1");
  assert.equal(result.generator, "chatgpt_builtin_image_generation");
  assert.equal(result.sourceText.length, 1);
  assert.match(result.sourceText[0].text, /keep the logo unchanged/);
  assert.equal(result.sourceImages.length, 1);
  assert.equal(result.sourceImages[0].mimeType, "image/png");
  assert.equal(result.contentItems.length, 1);
  assert.equal(result.contentItems[0].type, "image");
  assert.equal(result.contentItems[0].mimeType, "image/png");
  assert.equal(Buffer.from(result.contentItems[0].data, "base64").equals(png), true);
  assert.equal(result.routing.apiBillingRequired, false);
  assert.equal(result.routing.codexModelTurnRequired, false);

  await assert.rejects(
    handoff.prepare({ cwd: root, goal: "escape", sourceTextPaths: ["../outside.txt"] }),
    /outside trusted root|ENOENT/
  );

  console.log("Workbench image handoff contract passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
