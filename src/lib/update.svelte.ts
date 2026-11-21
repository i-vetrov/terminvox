// Auto-update: check GitHub Releases at launch and every 6h, download in the background, then offer
// a restart. The download is verified against the public key in tauri.conf.json before installing.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export const update = $state<{ version: string | null }>({ version: null }); // set once downloaded
let pending: Update | null = null;
let checking = false;

async function checkNow() {
  if (checking || pending) return;
  checking = true;
  try {
    const u = await check();
    if (u) {
      await u.download();
      pending = u;
      update.version = u.version;
    }
  } catch (e) {
    console.warn("update check failed", e); // offline, rate-limited… try again next time
  } finally {
    checking = false;
  }
}

export function startUpdateChecks() {
  if (import.meta.env.DEV) return; // dev builds aren't released
  checkNow();
  setInterval(checkNow, 6 * 60 * 60 * 1000);
}

/** Caller saves state first: on Windows the installer closes the app. */
export async function installAndRestart() {
  if (!pending) return;
  await pending.install();
  await relaunch();
}
