// Cabinet backup (SRAM + 93C46 EEPROM) for Scud Race Plus web (Claude
// 2026-11-18; Daytona USA 2 Web's of 2026-11-11). File layout as src/backup.c:
// 131072 bytes SRAM, then 64 little-endian EEPROM words. The EEPROM image
// (big-endian view) follows the original Model 3 format: "M3SEGA", CRC-CCITT
// of the 58-byte payload at 6..7, payload at 12..69 duplicated at 70..127.
// Payload bytes found by diffing the link cabinets' profiles (build/link):
//   30 = LINK ID (0 single, 1 master, 2 slave), 31 = car number - 1.
// Default image: the project's single-cabinet profile.
const DEFAULT_EEPROM = '4d33534547412604a218010500040001ffffff01010100010200000000000000010101008080030004030403060000000000000000000000000000000000000000000000000000040001ffffff010101000102000000000000000101010080800300040304030600000000000000000000000000000000000000000000000000';
export const SRAM_SIZE = 131072, BACKUP_SIZE = SRAM_SIZE + 128;
const DB = 'scudplus-nvram-v1';

function crc(payload) {
  let c = 0;
  for (const b of payload) { c ^= b << 8; for (let k = 0; k < 8; k++) c = ((c << 1) ^ (c & 0x8000 ? 0x1021 : 0)) & 0xffff; }
  return c;
}
const hex = s => Uint8Array.from(s.match(/../g), h => parseInt(h, 16));
export function eepromFromBackup(backup) {
  if (!backup || backup.length !== BACKUP_SIZE) return null;
  const big = new Uint8Array(128);
  for (let i = 0; i < 128; i++) big[i] = backup[SRAM_SIZE + (i ^ 1)];
  return String.fromCharCode(...big.subarray(0, 6)) === 'M3SEGA' ? big : null;
}
// Race options are Scud's game options (src/game_options.c: secret cars,
// reverse course), passed to the engine as variables, not EEPROM bytes.
export const RACE_OPTIONS = Object.freeze({ secretCars: { min: 0, max: 1 }, reverse: { min: 0, max: 1 } });
export function raceOptions() { return { secretCars: 0, reverse: 0 }; }
export function makeBackup(previous, { link = null, car = null } = {}) {
  const out = new Uint8Array(BACKUP_SIZE);
  if (previous && previous.length === BACKUP_SIZE) out.set(previous.subarray(0, SRAM_SIZE));
  const big = eepromFromBackup(previous) || hex(DEFAULT_EEPROM);
  const before = big.slice(12, 70);
  if (link !== null) big[30] = link;
  if (car !== null) big[31] = car - 1;
  if (big.subarray(12, 70).some((b, i) => b !== before[i])) {
    const generation = (((big[12] << 8) | big[13]) + 1) & 0xffff;   // as the original 07578
    big[12] = generation >> 8; big[13] = generation & 255;
    const c = crc(big.subarray(12, 70)); big[6] = c >> 8; big[7] = c & 255;
    big.copyWithin(70, 12, 70);
  }
  for (let i = 0; i < 128; i++) out[SRAM_SIZE + (i ^ 1)] = big[i];
  return out;
}
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('files', mode); let value;
      const req = fn(tx.objectStore('files')); req.onsuccess = () => { value = req.result; };
      tx.oncomplete = () => { db.close(); resolve(value); }; tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
export const loadStored = name => idb('readonly', s => s.get(name)).catch(() => null);
export const saveStored = (name, bytes) => idb('readwrite', s => s.put(bytes, name)).catch(e => console.warn('[nvram]', e));
