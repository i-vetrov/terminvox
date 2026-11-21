#!/usr/bin/env node
// npm run release 0.2.0
// Sets the version everywhere, commits, tags v0.2.0 and pushes. The Release workflow takes it
// from there (you approve it once in GitHub → Actions).
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const sh = (cmd, opts = {}) => execSync(cmd, { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], ...opts }).trim();
const die = (msg) => (console.error(`✗ ${msg}`), process.exit(1));

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) die("usage: npm run release 1.2.3");
const tag = `v${version}`;

if (sh("git status --porcelain")) die("working tree has uncommitted changes — commit or stash them first");
if (sh("git rev-parse --abbrev-ref HEAD") !== "main") die("releases are cut from main");
if (sh(`git tag -l ${tag}`)) die(`${tag} already exists`);

const edit = (file, fn) => writeFileSync(file, fn(readFileSync(file, "utf8")));
const setJsonVersion = (file) =>
  edit(file, (s) => {
    const j = JSON.parse(s);
    j.version = version;
    return JSON.stringify(j, null, 2) + "\n";
  });
setJsonVersion("package.json");
setJsonVersion("src-tauri/tauri.conf.json");
edit("src-tauri/Cargo.toml", (s) => s.replace(/^version = ".*"$/m, `version = "${version}"`));
sh("npm install --package-lock-only --ignore-scripts --no-audit --no-fund");
sh("cargo update --workspace --offline", { cwd: "src-tauri" }); // refresh our own version in Cargo.lock

sh("git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock");
sh(`git commit -m "Release ${tag}"`);
sh(`git tag -a ${tag} -m "TerminVox ${version}"`);
sh(`git push --atomic origin main ${tag}`, { stdio: "inherit" });

const repo = sh("git remote get-url origin").replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
console.log(`\n✓ ${tag} pushed. Approve the build: https://github.com/${repo}/actions`);
