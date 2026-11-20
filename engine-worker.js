// Scud Race Plus engine worker (Claude 2026-11-18).
//
// The WASM engine (scudplus.js, Emscripten pthreads) runs here, in a dedicated
// Worker, never on the page's main thread. This worker is the module's main
// runtime thread; the sound board and the scene builder are its pthreads.
//
// Before main() starts the worker answers the page's messages (ROM import,
// files, the link's shared buffers). Once main() runs it never returns to its
// event loop: the engine waits between fields on a futex in shared memory
// (web/native/platform_web_target.c) that the page (engine-host.js) releases
// when the next field is due. From then on:
//   - engine -> page: postMessage (each packet, logs, saved backups, link sends);
//   - page -> engine: shared memory only (control block, input record, the
//     link's records), since no message reaches this worker any more.
// So no JSPI, and the engine's work never blocks the page.

let M = null, roms = null, link = null, started = false;
const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const log = text => post({ t: 'log', text: String(text) });
const heapMB = () => { try { return Math.round(M.wasmMemory.buffer.byteLength / 1048576); } catch { return '?'; } };
// The report abort_report.cpp left in shared memory (thread, uncaught C++
// exception, stack); read here because an abort on a pthread arrives proxied.
const abortReport = () => { let r = ''; try { r = M.UTF8ToString(M._dayto_web_abort_report()); } catch {} return r || `no report (heap ${heapMB()} MB)`; };

// ---- the CENTRAL LINK transport, engine side (src/comm_central.c, DAYTO_WEB) ----
// The page's CentralLinkNet (central-link-net.js) owns the WebRTC links and
// keeps every node's records, joined states and transit estimates in a
// SharedArrayBuffer (LINK layout, mirrored there). This side reads it
// directly; what the engine does (publish, join, link) goes to the page as
// messages. Its own records are also written here, so the engine reads its
// block back at once.
function makeLink(shared, layout) {
  const L = layout, head = new Int32Array(shared, 0, L.headWords), joined = new Int32Array(shared, L.joined, L.nodes);
  const pub = new Float64Array(shared, L.pub, L.nodes), transit = new Float64Array(shared, L.transit, L.nodes);
  const tags = new Float64Array(shared, L.tags, L.nodes * L.ring), blocks = new Uint8Array(shared, L.blocks, L.nodes * L.ring * L.slot);
  let self = 0;
  const lk = {
    open(nodes, node) { self = node; post({ t: 'link', op: 'open', nodes, node }); return Atomics.load(head, L.OPEN) === 1; },
    close() { Atomics.store(joined, self, 2); post({ t: 'link', op: 'close' }); },
    setJoined(state) { Atomics.store(joined, self, state); post({ t: 'link', op: 'joined', state }); },
    joined(j) { return Atomics.load(joined, j); },
    setLinked() { Atomics.store(head, L.LINKED, 1); post({ t: 'link', op: 'linked' }); },
    linked() { return Atomics.load(head, L.LINKED) === 1; },
    publish(seq, block) {
      const r = seq % L.ring; blocks.set(block.subarray(0, L.slot), (self * L.ring + r) * L.slot); tags[self * L.ring + r] = seq;
      if (seq + 1 > pub[self]) pub[self] = seq + 1;
      post({ t: 'link', op: 'publish', seq, block }, [block.buffer]);
    },
    published(j) { return pub[j]; },
    // Lockstep only: wait for node j's record `want` (0), or give up (1) when it
    // left or stayed silent for timeoutMs. The page bumps head[NOTIFY] on every
    // record and state change.
    wait(j, want, timeoutMs) {
      const end = performance.now() + timeoutMs;
      for (;;) {
        if (pub[j] > want) return 0;
        if (Atomics.load(joined, j) === 2) return 1;
        const left = end - performance.now(); if (left <= 0) return 1;
        const seen = Atomics.load(head, L.NOTIFY);
        if (pub[j] > want) return 0;
        Atomics.wait(head, L.NOTIFY, seen, Math.min(left, 50));
      }
    },
    fetch(j, want) { const r = want % L.ring; return tags[j * L.ring + r] === want ? blocks.subarray((j * L.ring + r) * L.slot, (j * L.ring + r + 1) * L.slot) : null; },
    transitFields(j) { return transit[j]; },
    set motionStats(v) { post({ t: 'link', op: 'stats', stats: v }); },
    set racing(on) { post({ t: 'link', op: 'racing', on: !!on }); },
    onRacing: null,
    poseLog: null,
  };
  return lk;
}

const daytonaHost = {
  // platform_present: a packet is ready in shared memory. The first one also
  // releases any /roms files (none by default since the regions go straight
  // into engine memory, 'alloc' below; only a test that writes them).
  present(packet, field) {
    if (roms !== null) { dropRomFiles(); roms = null; }
    post({ t: 'present', packet, field });
  },
  // backup_web.c saved the cabinet backup: hand the bytes to the page (IndexedDB).
  backupSaved(path) { try { const b = M.FS.readFile(path); post({ t: 'backup', path, bytes: b }, [b.buffer]); } catch (e) { log('[backup] ' + e); } },
  get link() { return link; },
};
function dropRomFiles() {
  let freed = 0;
  try { for (const n of M.FS.readdir('/roms')) if (n.endsWith('.bin')) { freed += M.FS.stat('/roms/' + n).size; M.FS.unlink('/roms/' + n); } } catch {}
  if (freed) log(`[engine] ROM files released: ${(freed / 1048576).toFixed(0)} MB`);
}
function mkdirs(path) { const parts = path.split('/').slice(1, -1); let p = ''; for (const s of parts) { p += '/' + s; try { M.FS.mkdir(p); } catch {} } }

self.onmessage = async e => {
  const d = e.data;
  try {
    if (d.t === 'init') {
      importScripts(d.script);
      M = await createScudEngine({
        noInitialRun: true,
        mainScriptUrlOrBlob: d.script,
        print: t => log(t), printErr: t => log(t),
        onExit: code => post({ t: 'exit', code }),
        // abort() arrives with no reason ("", 2026-11-19, iPhone): the reason is the
        // report abort_report.cpp wrote (thread, uncaught exception, stack).
        onAbort: what => post({ t: 'abort', what: (what === undefined || what === null || what === '' ? '' : String(what) + '; ') + abortReport() }),
        daytonaHost,
      });
      post({ t: 'ready', memory: M.wasmMemory, control: M._dayto_web_control_ptr(), input: M._dayto_web_input_ptr(), audio: M._dayto_web_audio_ring(), ram: M._dayto_web_ram_ptr(), cores: navigator.hardwareConcurrency || 0 });
    } else if (d.t === 'alloc') {
      // Memory (2026-11-18, as Daytona USA 2 Web): the page writes large data
      // (the ROM ZIP, dev ROM regions) straight into the engine's shared
      // memory. Nothing large ever becomes a JS object here: this worker never
      // returns to its event loop once main() runs, so its JS garbage is never
      // collected (the /roms files and the ZIP stayed for the whole session).
      post({ t: 'reply', id: d.id, value: M._malloc(d.size) });
    } else if (d.t === 'import') {
      // Each region is assembled in the block main() keeps (rom_import_web.c).
      const code = M._dayto_web_import_rom(d.ptr, d.size, 0);
      M._free(d.ptr);
      post({ t: 'reply', id: d.id, value: { ok: code === 0, code, missing: code === 2 ? M.UTF8ToString(M._dayto_web_import_missing()) : '' } });
    } else if (d.t === 'region') {
      const name = M.stringToNewUTF8(d.name), ok = M._dayto_web_set_region(name, d.ptr, d.size); M._free(name);
      post({ t: 'reply', id: d.id, value: !!ok });
    } else if (d.t === 'writeFile') {
      mkdirs(d.path); M.FS.writeFile(d.path, d.bytes); if (d.path.startsWith('/roms/')) roms = '/roms';
      if (d.id !== undefined) post({ t: 'reply', id: d.id, value: true });
    } else if (d.t === 'link') {
      link = makeLink(d.shared, d.layout);
    } else if (d.t === 'start') {
      if (started) return; started = true;
      // environ is built when the module starts: set variables through libc so getenv() sees them.
      for (const [k, v] of Object.entries(d.env)) { const a = M.stringToNewUTF8(k), b = M.stringToNewUTF8(String(v)); M._setenv(a, b, 1); M._free(a); M._free(b); }
      post({ t: 'started' });
      M.callMain([]);   // returns only when the engine exits
    }
  } catch (err) {
    if (err && err.name === 'ExitStatus') { post({ t: 'exit', code: err.status }); return; }
    if (err === 'unwind') return;
    post({ t: 'error', message: String(err && err.stack || err) });
  }
};
