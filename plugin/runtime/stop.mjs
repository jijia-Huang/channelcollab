// src/stop.ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";

// src/config.ts
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
var DATA_DIR = path.resolve(process.env.CHANNELCOLLAB_HOME || path.join(os.homedir(), ".channelcollab"));
var CONFIG_PATH = path.join(DATA_DIR, "config.json");
var PID_PATH = path.join(DATA_DIR, "bot.pid");
var INBOX_DIR = path.join(DATA_DIR, "inbox");
var STOP_PIPE = `\\\\.\\pipe\\channelcollab-${createHash("sha1").update(DATA_DIR.toLowerCase()).digest("hex").slice(0, 12)}`;

// src/stop.ts
var WAIT_MS = 60 * 1e3;
function running(pid2) {
  try {
    process.kill(pid2, 0);
    return true;
  } catch {
    return false;
  }
}
function ask() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(STOP_PIPE, () => socket.write("stop\n"));
    let answer2 = "";
    socket.on("data", (d) => answer2 += d.toString());
    socket.on("end", () => resolve(answer2.trim()));
    socket.on("error", reject);
  });
}
var answer;
try {
  answer = await ask();
} catch (e) {
  console.log(`no bot answering on ${STOP_PIPE} for ${DATA_DIR} (${e.code})`);
  if (existsSync(PID_PATH)) {
    const pid2 = readFileSync(PID_PATH, "utf8").trim();
    console.log(`${PID_PATH} says ${pid2}; if that is a hung bot, end it with: taskkill /T /F /PID ${pid2}`);
  }
  process.exit(1);
}
console.log(`bot: ${answer}`);
var pid = Number(/pid=(\d+)/.exec(answer)?.[1]);
if (!pid) process.exit(1);
var deadline = Date.now() + WAIT_MS;
while (running(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
if (running(pid)) {
  console.log(`pid ${pid} still running after ${WAIT_MS / 1e3} s; taskkill /T /F`);
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "inherit" });
  } catch {
  }
  rmSync(PID_PATH, { force: true });
} else {
  console.log(`pid ${pid} exited`);
}
