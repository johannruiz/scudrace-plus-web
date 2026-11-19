// Field clock for a hidden tab (Claude 2026-11-19, engine-host.js arm()).
// A hidden page that plays no sound gets its timers throttled by the browser
// (Chrome: about one wake-up per second), so its fields ran at ~2 Hz and a
// linked cabinet in another tab held every cabinet at the link boot. A
// dedicated worker's timers are not throttled: each request { id, ms } is
// answered with { id } after ms, and the page runs the field from that message.
onmessage = e => { const { id, ms } = e.data; setTimeout(() => postMessage(id), ms); };
