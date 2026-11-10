#!/usr/bin/env node
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const URL = process.env.APP_URL || "http://127.0.0.1:4178/";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../evidence");
const CHROME = process.env.CHROME || "/usr/bin/google-chrome-stable";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitLoaded(page, timeout = 30000) {
  await page.waitForFunction(
    () => {
      const nodes = [...document.querySelectorAll("[data-loading]")];
      return nodes.length > 0 && nodes.every((n) => n.hidden);
    },
    { timeout }
  );
  await sleep(800);
}

async function shot(page, name) {
  const path = join(OUT, name);
  await page.screenshot({ path, type: "png" });
  console.log("wrote", path);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--use-angle=swiftshader",
      "--use-gl=angle",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--window-size=1920,1080",
    ],
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  await page.goto(URL, { waitUntil: "networkidle0" });
  await waitLoaded(page);
  await shot(page, "app-default.png");

  // original grey plaster (skin off)
  await page.click("#skin-tint");
  await sleep(250);
  await shot(page, "app-skin-off.png");

  // skin back on
  await page.click("#skin-tint");
  await sleep(200);

  // hide F on both? just left F and right B for a toggle demo
  await page.click("#left-panel [data-vector=F]");
  await page.click("#right-panel [data-vector=B]");
  await sleep(200);
  await shot(page, "app-toggle-vectors.png");

  // restore vectors
  await page.click("#left-panel [data-vector=F]");
  await page.click("#right-panel [data-vector=B]");

  // change theta to 45 on both
  await page.$eval("#left-panel [data-param=theta]", (el) => {
    el.value = "45";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.$eval("#right-panel [data-param=theta]", (el) => {
    el.value = "45";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);
  await shot(page, "app-formula-theta-45.png");

  // hide rig, reset theta
  await page.click("#show-rig");
  await page.$eval("#left-panel [data-param=theta]", (el) => {
    el.value = "90";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.$eval("#right-panel [data-param=theta]", (el) => {
    el.value = "90";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);
  await shot(page, "app-rig-hidden.png");

  // close-ups of each viewport
  const leftVp = await page.$("#left-panel .viewport");
  const rightVp = await page.$("#right-panel .viewport");
  await leftVp.screenshot({ path: join(OUT, "app-left-viewport.png") });
  await rightVp.screenshot({ path: join(OUT, "app-right-viewport.png") });
  console.log("wrote viewports");

  await browser.close();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
