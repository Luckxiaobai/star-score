// 钢琴卷帘 v2 几何数学校验（纯计算，不进浏览器）
// 目的：用数值证明三件事
//   1) 旧实现（height 写死 320 + MIN_PITCH=24）会把常见旋律（60~80）整个画到负坐标 → 看不见
//   2) 新实现（height 按容器实测 + 纵向 scrollY + A0~C8 全音域）能把旋律完整放进视口
//   3) 拖拽方向修正后：鼠标向上拖 → 音高升高

const ROW_HEIGHT = 10;
const MIN_PITCH = 21;   // A0
const MAX_PITCH = 108;  // C8
const GRID_HEIGHT = (MAX_PITCH - MIN_PITCH + 1) * ROW_HEIGHT; // 880

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---------- 旧实现 ---------- */
const OLD_MIN_PITCH = 24;
const OLD_HEIGHT = 320;
const oldPitchToY = (p) => OLD_HEIGHT - (p - OLD_MIN_PITCH) * ROW_HEIGHT;
const oldVisible = (p) => {
  const y = oldPitchToY(p);
  return y >= 0 && y + ROW_HEIGHT <= OLD_HEIGHT;
};
// 旧拖拽：dpitch = round(dyPx / ROW_HEIGHT)
const oldDpitch = (dyPx) => Math.round(dyPx / ROW_HEIGHT);

/* ---------- 新实现 ---------- */
const newPitchToY = (p, scrollY) => (MAX_PITCH - p) * ROW_HEIGHT - scrollY;
const newVisible = (p, scrollY, h) => {
  const y = newPitchToY(p, scrollY);
  return y >= 0 && y + ROW_HEIGHT <= h;
};
// 新拖拽：dpitch = round(-dyPx / ROW_HEIGHT)
const newDpitch = (dyPx) => Math.round(-dyPx / ROW_HEIGHT);

function maxScrollY(h) {
  return Math.max(0, GRID_HEIGHT - h);
}

// 复刻组件里的 fitPitchRange
function fitScrollY(pitches, h) {
  if (pitches.length === 0) {
    return clamp((MAX_PITCH - 60) * ROW_HEIGHT - h / 2, 0, maxScrollY(h));
  }
  const lo = Math.min(...pitches) - 2;
  const hi = Math.max(...pitches) + 2;
  const spanPx = (hi - lo + 1) * ROW_HEIGHT;
  let center;
  if (spanPx <= h) {
    center = (lo + hi) / 2;
  } else {
    const sorted = [...pitches].sort((a, b) => a - b);
    center = sorted[Math.floor(sorted.length / 2)];
  }
  return clamp(
    (MAX_PITCH - center) * ROW_HEIGHT - h / 2 + ROW_HEIGHT / 2,
    0,
    maxScrollY(h)
  );
}

function visibleRatio(pitches, scrollY, h) {
  const n = pitches.filter((p) => newVisible(p, scrollY, h)).length;
  return n / pitches.length;
}

let failures = 0;
function check(name, cond, detail) {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`[${tag}] ${name}${detail ? '  → ' + detail : ''}`);
}

console.log('=== 1) 旧实现的根因：常见旋律落在负坐标 ===');
{
  const melody = Array.from({ length: 20 }, (_, i) => 60 + i); // 60~79
  const oldVis = melody.filter(oldVisible).length;
  const oldYs = [oldPitchToY(60), oldPitchToY(79)];
  console.log(`    旧参数 MIN_PITCH=${OLD_MIN_PITCH}, height=${OLD_HEIGHT}`);
  console.log(`    音高 60 的 y = ${oldYs[0]}（<0 即在画布上方，看不见）`);
  console.log(`    音高 79 的 y = ${oldYs[1]}`);
  console.log(`    20 个旋律音里可见：${oldVis} 个`);
  check('旧实现确实会把 60~79 的旋律全部藏起来', oldVis === 0, `可见 ${oldVis}/20`);
  const oldRangeTop = OLD_HEIGHT / ROW_HEIGHT + OLD_MIN_PITCH; // 可见的最高音
  console.log(`    旧实现可见音域上限 ≈ ${oldRangeTop}（再高就画到画布外）`);
}

console.log('\n=== 2) 旧拖拽方向 ===');
{
  const dy = -10; // 鼠标向上拖 10px
  console.log(`    鼠标向上拖 ${dy}px：旧 dpitch=${oldDpitch(dy)}（音高下降 → 音块向下）`);
  check('旧实现方向确实是反的', oldDpitch(dy) < 0);
}

console.log('\n=== 3) 新实现：视口适配 ===');
for (const h of [320, 500, 700]) {
  const melody = Array.from({ length: 20 }, (_, i) => 60 + i);
  const scrollY = fitScrollY(melody, h);
  const ratio = visibleRatio(melody, scrollY, h);
  const yTop = newPitchToY(79, scrollY);
  const yBot = newPitchToY(60, scrollY);
  console.log(
    `    h=${h}px  scrollY=${scrollY.toFixed(0)}  音高79的y=${yTop.toFixed(0)}  音高60的y=${yBot.toFixed(0)}  可见率=${(ratio * 100).toFixed(0)}%`
  );
  check(`h=${h} 时 60~79 全部可见`, ratio === 1);
}

console.log('\n=== 4) 新实现：大跨度旋律（55~84）与全音域（21~108） ===');
{
  const mid = Array.from({ length: 30 }, (_, i) => 55 + i);
  const h = 500;
  const s = fitScrollY(mid, h);
  check('h=500 时 55~84 全部可见', visibleRatio(mid, s, h) === 1, `可见率=${(visibleRatio(mid, s, h) * 100).toFixed(0)}%`);
}
{
  // 88 键全覆盖 + 少量高音外点
  const wide = [21, 30, 45, 60, 61, 62, 63, 64, 65, 66, 67, 72, 84, 96, 108];
  const h = 500;
  const s = fitScrollY(wide, h);
  const ratio = visibleRatio(wide, s, h);
  console.log(`    全音域散布样本 可见率=${(ratio * 100).toFixed(0)}%（30 分钟内靠中位数定位）`);
  check('全音域时至少 60% 音符可见', ratio >= 0.6);
}

console.log('\n=== 5) 新拖拽方向 ===');
{
  check('鼠标向上拖 10px → dpitch=+1（音高升高）', newDpitch(-10) === 1, `dpitch=${newDpitch(-10)}`);
  check('鼠标向下拖 10px → dpitch=-1（音高降低）', newDpitch(10) === -1, `dpitch=${newDpitch(10)}`);
  check('向上拖 25px → dpitch=+3', newDpitch(-25) === 3, `dpitch=${newDpitch(-25)}`);
}

console.log('\n=== 6) 纵向滚动边界 ===');
{
  const h = 500;
  const max = maxScrollY(h);
  console.log(`    GRID_HEIGHT=${GRID_HEIGHT}px, h=${h}px, 最大 scrollY=${max}px（约 ${(GRID_HEIGHT / ROW_HEIGHT).toFixed(0)} 个半音行）`);
  check('scrollY 上限 = GRID_HEIGHT - h', max === GRID_HEIGHT - h);
  check('clamp 后不会出现负 scrollY', clamp(-100, 0, max) === 0);
  check('clamp 后不会超过上限', clamp(99999, 0, max) === max);
  // 全音域 A0 与 C8 都能滚到
  check('scrollY=0 时能看到 C8(108)', newVisible(108, 0, h));
  check('scrollY=max 时能看到 A0(21)', newVisible(21, max, h));
}

console.log('\n=== 7) 播放头与音块对齐（同一 tickToX 换算） ===');
{
  const KEY_WIDTH = 56;
  const zoom = 2; // 1px = 2 tick
  const scrollTick = 0;
  const tickToX = (t) => KEY_WIDTH + (t - scrollTick) / zoom;
  const ppq = 480;
  const bpm = 120;
  // 引擎：事件时间 = tickToSec(startTick)；播放头 sec = tick*60/(ppq*bpm) 的反算
  const tickToSec = (t) => (t / ppq) * (60 / bpm);
  const secToTick = (s) => (s * ppq * bpm) / 60;
  let ok = true;
  for (const t of [0, 480, 960, 1920, 7680]) {
    const sec = tickToSec(t);
    const back = secToTick(sec);
    if (Math.abs(back - t) > 1e-6) ok = false;
    if (Math.abs(tickToX(t) - (KEY_WIDTH + (back - scrollTick) / zoom)) > 1e-9) ok = false;
  }
  check('tickToSec / secToTick 往返一致，播放头 x 与音块 x 同源', ok);
  check('播放头 x 与音块起点 x 完全相等（对齐由构造保证）',
    tickToX(960) === KEY_WIDTH + (960 - scrollTick) / zoom,
    `x=${tickToX(960)}`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
