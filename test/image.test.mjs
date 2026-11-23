/**
 * The container image and the release, as checks a reviewer can run without
 * Docker: what the Dockerfile may contain, and that every place that names
 * the version names the same one. The live checks (no network, read-only
 * root, no capabilities) are in scripts/egress-proof.sh, which CI runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION } from "../src/server.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(repo, f), "utf8");
const dockerfile = read("Dockerfile");
const instructions = dockerfile.split("\n").filter((l) => /^[A-Z]+\s/.test(l));

test("the base image is pinned by digest, and there is exactly one", () => {
  const from = instructions.filter((l) => l.startsWith("FROM "));
  assert.equal(from.length, 1);
  assert.match(from[0], /^FROM \S+@sha256:[0-9a-f]{64}$/);
});

test("the image installs nothing and runs nothing at build time", () => {
  assert.deepEqual(instructions.filter((l) => /^(RUN|ADD) /.test(l)), []);
  assert.deepEqual(instructions.filter((l) => l.startsWith("COPY ")), ["COPY package.json ./", "COPY src ./src"]);
});

test("the process runs as a numeric non-root user", () => {
  const users = instructions.filter((l) => l.startsWith("USER "));
  assert.equal(users.length, 1);
  const [uid, gid] = users[0].slice(5).trim().split(":").map(Number);
  assert.ok(uid > 0 && gid > 0, users[0]);
});

test("entrypoint and health check are exec form: the image needs no shell", () => {
  for (const kw of ["ENTRYPOINT", "CMD", "HEALTHCHECK"]) {
    const line = instructions.find((l) => l.startsWith(`${kw} `));
    assert.ok(line, `${kw} present`);
    assert.match(line.replace(/^HEALTHCHECK .*?CMD /, "CMD "), /^(ENTRYPOINT|CMD) \[/, `${kw} must be exec form`);
  }
});

test("the build context is an allowlist: only package.json and src/", () => {
  const lines = read(".dockerignore").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(lines, ["*", "!package.json", "!src/"]);
});

test("package.json has no dependencies of any kind, and the lockfile agrees", () => {
  const p = JSON.parse(read("package.json"));
  for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundleDependencies"]) {
    assert.equal(Object.keys(p[k] ?? {}).length, 0, k);
  }
  const lock = JSON.parse(read("package-lock.json"));
  assert.deepEqual(Object.keys(lock.packages), [""], "the lockfile lists only this package");
});

test("one version everywhere: package.json, the lockfile, the server, the changelog and the README", () => {
  const p = JSON.parse(read("package.json"));
  assert.equal(VERSION, p.version);
  assert.equal(JSON.parse(read("package-lock.json")).version, p.version);
  assert.match(read("CHANGELOG.md"), new RegExp(`^## ${p.version.replace(/\./g, "\\.")} `, "m"));
  assert.ok(read("README.md").includes(`brix-edge:${p.version}`));
  assert.ok(dockerfile.includes(`brix-edge:${p.version}`));
});
