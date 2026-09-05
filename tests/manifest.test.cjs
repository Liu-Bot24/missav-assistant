const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

test("Manifest V3 正确连接设置弹窗与存储权限", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "观看小助手");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.deepEqual(manifest.content_scripts[0].js, ["site-library.js", "label-library.js", "genre-library.js", "content.js"]);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://client-rapi-missav.recombee.com/*"
  ]);
  assert.equal(manifest.background.service_worker, "background.js");
});

test("模板识别覆盖 HTTP 与 HTTPS，不申请本地文件权限", () => {
  const matches = manifest.content_scripts[0].matches;
  assert.deepEqual(matches, ["http://*/*", "https://*/*"]);
});

test("Manifest 引用的本地资源全部存在", () => {
  const referencedFiles = [
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    manifest.action.default_popup,
    manifest.background.service_worker,
    ...manifest.content_scripts[0].css,
    ...manifest.content_scripts[0].js,
    "popup.css",
    "popup.js"
  ];

  for (const file of referencedFiles) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} should exist`);
  }
});

test("设置弹窗不包含远程资源或内联脚本", () => {
  const html = fs.readFileSync(path.join(root, "popup.html"), "utf8");
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /<script(?:\s[^>]*)?>\s*[^<\s]/i);
  assert.match(html, /<script src="genre-library\.js"><\/script>/);
  assert.match(html, /<script src="popup\.js"><\/script>/);
  assert.match(html, /<script src="label-library\.js"><\/script>/);
  assert.match(html, /value="other-subtitle"/);
  assert.doesNotMatch(html, /customForm|customLabel/);
  assert.match(html, /id="infiniteScroll"/);
  assert.match(html, /id="genreIncludeField"/);
  assert.match(html, /id="genreIncludeSuggestions"/);
  assert.match(html, /id="genreExcludeField"/);
  assert.match(html, /id="genreExcludeSuggestions"/);
  assert.doesNotMatch(html, /id="genreLibraryList"/);
  assert.match(html, />只显示这些分类</);
  assert.match(html, />隐藏这些分类</);
});
