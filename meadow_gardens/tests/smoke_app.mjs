import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const temp = await mkdtemp(join(tmpdir(), "meadow-test-"));
const cookies = join(temp, "cookies.json");
const mock = createServer((req, res) => {
  const table = new URL(req.url, "http://localhost").pathname;
  assert.equal(req.headers.apikey, "test-only");
  res.setHeader("Content-Type", "application/json");
  if (table.endsWith("/session_state")) {
    res.end(JSON.stringify([{ id: 1, is_healthy: true, is_paused: false }]));
  } else {
    res.end(JSON.stringify([]));
  }
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const portFinder = createServer();
await new Promise((resolve) => portFinder.listen(0, "127.0.0.1", resolve));
const port = portFinder.address().port;
await new Promise((resolve) => portFinder.close(resolve));
const app = spawn(process.execPath, ["app/dist/index.cjs"], {
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), HOST: "127.0.0.1",
    SUPABASE_URL: `http://127.0.0.1:${mock.address().port}`, SUPABASE_KEY: "test-only",
    APP_PASSWORD: "test-only-password", CHRONOGOLF_COOKIES_FILE: cookies },
  stdio: "inherit",
});
const base = `http://127.0.0.1:${port}`;
const appExit = once(app, "exit");
const auth = { "x-app-password": "test-only-password", "content-type": "application/json" };
try {
  let page;
  for (let tries = 0; tries < 40; tries++) {
    try { page = await fetch(base); break; } catch { await setTimeout(100); }
  }
  assert.equal(page?.status, 200);
  assert.match(await page.text(), /<script\b/);
  assert.equal((await fetch(`${base}/api/queue`)).status, 401);
  const login = (password) => fetch(`${base}/api/auth/login`, {
    method: "POST", headers: auth, body: JSON.stringify({ password }),
  });
  assert.equal((await login("incorrect")).status, 401);
  assert.deepEqual(await (await login("test-only-password")).json(), { authenticated: true });
  for (const path of ["queue", "history", "settings", "session"]) {
    assert.equal((await fetch(`${base}/api/${path}`, { headers: auth })).status, 200);
  }
  const status = () => fetch(`${base}/api/cookies/status`, { headers: auth }).then((res) => res.json());
  assert.deepEqual(await status(), { exists: false });
  const update = await fetch(`${base}/api/cookies`, {
    method: "POST", headers: auth, body: JSON.stringify({ cookies: JSON.stringify([
      { name: "session", value: "fake", domain: ".chronogolf.com" },
      { name: "cf_clearance", value: "fake", domain: ".chronogolf.com" },
    ]) }),
  });
  assert.deepEqual(await update.json(), { success: true, count: 1 });
  assert.equal((await stat(cookies)).mode & 0o777, 0o600);
  assert.equal((await status()).count, 1);
  assert.deepEqual(JSON.parse(await readFile(cookies, "utf8")).map((c) => c.name), ["session"]);
  console.log("Offline app smoke test passed");
} finally {
  app.kill();
  await appExit;
  await new Promise((resolve) => mock.close(resolve));
  await rm(temp, { force: true, recursive: true });
}
