// Scud Race Plus web shell (Claude 2026-11-18; Daytona USA 2 Web's of
// 2026-11-11). The interface is Daytona USA Web's (same markup, styles and UI
// modules in css/ and d1/): ROM dropzone
// with local memory, Single player / Multiplayer, race setup, settings tabs
// (graphics, controller, keyboard, sound, racing wheel), touch controls,
// controller menu navigation and the pause menu. The engine is the WASM
// static recompilation, running on its own threads in a worker
// (engine-host.js, engine-worker.js) and drawn here with WebGPU; linked play
// uses the central link over WebRTC (central-link-net.js). Public rooms are
// disabled for now (user, 2026-11-18): private rooms by invitation only.
// The guest code never returns, so the engine starts once per page: changing
// the race setup or switching between single and linked play after starting
// reloads the page and continues where the player was (sessionStorage intent).
import { Daytona2Renderer } from './webgpu-renderer.js';
import { EngineHost, FIELD_MS, FIELD_MS_60 } from './engine-host.js';
import { CLIENT_VERSION, RELEASE_DATE } from './version.js';
import { AudioOutput } from './audio.js';
import { Controls } from './input.js';
import { createROMStore, createROMMemory } from './d1/rom-memory.js';
import { loadSettings, saveSettings } from './d1/preferences.js';
import { createKeyboardControls } from './d1/keyboard-controls.js';
import { createControllerControls } from './d1/controller-controls.js';
import { createGamepadRumble } from './d1/haptics.js';
import { startRumbleLog } from './rumble-log.js';
import { createWheelControls } from './d1/wheel-controls.js';
import { createTouchControls } from './d1/touch.js';
import { mountMenuGamepad } from './d1/menu-gamepad.js';
import { createGamepadHome } from './d1/gamepad-home.js';
import { protectTouchSurface } from './d1/touch-guard.js';
import { makeBackup, raceOptions, loadStored, saveStored } from './nvram.js';
import { CentralLinkNet } from './central-link-net.js';
import { PrivateRoom } from './room.js';
import { createRoomUI } from './room-ui.js';
import { mountGameChat } from './d1/game-chat.js';
import { mountHostConsole } from './host-console.js';
import { mountRaceStandings } from './race-standings.js';
import { createLobbySound } from './d1/lobby-sound.js';
import { createRoomArrivals } from './d1/room-arrivals.js';
import { createRoomSystemAlerts } from './d1/room-system-alerts.js';

const $ = id => document.getElementById(id);
// Footer version from version.js, the same one the rooms check (2026-11-18).
{ const el = $('buildVersion'), time = document.createElement('time'), [y, m, d] = RELEASE_DATE.split('-'); time.dateTime = RELEASE_DATE; time.textContent = `${d}.${m}.${y.slice(2)}`; el?.replaceChildren(`v${CLIENT_VERSION} · `, time); }
const html = document.documentElement;
const params = new URLSearchParams(location.search);
const BACKUP = '/save/cabinet.backup.bin', INTENT = 'scud-intent', RESUME = 'scud-room-resume', RACE_ID = 'scud-race-options-v1', DISPLAY_ID = 'scud-display-v1';
const storage = { getItem: k => { try { return localStorage.getItem(k); } catch { return null; } }, setItem: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const mobile = !!navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const settings = loadSettings(storage, { mobile });
const display = { mode: 'enhanced', scale: 1, motion: 'original', ...JSON.parse(storage.getItem(DISPLAY_ID) || '{}') };
if (params.get('scale')) display.scale = Number(params.get('scale')) || 1;   // tests: ?scale=0.5
if (params.get('smooth')) display.motion = params.get('smooth') === '1' ? 'smooth' : 'original';   // tests: ?smooth=1 / ?smooth=0
delete display.fps;   // the simulation rate is always shown (user, 2026-11-12)
const held = new Set();
let publicDirectory = null;
let outOfRace = false, preparing = false;   // preparing: the cabinet notice until the first field   // this cabinet left the linked race after stopping (outOfRaceCheck)
let gpuReady = false, probed = null;   // checkWebGPU (the renderer started while the page loads)
let host, renderer, engineReady, started = false, running = false, romReady = false, sessionKind = null, nvramName = 'cabinet';
// The arcade's own field rate, 57.524 Hz, by default (user, 2026-11-18: "as
// the original"; Daytona USA 2 Web runs 60). The fields follow the display in
// an exact ratio near that rate (engine-host.js, display lock: 23 fields every
// 24 refreshes at 60 Hz), so the cadence is a fixed pattern, never a drift.
// ?hz=60 (remembered for the tab) runs 60 fields/s in single play only;
// linked play always runs the arcade rate on every cabinet.
const fieldHz60 = (() => { try { const q = params.get('hz'); if (q) sessionStorage.setItem('scud-hz', q); return sessionStorage.getItem('scud-hz') === '60'; } catch { return false; } })();
const audio = new AudioOutput(), link = new CentralLinkNet();
const status = (t, ok = false) => { $('status').textContent = t; html.classList.toggle('ready', ok); };

// ---- input devices (Daytona USA Web modules) ------------------------------
const connectedDevices = () => { try { return [...(navigator.getGamepads?.() ?? [])].filter(p => p?.connected); } catch { return []; } };
const wheelControls = createWheelControls($('wheelControls'), { storage, getPads: connectedDevices });
// Controller vibration from the emulated arcade drive board (src/drive_board.c).
const rumble = createGamepadRumble(text => { $('rumbleStatus').textContent = text; });
const feedbackGamepad = () => wheelControls.feedbackPad() || navigationGamepad();
window.addEventListener('gamepaddisconnected', () => rumble.disconnect());
const controllerControls = createControllerControls($('controllerControls'), { storage, reservedIds: () => wheelControls.reservedIds(), wheelPad: () => wheelControls.feedbackPad() });
const keyboardControls = createKeyboardControls($('keyboardControls'), { held, storage, settings, mobile, onSetting: changeSetting });
if (mobile) $('inputTabLabel').textContent = 'Touch controls';
const touch = createTouchControls($('touchControls'), {
  isRunning: () => running && $('overlay').hidden,
  shift: amount => controls.shift(amount), menu: () => openMenu(), sound: () => toggleSound(),
  settings: () => { const p = $('touchControls').querySelector('.touch-service'); p.hidden = !p.hidden; },
});
const controls = new Controls({ keyboard: keyboardControls, controller: controllerControls, wheel: wheelControls, touch, settings,
  blocked: () => menuControls?.blocksGameplay(), onGear: g => { $('touchGear').textContent = g ? String(g) : 'N'; } });
protectTouchSurface(document.querySelector('.arcade'), { mobile });
html.classList.toggle('touch-device', navigator.maxTouchPoints > 0 || matchMedia('(any-pointer:coarse)').matches);

addEventListener('keydown', e => {
  if (e.code === 'Escape') {
    if (settingsOpen) { e.preventDefault(); if (controllerControls.cancel() || keyboardControls.cancel()) return; showMainMenu(); return; }
    if (started) { e.preventDefault(); $('overlay').hidden ? openMenu() : resumeGame(); return; }
  }
  if (!running || !$('overlay').hidden || !keyboardControls.uses(e.code) || e.ctrlKey || e.metaKey || e.altKey || ['INPUT', 'SELECT', 'BUTTON'].includes(e.target?.tagName)) return;
  e.preventDefault();
  const action = keyboardControls.action(e.code);
  if (!held.has(e.code)) {
    if (action === 'shiftDown' || action === 'shiftUp') controls.shift(action === 'shiftUp' ? 1 : -1);
    if (/^gear[1-4]$/.test(action || '')) controls.setGear(Number(action.at(-1)));
  }
  held.add(e.code);
});
addEventListener('keyup', e => held.delete(e.code));
addEventListener('blur', () => { held.clear(); keyboardControls.reset(); });

// ---- settings ---------------------------------------------------------------
let settingsOpen = false;
function applyDisplay() {
  storage.setItem(DISPLAY_ID, JSON.stringify(display));
  if (renderer) { renderer.classic = display.mode === 'classic'; renderer.widescreen = !renderer.classic; renderer.renderScale = display.scale; renderer.interp = display.motion === 'smooth'; }
  if (host) host.interp = display.motion === 'smooth';   // display interpolation (engine-host.js refreshLoop)
  $('graphicsSummary').textContent = (display.mode === 'classic' ? 'Classic · 496 × 384' : `Enhanced · Widescreen${display.scale < 1 ? ` · ${Math.round(display.scale * 100)}%` : ''}`) + (display.motion === 'smooth' ? ' · Smooth' : '');
  for (const r of document.querySelectorAll('[name="displayMode"]')) r.checked = r.value === display.mode;
  for (const r of document.querySelectorAll('[name="renderScale"]')) r.checked = Number(r.value) === display.scale;
  for (const r of document.querySelectorAll('[name="displayMotion"]')) r.checked = r.value === display.motion;
}
const SLIDERS = [['rumble', 'rumbleIntensity', 'rumbleValue'], ['volume', 'volumeIntensity', 'volumeValue'], ['uiVolume', 'uiVolumeIntensity', 'uiVolumeValue'], ['joystickSensitivity', 'joystickSensitivity', 'joystickSensitivityValue'], ['joystickDeadzone', 'joystickDeadzone', 'joystickDeadzoneValue']];
let uiGain = null;
function uiOutput() {   // interface sounds (lobby) have their own volume, as in Daytona USA Web
  const ctx = audio.context; if (!ctx) return null;
  if (!uiGain || uiGain.context !== ctx) { uiGain = ctx.createGain(); uiGain.connect(ctx.destination); }
  uiGain.gain.value = settings.uiVolume; return uiGain;
}
function syncSettings() {
  rumble.setIntensity(settings.vibrationEnabled ? settings.rumble : 0);
  for (const id of ['vibrationEnabled', 'settingsVibrationEnabled']) $(id).checked = settings.vibrationEnabled;
  for (const [key, input, output] of SLIDERS) {
    $(input).value = Math.round(settings[key] * 100);
    $(output).textContent = settings[key] === 0 && key !== 'joystickDeadzone' ? (['volume', 'uiVolume'].includes(key) ? 'Silent' : 'Off') : `${Math.round(settings[key] * 100)}%`;
    $(input).disabled = key === 'rumble' && !settings.vibrationEnabled;
  }
  audio.setVolume(settings.volume);
  if (uiGain) uiGain.gain.value = settings.uiVolume;
  keyboardControls.sync();
  $('touchControls').style.setProperty('--touch-button-scale', settings.touchButtonScale);
  $('touchControls').style.setProperty('--touch-steering-width', settings.touchSteeringWidth);
}
function changeSetting(key, value) { settings[key] = value; syncSettings(); saveSettings(storage, settings); }
for (const [key, id] of SLIDERS) $(id).addEventListener('input', e => changeSetting(key, Number(e.target.value) / 100));
for (const id of ['vibrationEnabled', 'settingsVibrationEnabled']) $(id).addEventListener('change', e => changeSetting('vibrationEnabled', e.target.checked));
for (const r of document.querySelectorAll('[name="displayMode"]')) r.addEventListener('change', e => { if (e.target.checked) { display.mode = e.target.value; applyDisplay(); } });
for (const r of document.querySelectorAll('[name="renderScale"]')) r.addEventListener('change', e => { if (e.target.checked) { display.scale = Number(e.target.value); applyDisplay(); } });
for (const r of document.querySelectorAll('[name="displayMotion"]')) r.addEventListener('change', e => { if (e.target.checked) { display.motion = e.target.value; applyDisplay(); } });
syncSettings(); applyDisplay();

const settingsTabs = [...document.querySelectorAll('#settingsModal > .settings-tabs [role="tab"]')];
function selectSettingsTab(tab, focus = false) {
  wheelControls.cancel(); controllerControls.cancel(); keyboardControls.cancel();
  for (const item of settingsTabs) { const on = item === tab; item.setAttribute('aria-selected', String(on)); item.tabIndex = on ? 0 : -1; $(item.getAttribute('aria-controls')).hidden = !on; }
  if (focus) tab.focus();
}
for (const tab of settingsTabs) {
  tab.addEventListener('click', () => selectSettingsTab(tab));
  tab.addEventListener('keydown', e => {
    const i = settingsTabs.indexOf(tab), n = settingsTabs.length;
    const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (next !== null) { e.preventDefault(); selectSettingsTab(settingsTabs[next], true); }
  });
}
function showMainMenu(focus = true) {
  wheelControls.cancel(); controllerControls.cancel(); keyboardControls.cancel();
  settingsOpen = false; $('mainMenu').hidden = false; $('settingsModal').hidden = true; $('overlay').scrollTop = 0;
  if (focus) $('settingsBtn').focus();
}
$('settingsBtn').addEventListener('click', () => {
  settingsOpen = true; $('mainMenu').hidden = true; $('settingsModal').hidden = false; $('overlay').scrollTop = 0;
  settingsTabs.find(t => t.getAttribute('aria-selected') === 'true').focus();
});
$('settingsBack').addEventListener('click', () => showMainMenu());
// Device lists, assignment and live meters also refresh while paused (no fields run then).
setInterval(() => {
  const visible = settingsOpen && !$('overlay').hidden;
  wheelControls.update(connectedDevices(), performance.now(), visible && !$('experimentalPanel').hidden);

  const now = performance.now(), devices = connectedDevices();
  controllerControls.update(devices, now, visible && !$('controllerPanel').hidden, settings.joystickSensitivity, settings.joystickDeadzone);
  keyboardControls.update(now, visible && !$('inputPanel').hidden);
  menuControls?.update(now); gamepadHome.update();
}, 33);

// ---- menu views (Daytona USA Web launcher) -----------------------------------
// Views: 'rom' (choose the ZIP), 'modes' (Single / Multiplayer), 'single',
// 'entry' (create / join a room) and 'room' (the starting grid).
const utilities = document.querySelector('.menu-quick-controls'), utilitiesHome = utilities.parentElement;
function view(name) {
  if (!gpuReady && (name === 'single' || name === 'entry' || name === 'room')) { $('errorNotice').hidden = !errorShown; return; }   // no play without a working renderer
  publicDirectory?.setBrowsing(name === 'entry');
  const panel = name === 'single' || name === 'entry' || name === 'room';
  $('dropzone').hidden = name !== 'rom'; $('playerModes').hidden = name !== 'modes';
  $('singlePlayerPanel').hidden = name !== 'single'; $('multiplayerEntry').hidden = name !== 'entry'; $('roomPanel').hidden = name !== 'room';
  for (const el of [$('romMeta'), document.querySelector('.launch-options'), document.querySelector('.first-run'), $('message')]) el.hidden = panel;
  $('menuDialog').classList.toggle('mp-view', panel);
  // The quick controls (vibration, Settings) move to the room header, as in Daytona USA Web.
  const linked = name === 'entry' || name === 'room';
  $('mpUtilities').hidden = !linked;
  (linked ? $('mpUtilities') : utilitiesHome).append(utilities);
  document.querySelector('.controls-guide').hidden = panel;
  $('overlay').scrollTop = 0;
}
function openMenu() {
  if (!started) return;
  // Linked play never pauses (as Daytona USA Web): the other cabinets keep
  // racing and wait for this one's records, so only the controls are released.
  $('overlay').hidden = false; html.classList.add('launcher-open'); if (sessionKind !== 'link') host.setPaused(true); rumble.stop(); controls.enabled = false; controls.clear(); held.clear();
  $('closeBtn').hidden = false;
  view(sessionKind === 'link' ? 'room' : 'modes'); room.changed();
}
async function resumeGame() {
  if (!started || outOfRace) return;
  showMainMenu(false);
  $('overlay').hidden = true; html.classList.remove('launcher-open'); host.setPaused(false); controls.enabled = true;
  $('screen').focus({ preventScroll: true });
  try { await audio.start(); } catch {}
}
$('closeBtn').addEventListener('click', () => resumeGame());
$('menuBtn').addEventListener('click', () => openMenu());
$('fullscreenBtn').addEventListener('click', () => document.fullscreenElement ? document.exitFullscreen?.() : html.requestFullscreen?.());
// Sound buttons (corner and touch): the icon shows the state, as in Daytona USA Web (2026-11-12).
function updateSoundControls() {
  const label = audio.muted ? 'Unmute sound' : 'Mute sound';
  for (const b of [$('soundBtn'), $('touchControls').querySelector('[data-sound]')]) {
    if (!b) continue;
    b.setAttribute('aria-label', label); b.title = label; b.setAttribute('aria-pressed', String(audio.muted));
    b.textContent = audio.muted ? '♪̸' : '♫';
  }
}
function toggleSound() { audio.setMuted(!audio.muted); updateSoundControls(); }
$('soundBtn').addEventListener('click', toggleSound);
// In-game controls: shown while the pointer moves, hidden 2.2 s after (as Daytona USA Web).
let hudTimer;
function showHUD() { html.classList.add('hud-visible'); clearTimeout(hudTimer); hudTimer = setTimeout(() => html.classList.remove('hud-visible'), 2200); }
addEventListener('pointermove', showHUD); addEventListener('pointerdown', showHUD);
function navigationGamepad() { const s = controllerControls.getPad(); return s ? connectedDevices().find(p => p.index === s.index && p.id === s.id) || null : null; }
function menuBackLabel() {
  if (settingsOpen || !$('singlePlayerPanel').hidden || !$('multiplayerEntry').hidden) return 'Back';
  if (!$('roomPanel').hidden) return started ? 'Return to game' : 'Leave room';
  return started ? 'Resume' : null;
}
function gamepadBack() {
  if (settingsOpen) { showMainMenu(); return; }
  if (!$('singlePlayerPanel').hidden || !$('multiplayerEntry').hidden) { view('modes'); return; }
  if (started) void resumeGame();
}
const gamepadHome = createGamepadHome({ getPad: navigationGamepad, canOpen: () => started && $('overlay').hidden, open: openMenu });
const menuControls = mountMenuGamepad({ root: $('menuDialog'), hints: $('menuGamepadHints'), getPad: navigationGamepad, isOpen: () => !$('overlay').hidden,
  isCapturing: () => controllerControls.isListening?.() || wheelControls.isListening?.() || keyboardControls.isListening(), back: gamepadBack, backLabel: menuBackLabel });
html.classList.add('launcher-open');

// ---- engine and ROM --------------------------------------------------------
// Errors the player must see (user, 2026-11-19): without graphics acceleration
// the start just stayed black, and on an iPhone it stopped on the boot screen,
// with the reason only in the console. The first one stays on screen, with
// its technical detail for a report.
const GPU_HELP = 'Scud Race Plus draws with WebGPU, the browser’s access to your graphics card. Turn on hardware acceleration in your browser settings (Chrome and Edge: Settings → System), update the browser and the graphics driver, or try a current Chrome, Edge or Safari.';
let errorShown = false;
function showError(title, text, detail = '') {
  if (errorShown) { if (detail) console.error('[error]', title, detail); return; }
  errorShown = true;
  console.error('[error]', title, detail || text);
  preparing = false; $('restartNotice').hidden = true;
  $('errorTitle').textContent = title; $('errorText').textContent = text;
  const d = $('errorDetail'); d.textContent = detail ? `${String(detail).slice(0, 2000)}\nv${CLIENT_VERSION} · ${navigator.userAgent}` : ''; d.hidden = !detail;
  $('errorNotice').hidden = false; $('errorReload').focus({ preventScroll: true });
}
$('errorReload').addEventListener('click', () => location.reload());
$('errorClose').addEventListener('click', () => { $('errorNotice').hidden = true; });
const errorText = e => String(e?.message || e?.reason || e || 'unknown error');
// The page's own check before the ROM is chosen: no WebGPU, or no adapter (no graphics acceleration).
class GPUUnavailable extends Error {}
// The whole renderer starts here, while the page loads (user, 2026-11-19): a
// browser that cannot draw the game never reaches Single player or Multiplayer,
// so it cannot join a room and hold up the other drivers. The race uses it.
// gpuReady, probed: declared with the page state (view() reads them).
async function checkWebGPU() {
  if (!('gpu' in navigator)) throw new GPUUnavailable('This browser has no WebGPU.');
  let adapter = null; try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch (e) { throw new GPUUnavailable('WebGPU failed: ' + errorText(e)); }
  if (!adapter) throw new GPUUnavailable('WebGPU found no graphics adapter (graphics acceleration off or not supported).');
  try { probed = await Daytona2Renderer.create($('screen'), './shaders/', { gpuTilegen: !params.has('cputile') }); }
  catch (e) { throw new GPUUnavailable(errorText(e)); }
  watchGPU(probed);
  gpuReady = true;
}
function watchGPU(r) {
  r.device.addEventListener('uncapturederror', e => {
    const m = e.error?.message || String(e.error); console.error('[webgpu]', m);
    if (e.error?.constructor?.name === 'GPUOutOfMemoryError') showError('Out of graphics memory', 'The browser could not give the game enough graphics memory. Close other tabs and apps, then reload the page.', m);
    else showError('Graphics error', 'The graphics card reported an error, so the picture may be wrong or stopped. Reload the page; if it happens again, please report the text below.', m);
  });
  r.device.lost.then(info => {
    if (info.reason === 'destroyed' || host?.stopped) return;
    gpuReady = false;
    showError('The graphics card stopped', 'The browser stopped the game’s graphics (WebGPU device lost), often because it ran out of graphics memory. Close other tabs and apps, then reload the page.', info.message || info.reason || '');
  });
}
async function loadEngine() {
  await checkWebGPU();
  host = new EngineHost({ audio, input: controls, link, onField: h => onField(h) });
  host.onError = (kind, e) => kind === 'render'
    ? showError('Graphics error', 'Drawing the game failed, so the picture may be wrong or stopped. Reload the page; if it happens again, please report the text below.', errorText(e))
    : showError('The game stopped', 'The arcade engine stopped with an error. Reload the page; if it happens again, please report the text below.', errorText(e));
  if (fieldHz60) host.fieldMs = FIELD_MS_60;
  await host.load('./scudplus.js');
  host.backupSaved = bytes => saveStored(nvramName, bytes);   // the engine worker sends the saved file
  return host;
}
engineReady = loadEngine();
engineReady.then(() => status('Choose your ROM to start.')).catch(e => {
  status(e.message);
  if (e instanceof GPUUnavailable) showError('Your graphics card is not available', GPU_HELP, e.message);
  else showError('The game cannot start', 'The engine could not load in this browser.', e.message);
});
function romLoaded(text) {
  romReady = true; status(text, true);
  $('message').textContent = 'Your arcade is ready.'; $('fileLabel').textContent = 'Change ROM ZIP';
  view('modes'); $('singlePlayer').focus({ preventScroll: true });
  continueIntent();
}
async function importZip(file) {
  await engineReady;
  status('Checking ROM chips…');
  const r = await host.importROM(new Uint8Array(await file.arrayBuffer()));
  if (!r.ok) {
    status(r.code === 1 ? 'This is not a readable ZIP.' : r.code === 2 ? `Missing or modified chip: ${r.missing}. Scud Race Plus (scudplus) is required.` : 'ROM import failed.');
    return { ok: false, invalid: r.code === 1 || r.code === 2 };
  }
  $('romMeta').textContent = `${file.name} · Scud Race Plus · Verified chip by chip · Your file stays on this device.`;
  romLoaded('ROM verified.');
  return { ok: true };
}
// The Scud Race Plus ZIP is large: IndexedDB needs longer than the 5 s D1 default.
const romMemory = createROMMemory({ store: createROMStore({ timeoutMs: 60000 }), load: f => importZip(f), onBusy: b => { $('dropzone').classList.toggle('busy', b); }, onWarning: e => console.warn(e) });
$('romInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) { if (started) restartWith({ view: 'modes' }); else romMemory.select(f); } e.target.value = ''; });
$('dropzone').addEventListener('dragover', e => { e.preventDefault(); $('dropzone').classList.add('dragging'); });
$('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('dragging'));
$('dropzone').addEventListener('drop', e => { e.preventDefault(); $('dropzone').classList.remove('dragging'); const f = e.dataTransfer.files[0]; if (f && !started) romMemory.select(f); });
$('dropzone').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('romInput').click(); } });
$('changeROM').addEventListener('click', () => { if (started) { restartWith({ view: 'rom' }); return; } romReady = false; view('rom'); $('romInput').click(); });
// Development: ?devroms=1 loads prepared regions served by web/tools/serve.js.
async function devRoms() {
  await engineReady;
  for (const n of ['crom', 'banked_crom', 'vrom', 'audiocpu', 'samples', 'dsbz80_mpegcpu', 'dsbz80_mpeg']) {
    const r = await fetch(`./dev-roms/${n}.bin`); if (!r.ok) throw new Error('dev ROM missing: ' + n);
    let bytes = new Uint8Array(await r.arrayBuffer());
    // Banked CROM: only the 8 MB banks up to the last data, as the ZIP import keeps
    // (rom_import_web.c, 2026-11-19): 64 of 128 MB in Scud Race Plus.
    if (n === 'banked_crom') { const w = new Uint32Array(bytes.buffer); let e = w.length; while (e && !w[e - 1]) e--; bytes = bytes.subarray(0, Math.min(bytes.length, Math.ceil(e * 4 / 0x800000) * 0x800000)); }
    if (!await host.writeRegion(n, bytes)) throw new Error('dev ROM not accepted: ' + n);
  }
  romLoaded('Development ROM regions loaded.');
}
view('rom');
if (params.get('devroms')) devRoms().catch(e => { restartNotice(null); status(e.message); });
else engineReady.then(() => romMemory.restore()).catch(() => {}).finally(() => { if (!romReady) restartNotice(null); });

// A new race setup or a switch between single and linked play reloads the page.
let pageRestarting = false;   // a planned restart (restartWith): the room goes on
function restartWith(intent) { pageRestarting = true; try { sessionStorage.setItem(INTENT, JSON.stringify(intent)); } catch {} restartNotice(intent); requestSave(); setTimeout(() => { host?.stop(); setTimeout(() => location.reload(), 0); }, 150); }
const RESTART_TEXT = {
  room: ['MULTIPLAYER', 'Returning to the room', 'Restarting this cabinet. Your seat is kept.'],
  entry: ['MULTIPLAYER', 'Leaving the room', 'Restarting this cabinet.'],
  multiplayer: ['MULTIPLAYER', 'Opening multiplayer', 'Restarting this cabinet for linked play.'],
  'single-start': ['SINGLE PLAYER', 'Applying your race setup', 'Restarting this cabinet with the new settings. Saved scores stay.'],
  // While the engine starts, until its first field (user, 2026-11-12: as Daytona USA Web)
  'prepare-single': ['SINGLE PLAYER', 'Preparing cabinet…', ''],
  'prepare-link': ['MULTIPLAYER', 'Preparing linked cabinet…', ''],
};
function restartNotice(intent) {
  const n = $('restartNotice');
  if (!intent || intent.view === 'rom') { n.hidden = true; return; }
  const [eyebrow, title, text] = RESTART_TEXT[intent.from === 'single' ? 'multiplayer' : intent.view] || ['', 'Restarting the cabinet', 'One moment…'];
  const detail = intent.note || text;   // note: why the host returned everyone (room.checkDropReturn)
  $('restartEyebrow').textContent = eyebrow; $('restartTitle').textContent = title; $('restartText').textContent = detail; $('restartText').hidden = !detail; n.hidden = false;
}
// A restart in progress shows what is happening instead of the ROM screen while
// the engine and the stored ROM load again (closed in continueIntent).
try { restartNotice(JSON.parse(sessionStorage.getItem(INTENT) || 'null')); } catch {}
function continueIntent() {
  let intent = null; try { intent = JSON.parse(sessionStorage.getItem(INTENT) || 'null'); sessionStorage.removeItem(INTENT); } catch {}
  if (intent?.view === 'room' && intent.closed) { view('room'); room.fail(intent.note || 'The host closed the room.'); restartNotice(null); return; }
  if (intent?.view === 'room') { void resumeRoom().then(ok => { if (!ok) view('entry'); restartNotice(null); }); return; }
  if (intent?.view !== 'single-start') restartNotice(null);
  if (!intent) return;
  if (intent.view === 'single-start') void startSingle().catch(() => restartNotice(null));   // else closed by the first field
  else if (intent.view) { view(intent.view); if (intent.view === 'rom') $('romInput').click(); }
}

async function startEngine({ backup, env = {} }) {
  if (started) return;
  if (!gpuReady) { $('errorNotice').hidden = !errorShown; return; }   // never without a working renderer (checkWebGPU)
  started = running = true;
  // A restart notice already up (Applying your race setup…) stays; else the short preparing one
  preparing = true; if ($('restartNotice').hidden) restartNotice({ view: sessionKind === 'link' ? 'prepare-link' : 'prepare-single' });
  $('overlay').hidden = true; html.classList.remove('launcher-open'); html.classList.add('playing');
  try { await audio.start(); } catch (e) { console.warn('[audio]', e); }
  $('soundBtn').disabled = false; updateSoundControls();
  const cpuTile = params.has('cputile');   // debug: 2D layers composed in WASM instead of WebGPU compute
  try { renderer = probed || await Daytona2Renderer.create($('screen'), './shaders/', { gpuTilegen: !cpuTile }); if (!probed) watchGPU(renderer); }
  catch (e) { preparing = false; restartNotice(null); showError('The graphics card could not start', GPU_HELP, errorText(e)); throw e; }
  host.renderer = renderer;
  applyDisplay();
  host.unpaced = params.has('unpaced'); host.burst = Number(params.get('burst') || 1);   // benchmark: run fields back to back
  if (params.has('noaudio')) audio.setMuted(true);
  if (params.has('norender')) host.renderer = null;
  window.__d2 = window.__scud = { host, renderer, controls, room, audio };   // debugging aid (the D2 test tools read __d2)
  await host.writeFile(BACKUP, backup);
  // ?devroms=1&denv=NAME=VALUE,... : extra engine variables for local diagnostics only.
  const devEnv = params.has('devroms') && params.get('denv') ? Object.fromEntries(params.get('denv').split(',').map(kv => kv.split('=')).filter(kv => /^(DAYTO|M3)_[A-Z0-9_]+$/.test(kv[0]))) : {};
  host.start({ M3_BACKUP: BACKUP, ...env, ...devEnv, ...(params.get('profile') ? { DAYTO_VIDEO_PROFILE: '1' } : {}), ...(cpuTile ? { DAYTO_WEB_CPU_TILEGEN: '1' } : {}), ...(params.get('motion') ? { DAYTO_MOTION_TRACKING: '1' } : {}), ...(params.get('xform') === '0' ? { DAYTO_GPU_XFORM: '0' } : {}), DAYTO_WEB_INTERP: params.get('interp') === '0' ? '0' : '1', ...(fieldHz60 && sessionKind !== 'link' ? { M3_SOUND_FIELD_US: '16667' } : {}), ...(/^\d+$/.test(params.get('ppc') || '') ? { M3_PPC_MHZ: params.get('ppc') } : {}) });   // ?ppc=66: the guest CPU speed (tests; main_web.c, default 100)
  setInterval(requestSave, 30000);
  // No new field for 12 s while the game should run (single play, page visible,
  // not paused): the cabinet stopped without saying why (the iPhone's boot
  // screen, 2026-11-19). Linked play waits for the others, so it is left out.
  // The 12 s count only while this check itself runs on time: a hidden tab, a
  // frozen page or a sleeping computer stop its timer too, so a late tick (over
  // 4 s for a 2 s timer) or a page shown again starts the count afresh (user,
  // 2026-11-19: no false alarm on returning to the tab).
  let active = performance.now(), lastTick = active, stallShown = false;
  const restartCount = () => { active = lastTick = performance.now(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) restartCount(); });
  addEventListener('resume', restartCount); addEventListener('pageshow', restartCount);
  setInterval(() => {
    const now = performance.now(), late = now - lastTick > 4000; lastTick = now;
    if (late || host.stopped || host.exited || host.paused || document.hidden || sessionKind !== 'single') { active = now; return; }
    const last = Math.max(host.lastPresent || 0, active), stalled = now - last;
    if (stalled < 12000 || stallShown) return;
    stallShown = true;
    showError('The game stopped responding', `No new picture from the arcade engine for ${Math.round(stalled / 1000)} s. Reload the page; if it happens again, please report the text below.`,
      `fields ${host.fields || 0}, engine field ${host.ctl?.[8] ?? '?'}, engine ${(host.engineMs || 0).toFixed(1)} ms/field, waiting ${!!host.waiter}, in flight ${!!host.inFlight}`);
  }, 2000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) requestSave(); });
  // As Daytona USA Web's pause notice: a hidden tab slows this cabinet while the
  // others keep racing (the link never waits for it), so say so on return.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = performance.now(); return; }
    if (sessionKind === 'link' && started && hiddenAt && performance.now() - hiddenAt > 2000) {
      const n = $('networkStatus'); n.textContent = 'Your browser paused this tab. Your car stopped while the other drivers kept racing.'; n.hidden = false;
      clearTimeout(n.hideTimer); n.hideTimer = setTimeout(() => { n.hidden = true; }, 7000);
    }
    hiddenAt = 0;
  });
  addEventListener('pagehide', requestSave);
  addEventListener('pagehide', e => { if (!e.persisted) host?.stop(); });   // reload or close: free the engine (EngineHost.stop)
}
// Saves happen inside the engine at the next field boundary (the worker then sends the file).
function requestSave() { if (host?.module?.daytonaHost && started) host.module.daytonaHost.saveRequested = true; }
let fpsTick = 0; const drawMarks = [];
// ?rumblelog: diagnostic log of controller vibration (rumble-log.js, local diagnostic server only).
const rumbleLogOn = (() => { try { if (new URLSearchParams(location.search).has('rumblelog')) sessionStorage.setItem('scud-rumblelog', '1'); return sessionStorage.getItem('scud-rumblelog') === '1'; } catch { return false; } })();
const rumbleLog = rumbleLogOn
  ? startRumbleLog({ getModule: () => host?.module, getInput: () => controls.current, menuOpen: () => !$('overlay').hidden }) : null;
function onField(h) {
  if (preparing) { preparing = false; restartNotice(null); }
  rumbleLog?.();
  if (++fpsTick % 30 === 0) {
    $('fps').textContent = h.fps().toFixed(1);   // game fields per second
    // Frames actually drawn per second (vsync + direct), below the field rate (user, 2026-11-12)
    const now = performance.now(), draws = h.vsyncDraws + h.directDraws;
    drawMarks.push({ t: now, draws }); if (drawMarks.length > 5) drawMarks.shift();   // over the last ~2 s
    const m = drawMarks[0]; if (now - m.t > 100) $('drawFps').textContent = ((draws - m.draws) * 1000 / (now - m.t)).toFixed(1);
  }
  const M = h.module;
  if (M._dayto_web_rumble_strong && document.hasFocus() && !document.hidden && $('overlay').hidden)
    rumble.update(feedbackGamepad(), M._dayto_web_rumble_strong(), M._dayto_web_rumble_weak(), performance.now());
  else rumble.stop();
}

// ---- single player (race setup = Scud's game options, src/game_options.c) --
// Secret cars and reverse course are engine options (DAYTO_SECRET_CARS,
// DAYTO_REVERSE), not EEPROM bytes; the cabinet's TEST menu stays the game's.
const RACE_FIELDS = { secretCars: 'singleSecretCars', reverse: 'singleReverse' };
let appliedRace = null;
async function storedRace() {
  let saved = null; try { saved = JSON.parse(storage.getItem(RACE_ID) || 'null'); } catch {}
  return { ...raceOptions(), ...(saved || {}) };
}
const raceEnv = race => ({ DAYTO_SECRET_CARS: race.secretCars ? '1' : '0', DAYTO_REVERSE: race.reverse ? '1' : '0' });
function formRace() { const r = {}; for (const [k, id] of Object.entries(RACE_FIELDS)) r[k] = Number($(id).value); return r; }
const sameRace = (a, b) => !!a && !!b && Object.keys(RACE_FIELDS).every(k => a[k] === b[k]);
function updateSingleLabel() { $('singleStartLabel').textContent = started && sessionKind === 'single' ? (sameRace(formRace(), appliedRace) ? 'RESUME ARCADE' : 'APPLY & RESTART') : 'ENTER ARCADE'; updateSingleHint(); }
// As Daytona USA Web: back in the race setup with the game paused, unchanged
// settings resume it; changed ones restart the cabinet (saved scores stay).
const SINGLE_HINT = $('singleSessionHint').textContent;
function updateSingleHint() {
  const live = started && sessionKind === 'single', same = live && sameRace(formRace(), appliedRace);
  $('singleSessionHint').textContent = same ? 'Your current session is paused and ready to resume.' : live ? 'New settings restart this cabinet. Saved scores stay.' : SINGLE_HINT;
}
$('singleRaceForm').addEventListener('change', updateSingleLabel);
$('singlePlayer').addEventListener('click', async () => {
  const r = appliedRace || await storedRace(); for (const [k, id] of Object.entries(RACE_FIELDS)) $(id).value = String(r[k]);
  view('single'); updateSingleLabel(); $('singleSecretCars').focus();
});
$('singleBack').addEventListener('click', () => view('modes'));
$('singleRaceForm').addEventListener('submit', e => {
  e.preventDefault();
  const race = formRace(); storage.setItem(RACE_ID, JSON.stringify(race));
  if (started) { if (sessionKind === 'single' && sameRace(race, appliedRace)) void resumeGame(); else restartWith({ view: 'single-start' }); return; }
  void startSingle();
});
async function startSingle() {
  const race = await storedRace(); appliedRace = race; sessionKind = 'single'; nvramName = 'cabinet';
  await startEngine({ backup: makeBackup(await loadStored('cabinet'), { link: 0 }), env: raceEnv(race) });
}

// ---- multiplayer: private rooms (room.js, room-ui.js, Daytona USA Web chat) ----
// The host cabinet is the room authority and the central link MASTER (node 0).
const lobbySound = createLobbySound({ context: () => audio.context, output: uiOutput, muted: () => audio.muted || settings.uiVolume === 0 });
$('previewUISound').addEventListener('click', async () => { try { await audio.start(); } catch {} lobbySound('confirmed'); });
// Room notices for every cabinet (user, 2026-11-12, as Daytona USA Web):
// d1/room-arrivals.js reads the room snapshots; each arrival, request (host),
// departure or stalled driver shows in the lobby footer or as the race toast,
// plays its lobby sound and, while this page is in the background, raises a
// system notification (d1/room-system-alerts.js, room-alerts-sw.js).
const roomAlerts = createRoomSystemAlerts({ onClick: () => { openMenu(); if (room.phase === 'lobby' && !$('pendingJump').hidden) $('pendingJump').click(); } });
const roomArrivals = createRoomArrivals({ notify: e => {
  roomUI?.announce(e);
  lobbySound(e.kind === 'request' ? 'request' : e.kind === 'left' || e.kind === 'stalled' ? 'departure' : 'arrival');
  void roomAlerts.show(e);
} });
const room = new PrivateRoom(link, {
  onChange: state => { publicDirectory?.updateHost(state); roomAlerts.sync(state); roomUI?.render(state); roomArrivals.update(state); gameChat?.sync(state); hostConsole?.render(state); linkLostNotice(state); outOfRaceCheck(state); },
  onEvent: event => roomUI?.event(event),
  onStart: session => void startLinked(session),
  // The host returned everyone to the room: every cabinet restarts its page
  // (one engine per page) and comes back into the same room and seat.
  onStop: (_, note) => backToRoom(note),
  onHostLost: info => hostLost(info),
  // Game phase for the room's drop rule (room.checkDropReturn, linked games only).
  gamePhase: () => (started && sessionKind === 'link' && host?.module?._dayto_web_link_phase?.()) || 0,
});
// The host cabinet (link master) left during a linked game: say so over the
// game, not only in the room menu, and keep it shown (the race cannot finish).
// This cabinet stopped responding during the linked game and the race went on
// without it (room.checkStalled): its own race would resume where it froze, so
// it stops here and waits in the room until the host returns everyone to it.
function outOfRaceCheck(state) {
  if (outOfRace || sessionKind !== 'link' || !started || state.phase !== 'playing') return;
  if (state.members.find(m => m.id === state.id)?.connection !== 'stalled') return;
  outOfRace = true; console.warn('[room] this cabinet stopped responding: out of this race, waiting in the room');
  openMenu(); host.setPaused(true); $('closeBtn').hidden = true;
}
function linkLostNotice(state) {
  if (sessionKind !== 'link' || !started || state.phase !== 'error' || !state.error) return;
  const n = $('networkStatus'); if (n.textContent === state.error && !n.hidden) return;
  clearTimeout(n.hideTimer); n.textContent = state.error; n.hidden = false;
}
// The host left a linked game (user, 2026-11-14): this guest leaves the race,
// which cannot go on, for the room. If the host closed the room the room view
// says so; otherwise the guest tries to rejoin for 30 s (resumeRoom), in case
// the host cabinet comes back with the room, and else says the host left.
function hostLost({ closed, resume }) {
  if (!started || sessionKind !== 'link' || pageRestarting) return;   // already going back to the room (stop)
  roomArrivals.mute();
  if (!closed && resume) {
    try { sessionStorage.setItem(RESUME, JSON.stringify({ ...resume, retry: true })); } catch {}
    restartWith({ view: 'room', note: 'The host cabinet left the race. Waiting for the room to reopen…' });
  } else restartWith({ view: 'room', closed: true, note: 'The host closed the room.' });
}
// The host closes the room when its page goes away outside a planned restart
// (tab closed, F5, navigation), so the guests leave the game at once.
addEventListener('pagehide', e => { if (!e.persisted && !pageRestarting && room.isHost) room.leave(); });
function backToRoom(note = '') {
  roomArrivals.mute();   // the other cabinets restart too: their departures are not news
  const resume = room.resumeState(); if (!resume) { restartWith({ view: 'entry' }); return; }
  try { sessionStorage.setItem(RESUME, JSON.stringify(resume)); } catch {}
  try { link.peer?.destroy(); } catch {}
  restartWith({ view: 'room', ...(note ? { note } : {}) });
}
// After a restart: reopen the room (host) or go back to the same seat (guest).
// After the host left a race (hostLost): rejoin attempts for 30 s, the restart notice kept up meanwhile.
async function rejoinRoom(r) {
  restartNotice({ view: 'room', note: 'Waiting for the host to reopen the room…' });
  const until = Date.now() + 30000;
  for (;;) {
    try { await room.join(r.code, r.name, r.token); } catch {}
    const phase = await new Promise(res => { const t0 = Date.now(), poll = setInterval(() => { if (room.phase !== 'connecting' || Date.now() - t0 > 20000) { clearInterval(poll); res(room.phase); } }, 200); });
    if (phase !== 'error' && phase !== 'connecting') return;
    if (Date.now() >= until) { room.leave(); room.fail('The host cabinet left the race and did not reopen the room.'); return; }
    await new Promise(res => setTimeout(res, 3000));
  }
}
async function resumeRoom() {
  let r = null; try { r = JSON.parse(sessionStorage.getItem(RESUME) || 'null'); sessionStorage.removeItem(RESUME); } catch {}
  if (!r || Date.now() - r.at > 120000) return false;
  view('room'); restartNotice(null);
  try {
    if (r.role === 'host') await room.create(r.name, { restore: r });
    else { await new Promise(res => setTimeout(res, 2500)); if (r.retry) await rejoinRoom(r); else await room.join(r.code, r.name, r.token); }
    history.replaceState(history.state, '', location.pathname + location.search + '#room=' + room.code);
  } catch (e) { console.warn('[room] resume failed', e); }
  return true;
}
window.__d2room = room;   // debugging aid (automated lobby tests)
room.health = () => ({ hz: started && host?.fps ? host.fps() : null, visible: !document.hidden });
const standings = mountRaceStandings($('raceStandings'));
// The standings stay from the start until the cabinet is back in attract
// (user, 2026-11-14): link.racing ends as this car crosses the line (byte 211),
// so the results after it follow the game phase (byte 4 >= 129: race, results;
// byte 19 = 0: attract). Checked twice a second, as no order comes after FINAL.
const standingsShown = () => {
  if (sessionKind !== 'link') return false;
  if (link.racing) return true;
  const p = (started && host?.module?._dayto_web_link_phase?.()) >>> 0;
  return !!(p & 0x1000000) && (p >>> 16 & 255) !== 0 && (p & 255) >= 129;
};
room.onOrder = order => standings.update(order, room.members, standingsShown());
setInterval(() => { if (sessionKind === 'link') standings.update(room.order, room.members, standingsShown()); }, 500);
const hostConsole = mountHostConsole(room, { link, open: () => { $('mainMenu').hidden = true; $('overlay').scrollTop = 0; }, close: () => { $('mainMenu').hidden = false; } });
const unlockAudio = async () => { try { await audio.start(); } catch {} };
// Sound blocked by the autoplay policy (a linked race started from the network) starts at the next key or click.
for (const type of ['pointerdown', 'keydown']) addEventListener(type, () => { if (audio.context?.state === 'suspended') audio.context.resume().catch(() => {}); }, { capture: true, passive: true });
// Public rooms (the Firebase directory) are disabled for now (user, 2026-11-18): publicDirectory stays null.
const roomUI = createRoomUI(room, { show: view, gameRunning: () => started && sessionKind === 'link', unlockAudio, sound: kind => lobbySound(kind), onEntry: () => void roomAlerts.enable() });
const gameChat = mountGameChat($('gameChat'), { room, storage, gameShown: () => started && running && $('overlay').hidden,
  notify: () => lobbySound('chat'), onRead: () => roomUI.markChatRead(), onTyping: () => { held.clear(); keyboardControls.reset(); },
  returnFocus: () => $('screen').focus({ preventScroll: true }) });
gameChat.sync(room.snapshot()); setInterval(() => gameChat.update(), 250);
$('multiplayerPlayer').addEventListener('click', () => {
  if (started && sessionKind !== 'link') { restartWith({ view: 'entry', from: 'single' }); return; }
  view(room.occupied ? 'room' : 'entry'); (room.occupied ? $('readyRoom') : $('driverName')).focus();
});
$('modeBack').addEventListener('click', () => view('modes'));
// The room starts with the host's own race setup; the grid shares it.
$('createRoom').addEventListener('click', () => { const wait = setInterval(async () => { if (room.phase === 'lobby' && room.isHost) { clearInterval(wait); room.setSettings(await storedRace()); } else if (room.phase !== 'connecting') clearInterval(wait); }, 100); });
$('leaveRoom').addEventListener('click', () => {
  if (started && sessionKind === 'link') { room.leave(); history.replaceState(history.state, '', location.pathname + location.search); restartWith({ view: 'entry' }); return; }
  room.leave(); history.replaceState(history.state, '', location.pathname + location.search); view('entry');
});
$('returnRoomGame').addEventListener('click', () => resumeGame());
$('stopRoom').addEventListener('click', () => room.stopRace());   // no browser confirmation (user, 2026-11-13)
if (new URLSearchParams(location.hash.slice(1)).get('room')) $('joinCode').dispatchEvent(new Event('input'));
async function startLinked({ nodes, node, car, race }) {
  sessionKind = 'link'; nvramName = 'cabinet-link';
  const previous = await loadStored('cabinet-link') || await loadStored('cabinet');
  const backup = makeBackup(previous, { link: node === 0 ? 1 : 2, car: car || node + 1 });
  $('networkStatus').hidden = false; $('networkStatus').textContent = `Linked · car ${car || node + 1} · ${nodes} cabinets`;
  setTimeout(() => { $('networkStatus').hidden = true; }, 6000);
  // Linked play runs the arcade rate on every cabinet (user, 2026-11-18), even
  // after ?hz=60: the link's playout clock and prediction count in the
  // remote cabinets' fields, 17385 us (at an assumed 60 the arrival offset
  // grew 41 ms/s and read as jitter, D2 2026-11-13).
  host.fieldMs = FIELD_MS;
  // The engine busy-waits the whole gap between fields in linked play
  // (2026-11-18): two cabinets on this laptop with the short wait (10 ms, the
  // single-play default) showed 1-2 irregular gaps each in 150 s from slow
  // sound board fields, none with the full one. ?spin= still chooses.
  if (!params.has('spin')) host.spinMode = '1';
  const linkFieldUs = 17385;
  link.fieldHz = 1e6 / linkFieldUs;
  await startEngine({ backup, env: { DAYTO_CENTRAL_FIELD_US: String(linkFieldUs), DAYTO_CENTRAL_NAME: 'web', DAYTO_CENTRAL_NODES: String(nodes), DAYTO_CENTRAL_NODE: String(node), DAYTO_CENTRAL_DELAY: String(link.delay), DAYTO_CENTRAL_TIMEOUT_MS: '8000',
    // Asynchronous central link with remote-car playout (?link=lockstep restores the barrier).
    DAYTO_CENTRAL_ASYNC: params.get('link') === 'lockstep' ? '0' : '1', DAYTO_CENTRAL_PREDICT: params.get('predict') === '0' ? '0' : '1', DAYTO_CENTRAL_SMOOTH: params.get('smooth') === '0' ? '0' : '1', ...(params.has('gamelead') ? { DAYTO_CENTRAL_GAMELEAD: String(Math.round(Number(params.get('gamelead')) * 10) || 0) } : {}), ...(params.has('heading') ? { DAYTO_CENTRAL_HEADING: params.get('heading') === '0' ? '0' : '1' } : {}), ...(params.has('pipelead') ? { DAYTO_CENTRAL_PIPELEAD: String(Math.round(Number(params.get('pipelead')) * 10) | 0) } : {}), ...(params.has('inverse') ? { DAYTO_CENTRAL_INVERSE: params.get('inverse') === '0' ? '0' : '1' } : {}), ...(params.has('percar') ? { DAYTO_CENTRAL_PERCAR: params.get('percar') === '0' ? '0' : '1' } : {}), ...(params.has('snapjumps') ? { DAYTO_CENTRAL_SNAPJUMPS: params.get('snapjumps') === '1' ? '1' : '0' } : {}), ...(params.has('leadcap') ? { DAYTO_CENTRAL_LEADCAP: String(Number(params.get('leadcap')) | 0) } : {}), ...(params.has('leaddown') ? { DAYTO_CENTRAL_LEADDOWN: String(Math.round(Number(params.get('leaddown')) * 100) | 0) } : {}), ...(params.has('leadrate') ? { DAYTO_CENTRAL_LEADRATE: String(Math.round(Number(params.get('leadrate')) * 100) | 0) } : {}),
    // Room options: every cabinet runs the host's game options.
    ...raceEnv(race) } });
  room.changed();
}
