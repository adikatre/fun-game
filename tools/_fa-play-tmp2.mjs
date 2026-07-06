// Live playtest bot v2: a CAREFUL controller that serializes the single
// runway (one active approach at a time, holds everyone else) to test
// whether disciplined sequencing avoids the pileups seen in v1.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';

const BASE = 'http://localhost:5173/?seed=42';
const OUT = '/tmp/fa-play2';
mkdirSync(OUT, { recursive: true });

const CSS_W = 1280, CSS_H = 800;
const WORLD_W = 1600, WORLD_H = 1000;
const INSET = 12;
const SCALE = Math.min((CSS_W - INSET * 2) / WORLD_W, (CSS_H - INSET * 2) / WORLD_H);
const OFF_X = (CSS_W - WORLD_W * SCALE) / 2;
const OFF_Y = (CSS_H - WORLD_H * SCALE) / 2;
const toScreen = (wx, wy) => ({ x: OFF_X + wx * SCALE, y: OFF_Y + wy * SCALE });

const log = [];
const say = (m) => { console.log(m); log.push(`[${new Date().toISOString()}] ${m}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: CSS_W, height: CSS_H } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const canvasBox = await page.locator('#game').boundingBox();
const sx = (wx) => canvasBox.x + toScreen(wx, 0).x;
const sy = (wy) => canvasBox.y + toScreen(0, wy).y;

async function clickCss(cx, cy) { await page.mouse.click(canvasBox.x + cx, canvasBox.y + cy); }
async function clickWorld(wx, wy) { await page.mouse.click(sx(wx), sy(wy)); }
async function dragWorld(fx, fy, tx, ty) {
  await page.mouse.move(sx(fx), sy(fy));
  await page.mouse.down();
  await page.mouse.move(sx((fx + tx) / 2), sy((fy + ty) / 2), { steps: 6 });
  await page.mouse.move(sx(tx), sy(ty), { steps: 6 });
  await page.mouse.up();
}
async function rightClickWorld(wx, wy) { await page.mouse.click(sx(wx), sy(wy), { button: 'right' }); }

const getState = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__atc.state)));

function menuBtnCenter() {
  const maxRowW = Math.min(CSS_W - 40, 460);
  const scale = maxRowW / 460;
  const bw = 220 * scale, bh = 56, gap = 20 * scale;
  const cx = CSS_W / 2, cy = CSS_H / 2 + 30;
  return [cx - bw - gap / 2 + bw / 2, cy + bh / 2];
}

let s = await getState();
say(`boot status=${s.status}`);
if (s.status === 'menu') {
  const [x, y] = menuBtnCenter();
  await clickCss(x, y);
  await page.waitForTimeout(300);
}
s = await getState();
if (s.status === 'tutorial') {
  await clickCss(CSS_W / 2, CSS_H - 60);
  await page.waitForTimeout(300);
}
s = await getState();
say(`after tutorial click status=${s.status} day=${s.day}`);
await page.screenshot({ path: `${OUT}/00-start.png` });

function chooseEnd(ac, rw) {
  const d0 = Math.hypot(ac.x - rw.ends[0].finalEntry.x, ac.y - rw.ends[0].finalEntry.y);
  const d1 = Math.hypot(ac.x - rw.ends[1].finalEntry.x, ac.y - rw.ends[1].finalEntry.y);
  return d0 <= d1 ? 0 : 1;
}
async function selectAndTakeoff(ac) {
  await clickWorld(ac.x, ac.y);
  await page.waitForTimeout(80);
  const pos = toScreen(ac.x, ac.y);
  const w = 80, h = 32, margin = 8;
  let x = Math.max(margin, Math.min(pos.x + 30, CSS_W - w - margin));
  let y = Math.max(margin, Math.min(pos.y - 40, CSS_H - h - margin));
  await clickCss(x + w / 2, y + h / 2);
}

const PLAY_SECONDS = 340; // aim to reach the debrief screen
const SCREENSHOT_EVERY_MS = 20000;
let lastShot = 0;
const started = Date.now();
let actionsLog = [];
const heldIds = new Set();

while (Date.now() - started < PLAY_SECONDS * 1000) {
  s = await getState();
  if (s.status !== 'playing') {
    say(`status changed to ${s.status} at t=${s.time?.toFixed?.(1)} cash=${s.cash} incidents=${s.incidents}`);
    if (s.status === 'debrief' || s.status === 'fired') break;
  } else {
    const rw = s.runways[0];
    const now = s.time;
    const busy = rw.occupiedUntil > now + 0.25;

    const approaching = s.aircraft.filter((a) => a.phase === 'approach' || a.phase === 'landing');
    const lineUp = s.aircraft.filter((a) => a.phase === 'lineUpWait');
    const holdingPool = s.aircraft.filter((a) => a.phase === 'holding');
    const freshInbound = s.aircraft.filter((a) => a.phase === 'inbound' && a.assignedRunwayId == null);
    const readyDeps = s.aircraft.filter((a) => a.phase === 'readyDep');

    let acted = false;

    // 1) Hold any brand-new inbound plane immediately if the approach slot is
    //    already spoken for (either someone's on approach, or someone's queued
    //    in the hold stack) — keep the sky orderly, one plane at a time.
    if (!acted && freshInbound.length > 0 && (approaching.length > 0 || holdingPool.length > 0)) {
      const ac = freshInbound[0];
      await rightClickWorld(ac.x, ac.y);
      actionsLog.push(`t=${now.toFixed(0)} HOLD(new arrival, queue busy) ${ac.callsign}`);
      acted = true;
    }

    // 2) If the approach slot is free, clear the most urgent candidate
    //    (prefer emergencies / low fuel), from {fresh inbound, holding pool}.
    if (!acted && approaching.length === 0 && !busy) {
      const candidates = [...freshInbound, ...holdingPool].sort(
        (a, b) => (b.emergency !== 'none') - (a.emergency !== 'none') || a.fuelSeconds - b.fuelSeconds,
      );
      if (candidates.length > 0) {
        const ac = candidates[0];
        const end = chooseEnd(ac, rw);
        await dragWorld(ac.x, ac.y, rw.ends[end].finalEntry.x, rw.ends[end].finalEntry.y);
        actionsLog.push(`t=${now.toFixed(0)} LAND ${ac.callsign} end=${end} emergency=${ac.emergency} fuel=${ac.fuelSeconds.toFixed(0)}`);
        acted = true;
      }
    }

    // 3) Clear a lined-up departure for takeoff only when the runway is free
    //    and nobody is inbound/holding (arrivals get priority — they have fuel limits).
    if (!acted && lineUp.length > 0 && !busy && approaching.length === 0 && freshInbound.length === 0 && holdingPool.length === 0) {
      await selectAndTakeoff(lineUp[0]);
      actionsLog.push(`t=${now.toFixed(0)} TAKEOFF clearance ${lineUp[0].callsign}`);
      acted = true;
    }

    // 4) Dispatch a ready departure to taxi out, same low-priority condition.
    if (!acted && readyDeps.length > 0 && !busy && approaching.length === 0 && freshInbound.length === 0 && holdingPool.length === 0 && lineUp.length === 0) {
      const ac = readyDeps[0];
      const end = chooseEnd(ac, rw) === 0 ? 1 : 0;
      await dragWorld(ac.x, ac.y, rw.ends[end].finalEntry.x, rw.ends[end].finalEntry.y);
      actionsLog.push(`t=${now.toFixed(0)} DISPATCH ${ac.callsign} end=${end}`);
      acted = true;
    }

    if (!acted) await page.waitForTimeout(300);
  }

  if (Date.now() - lastShot > SCREENSHOT_EVERY_MS) {
    lastShot = Date.now();
    const st = await getState();
    const idx = String(Math.round((Date.now() - started) / 1000)).padStart(3, '0');
    await page.screenshot({ path: `${OUT}/t${idx}s.png` });
    say(`t=${st.time?.toFixed?.(1)} cash=$${st.cash} incidents=${st.incidents} nearMisses=${st.nearMisses} n=${st.aircraft.length} status=${st.status}`);
  }
  await page.waitForTimeout(30);
}

s = await getState();
say(`FINAL status=${s.status} t=${s.time?.toFixed?.(1)} cash=${s.cash} incidents=${s.incidents} nearMisses=${s.nearMisses} grade=${s.grade}`);
await page.screenshot({ path: `${OUT}/zz-final.png` });

writeFileSync(`${OUT}/actions.log`, actionsLog.join('\n'));
writeFileSync(`${OUT}/run.log`, log.join('\n'));
writeFileSync(`${OUT}/console-errors.log`, consoleErrors.join('\n'));
say(`console errors: ${consoleErrors.length}`);
await browser.close();
