/* =========================================================================
   Rosny DDT Command Centre — application logic
   Vanilla JS, no build step, no external requests. Data lives in
   localStorage (auto) + optional JSON export/import for backup/sync.
   ========================================================================= */

const STORAGE_KEY = "rc_ddt_command_centre_v1";

// Safe to publish — this is the "publishable" key, meant for client-side use
// and gated by Row Level Security on the Supabase side. It cannot read or
// write anything without also knowing the passphrase-derived row/key below,
// and even then only gets an encrypted blob it cannot decrypt on its own.
const SUPABASE_URL = "https://dnmxkfdgdzkzfegfnzbq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_4PpEPhWb87XZX6xHLgj_gA_L0FirFwB";
const DAY_ORDER = ["monday","tuesday","wednesday","thursday","friday"];
const DAY_LABEL = { monday:"Monday", tuesday:"Tuesday", wednesday:"Wednesday", thursday:"Thursday", friday:"Friday" };

function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function todayISO(d = new Date()){ const p=n=>String(n).padStart(2,"0"); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; }
function fmtDateLong(iso){
  if(!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-AU", { weekday:"long", day:"numeric", month:"long", year:"numeric" });
}
function fmtDateShort(iso){
  if(!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-AU", { weekday:"short", day:"numeric", month:"short" });
}
function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function formatBytes(n){
  if(n < 1024) return n + " B";
  if(n < 1024*1024) return (n/1024).toFixed(0) + " KB";
  return (n/(1024*1024)).toFixed(1) + " MB";
}
function dayKeyFromISO(iso){
  const d = new Date(iso + "T00:00:00");
  return DAY_ORDER[d.getDay()-1] || null; // Sun=0 -> undefined -> null
}

/** Mon-Fri ISO dates for the school week containing today -- used by the
 * Dashboard's "This week at a glance" and "Print week's coverage". */
function currentWeekDates(){
  const t = new Date(todayISO() + "T00:00:00");
  const monday = new Date(t);
  monday.setDate(t.getDate() - ((t.getDay() + 6) % 7)); // getDay(): Sun=0..Sat=6 -> days since Monday
  return [0,1,2,3,4].map(i => { const d = new Date(monday); d.setDate(monday.getDate()+i); return todayISO(d); });
}

/* ---------------------------------------------------------------------- */
/* Default seed data                                                      */
/* ---------------------------------------------------------------------- */
function defaultState(){
  // Real names/phone numbers/emails live only in local-seed.js, which is
  // gitignored and never published — see that file's header comment. On a
  // published copy (e.g. GitHub Pages) that file simply doesn't exist, so
  // LOCAL_SEED is undefined and the app starts with an empty team/pool.
  const seed = window.LOCAL_SEED || { teacherNames: [], taNames: [], externalPool: [], classGrid: [], taGrid: [] };
  const teachers = seed.teacherNames.map(name => ({ id: uid(), name, role: "Teacher" }));
  const tas = seed.taNames.map(name => ({ id: uid(), name, role: "TA" }));
  const externalPool = seed.externalPool.map(c => ({ id: uid(), ...c }));
  const classGrid = seed.classGrid || [];
  const taGrid = seed.taGrid || [];

  return {
    version: 1,
    meta: {
      schoolName: "Rosny College",
      learningArea: "Design and Digital Technologies",
      leaderName: seed.leaderName || "",
      createdAt: todayISO(),
      lastBackup: null,
      lastSyncedAt: null,
    },
    settings: {
      theme: "workshop",
      // DECYP's published 2026 term dates (general — colleges like Rosny can run
      // a different Term 4 finish around exams, so treat these as an editable
      // starting point, not gospel). Source: decyp.tas.gov.au/learning/term-dates
      terms: [
        { number: 1, startDate: "2026-02-05", endDate: "2026-04-17" },
        { number: 2, startDate: "2026-05-04", endDate: "2026-07-10" },
        { number: 3, startDate: "2026-07-27", endDate: "2026-10-02" },
        { number: 4, startDate: "2026-10-19", endDate: "2026-12-18" },
      ],
      relief: {
        spreadsheetLocation: "Leadership Team (MS Teams) — relief/payment spreadsheet",
        columns: ["Date","Absent Staff","Type","Session(s)","Line/Class","Relief Staff","Reason","Notes","Entered By"],
      },
      teamsChannel: "RON – All Staff  ›  Design and Digital Technology",
      // Blank = use the built-in SUPABASE_URL/SUPABASE_ANON_KEY above.
      // Only fill these in if you ever move to a different Supabase project.
      sync: { url: "", anonKey: "" },
    },
    timetable: {
      times: {
        standard:  [["1","8:30 AM","10:00 AM"], ["2","10:30 AM","12:00 PM"], ["3","1:00 PM","2:30 PM"]],
        wednesday: [["1","8:30 AM","10:00 AM"], ["2","10:30 AM","12:00 PM"], ["SG","12:00 PM","12:45 PM"], ["3","1:30 PM","3:00 PM"]],
      },
      days: {
        monday:    { kind: "standard",  lines: ["Line 1","Line 2","Line 3"] },
        tuesday:   { kind: "standard",  lines: ["Line 4","Line 4","Line 5"] },
        wednesday: { kind: "wednesday", lines: ["Line 2","Line 3","Support Group","Line 1"] },
        thursday:  { kind: "standard",  lines: ["Line 5","Line 5","Line 4"] },
        friday:    { kind: "standard",  lines: ["Line 3","Line 1","Line 2"] },
      },
      // Who's teaching/covering what, per day/session/line — from local-seed.js
      // (see that file's comment for the session-index convention, which
      // differs slightly on Wednesday because of the Support Group gap).
      classGrid,
      taGrid,
    },
    team: { teachers, tas },
    relief: {
      log: [],   // {id,date,absentStaffId,absentStaffName,type,sessions:[idx],room,reliefStaffName,relievers:[{name,sessions:[idx]}],reason,notes,createdAt}
      // reliefStaffName is the single/default reliever (the common case).
      // relievers is only populated when coverage is split across different
      // people for different sessions of a "specific session(s)" absence --
      // see relieverGroupsFor() below, which is the one place that should
      // read either field so every other call site stays split-aware for free.
      // External relief pool — the people who actually cover absences (not your DDT team).
      // Shown at the TOP of every "who covered this" list, ahead of your own team.
      externalPool,
    },
    meetings: {
      standingItems: {
        "Reflective Practice": ["Review actions from last meeting","Reflective Practice focus discussion","Learning Area updates","Other business"],
        "Literacy Inquiry": ["Inquiry question / data review","Strategy trial updates & evidence","Student work samples","Next steps","Other business"],
        "General": ["Previous actions","Main agenda items","Learning Area updates","Other business"],
      },
      items: [], // {id,type:"PLT/LA"|"GSM"|"Senior Staff",date,focus,agenda:[],minutes:"",actions:[{id,text,done,assignee}]}
    },
    tasks: [], // {id,title,notes,due,assignee,status:"open"|"done",createdAt}
    files: {
      queue: [], // {id,fileName,destination,notes,done,addedAt}
    },
    quickLaunch: [
      { label: "Outlook", url: "https://outlook.office.com/mail/", icon: "mail", appScheme: "mailto:" },
      { label: "Teams", url: "https://teams.microsoft.com/", icon: "teams", appScheme: "msteams://" },
      { label: "EduPoint", url: "", icon: "list" },
      { label: "Canvas", url: "", icon: "book" },
      { label: "Staff Timetables", url: "", icon: "grid", action: "showFullStaffTimetable" },
      { label: "TA Timetable", url: "", icon: "grid", action: "showFullTaTimetable" },
      { label: "Unity3D", url: "https://unity.com/", icon: "cube", appScheme: "unityhub://" },
      { label: "Unreal / Epic Games", url: "https://www.unrealengine.com/", icon: "cube", appScheme: "com.epicgames.launcher://apps" },
      { label: "YouTube", url: "https://www.youtube.com/", icon: "play" },
      { label: "Chrome", url: "https://www.google.com/chrome/", icon: "globe", appScheme: "googlechrome://" },
      { label: "Claude", url: "https://claude.ai/", icon: "spark", appScheme: "claude://" },
    ],
    scratchpad: "",
  };
}

/* ---------------------------------------------------------------------- */
/* State load / save                                                      */
/* ---------------------------------------------------------------------- */
let state = loadState();
let saveTimer = null;

function loadState(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultState();
    const parsed = JSON.parse(raw);
    // shallow-merge with defaults so new fields introduced later don't break old saves
    const def = defaultState();
    const merged = deepMerge(def, parsed);
    addMissingQuickLaunchEntries(merged, def);
    backfillQuickLaunchSchemes(merged, def);
    correctKnownBadSchemes(merged);
    backfillFavorites(merged);
    backfillQuickLaunchActions(merged, def);
    // Same class of gap as favourites/schemes above — data saved before
    // local-seed.js had a leaderName would otherwise be stuck showing the
    // "[Your name]" placeholder forever.
    if(!merged.meta.leaderName && window.LOCAL_SEED && window.LOCAL_SEED.leaderName){
      merged.meta.leaderName = window.LOCAL_SEED.leaderName;
    }
    if(merged.settings && merged.settings.term) delete merged.settings.term; // replaced by settings.terms (whole-year model)
    return merged;
  } catch(e){
    console.error("Failed to load saved data, starting fresh.", e);
    return defaultState();
  }
}
/** Arrays are replaced wholesale on load, not merged — so a brand new
 * default quick-launch tile (e.g. a tile added in a later update) simply
 * won't exist on a browser that already has saved data. This appends any
 * default tile missing from the saved list, matched by label, without
 * touching or reordering anything already there. */
function addMissingQuickLaunchEntries(state, defaults){
  if(!Array.isArray(state.quickLaunch)) { state.quickLaunch = []; }
  const existing = new Set(state.quickLaunch.map(q => (q.label||"").toLowerCase()));
  defaults.quickLaunch.forEach(d => {
    if(!existing.has(d.label.toLowerCase())) state.quickLaunch.push({ ...d });
  });
}

/** Data saved before app-launch links existed won't have `appScheme` set
 * (arrays are replaced wholesale on load, not merged field-by-field) — this
 * fills in any missing app-launch link on saved quick-launch tiles that
 * still match a default tile by label, so the feature "just appears" on
 * next load instead of requiring a manual Settings edit. Never touches a
 * link the user has customised (only fills in where appScheme is blank). */
function backfillQuickLaunchSchemes(state, defaults){
  if(!Array.isArray(state.quickLaunch)) return;
  state.quickLaunch.forEach(q => {
    if(!q.appScheme){
      const match = defaults.quickLaunch.find(d => d.label.toLowerCase() === (q.label||"").toLowerCase() && d.appScheme);
      if(match) q.appScheme = match.appScheme;
    }
  });
}
/** Same idea as backfillQuickLaunchSchemes, for the in-app "action" tiles
 * (Staff/TA timetables) added after those two tiles already existed as
 * blank placeholders on saved data. */
function backfillQuickLaunchActions(state, defaults){
  if(!Array.isArray(state.quickLaunch)) return;
  state.quickLaunch.forEach(q => {
    if(!q.action){
      const match = defaults.quickLaunch.find(d => d.label.toLowerCase() === (q.label||"").toLowerCase() && d.action);
      if(match) q.action = match.action;
    }
  });
}
/** One-off corrections for app-launch values that shipped wrong and were
 * already saved to a browser before the fix — safe because it only touches
 * an exact previously-known-bad value, never anything the user has set
 * themselves. Add an entry here (old value → new value) whenever a shipped
 * default protocol turns out to be wrong, instead of relying on people to
 * notice and manually fix Settings themselves. */
/** Sets the initial "pinned" relief contacts on a saved pool that predates
 * the favourite field — only touches entries that have never had the field
 * at all, so unpinning someone later always sticks (never re-forced back). */
function backfillFavorites(state){
  // The actual initial-favourites list lives in local-seed.js (real names
  // don't belong in this published file) — nothing to backfill without it.
  const initialFavorites = new Set((window.LOCAL_SEED && window.LOCAL_SEED.initialFavorites) || []);
  if(!initialFavorites.size) return;
  state.relief.externalPool.forEach(c => {
    if(c.favorite === undefined) c.favorite = initialFavorites.has(c.name);
  });
}
function correctKnownBadSchemes(state){
  const fixes = { "Outlook": { from: "ms-outlook://", to: "mailto:" } };
  state.quickLaunch.forEach(q => {
    const fix = fixes[q.label];
    if(fix && q.appScheme === fix.from) q.appScheme = fix.to;
  });
}
function deepMerge(base, override){
  if(Array.isArray(base)) return override !== undefined ? override : base;
  if(typeof base === "object" && base !== null){
    const out = { ...base };
    for(const k in override){
      out[k] = (typeof base[k] === "object" && base[k] !== null && !Array.isArray(base[k]))
        ? deepMerge(base[k], override[k]) : override[k];
    }
    return out;
  }
  return override !== undefined ? override : base;
}
function persist(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const el = document.getElementById("saveIndicator");
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch(err){
      // Most likely a quota error -- relief attachments are the one thing
      // in this app large enough to hit it. Surfacing this matters: without
      // it, the change stays in memory but silently never actually saves,
      // and vanishes on next reload with no warning at all.
      console.error("Save failed:", err);
      if(el) el.textContent = "Save failed!";
      toast("Save failed — storage is full. Try removing a large attachment from a relief entry.", { duration: 6000 });
      return;
    }
    if(el){
      const t = new Date();
      el.textContent = `Saved ${t.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit"})}`;
    }
    scheduleSyncPush();
  }, 250);
}

/* ---------------------------------------------------------------------- */
/* Cross-device sync (optional) — end-to-end encrypted via Supabase.      */
/* Your passphrase never leaves this browser: it's used locally to derive */
/* (a) an AES-256 key that encrypts/decrypts everything before it's sent, */
/* and (b) which row in Supabase to use — so Supabase only ever sees      */
/* ciphertext, and only devices that know your passphrase can find or     */
/* read it. Nothing here runs, or is even loaded meaningfully, unless you */
/* explicitly turn sync on in Settings.                                   */
/* ---------------------------------------------------------------------- */
const SYNC_SALT = new TextEncoder().encode("ddt-command-centre-sync-v1");
const SYNC_KEY_STORAGE = "rc_ddt_sync_key_v1";
const SYNC_TABLE = "sync_state";

let syncClient = null;
let syncKey = null;       // CryptoKey, derived from the passphrase
let syncRowId = null;     // deterministic UUID, also derived from the passphrase
let syncChannel = null;
let syncStatus = "off";   // off | connecting | synced | error
let syncPushTimer = null;

function getSyncClient(){
  if(syncClient) return syncClient;
  if(typeof window.supabase === "undefined") return null;
  const url = (state.settings.sync && state.settings.sync.url) || SUPABASE_URL;
  const key = (state.settings.sync && state.settings.sync.anonKey) || SUPABASE_ANON_KEY;
  if(!url || !key) return null;
  syncClient = window.supabase.createClient(url, key);
  return syncClient;
}

/** Derives both the AES-GCM key and a deterministic row UUID from one
 * passphrase — so entering the same passphrase on two devices is all it
 * takes for them to find each other, with no separate "sync code" to share. */
async function deriveSyncMaterial(passphrase){
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: SYNC_SALT, iterations: 150000, hash: "SHA-256" },
    baseKey, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
  );
  const idBits = await crypto.subtle.digest("SHA-256", enc.encode(passphrase + ":rowid:v1"));
  const idBytes = new Uint8Array(idBits).slice(0, 16);
  const hex = [...idBytes].map(b => b.toString(16).padStart(2, "0")).join("");
  const rowId = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
  return { key, rowId };
}
async function encryptForSync(obj){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, syncKey, data);
  return btoa(String.fromCharCode(...iv)) + ":" + btoa(String.fromCharCode(...new Uint8Array(cipher)));
}
async function decryptFromSync(payload){
  const [ivB64, cipherB64] = payload.split(":");
  const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
  const cipher = Uint8Array.from(atob(cipherB64), c => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, syncKey, cipher);
  return JSON.parse(new TextDecoder().decode(plain));
}

async function enableSync(passphrase, remember){
  const client = getSyncClient();
  if(!client){ toast("Sync couldn't start — check the Supabase details in Settings."); return false; }
  try {
    const { key, rowId } = await deriveSyncMaterial(passphrase);
    syncKey = key; syncRowId = rowId;
    if(remember){
      const raw = await crypto.subtle.exportKey("raw", key);
      localStorage.setItem(SYNC_KEY_STORAGE, JSON.stringify({ rowId, keyB64: btoa(String.fromCharCode(...new Uint8Array(raw))) }));
    }
    await syncPullAndMerge(true);
    subscribeSyncChannel();
    return true;
  } catch(e){
    console.error("enableSync failed", e);
    toast("Couldn't set up sync — check your connection and try again.");
    return false;
  }
}

async function loadRememberedSync(){
  const raw = localStorage.getItem(SYNC_KEY_STORAGE);
  if(!raw) return false;
  try {
    const { rowId, keyB64 } = JSON.parse(raw);
    const keyBytes = Uint8Array.from(atob(keyB64), c => c.charCodeAt(0));
    syncKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", true, ["encrypt", "decrypt"]);
    syncRowId = rowId;
    const client = getSyncClient();
    if(!client) return false;
    await syncPullAndMerge(false);
    subscribeSyncChannel();
    return true;
  } catch(e){
    console.error("loadRememberedSync failed", e);
    return false;
  }
}

function forgetSync(){
  localStorage.removeItem(SYNC_KEY_STORAGE);
  syncKey = null; syncRowId = null;
  if(syncChannel){ try { getSyncClient()?.removeChannel(syncChannel); } catch(e){} syncChannel = null; }
  clearInterval(syncPollTimer);
  syncStatus = "off";
  updateSyncStatusUI();
}

async function syncPullAndMerge(isInitialSetup){
  const client = getSyncClient();
  if(!client || !syncKey || !syncRowId) return;
  syncStatus = "connecting"; updateSyncStatusUI();
  try {
    const { data, error } = await client.from(SYNC_TABLE).select("payload, updated_at").eq("id", syncRowId).maybeSingle();
    if(error) throw error;
    if(data && data.payload){
      const remote = await decryptFromSync(data.payload);
      const remoteTime = new Date(data.updated_at).getTime();
      const localTime = state.meta.lastSyncedAt ? new Date(state.meta.lastSyncedAt).getTime() : 0;
      if(remoteTime > localTime){
        state = deepMerge(defaultState(), remote);
        state.meta.lastSyncedAt = data.updated_at;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        renderAll();
        toast("Synced from your other device.");
      }
    } else if(isInitialSetup){
      await syncPush(); // nothing there yet — seed it with this device's data
    }
    if(syncKey) syncStatus = "synced"; // guard: sync may have been turned off while this request was in flight
  } catch(e){
    console.error("syncPullAndMerge failed", e);
    if(syncKey) syncStatus = "error";
  }
  updateSyncStatusUI();
}

function scheduleSyncPush(){
  if(!syncKey || !syncRowId) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(syncPush, 800);
}
async function syncPush(){
  const client = getSyncClient();
  if(!client || !syncKey || !syncRowId) return;
  syncStatus = "connecting"; updateSyncStatusUI();
  try {
    const payload = await encryptForSync(state);
    const now = new Date().toISOString();
    const { error } = await client.from(SYNC_TABLE).upsert({ id: syncRowId, payload, updated_at: now });
    if(error) throw error;
    state.meta.lastSyncedAt = now;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if(syncKey) syncStatus = "synced"; // guard: sync may have been turned off while this request was in flight
  } catch(e){
    console.error("syncPush failed", e);
    if(syncKey) syncStatus = "error";
  }
  updateSyncStatusUI();
}

var syncPollTimer = null;
function subscribeSyncChannel(){
  const client = getSyncClient();
  if(!client || !syncRowId) return;
  if(syncChannel){ try { client.removeChannel(syncChannel); } catch(e){} }
  syncChannel = client.channel("sync_state_" + syncRowId)
    .on("postgres_changes", { event: "*", schema: "public", table: SYNC_TABLE, filter: `id=eq.${syncRowId}` }, () => syncPullAndMerge(false))
    .subscribe();

  // Belt-and-braces polling fallback — covers the gap if realtime push isn't
  // enabled for the table, or a mobile connection drops the live socket
  // without reconnecting cleanly. Cheap: one small row read every 20s.
  clearInterval(syncPollTimer);
  syncPollTimer = setInterval(() => { if(syncKey && syncRowId) syncPullAndMerge(false); }, 20000);
}

function updateSyncStatusUI(){
  const el = document.getElementById("syncStatusIndicator");
  if(!el) return;
  const map = { off: "Not set up", connecting: "Syncing…", synced: "Synced ✓", error: "Sync error — working offline" };
  el.textContent = map[syncStatus] || syncStatus;
  el.className = "badge " + (syncStatus === "synced" ? "badge-good" : syncStatus === "error" ? "badge-flag" : "badge-muted");
}

/* ---------------------------------------------------------------------- */
/* Term / week helpers — covers the whole year (all 4 terms), so the      */
/* dashboard header stays correct without manual upkeep each term.        */
/* ---------------------------------------------------------------------- */
function currentTermInfo(){
  const now = new Date(todayISO() + "T00:00:00");
  const terms = [...(state.settings.terms || [])].sort((a,b) => a.startDate.localeCompare(b.startDate));
  for(const t of terms){
    const start = new Date(t.startDate + "T00:00:00");
    const end = new Date(t.endDate + "T00:00:00");
    if(now >= start && now <= end){
      const diffDays = Math.floor((now - start) / 86400000);
      const week = Math.floor(diffDays / 7) + 1;
      // Same formula as `week`, just evaluated at the term's end date — keeps
      // "week" and "totalWeeks" internally consistent (week can never exceed it).
      const totalWeeks = Math.floor((end - start) / 86400000 / 7) + 1;
      return { inTerm: true, number: t.number, week, totalWeeks };
    }
  }
  const upcoming = terms.find(t => new Date(t.startDate + "T00:00:00") > now);
  return { inTerm: false, upcoming };
}

/* ---------------------------------------------------------------------- */
/* App launcher — tries a desktop app's registered protocol first, falls  */
/* back to the website if the app isn't installed / nothing handles it.   */
/* ---------------------------------------------------------------------- */
function launchApp(label, scheme, webUrl){
  let settled = false;
  const cancelFallback = () => { settled = true; document.removeEventListener("visibilitychange", onHide); };
  const onHide = () => { if(document.hidden) cancelFallback(); };
  document.addEventListener("visibilitychange", onHide);

  toast(`Opening ${label} app…`);

  // Direct, synchronous top-level navigation — this is what makes Chromium
  // treat it as a real external-protocol request and show its native
  // "Open <App>?" handoff prompt (or hand off silently if you've already
  // ticked "always allow"). A hidden iframe CANNOT trigger this reliably —
  // Chromium blocks programmatic external-protocol navigation from child
  // frames as an anti-abuse measure, so it fails silently every time,
  // which is what was happening here. If the scheme has no registered
  // handler at all, this line does nothing and the page is unaffected.
  try { window.location.href = scheme; } catch(e){}

  setTimeout(() => {
    if(settled) return;
    cancelFallback();
    if(webUrl){
      toast(`${label} app not detected — opened the web version instead.`);
      window.open(webUrl, "_blank", "noopener");
    }
  }, 2200);
}

/* ---------------------------------------------------------------------- */
/* Toast                                                                  */
/* ---------------------------------------------------------------------- */
/** Plain toast by default. Pass {actionLabel, onAction} (e.g. an "Undo"
 * button after a delete) to show a clickable action inside it instead --
 * the toast stays up longer in that case so there's a real chance to use it. */
function toast(msg, opts){
  const el = document.getElementById("toast");
  clearTimeout(toast._t);
  if(opts && opts.actionLabel && opts.onAction){
    el.innerHTML = `<span>${escapeHtml(msg)}</span> <button type="button" class="toast-action">${escapeHtml(opts.actionLabel)}</button>`;
    el.classList.add("show", "has-action");
    el.querySelector(".toast-action").addEventListener("click", () => {
      clearTimeout(toast._t);
      el.classList.remove("show", "has-action");
      opts.onAction();
    });
    toast._t = setTimeout(() => el.classList.remove("show", "has-action"), opts.duration || 6000);
  } else {
    el.textContent = msg;
    el.classList.remove("has-action");
    el.classList.add("show");
    toast._t = setTimeout(() => el.classList.remove("show"), (opts && opts.duration) || 2200);
  }
}

/* ---------------------------------------------------------------------- */
/* Icons (inline SVG, feather-style, no external font)                    */
/* ---------------------------------------------------------------------- */
const ICONS = {
  mail: `<path d="M3 5h18v14H3z"/><path d="m3 6 9 7 9-7"/>`,
  teams: `<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M16 4v16"/>`,
  list: `<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>`,
  book: `<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22.5z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>`,
  grid: `<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>`,
  cube: `<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>`,
  play: `<circle cx="12" cy="12" r="10"/><path d="M10 8l6 4-6 4z"/>`,
  globe: `<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  trash: `<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>`,
  edit: `<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>`,
  copy: `<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>`,
  print: `<path d="M6 9V2h12v7"/><rect x="4" y="9" width="16" height="8" rx="1.5"/><path d="M6 17v5h12v-5"/>`,
  sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
  moon: `<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>`,
  check: `<path d="M20 6 9 17l-5-5"/>`,
  down: `<path d="m6 9 6 6 6-6"/>`,
  alert: `<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>`,
  inbox: `<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7z"/>`,
  export: `<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>`,
  import: `<path d="M12 21V9"/><path d="m7 16 5 5 5-5"/><path d="M5 3h14"/>`,
  users: `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
  file: `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>`,
  clock: `<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`,
  settings: `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.36.4.66.73.86.29.18.63.28 1 .28H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`,
  calendar: `<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>`,
  phone: `<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>`,
  message: `<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>`,
  search: `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>`,
  spark: `<path d="M12 2l2.2 6.8L21 11l-6.8 2.2L12 20l-2.2-6.8L3 11l6.8-2.2z"/>`,
  star: `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`,
};
function starIcon(filled){
  return `<svg viewBox="0 0 24 24" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mini-icon" style="width:15px;height:15px;">${ICONS.star}</svg>`;
}
function icon(name, extra=""){ return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${extra}">${ICONS[name]||""}</svg>`; }

/* ---------------------------------------------------------------------- */
/* Tabs / router                                                          */
/* ---------------------------------------------------------------------- */
const TABS = [
  { id: "dashboard", label: "Dashboard", render: renderDashboard },
  { id: "relief",    label: "Relief",    render: renderRelief },
  { id: "meetings",  label: "Meetings",  render: renderMeetings },
  { id: "tasks",     label: "Tasks",     render: renderTasks },
  { id: "team",      label: "Team & Files", render: renderTeamFiles },
  { id: "settings",  label: "Settings",  render: renderSettings },
];

function showTab(id){
  document.querySelectorAll(".tabnav button").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + id));
  const tab = TABS.find(t => t.id === id);
  if(tab) tab.render();
  location.hash = id;
}

/* ---------------------------------------------------------------------- */
/* DASHBOARD                                                              */
/* ---------------------------------------------------------------------- */
function renderDashboard(){
  const root = document.getElementById("view-dashboard");
  const today = todayISO();
  const dayKey = dayKeyFromISO(today);
  const ti = currentTermInfo();
  const termLabel = ti.inTerm
    ? `T${ti.number} · W${ti.week} of ${ti.totalWeeks}`
    : (ti.upcoming ? `Holidays — T${ti.upcoming.number} starts ${fmtDateShort(ti.upcoming.startDate)}` : "Holidays");

  const dayInfo = dayKey ? state.timetable.days[dayKey] : null;
  const times = dayInfo ? state.timetable.times[dayInfo.kind] : null;

  const awayToday = state.relief.log.filter(r => r.date === today);
  const openTasks = state.tasks.filter(t => t.status !== "done");
  const overdue = openTasks.filter(t => t.due && t.due < today);
  const dueToday = openTasks.filter(t => t.due === today);

  const nextMeetings = state.meetings.items
    .filter(m => m.date && m.date >= today)
    .sort((a,b) => a.date.localeCompare(b.date) || (a.startTime||"").localeCompare(b.startTime||""))
    .slice(0, 4);

  const lineSummary = dayInfo ? dayInfo.lines.join(" · ") : "—";

  const weekDays = currentWeekDates().map(iso => {
    const dk = dayKeyFromISO(iso);
    const di = dk ? state.timetable.days[dk] : null;
    return {
      iso,
      label: new Date(iso + "T00:00:00").toLocaleDateString("en-AU", { weekday: "short" }),
      lineSummary: di ? di.lines.join(" · ") : "—",
      awayCount: state.relief.log.filter(r => r.date === iso).length,
      meetingCount: state.meetings.items.filter(m => m.date === iso).length,
    };
  });

  root.innerHTML = `
    <dl class="titleblock">
      <div><dt>Date</dt><dd class="mono">${fmtDateShort(today)}</dd></div>
      <div><dt>Term · Week</dt><dd class="mono">${escapeHtml(termLabel)}</dd></div>
      <div><dt>Rotation Today</dt><dd class="mono">${dayKey ? escapeHtml(lineSummary) : "Weekend"}</dd></div>
      <div><dt>Learning Area</dt><dd>${escapeHtml(state.meta.learningArea)}</dd></div>
    </dl>

    <div class="card section-gap">
      <div class="card-head"><h2>${icon("calendar")} This week at a glance</h2></div>
      <div class="row" style="gap:10px; overflow-x:auto;">
        ${weekDays.map(d => `
          <div class="stat-tile" style="flex:1; min-width:118px; ${d.iso === today ? "border-color:var(--accent);" : ""}">
            <div class="stat-label">${escapeHtml(d.label)} <span class="mono">${fmtDateShort(d.iso).replace(/^\w+, /, "")}</span></div>
            <div class="hint" style="margin:4px 0;">${escapeHtml(d.lineSummary)}</div>
            <div class="row" style="gap:4px; justify-content:center; flex-wrap:wrap;">
              ${d.awayCount ? `<span class="badge badge-flag">${d.awayCount} away</span>` : ""}
              ${d.meetingCount ? `<span class="badge badge-muted">${d.meetingCount} mtg</span>` : ""}
              ${!d.awayCount && !d.meetingCount ? `<span class="hint">—</span>` : ""}
            </div>
          </div>
        `).join("")}
      </div>
    </div>

    <div class="grid grid-2 section-gap">
      <div class="card">
        <div class="card-head"><h2>${icon("clock")} Today's sessions</h2></div>
        ${dayInfo ? renderSessionRows(dayInfo, times, today, dayKey) : `<div class="empty-state">${icon("calendar")}<div>No timetabled sessions on weekends.</div></div>`}
      </div>

      <div class="grid" style="gap:16px;">
        <div class="card">
          <div class="card-head"><h2>${icon("alert")} Away today</h2><button class="btn btn-sm" data-goto="relief">Log absence</button></div>
          ${awayToday.length ? `<div class="list">${awayToday.map(reliefItemHtml).join("")}</div>`
            : `<div class="empty-state" style="padding:16px;">No absences logged for today.</div>`}
        </div>
        <div class="card">
          <div class="card-head"><h2>Tasks</h2><button class="btn btn-sm" data-goto="tasks">Open tasks</button></div>
          <div class="row" style="gap:10px;">
            <div class="stat-tile" style="flex:1;"><div class="stat-num mono">${dueToday.length}</div><div class="stat-label">Due today</div></div>
            <div class="stat-tile" style="flex:1;"><div class="stat-num mono" style="color:${overdue.length? "var(--flag)":"inherit"}">${overdue.length}</div><div class="stat-label">Overdue</div></div>
            <div class="stat-tile" style="flex:1;"><div class="stat-num mono">${openTasks.length}</div><div class="stat-label">Open total</div></div>
          </div>
        </div>
      </div>
    </div>

    <div class="grid grid-2 section-gap">
      <div class="card">
        <div class="card-head"><h2>${icon("calendar")} Upcoming meetings</h2><button class="btn btn-sm" data-goto="meetings">All meetings</button></div>
        ${nextMeetings.length ? `<div class="list">${nextMeetings.map(nm => {
          const t = formatMeetingTime(nm.startTime, nm.endTime);
          return `<div class="item" data-open-dash-meeting="${nm.id}" style="cursor:pointer;">
            <div class="item-main">
              <div class="item-title">${escapeHtml(nm.type)} — ${escapeHtml(nm.focus||"")}</div>
              <div class="item-sub mono">${fmtDateShort(nm.date)}${t ? " · " + escapeHtml(t) : ""}</div>
            </div>
          </div>`;
        }).join("")}</div>` : `<div class="empty-state" style="padding:16px;">No upcoming meetings scheduled. Add one in the Meetings tab.</div>`}
      </div>
      <div class="card">
        <div class="card-head"><h2>Quick launch</h2><button class="btn btn-sm" data-goto="settings">Edit links</button></div>
        <form id="googleSearchForm" class="row" style="margin-bottom:8px;">
          <input type="search" id="googleSearchInput" placeholder="Search Google…" style="flex:1;">
          <button class="btn btn-sm" type="submit">${icon("search")} Search</button>
        </form>
        <div class="field" style="position:relative;">
          <input type="search" id="appSearchInput" placeholder="Search tasks, relief, meetings, team…">
          <div id="appSearchResults" class="list" style="position:absolute; z-index:20; top:100%; left:0; right:0; margin-top:4px; display:none;"></div>
        </div>
        <div class="qgrid" id="qgrid"></div>
      </div>
    </div>

    <div class="card section-gap">
      <div class="card-head"><h2>Scratchpad</h2><span class="eyebrow">autosaves</span></div>
      <textarea id="scratchpad" placeholder="Quick notes for today...">${escapeHtml(state.scratchpad)}</textarea>
    </div>
  `;

  document.getElementById("scratchpad").addEventListener("input", e => {
    state.scratchpad = e.target.value; persist();
  });
  root.querySelectorAll("[data-goto]").forEach(b => b.addEventListener("click", () => showTab(b.dataset.goto)));
  root.querySelectorAll("[data-open-dash-meeting]").forEach(el => el.addEventListener("click", () => {
    showTab("meetings");
    openMeetingDetail(el.dataset.openDashMeeting);
    document.getElementById("meetingDetailCard").scrollIntoView({ behavior: "smooth" });
  }));
  root.querySelectorAll("[data-session-toggle]").forEach(el => el.addEventListener("click", () => {
    const panel = document.getElementById("sessionDetail" + el.dataset.sessionToggle);
    if(panel) panel.style.display = panel.style.display === "none" ? "" : "none";
  }));
  renderQuickLaunch();

  document.getElementById("googleSearchForm").addEventListener("submit", e => {
    e.preventDefault();
    const q = document.getElementById("googleSearchInput").value.trim();
    if(!q) return;
    window.open("https://www.google.com/search?q=" + encodeURIComponent(q), "_blank", "noopener");
  });

  const appSearchInput = document.getElementById("appSearchInput");
  const appSearchResults = document.getElementById("appSearchResults");
  appSearchInput.addEventListener("input", () => {
    const results = globalSearch(appSearchInput.value);
    if(!results.length){ appSearchResults.style.display = "none"; return; }
    appSearchResults.style.display = "";
    appSearchResults.innerHTML = results.map((r,i) => `
      <div class="item" data-search-result="${i}">
        <div class="item-main"><span class="badge badge-muted">${escapeHtml(r.type)}</span> ${escapeHtml(r.label)}</div>
      </div>`).join("");
    appSearchResults.querySelectorAll("[data-search-result]").forEach(el => el.addEventListener("click", () => {
      showTab(results[+el.dataset.searchResult].tab);
      appSearchInput.value = ""; appSearchResults.style.display = "none";
    }));
  });
}

function renderQuickLaunch(){
  const box = document.getElementById("qgrid");
  box.innerHTML = state.quickLaunch.map((q,i) => {
    if(q.action && typeof window[q.action] === "function"){
      return `<button class="qtile" data-ql-action="${i}" title="Opens ${escapeHtml(q.label)}">${icon(q.icon||"globe")}<span>${escapeHtml(q.label)}</span></button>`;
    }
    if(!q.url && !q.appScheme){
      return `<button class="qtile empty" data-ql-empty="${i}" title="No link set — edit in Settings">${icon(q.icon||"globe")}<span>${escapeHtml(q.label)}</span></button>`;
    }
    if(q.appScheme){
      return `<button class="qtile" data-ql-app="${i}" title="Opens the ${escapeHtml(q.label)} app — falls back to the website if it's not installed">${icon(q.icon||"globe")}<span>${escapeHtml(q.label)}</span></button>`;
    }
    return `<a class="qtile" href="${escapeHtml(q.url)}" target="_blank" rel="noopener">${icon(q.icon||"globe")}<span>${escapeHtml(q.label)}</span></a>`;
  }).join("");

  box.querySelectorAll("[data-ql-action]").forEach(b => b.addEventListener("click", () => {
    const q = state.quickLaunch[+b.dataset.qlAction];
    window[q.action]();
  }));
  box.querySelectorAll("[data-ql-empty]").forEach(b => b.addEventListener("click", () => showTab("settings")));
  box.querySelectorAll("[data-ql-app]").forEach(b => b.addEventListener("click", () => {
    const q = state.quickLaunch[+b.dataset.qlApp];
    launchApp(q.label, q.appScheme, q.url);
  }));
}

function renderSessionRows(dayInfo, times, dateISO, dayKey){
  return `<div>${times.map((t, i) => {
    const [label, start, end] = t;
    const line = dayInfo.lines[i] || "—";
    const isSG = /support group/i.test(line);
    const awayForThis = state.relief.log.filter(r => r.date === dateISO && (r.sessions||[]).includes(i));
    const classes = classGridFor(dayKey, i);
    const tas = taGridFor(dayKey, i);
    return `<div>
      <div class="session-row ${classes.length ? "session-row-clickable" : ""}" ${classes.length ? `data-session-toggle="${i}"` : ""}>
        <div class="session-badge">${escapeHtml(label)}</div>
        <div class="session-time mono">${escapeHtml(start)}–${escapeHtml(end)}</div>
        <div class="session-line ${isSG ? "sg":""}">${escapeHtml(line)}</div>
        <div style="display:flex; align-items:center; gap:8px;">
          ${awayForThis.length ? `<span class="session-away">${awayForThis.length} away</span>` : ""}
          ${classes.length ? `<span class="badge badge-muted mono">${classes.length} classes ${icon("down","mini-icon")}</span>` : ""}
        </div>
      </div>
      ${classes.length ? `<div class="session-detail" id="sessionDetail${i}" style="display:none;">
        <div class="table-wrap"><table>
          <thead><tr><th>Teacher</th><th>Subject</th><th>Room</th><th>TA covering</th></tr></thead>
          <tbody>${classes.map(c => {
            const ta = tas.find(x => x.line === c.line && (x.subject === c.subject || tas.length === 1));
            return `<tr><td>${escapeHtml(c.teacher)}</td><td>${escapeHtml(c.subject)}</td><td class="mono">${escapeHtml(c.room||"—")}</td><td>${ta ? escapeHtml(ta.ta) : `<span class="hint">—</span>`}</td></tr>`;
          }).join("")}</tbody>
        </table></div>
      </div>` : ""}
    </div>`;
  }).join("")}</div>`;
}

function reliefItemHtml(r){
  const sessLabel = (r.sessions && r.sessions.length) ? `S${r.sessions.map(i=>i+1).join(",")}` : (r.type === "duty" ? "Duty" : "Full day");
  return `<div class="item">
    <div class="item-main">
      <div class="item-title">${escapeHtml(r.absentStaffName)} <span class="badge badge-flag">${escapeHtml(sessLabel)}</span></div>
      <div class="item-sub">${reliefSummaryText(r) ? "Covered by " + escapeHtml(reliefSummaryText(r)) + (allRelieverNames(r).length === 1 ? contactLinksHtml(allRelieverNames(r)[0]) : "") : "No relief assigned yet"}</div>
    </div>
  </div>`;
}

/** Small inline call/email links for a relief-pool contact, if we have their details. */
function contactLinksHtml(name){
  const c = poolContactByName(name);
  if(!c || (!c.phone && !c.email)) return "";
  const bits = [];
  if(c.phone) bits.push(`<a href="${telHref(c.phone)}">Call</a>`);
  if(c.email) bits.push(`<a href="mailto:${escapeHtml(c.email)}">Email</a>`);
  return ` · ${bits.join(" · ")}`;
}
/** Download links for a relief entry's attached documents -- the data URL
 * is used directly as the href, so no server or Blob juggling is needed. */
function attachmentLinksHtml(attachments){
  if(!attachments || !attachments.length) return "";
  return attachments.map(a => `<a href="${a.dataUrl}" download="${escapeHtml(a.name)}">${icon("file","mini-icon")}${escapeHtml(a.name)}</a>`).join(" · ");
}

/* ---------------------------------------------------------------------- */
/* RELIEF                                                                 */
/* ---------------------------------------------------------------------- */
let reliefDraft = null; // holds in-progress generated outputs context
let reliefEditingId = null;
let reliefPendingAttachments = []; // {name,type,size,dataUrl}[] for the form currently open (add or edit)
let reliefDirSort = { key: null, dir: 1 };   // Relief tab directory table sort
let poolManageSort = { key: null, dir: 1 };  // Team & Files pool management table sort
let reliefDirSubjectFilter = new Set();      // Relief tab directory subject-tag filter
let reliefDirExpanded = false;               // Relief tab directory: show full list vs. pinned favourites only
let poolManageSubjectFilter = new Set();     // Team & Files pool manager subject-tag filter

/** Generic column sort: mutates rows in place by comparing string/number
 * fields, with "count"/"last" handled specially (numeric / date-string). */
function sortRows(rows, sortState){
  if(!sortState.key) return rows;
  const { key, dir } = sortState;
  return [...rows].sort((a,b) => {
    if(key === "count") return dir * ((a.count||0) - (b.count||0));
    if(key === "last") return dir * (a.last||"").localeCompare(b.last||"");
    const av = (a[key] || "").toString().toLowerCase();
    const bv = (b[key] || "").toString().toLowerCase();
    return dir * av.localeCompare(bv);
  });
}
function sortArrow(sortState, key){ return sortState.key === key ? (sortState.dir === 1 ? " ▲" : " ▼") : ""; }
function wireSortHeaders(root, sortState, onChange){
  root.querySelectorAll("[data-sort-key]").forEach(th => th.addEventListener("click", () => {
    if(sortState.key === th.dataset.sortKey) sortState.dir *= -1;
    else { sortState.key = th.dataset.sortKey; sortState.dir = 1; }
    onChange();
  }));
}

function allStaffNames(){
  return [...state.team.teachers, ...state.team.tas].map(p => p.name);
}

/** Relief pool first (in list order), then your own team members who
 * aren't already in the pool — this is the order used everywhere someone
 * is picked to cover an absence, since most cover comes from the pool. */
function reliefCandidateObjects(){
  const poolLower = new Set(state.relief.externalPool.map(p => p.name.toLowerCase()));
  const teamExtra = [...state.team.teachers, ...state.team.tas]
    .filter(p => !poolLower.has(p.name.toLowerCase()))
    .map(p => ({ id: p.id, name: p.name, phone: "", email: "", availability: "", subjects: "", isTeam: true }));
  return [...state.relief.externalPool, ...teamExtra];
}
function reliefCandidateNames(){ return reliefCandidateObjects().map(c => c.name); }
function poolContactByName(name){
  if(!name) return null;
  const n = name.trim().toLowerCase();
  return state.relief.externalPool.find(p => p.name.toLowerCase() === n) || null;
}
/** True while a pool contact's own "unavailable until" date hasn't passed
 * yet (e.g. their own leave/holidays) -- today still counts as unavailable. */
function isCurrentlyUnavailable(c){ return !!(c.unavailableUntil && c.unavailableUntil >= todayISO()); }
function unavailableBadgeHtml(c){ return isCurrentlyUnavailable(c) ? `<span class="badge badge-flag">Unavailable until ${fmtDateShort(c.unavailableUntil)}</span> ` : ""; }
function telHref(phone){ return "tel:" + phone.replace(/[^\d+]/g, ""); }
function smsHref(phone, body){ return "sms:" + phone.replace(/[^\d+]/g, "") + "?body=" + encodeURIComponent(body); }

/** First name = first word; surname = everything else — handles multi-word
 * surnames correctly ("Leah Gregory Lamb" → "Leah" / "Gregory Lamb").
 * Derived on the fly from the stored `name` field so it works for existing
 * saved data too, with nothing to migrate. */
function splitName(fullName){
  const parts = (fullName || "").trim().split(/\s+/).filter(Boolean);
  if(parts.length <= 1) return { firstName: parts[0] || "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** Subjects are free-text ("VET;Technologies", "Maths, Science", "English/HaSS")
 * — split on the common separators people actually used into clean tags. */
function tokenizeSubjects(subjects){
  if(!subjects) return [];
  return subjects.split(/[;,/]/).map(s => s.trim()).filter(Boolean);
}
function hasAnySubjectTag(subjects){
  return tokenizeSubjects(subjects).some(t => t.toLowerCase() === "any");
}
/** Unique subject tags across a contact list, one representative casing per
 * tag (first one seen), sorted alphabetically — feeds the filter chips. */
function collectSubjectTags(contacts){
  const seen = new Map();
  contacts.forEach(c => tokenizeSubjects(c.subjects).forEach(tag => {
    const key = tag.toLowerCase();
    if(!seen.has(key)) seen.set(key, tag);
  }));
  return [...seen.values()].sort((a,b) => a.localeCompare(b));
}
/** True if a contact matches the selected filter tags — a contact tagged
 * "ANY" always matches, since that's what "ANY" means in practice. */
function matchesSubjectFilter(contact, selectedTags){
  if(!selectedTags || !selectedTags.size) return true;
  if(hasAnySubjectTag(contact.subjects)) return true;
  const mine = new Set(tokenizeSubjects(contact.subjects).map(t => t.toLowerCase()));
  for(const tag of selectedTags) if(mine.has(tag.toLowerCase())) return true;
  return false;
}

/** Renders whatever's currently staged in reliefPendingAttachments (new
 * uploads this session, plus any the entry already had when editing) into
 * the "Log an absence" form -- top-level (not nested in renderRelief) so
 * populateReliefFormForEdit can refresh it too when loading an existing
 * entry's attachments. */
function renderPendingAttachments(){
  const box = document.getElementById("rf-attachment-list");
  if(!box) return;
  if(!reliefPendingAttachments.length){ box.innerHTML = ""; return; }
  box.innerHTML = `<div class="list">${reliefPendingAttachments.map((a,i) => `
    <div class="item" style="padding:6px 10px;">
      <div class="item-main" style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
        <span>${icon("file","mini-icon")} ${escapeHtml(a.name)} <span class="hint">(${formatBytes(a.size)})</span></span>
        <button type="button" class="btn btn-sm btn-danger" data-remove-attachment="${i}">${icon("trash")}</button>
      </div>
    </div>
  `).join("")}</div>`;
  box.querySelectorAll("[data-remove-attachment]").forEach(b => b.addEventListener("click", () => {
    reliefPendingAttachments.splice(+b.dataset.removeAttachment, 1);
    renderPendingAttachments();
  }));
}

function renderRelief(){
  const root = document.getElementById("view-relief");
  const today = todayISO();

  root.innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><h2 id="reliefFormHeading">${icon("alert")} Log an absence</h2><button type="button" class="btn btn-sm" id="reliefCancelEditBtn" style="display:none;">Cancel edit</button></div>
        <form id="reliefForm">
          <div class="row">
            <div class="field">
              <label for="rf-staff">Absent staff member</label>
              <select id="rf-staff" required>
                <option value="">Select…</option>
                ${allStaffNames().map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("")}
                <option value="__other">Other / not listed…</option>
              </select>
            </div>
            <div class="field" id="rf-staff-other-wrap" style="display:none;">
              <label for="rf-staff-other">Name</label>
              <input type="text" id="rf-staff-other" placeholder="Full name">
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label for="rf-date">Date</label>
              <input type="date" id="rf-date" value="${today}" required>
            </div>
            <div class="field">
              <label for="rf-type">Absence type</label>
              <select id="rf-type">
                <option value="full-day">Full teaching day</option>
                <option value="sessions">Specific session(s)</option>
                <option value="duty">Duty only</option>
              </select>
            </div>
          </div>
          <div class="field" id="rf-end-wrap" style="display:none;">
            <label for="rf-end-date">End date (optional — logs each school day in the range)</label>
            <input type="date" id="rf-end-date">
          </div>
          <div class="field" id="rf-sessions-wrap">
            <label>Session(s) affected</label>
            <div id="rf-sessions" class="row" style="gap:14px;"></div>
            <div class="hint">Based on the rotation for the selected date.</div>
          </div>
          <div id="rf-classes-panel"></div>
          <div class="row">
            <div class="field">
              <label for="rf-room">Room (optional)</label>
              <input type="text" id="rf-room" placeholder="e.g. D12">
            </div>
            <div class="field" id="rf-relief-single-wrap">
              <label for="rf-relief">Relief staff assigned (optional)</label>
              <input type="text" id="rf-relief" list="rf-pool-list" placeholder="Start typing a name… (relief pool first, then your team)">
              <datalist id="rf-pool-list">${reliefCandidateNames().map(n=>`<option value="${escapeHtml(n)}">`).join("")}</datalist>
            </div>
          </div>
          <div class="field" id="rf-split-wrap" style="display:none;">
            <label class="checkline"><input type="checkbox" id="rf-split-relief"> Split coverage — different relief for different sessions</label>
          </div>
          <div id="rf-session-relievers"></div>
          <div class="field">
            <label for="rf-reason">Reason</label>
            <select id="rf-reason">
              <option>Personal / sick leave</option>
              <option>Professional learning</option>
              <option>Exam marking</option>
              <option>Approved leave</option>
              <option>Carers</option>
              <option>Bereavement</option>
              <option>LWOP</option>
              <option>LSL</option>
              <option>Other</option>
            </select>
          </div>
          <div class="field">
            <label for="rf-notes">Notes (relief instructions, work set, etc.)</label>
            <textarea id="rf-notes" placeholder="What should the relief teacher know?"></textarea>
          </div>
          <div class="field">
            <label for="rf-attachments">Attach a document (optional — work set, class list, etc.)</label>
            <input type="file" id="rf-attachments" multiple>
            <div class="hint">Stored with this entry on this computer. <code>mailto:</code> can't attach files automatically — "Email draft" will show a download link for each one instead, ready to drag into the email that opens.</div>
            <div id="rf-attachment-list" style="margin-top:6px;"></div>
          </div>
          <button class="btn btn-primary" type="submit" id="reliefSubmitBtn">${icon("plus")} Log absence</button>
        </form>
      </div>

      <div class="card">
        <div class="card-head"><h2>${icon("users")} Relief directory</h2></div>
        <div class="field">
          <input type="search" id="reliefDirSearch" placeholder="Search by name, subject, or availability…">
        </div>
        <div class="field">
          <label>Filter by subject / area</label>
          <div class="chip-row" id="reliefDirChips"></div>
        </div>
        <div id="reliefPool"></div>
        <div class="hint section-gap">Relief pool listed first, then your own team — sorted by least-recently used so you can spread coverage fairly. Manage contact details in Team &amp; Files.</div>
      </div>
    </div>

    <div class="card section-gap" id="reliefOutputCard" style="display:none;">
      <div class="card-head"><h2>${icon("copy")} Generate outputs</h2><button class="btn btn-ghost btn-sm" id="closeOutput">Close</button></div>
      <div class="output-tabs" id="outputTabs"></div>
      <div id="outputPanel"></div>
    </div>

    <div class="card section-gap">
      <div class="card-head"><h2>${icon("clock")} This term's relief stats</h2></div>
      <div id="reliefStats"></div>
    </div>

    <div class="card section-gap">
      <div class="card-head"><h2>${icon("users")} Leave tallies (this year)</h2></div>
      <div class="hint" style="margin-bottom:8px;">Counts each logged relief entry as one instance — a "Specific session(s)" entry counts the same as a full day.</div>
      <div id="leaveTallies"></div>
    </div>

    <div class="card section-gap">
      <div class="card-head">
        <h2>Relief log</h2>
        <div class="row" style="gap:8px;">
          <button class="btn btn-sm" id="printTodayBtn">${icon("print")} Print today's coverage</button>
          <button class="btn btn-sm" id="printWeekBtn">${icon("print")} Print week's coverage</button>
          <button class="btn btn-sm" id="exportReliefCsvBtn">${icon("export")} Export CSV</button>
          <input type="search" id="reliefSearch" placeholder="Search log…" style="max-width:220px;">
        </div>
      </div>
      <div class="row" style="gap:10px; align-items:flex-end; margin-bottom:12px;">
        <div class="field" style="margin:0;">
          <label for="reliefFromDate" class="hint">From</label>
          <input type="date" id="reliefFromDate">
        </div>
        <div class="field" style="margin:0;">
          <label for="reliefToDate" class="hint">To</label>
          <input type="date" id="reliefToDate">
        </div>
        <button class="btn btn-sm btn-ghost" id="reliefClearDateFilter">Clear dates</button>
        <div class="hint">Export CSV downloads whatever's shown below — set a date range first for a term's worth of records.</div>
      </div>
      <div id="reliefLog"></div>
    </div>
  `;

  document.getElementById("printTodayBtn").addEventListener("click", printTodaysCoverage);
  document.getElementById("printWeekBtn").addEventListener("click", printWeekCoverage);
  renderReliefStats();
  renderLeaveTallies();

  const staffSel = document.getElementById("rf-staff");
  staffSel.addEventListener("change", () => {
    document.getElementById("rf-staff-other-wrap").style.display = staffSel.value === "__other" ? "" : "none";
    renderClassesPanel();
  });

  const dateInput = document.getElementById("rf-date");
  const typeSel = document.getElementById("rf-type");
  /** The "log a run of days" end-date field only makes sense for a fresh
   * "Full teaching day" absence -- hidden (and cleared) while editing an
   * existing entry, since editing always applies to that one record. */
  function updateEndDateVisibility(){
    const endWrap = document.getElementById("rf-end-wrap");
    const show = typeSel.value === "full-day" && !reliefEditingId;
    endWrap.style.display = show ? "" : "none";
    if(!show) document.getElementById("rf-end-date").value = "";
  }
  function renderSessionCheckboxes(){
    updateEndDateVisibility();
    const dayKey = dayKeyFromISO(dateInput.value);
    const wrap = document.getElementById("rf-sessions-wrap");
    const box = document.getElementById("rf-sessions");
    if(typeSel.value !== "sessions" || !dayKey){
      wrap.style.display = "none"; box.innerHTML = "";
      renderSessionRelieverInputs();
      return;
    }
    wrap.style.display = "";
    const dayInfo = state.timetable.days[dayKey];
    const times = state.timetable.times[dayInfo.kind];
    box.innerHTML = times.map((t,i) => `
      <label class="checkline"><input type="checkbox" class="rf-sess-cb" value="${i}"> ${escapeHtml(t[0])} · ${escapeHtml(dayInfo.lines[i])}</label>
    `).join("");
    renderSessionRelieverInputs();
  }
  /** Shows/hides the "split coverage" checkbox (only relevant once 2+
   * sessions are checked on a "specific session(s)" absence) and, when
   * ticked, swaps the single "Relief staff assigned" field for one
   * relief-name input per checked session so different people can cover
   * different sessions of the same absence. */
  function renderSessionRelieverInputs(){
    const splitWrap = document.getElementById("rf-split-wrap");
    const splitCb = document.getElementById("rf-split-relief");
    const singleWrap = document.getElementById("rf-relief-single-wrap");
    const out = document.getElementById("rf-session-relievers");
    const checkedSessions = [...document.querySelectorAll(".rf-sess-cb:checked")].map(cb=>+cb.value).sort((a,b)=>a-b);
    const canSplit = typeSel.value === "sessions" && checkedSessions.length > 1;
    splitWrap.style.display = canSplit ? "" : "none";
    if(!canSplit) splitCb.checked = false;
    const splitting = canSplit && splitCb.checked;
    singleWrap.style.display = splitting ? "none" : "";
    if(!splitting){ out.style.display = "none"; out.innerHTML = ""; return; }

    const dayKey = dayKeyFromISO(dateInput.value);
    const dayInfo = state.timetable.days[dayKey];
    const times = state.timetable.times[dayInfo.kind];
    const existing = {};
    out.querySelectorAll("[data-sess-relief]").forEach(inp => { existing[inp.dataset.sessRelief] = inp.value; });
    out.style.display = "";
    out.innerHTML = `<div class="hint" style="margin:2px 0 8px;">Who's covering each session:</div>` + checkedSessions.map(i => `
      <div class="field">
        <label>S${i+1} · ${escapeHtml(times[i][0])} · ${escapeHtml(dayInfo.lines[i])}</label>
        <input type="text" data-sess-relief="${i}" list="rf-pool-list" value="${escapeHtml(existing[i]||"")}" placeholder="Relief for this session">
      </div>
    `).join("");
  }
  /** Shows what the selected absent teacher actually teaches that day
   * (subject + room), and who normally TAs each of those sessions —
   * click a suggested TA to drop them straight into "Relief staff assigned". */
  function renderClassesPanel(){
    const panel = document.getElementById("rf-classes-panel");
    const name = staffSel.value;
    const dayKey = dayKeyFromISO(dateInput.value);
    if(!name || name === "__other" || !dayKey){ panel.innerHTML = ""; return; }
    const classes = classesForTeacherToday(name, dayKey);
    if(!classes.length){ panel.innerHTML = ""; return; }
    panel.innerHTML = `
      <div class="card" style="background:var(--accent-soft); border-color:var(--accent); margin-bottom:14px;">
        <h3 style="margin-bottom:8px;">${escapeHtml(name)}'s classes on ${escapeHtml(DAY_LABEL[dayKey])}</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Session</th><th>Subject</th><th>Room</th><th>Usual TA</th></tr></thead>
          <tbody>${classes.map(c => {
            const ta = taGridFor(dayKey, c.sessionIdx).find(t => t.line === c.line);
            return `<tr>
              <td class="mono">S${escapeHtml(c.sessionLabel)}</td>
              <td>${escapeHtml(c.subject)}</td>
              <td class="mono">${escapeHtml(c.room||"—")}</td>
              <td>${ta ? `<button type="button" class="btn btn-sm" data-suggest-relief="${escapeHtml(ta.ta)}">${icon("plus")} ${escapeHtml(ta.ta)}</button>` : `<span class="hint">—</span>`}</td>
            </tr>`;
          }).join("")}</tbody>
        </table></div>
        <div class="hint" style="margin-top:6px;">Suggested TAs are who normally covers that line — click to use them as relief, or pick anyone else below.</div>
      </div>
    `;
    panel.querySelectorAll("[data-suggest-relief]").forEach(b => b.addEventListener("click", () => {
      document.getElementById("rf-relief").value = b.dataset.suggestRelief;
      toast(`${b.dataset.suggestRelief} set as relief.`);
    }));
  }
  dateInput.addEventListener("change", () => { renderSessionCheckboxes(); renderClassesPanel(); });
  typeSel.addEventListener("change", renderSessionCheckboxes);
  document.getElementById("rf-sessions").addEventListener("change", e => {
    if(e.target.classList.contains("rf-sess-cb")) renderSessionRelieverInputs();
  });
  document.getElementById("rf-split-relief").addEventListener("change", renderSessionRelieverInputs);
  renderSessionCheckboxes();
  renderClassesPanel();
  renderPendingAttachments();

  document.getElementById("rf-attachments").addEventListener("change", e => {
    const files = [...e.target.files];
    let remaining = files.length;
    if(!remaining) return;
    files.forEach(file => {
      if(file.size > 3*1024*1024){
        toast(`${file.name} is ${formatBytes(file.size)} — large attachments use up this computer's storage quickly (and slow down sync, if it's on). A smaller file works better if you have a choice.`, { duration: 6000 });
      }
      const reader = new FileReader();
      const done = () => { remaining--; if(remaining === 0){ renderPendingAttachments(); e.target.value = ""; } };
      reader.onload = () => {
        reliefPendingAttachments.push({ name: file.name, type: file.type || "application/octet-stream", size: file.size, dataUrl: reader.result });
        done();
      };
      reader.onerror = () => { toast(`Couldn't read ${file.name}.`); done(); };
      reader.readAsDataURL(file);
    });
  });

  function resetReliefFormToAddMode(){
    reliefEditingId = null;
    document.getElementById("reliefFormHeading").innerHTML = `${icon("alert")} Log an absence`;
    document.getElementById("reliefSubmitBtn").innerHTML = `${icon("plus")} Log absence`;
    document.getElementById("reliefCancelEditBtn").style.display = "none";
    document.getElementById("reliefForm").reset();
    staffSel.dispatchEvent(new Event("change"));
    dateInput.value = todayISO();
    reliefPendingAttachments = [];
    renderPendingAttachments();
    renderSessionCheckboxes();
    renderClassesPanel();
  }
  document.getElementById("reliefCancelEditBtn").addEventListener("click", resetReliefFormToAddMode);

  document.getElementById("reliefForm").addEventListener("submit", e => {
    e.preventDefault();
    const staffVal = staffSel.value === "__other" ? document.getElementById("rf-staff-other").value.trim() : staffSel.value;
    if(!staffVal){ toast("Choose or enter an absent staff member."); return; }
    const type = typeSel.value;
    const sessions = type === "sessions" ? [...document.querySelectorAll(".rf-sess-cb:checked")].map(cb=>+cb.value) : [];

    // Split coverage: one relief-name input per checked session, merged into
    // {name, sessions} groups (so two sessions given the same name become
    // one group, e.g. "Jane Smith (S2,3)" rather than two separate entries).
    const splitCb = document.getElementById("rf-split-relief");
    const splitting = type === "sessions" && splitCb && splitCb.checked;
    let relievers = [];
    if(splitting){
      const bySession = [...document.querySelectorAll("#rf-session-relievers [data-sess-relief]")]
        .map(inp => ({ session: +inp.dataset.sessRelief, name: inp.value.trim() }))
        .filter(x => x.name);
      const merged = {};
      bySession.forEach(({session, name}) => { (merged[name] = merged[name] || []).push(session); });
      relievers = Object.keys(merged).map(name => ({ name, sessions: merged[name].sort((a,b)=>a-b) }));
    }

    const fields = {
      date: dateInput.value,
      absentStaffName: staffVal,
      type,
      sessions,
      room: document.getElementById("rf-room").value.trim(),
      reliefStaffName: splitting ? (relievers.length === 1 ? relievers[0].name : "") : document.getElementById("rf-relief").value.trim(),
      relievers,
      reason: document.getElementById("rf-reason").value,
      notes: document.getElementById("rf-notes").value.trim(),
      attachments: [...reliefPendingAttachments],
    };

    if(reliefEditingId){
      const existing = state.relief.log.find(x => x.id === reliefEditingId);
      if(existing){
        Object.assign(existing, fields);
        persist();
        toast("Relief entry updated.");
        resetReliefFormToAddMode();
        renderRelief();
        openReliefOutputs(existing);
        document.getElementById("reliefOutputCard").scrollIntoView({behavior:"smooth"});
        return;
      }
      reliefEditingId = null;
    }

    // Multi-day: "Full teaching day" only, and only when logging fresh (not
    // editing) -- one identical record per school day in the range, so every
    // day stays individually editable/deletable exactly like a normal entry.
    const endDateInput = document.getElementById("rf-end-date");
    const endDateVal = (type === "full-day" && endDateInput) ? endDateInput.value : "";
    if(endDateVal && endDateVal > fields.date){
      const dates = [];
      const d = new Date(fields.date + "T00:00:00");
      const end = new Date(endDateVal + "T00:00:00");
      while(d <= end){
        const iso = todayISO(d); // local-date formatting -- toISOString() would shift through UTC and land on the wrong day in AEST
        if(dayKeyFromISO(iso)) dates.push(iso); // skips weekends
        d.setDate(d.getDate()+1);
      }
      if(!dates.length){ toast("No school days in that date range."); return; }
      const records = dates.map(iso => ({ id: uid(), ...fields, date: iso, createdAt: new Date().toISOString() }));
      state.relief.log.unshift(...records);
      persist();
      toast(`${records.length} absence${records.length>1?"s":""} logged, ${fmtDateShort(dates[0])}–${fmtDateShort(dates[dates.length-1])}.`);
      reliefPendingAttachments = []; // don't carry an attachment forward into whatever's logged next
      renderRelief();
      openReliefOutputs(records[0]);
      document.getElementById("reliefOutputCard").scrollIntoView({behavior:"smooth"});
      return;
    }

    // Same person + same date already has an entry -- most often an
    // accidental double-log, so check before creating a genuine duplicate.
    const dupes = state.relief.log.filter(x => x.absentStaffName === staffVal && x.date === fields.date);
    if(dupes.length){
      const dupeSummary = dupes.map(x => x.type === "duty" ? "Duty" : x.type === "full-day" ? "Full day" : sessionLabelList(x.sessions)).join(", ");
      if(!confirm(`${staffVal} already has a relief entry logged for ${fmtDateShort(fields.date)} (${dupeSummary}). Log this anyway?`)) return;
    }

    const record = { id: uid(), ...fields, createdAt: new Date().toISOString() };
    state.relief.log.unshift(record);
    persist();
    toast("Absence logged.");
    reliefPendingAttachments = []; // don't carry an attachment forward into whatever's logged next
    renderRelief();
    openReliefOutputs(record);
    document.getElementById("reliefOutputCard").scrollIntoView({behavior:"smooth"});
  });

  document.getElementById("closeOutput").addEventListener("click", () => {
    document.getElementById("reliefOutputCard").style.display = "none";
  });

  renderReliefPool();
  renderReliefLog();

  document.getElementById("reliefSearch").addEventListener("input", () => renderReliefLog());
  document.getElementById("reliefFromDate").addEventListener("change", () => renderReliefLog());
  document.getElementById("reliefToDate").addEventListener("change", () => renderReliefLog());
  document.getElementById("reliefClearDateFilter").addEventListener("click", () => {
    document.getElementById("reliefFromDate").value = "";
    document.getElementById("reliefToDate").value = "";
    renderReliefLog();
  });
  document.getElementById("exportReliefCsvBtn").addEventListener("click", exportReliefLogCsv);
  document.getElementById("reliefDirSearch").addEventListener("input", e => renderReliefPool(e.target.value));
}

function renderReliefPool(filter=""){
  const box = document.getElementById("reliefPool");
  const chipBox = document.getElementById("reliefDirChips");
  const f = filter.trim().toLowerCase();

  let pool = reliefCandidateObjects().map(c => {
    const uses = state.relief.log.filter(r => allRelieverNames(r).includes(c.name));
    const last = uses.map(u=>u.date).sort().pop();
    return { ...c, ...splitName(c.name), count: uses.length, last };
  });

  if(chipBox) renderSubjectChips(chipBox, collectSubjectTags(pool), reliefDirSubjectFilter, () => renderReliefPool(document.getElementById("reliefDirSearch").value));

  if(f) pool = pool.filter(c => `${c.name} ${c.availability} ${c.subjects}`.toLowerCase().includes(f));
  pool = pool.filter(c => matchesSubjectFilter(c, reliefDirSubjectFilter));
  // Currently-unavailable contacts sort below available ones either way,
  // so a run of leave/holidays doesn't crowd out who can actually help.
  pool = reliefDirSort.key
    ? sortRows(pool, reliefDirSort)
    : pool.sort((a,b) => (isCurrentlyUnavailable(a) - isCurrentlyUnavailable(b)) || (a.last||"").localeCompare(b.last||"") || a.count - b.count);

  if(!pool.length){ box.innerHTML = `<div class="empty-state">No matches. Try clearing the subject filter, or add contacts in Team &amp; Files.</div>`; return; }

  // Only pin+collapse in the plain default view — any active search, sort,
  // or subject filter means the person is actively looking for someone
  // specific, so show every match instead of hiding results behind "more".
  const isDefaultView = !f && !reliefDirSort.key && reliefDirSubjectFilter.size === 0;
  const favCount = pool.filter(p => p.favorite).length;
  let visiblePool = pool;
  let hiddenCount = 0;
  if(isDefaultView && favCount && !reliefDirExpanded){
    visiblePool = pool.filter(p => p.favorite);
    hiddenCount = pool.length - visiblePool.length;
  }

  const rowHtml = p => `<tr>
      <td>
        ${!p.isTeam ? `<button type="button" class="icon-btn star-btn ${p.favorite ? "is-favorite" : ""}" data-fav-toggle="${p.id}" title="${p.favorite ? "Unpin from top" : "Pin to top"}" style="width:22px;height:22px;padding:2px;vertical-align:-5px;">${starIcon(!!p.favorite)}</button>` : ""}
        ${escapeHtml(p.firstName)}${p.isTeam ? ` <span class="badge badge-muted">Team</span>` : ""}
      </td>
      <td>${escapeHtml(p.lastName)}</td>
      <td class="mono" style="white-space:nowrap;">${p.phone ? `<a href="${telHref(p.phone)}">${icon("phone","mini-icon")}${escapeHtml(p.phone)}</a>` : ""}${p.phone && p.email ? " · " : ""}${p.email ? `<a href="mailto:${escapeHtml(p.email)}">email</a>` : (!p.phone ? "—" : "")}</td>
      <td class="hint">${unavailableBadgeHtml(p)}${escapeHtml(p.availability || "—")}</td>
      <td class="hint">${escapeHtml(p.subjects || "—")}</td>
      <td class="mono">${p.count}</td>
      <td class="mono">${p.last ? fmtDateShort(p.last) : "—"}</td>
      <td><button class="btn btn-sm" data-assign="${escapeHtml(p.name)}">Assign</button></td>
    </tr>`;

  box.innerHTML = `
    ${reliefDirSort.key ? `<div class="hint" style="margin-bottom:6px;">Sorted by ${escapeHtml(reliefDirSort.key)} — <a href="#" id="reliefDirSortReset">reset to least-recently-used</a>.</div>` : ""}
    ${isDefaultView && favCount ? `<div class="hint" style="margin-bottom:6px;">${icon("star","mini-icon")}Pinned contacts shown first — click the star on anyone to pin or unpin them.</div>` : ""}
    <div class="table-wrap"><table>
    <thead><tr>
      <th class="sortable" data-sort-key="firstName">First name${sortArrow(reliefDirSort,"firstName")}</th>
      <th class="sortable" data-sort-key="lastName">Surname${sortArrow(reliefDirSort,"lastName")}</th>
      <th>Contact</th>
      <th class="sortable" data-sort-key="availability">Availability${sortArrow(reliefDirSort,"availability")}</th>
      <th class="sortable" data-sort-key="subjects">Subjects${sortArrow(reliefDirSort,"subjects")}</th>
      <th class="sortable" data-sort-key="count">Used${sortArrow(reliefDirSort,"count")}</th>
      <th class="sortable" data-sort-key="last">Last used${sortArrow(reliefDirSort,"last")}</th>
      <th></th>
    </tr></thead>
    <tbody>${visiblePool.map(rowHtml).join("")}</tbody>
  </table></div>
  ${hiddenCount > 0 ? `<div style="text-align:center; margin-top:10px;"><button class="btn btn-sm" id="reliefDirExpandBtn">Show ${hiddenCount} more ${icon("down","mini-icon")}</button></div>` : ""}
  ${isDefaultView && reliefDirExpanded && favCount ? `<div style="text-align:center; margin-top:10px;"><button class="btn btn-sm" id="reliefDirCollapseBtn">Show pinned only</button></div>` : ""}
  `;

  wireSortHeaders(box, reliefDirSort, () => renderReliefPool(document.getElementById("reliefDirSearch").value));
  const resetLink = document.getElementById("reliefDirSortReset");
  if(resetLink) resetLink.addEventListener("click", e => {
    e.preventDefault(); reliefDirSort = { key: null, dir: 1 };
    renderReliefPool(document.getElementById("reliefDirSearch").value);
  });
  const expandBtn = document.getElementById("reliefDirExpandBtn");
  if(expandBtn) expandBtn.addEventListener("click", () => { reliefDirExpanded = true; renderReliefPool(document.getElementById("reliefDirSearch").value); });
  const collapseBtn = document.getElementById("reliefDirCollapseBtn");
  if(collapseBtn) collapseBtn.addEventListener("click", () => { reliefDirExpanded = false; renderReliefPool(document.getElementById("reliefDirSearch").value); });

  box.querySelectorAll("[data-fav-toggle]").forEach(b => b.addEventListener("click", () => {
    const contact = state.relief.externalPool.find(x => x.id === b.dataset.favToggle);
    if(!contact) return;
    contact.favorite = !contact.favorite;
    persist();
    renderReliefPool(document.getElementById("reliefDirSearch").value);
  }));

  box.querySelectorAll("[data-assign]").forEach(b => b.addEventListener("click", () => {
    const field = document.getElementById("rf-relief");
    field.value = b.dataset.assign;
    field.scrollIntoView({ behavior: "smooth", block: "center" });
    field.focus();
    toast(`${b.dataset.assign} set as relief — finish logging the absence above.`);
  }));
}

/** Reusable multi-select chip row for filtering by subject tag. */
function renderSubjectChips(container, tags, selectedSet, onChange){
  if(!tags.length){ container.innerHTML = ""; return; }
  container.innerHTML = tags.map(tag => `
    <button type="button" class="chip ${selectedSet.has(tag) ? "chip-active" : ""}" data-chip="${escapeHtml(tag)}">${escapeHtml(tag)}</button>
  `).join("") + (selectedSet.size ? `<button type="button" class="chip chip-clear" id="${container.id}ClearBtn">Clear (${selectedSet.size})</button>` : "");
  container.querySelectorAll("[data-chip]").forEach(b => b.addEventListener("click", () => {
    const t = b.dataset.chip;
    if(selectedSet.has(t)) selectedSet.delete(t); else selectedSet.add(t);
    onChange();
  }));
  const clearBtn = document.getElementById(container.id + "ClearBtn");
  if(clearBtn) clearBtn.addEventListener("click", () => { selectedSet.clear(); onChange(); });
}

/** The relief log entries currently matching the search text + date-range
 * filters (if any active) -- shared by the on-screen log list and CSV
 * export, so "export what's shown" genuinely exports what's shown. */
function filteredReliefEntries(){
  const f = (document.getElementById("reliefSearch")?.value || "").trim().toLowerCase();
  const from = document.getElementById("reliefFromDate")?.value || "";
  const to = document.getElementById("reliefToDate")?.value || "";
  let entries = state.relief.log;
  if(f) entries = entries.filter(r => `${r.absentStaffName} ${allRelieverNames(r).join(" ")} ${r.reason} ${r.notes}`.toLowerCase().includes(f));
  if(from) entries = entries.filter(r => r.date >= from);
  if(to) entries = entries.filter(r => r.date <= to);
  return entries;
}

function renderReliefLog(){
  const box = document.getElementById("reliefLog");
  const entries = filteredReliefEntries();
  const filtersActive = !!(document.getElementById("reliefSearch")?.value.trim() || document.getElementById("reliefFromDate")?.value || document.getElementById("reliefToDate")?.value);

  if(!entries.length){
    box.innerHTML = `<div class="empty-state">${icon("inbox")}<div>${filtersActive ? "No entries match your search or date filter." : "No relief entries yet. Log an absence above to get started."}</div></div>`;
    return;
  }

  // Newest date first, oldest date at the bottom -- dates are ISO
  // (YYYY-MM-DD) strings so a plain string comparison sorts chronologically.
  const sorted = entries.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  box.innerHTML = `<div class="list">${sorted.map(r => {
    const sessLabel = r.type === "duty" ? "Duty" : r.type === "full-day" ? "Full day" : `S${(r.sessions||[]).map(i=>i+1).join(",")||"?"}`;
    return `<div class="item">
      <div class="item-main">
        <div class="item-title">${escapeHtml(r.absentStaffName)} <span class="badge badge-flag">${escapeHtml(sessLabel)}</span></div>
        <div class="item-sub mono">${fmtDateShort(r.date)} · ${reliefSummaryText(r) ? "Relief: " + escapeHtml(reliefSummaryText(r)) : "No relief assigned"} · ${escapeHtml(r.reason||"")}${allRelieverNames(r).length === 1 ? contactLinksHtml(allRelieverNames(r)[0]) : ""}</div>
        ${r.attachments && r.attachments.length ? `<div class="item-sub">${attachmentLinksHtml(r.attachments)}</div>` : ""}
      </div>
      <div class="item-actions">
        <button class="btn btn-sm" data-out="${r.id}">${icon("copy")} Outputs</button>
        <button class="btn btn-sm" data-edit="${r.id}">${icon("edit")} Edit</button>
        <button class="btn btn-sm btn-danger" data-del="${r.id}">${icon("trash")}</button>
      </div>
    </div>`;
  }).join("")}</div>`;

  box.querySelectorAll("[data-out]").forEach(b => b.addEventListener("click", () => {
    const r = state.relief.log.find(x => x.id === b.dataset.out);
    if(r){ document.getElementById("reliefOutputCard").scrollIntoView({behavior:"smooth"}); openReliefOutputs(r); }
  }));
  box.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => {
    const r = state.relief.log.find(x => x.id === b.dataset.edit);
    if(r) populateReliefFormForEdit(r);
  }));
  box.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
    if(!confirm("Remove this relief entry?")) return;
    const removedIdx = state.relief.log.findIndex(x => x.id === b.dataset.del);
    if(removedIdx === -1) return;
    const [removed] = state.relief.log.splice(removedIdx, 1);
    persist(); renderReliefLog(); renderReliefPool(); renderReliefStats(); renderLeaveTallies();
    toast("Relief entry removed.", { actionLabel: "Undo", onAction: () => {
      state.relief.log.splice(Math.min(removedIdx, state.relief.log.length), 0, removed);
      persist(); renderReliefLog(); renderReliefPool(); renderReliefStats(); renderLeaveTallies();
      toast("Restored.");
    }});
  }));
}

/** Wraps a CSV field in quotes and escapes internal quotes, but only when
 * the value actually needs it (contains a comma, quote, or line break). */
function csvField(val){
  const s = String(val ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}

/** Downloads whatever's currently shown in the relief log (respecting the
 * search text + date-range filters) as a CSV -- oldest first, since that
 * reads better as a term/year record than the log's on-screen newest-first
 * order. Uses the same column set as Settings' relief spreadsheet columns. */
function exportReliefLogCsv(){
  const entries = filteredReliefEntries().slice().sort((a,b) => (a.date||"").localeCompare(b.date||""));
  if(!entries.length){ toast("No relief entries to export."); return; }
  const leader = state.meta.leaderName || "";
  const cols = state.settings.relief.columns;
  const rows = entries.map(r => { const v = reliefRowValues(r, leader); return cols.map(c => v[c] ?? ""); });
  const csv = [cols, ...rows].map(row => row.map(csvField).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `relief-log-${todayISO()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast(`Exported ${entries.length} ${entries.length === 1 ? "entry" : "entries"} to CSV.`);
}

/** Fills the "Log an absence" form with an existing entry's values and
 * switches it into edit mode - reuses the same form/validation as adding
 * a new one, so editing gets every field (including the classes panel and
 * suggested-relief chips) for free. */
function populateReliefFormForEdit(r){
  showTab("relief");
  reliefEditingId = r.id;

  const staffSel = document.getElementById("rf-staff");
  const isKnownStaff = [...staffSel.options].some(o => o.value === r.absentStaffName);
  staffSel.value = isKnownStaff ? r.absentStaffName : "__other";
  staffSel.dispatchEvent(new Event("change"));
  if(!isKnownStaff) document.getElementById("rf-staff-other").value = r.absentStaffName;

  document.getElementById("rf-date").value = r.date;
  document.getElementById("rf-type").value = r.type;
  document.getElementById("rf-type").dispatchEvent(new Event("change"));
  (r.sessions || []).forEach(i => {
    const cb = document.querySelector(`.rf-sess-cb[value="${i}"]`);
    if(cb){ cb.checked = true; cb.dispatchEvent(new Event("change", {bubbles:true})); }
  });

  document.getElementById("rf-room").value = r.room || "";
  const hasSplit = !!(r.relievers && r.relievers.length);
  document.getElementById("rf-relief").value = hasSplit ? "" : (r.reliefStaffName || "");
  const splitCb = document.getElementById("rf-split-relief");
  if(splitCb){
    splitCb.checked = hasSplit;
    splitCb.dispatchEvent(new Event("change", {bubbles:true}));
    if(hasSplit){
      r.relievers.forEach(g => (g.sessions||[]).forEach(i => {
        const inp = document.querySelector(`[data-sess-relief="${i}"]`);
        if(inp) inp.value = g.name;
      }));
    }
  }
  document.getElementById("rf-reason").value = r.reason || "Personal / sick leave";
  document.getElementById("rf-notes").value = r.notes || "";
  reliefPendingAttachments = [...(r.attachments || [])];
  renderPendingAttachments();

  document.getElementById("reliefFormHeading").innerHTML = `${icon("edit")} Edit absence`;
  document.getElementById("reliefSubmitBtn").innerHTML = `${icon("check")} Save changes`;
  document.getElementById("reliefCancelEditBtn").style.display = "";

  document.getElementById("reliefForm").scrollIntoView({ behavior: "smooth" });
}

/** classGrid/taGrid use a "real teaching session" index that skips
 * Wednesday's Support Group gap — this converts an app session index
 * (which DOES include the SG slot at position 2) to that grid index.
 * Returns null for Wednesday's SG slot itself, which has no class data. */
function gridSessionIndex(dayKey, appSessionIdx){
  if(dayKey === "wednesday"){
    if(appSessionIdx === 2) return null;
    if(appSessionIdx === 3) return 2;
  }
  return appSessionIdx;
}
function classGridFor(dayKey, appSessionIdx){
  const gi = gridSessionIndex(dayKey, appSessionIdx);
  if(gi === null) return [];
  return state.timetable.classGrid.filter(c => c.day === dayKey && c.session === gi);
}
function taGridFor(dayKey, appSessionIdx){
  const gi = gridSessionIndex(dayKey, appSessionIdx);
  if(gi === null) return [];
  return state.timetable.taGrid.filter(t => t.day === dayKey && t.session === gi);
}
/** What a specific teacher is teaching today (day) — used by both the
 * Dashboard and the Relief form. */
function classesForTeacherToday(teacherName, dayKey){
  if(!dayKey) return [];
  const dayInfo = state.timetable.days[dayKey];
  const times = state.timetable.times[dayInfo.kind];
  const out = [];
  times.forEach((t, i) => {
    const entry = classGridFor(dayKey, i).find(c => c.teacher === teacherName);
    if(entry) out.push({ sessionIdx: i, sessionLabel: t[0], time: `${t[1]}–${t[2]}`, ...entry });
  });
  return out;
}

/* ---------------------------------------------------------------------- */
/* Timetable modal — a teacher's full week, a TA's full week, or the      */
/* whole TA roster for the week, built from classGrid/taGrid.             */
/* ---------------------------------------------------------------------- */
function openTimetableModal(title, bodyHtml){
  document.getElementById("timetableModalTitle").textContent = title;
  document.getElementById("timetableModalBody").innerHTML = bodyHtml;
  document.getElementById("timetableModalBackdrop").classList.add("show");
}
function closeTimetableModal(){
  document.getElementById("timetableModalBackdrop").classList.remove("show");
}

function daySectionHtml(dayKey, rowsHtml, headCols){
  return `<h3 style="margin:16px 0 6px;">${DAY_LABEL[dayKey]}</h3>
    <div class="table-wrap"><table>
      <thead><tr>${headCols.map(h=>`<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table></div>`;
}

/** One teacher's timetable across the whole week — every session, with
 * "Free period" / "Support Group" shown for gaps rather than skipped, so
 * the full shape of their week is visible, not just the booked slots. */
function showTeacherTimetable(name){
  const body = DAY_ORDER.map(dayKey => {
    const dayInfo = state.timetable.days[dayKey];
    const times = state.timetable.times[dayInfo.kind];
    const bySession = {};
    classesForTeacherToday(name, dayKey).forEach(c => { bySession[c.sessionIdx] = c; });
    const rows = times.map((t, i) => {
      const c = bySession[i];
      const isSG = /support group/i.test(dayInfo.lines[i]);
      const cell = c ? escapeHtml(c.subject) : (isSG ? `<span class="hint">Support Group</span>` : `<span class="hint">Free period</span>`);
      return `<tr><td class="mono">${escapeHtml(t[0])}</td><td class="mono">${escapeHtml(t[1])}–${escapeHtml(t[2])}</td><td>${cell}</td><td class="mono">${c ? escapeHtml(c.room||"—") : "—"}</td></tr>`;
    }).join("");
    return daySectionHtml(dayKey, rows, ["S","Time","Subject","Room"]);
  }).join("");
  openTimetableModal(`${name} — timetable`, body);
}

/** One TA's timetable across the whole week (subject + which line, no
 * room — the source data doesn't track rooms for TA coverage). */
function showTaTimetable(name){
  const body = DAY_ORDER.map(dayKey => {
    const dayInfo = state.timetable.days[dayKey];
    const times = state.timetable.times[dayInfo.kind];
    const rows = times.map((t, i) => {
      const entries = taGridFor(dayKey, i).filter(x => x.ta === name);
      const isSG = /support group/i.test(dayInfo.lines[i]);
      const cell = entries.length ? entries.map(e => escapeHtml(e.subject)).join(", ") : (isSG ? `<span class="hint">Support Group</span>` : `<span class="hint">Free period</span>`);
      return `<tr><td class="mono">${escapeHtml(t[0])}</td><td class="mono">${escapeHtml(t[1])}–${escapeHtml(t[2])}</td><td>${cell}</td><td class="mono">${escapeHtml(dayInfo.lines[i])}</td></tr>`;
    }).join("");
    return daySectionHtml(dayKey, rows, ["S","Time","Subject","Line"]);
  }).join("");
  openTimetableModal(`${name} — timetable (TA)`, body);
}

/** Every TA's coverage for the whole week, organised by day/session/line
 * — the "who's where" view, as opposed to one TA's own week. */
/** Every teacher's classes for the whole week, organised by day/session/line
 * — the "who's teaching what, where" view, parallel to showFullTaTimetable. */
function showFullStaffTimetable(){
  const body = DAY_ORDER.map(dayKey => {
    const dayInfo = state.timetable.days[dayKey];
    const times = state.timetable.times[dayInfo.kind];
    const rows = times.map((t, i) => {
      const entries = classGridFor(dayKey, i);
      const isSG = /support group/i.test(dayInfo.lines[i]);
      const cell = entries.length
        ? entries.map(e => `${escapeHtml(e.teacher)} — ${escapeHtml(e.subject)}${e.room ? " (" + escapeHtml(e.room) + ")" : ""}`).join("<br>")
        : (isSG ? `<span class="hint">Support Group</span>` : `<span class="hint">—</span>`);
      return `<tr><td class="mono">${escapeHtml(t[0])}</td><td class="mono">${escapeHtml(t[1])}–${escapeHtml(t[2])}</td><td class="mono">${escapeHtml(dayInfo.lines[i])}</td><td>${cell}</td></tr>`;
    }).join("");
    return daySectionHtml(dayKey, rows, ["S","Time","Line","Teacher — Subject (Room)"]);
  }).join("");
  openTimetableModal("Staff timetable — whole week", body);
}

function showFullTaTimetable(){
  const body = DAY_ORDER.map(dayKey => {
    const dayInfo = state.timetable.days[dayKey];
    const times = state.timetable.times[dayInfo.kind];
    const rows = times.map((t, i) => {
      const entries = taGridFor(dayKey, i);
      const isSG = /support group/i.test(dayInfo.lines[i]);
      const cell = entries.length ? entries.map(e => `${escapeHtml(e.ta)} — ${escapeHtml(e.subject)}`).join("<br>") : (isSG ? `<span class="hint">Support Group</span>` : `<span class="hint">—</span>`);
      return `<tr><td class="mono">${escapeHtml(t[0])}</td><td class="mono">${escapeHtml(t[1])}–${escapeHtml(t[2])}</td><td class="mono">${escapeHtml(dayInfo.lines[i])}</td><td>${cell}</td></tr>`;
    }).join("");
    return daySectionHtml(dayKey, rows, ["S","Time","Line","TA — Subject"]);
  }).join("");
  openTimetableModal("TA timetable — whole week", body);
}

/** Normalises a relief log entry's assigned reliever(s) into a uniform
 * list of {name, sessions} groups -- the one place every other function
 * should go through, so they all stay aware of split coverage for free.
 * Most entries are just one person covering the whole absence (from
 * reliefStaffName); the optional relievers[] array lets different people
 * cover different sessions of the same "specific session(s)" absence. */
function relieverGroupsFor(r){
  if(r.relievers && r.relievers.length) return r.relievers.filter(g => g.name);
  if(r.reliefStaffName) return [{ name: r.reliefStaffName, sessions: r.sessions || [] }];
  return [];
}

/** Every distinct reliever name on an absence, split or not -- used for
 * search, "who's covering most" stats, and the relief pool's
 * least-recently-used sort/use-count. */
function allRelieverNames(r){
  return [...new Set(relieverGroupsFor(r).map(g => g.name))];
}

/** "S1" / "S2,3" style label for a set of session indices (1-based, sorted). */
function sessionLabelList(sessions){
  if(!sessions || !sessions.length) return "?";
  return "S" + sessions.slice().sort((a,b)=>a-b).map(i=>i+1).join(",");
}

/** Human-readable "who's covering what": just a name for the common single
 * -reliever case, or "Jo Bloggs (S1), Jane Smith (S2,3)" when split. */
function reliefSummaryText(r){
  const groups = relieverGroupsFor(r);
  if(!groups.length) return "";
  if(!(r.relievers && r.relievers.length)) return groups[0].name;
  return groups.map(g => `${g.name} (${sessionLabelList(g.sessions)})`).join(", ");
}

function sessionDescriptionFor(r){
  const dayKey = dayKeyFromISO(r.date);
  if(!dayKey) return { text: "", lines: [] };
  const dayInfo = state.timetable.days[dayKey];
  const times = state.timetable.times[dayInfo.kind];
  if(r.type === "duty") return { text: "duty", lines: [] };
  if(r.type === "full-day") return { text: "all sessions (full day)", lines: dayInfo.lines };
  const idxs = r.sessions && r.sessions.length ? r.sessions : times.map((_,i)=>i);
  const parts = idxs.map(i => `S${times[i][0]} ${times[i][1]}–${times[i][2]} (${dayInfo.lines[i]})`);
  return { text: parts.join(", "), lines: idxs.map(i => dayInfo.lines[i]) };
}

/** The named-column values for one relief entry, keyed exactly like
 * state.settings.relief.columns -- shared by the per-entry "Spreadsheet
 * row" output and the whole-log CSV export so both stay in sync. */
function reliefRowValues(r, leader){
  const sess = sessionDescriptionFor(r);
  return {
    "Date": r.date, "Absent Staff": r.absentStaffName, "Type": r.type, "Session(s)": sess.text,
    "Line/Class": sess.lines.join("; "), "Relief Staff": reliefSummaryText(r), "Reason": r.reason || "",
    "Notes": r.notes || "", "Entered By": leader,
  };
}

/** One consolidated page for every absence today — for the staffroom wall
 * or front office, distinct from the per-absence cover sheet. */
function printTodaysCoverage(){
  const today = todayISO();
  const entries = state.relief.log.filter(r => r.date === today);
  const el = document.getElementById("printSheet");
  el.innerHTML = `
    <div class="print-sheet">
      <h1>Today's Coverage</h1>
      <p>${escapeHtml(state.meta.schoolName)} · ${escapeHtml(state.meta.learningArea)} · ${fmtDateLong(today)}</p>
      ${entries.length ? `<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%;">
        <tr><th>Absent</th><th>Sessions</th><th>Relief</th><th>Room</th><th>Notes</th></tr>
        ${entries.map(r => {
          const sess = sessionDescriptionFor(r);
          return `<tr><td>${escapeHtml(r.absentStaffName)}</td><td>${escapeHtml(sess.text)}</td><td>${escapeHtml(reliefSummaryText(r) || "TBC")}</td><td>${escapeHtml(r.room || "—")}</td><td>${escapeHtml(r.notes || "—")}</td></tr>`;
        }).join("")}
      </table>` : `<p>No absences logged for today.</p>`}
      <p class="pfoot">Printed ${new Date().toLocaleString("en-AU")}</p>
    </div>
  `;
  window.print();
}

/** One page for the whole current school week (Mon-Fri), grouped by day --
 * same shape as "Today's coverage" but for planning a busy week ahead
 * rather than the daily staffroom sheet. */
function printWeekCoverage(){
  const weekDates = currentWeekDates();
  const el = document.getElementById("printSheet");
  el.innerHTML = `
    <div class="print-sheet">
      <h1>This Week's Coverage</h1>
      <p>${escapeHtml(state.meta.schoolName)} · ${escapeHtml(state.meta.learningArea)} · ${fmtDateLong(weekDates[0])} – ${fmtDateLong(weekDates[4])}</p>
      ${weekDates.map(date => {
        const entries = state.relief.log.filter(r => r.date === date);
        return `<h2 style="margin-top:16px;">${fmtDateLong(date)}</h2>
          ${entries.length ? `<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%;">
            <tr><th>Absent</th><th>Sessions</th><th>Relief</th><th>Room</th><th>Notes</th></tr>
            ${entries.map(r => {
              const sess = sessionDescriptionFor(r);
              return `<tr><td>${escapeHtml(r.absentStaffName)}</td><td>${escapeHtml(sess.text)}</td><td>${escapeHtml(reliefSummaryText(r) || "TBC")}</td><td>${escapeHtml(r.room || "—")}</td><td>${escapeHtml(r.notes || "—")}</td></tr>`;
            }).join("")}
          </table>` : `<p>No absences logged.</p>`}`;
      }).join("")}
      <p class="pfoot">Printed ${new Date().toLocaleString("en-AU")}</p>
    </div>
  `;
  window.print();
}

/** Per-absent-staff-member leave tallies over a set of relief.log entries
 * -- total entries plus a breakdown by reason, sorted by total descending.
 * Shared by the always-visible "this year" widget on the Relief tab and
 * the term/year summary report (fed whatever date range it's scoped to).
 * Counts each LOGGED ENTRY as one instance, not a fractional day -- a
 * "Specific session(s)" entry counts the same as a full day, so treat this
 * as a count of absences logged, not a precise day tally. */
function leaveTalliesByStaff(entries){
  const byStaff = {};
  entries.forEach(r => {
    const name = r.absentStaffName;
    if(!byStaff[name]) byStaff[name] = { name, total: 0, byReason: {} };
    byStaff[name].total++;
    const k = r.reason || "Unspecified";
    byStaff[name].byReason[k] = (byStaff[name].byReason[k] || 0) + 1;
  });
  return Object.values(byStaff).sort((a,b) => b.total - a.total);
}
function leaveTallyBreakdownText(tally){
  return Object.entries(tally.byReason).sort((a,b) => b[1]-a[1]).map(([k,v]) => `${k}: ${v}`).join(", ");
}

/** This term's relief numbers — absences, reasons, who's covering most,
 * pending pay entries. Bounded to the current term's date range if we're
 * in one, otherwise shows everything logged. */
function renderReliefStats(){
  const box = document.getElementById("reliefStats");
  if(!box) return;
  const ti = currentTermInfo();
  let entries = state.relief.log;
  let scopeLabel = "logged";
  if(ti.inTerm){
    const term = state.settings.terms.find(t => t.number === ti.number);
    entries = entries.filter(r => r.date >= term.startDate && r.date <= term.endDate);
    scopeLabel = `Term ${ti.number}`;
  }

  const byReason = {};
  entries.forEach(r => { const k = r.reason || "Unspecified"; byReason[k] = (byReason[k] || 0) + 1; });
  const topReasons = Object.entries(byReason).sort((a,b) => b[1] - a[1]);

  const byReliever = {};
  entries.forEach(r => { allRelieverNames(r).forEach(name => { byReliever[name] = (byReliever[name] || 0) + 1; }); });
  const topRelievers = Object.entries(byReliever).sort((a,b) => b[1] - a[1]).slice(0, 6);

  const rowHtml = (label, count) => `
    <div class="item" style="padding:7px 10px;">
      <div class="item-main" style="display:flex; justify-content:space-between; align-items:center;">
        <span>${escapeHtml(label)}</span><span class="mono badge badge-muted">${count}</span>
      </div>
    </div>`;

  box.innerHTML = `
    <div class="row" style="gap:10px; margin-bottom:14px;">
      <div class="stat-tile" style="flex:1;"><div class="stat-num mono">${entries.length}</div><div class="stat-label">Absences ${escapeHtml(scopeLabel)}</div></div>
      <div class="stat-tile" style="flex:1;"><div class="stat-num mono">${Object.keys(byReliever).length}</div><div class="stat-label">People covering</div></div>
    </div>
    <div class="grid grid-2">
      <div><h3 style="margin-bottom:6px;">By reason</h3>${topReasons.length ? topReasons.map(([r,c]) => rowHtml(r,c)).join("") : `<div class="hint">No data yet.</div>`}</div>
      <div><h3 style="margin-bottom:6px;">Most-used relief</h3>${topRelievers.length ? topRelievers.map(([n,c]) => rowHtml(n,c)).join("") : `<div class="hint">No data yet.</div>`}</div>
    </div>
  `;
}

/** Always-on-screen leave tally per absent staff member, scoped to the
 * current calendar year -- distinct from the printable term/year summary
 * report, which can cover any chosen term or the whole year on demand. */
function renderLeaveTallies(){
  const box = document.getElementById("leaveTallies");
  if(!box) return;
  const year = new Date().getFullYear();
  const entries = state.relief.log.filter(r => r.date && r.date.slice(0,4) === String(year));
  const tallies = leaveTalliesByStaff(entries);
  if(!tallies.length){ box.innerHTML = `<div class="hint">No absences logged in ${year} yet.</div>`; return; }
  box.innerHTML = `<div class="list">${tallies.map(t => `
    <div class="item" style="padding:7px 10px;">
      <div class="item-main" style="display:flex; justify-content:space-between; align-items:baseline; gap:10px;">
        <span>${escapeHtml(t.name)}</span><span class="mono badge badge-muted">${t.total}</span>
      </div>
      <div class="hint">${escapeHtml(leaveTallyBreakdownText(t))}</div>
    </div>
  `).join("")}</div>`;
}

/** Resolves the Settings report scope-picker's value to a concrete date
 * range + label -- either a configured term, or the whole current
 * calendar year. */
function summaryReportRange(scope){
  if(scope === "whole-year"){
    const y = new Date().getFullYear();
    return { label: `${y} — whole year`, start: `${y}-01-01`, end: `${y}-12-31` };
  }
  const term = state.settings.terms.find(t => String(t.number) === String(scope));
  if(!term) return null;
  return { label: `Term ${term.number} (${fmtDateShort(term.startDate)}–${fmtDateShort(term.endDate)})`, start: term.startDate, end: term.endDate };
}

/** Printable term/year summary: relief absences (with leave tallies per
 * staff member), meetings held, and task completion -- for line-manager
 * conversations or your own record. Reuses the same #printSheet target
 * as every other print action, so it works from any tab. */
function generateSummaryReport(scope){
  const range = summaryReportRange(scope);
  if(!range){ toast("Pick a valid report scope."); return; }

  const relief = state.relief.log.filter(r => r.date >= range.start && r.date <= range.end);
  const byReason = {};
  relief.forEach(r => { const k = r.reason || "Unspecified"; byReason[k] = (byReason[k]||0)+1; });
  const topReasons = Object.entries(byReason).sort((a,b)=>b[1]-a[1]);
  const byReliever = {};
  relief.forEach(r => { allRelieverNames(r).forEach(n => { byReliever[n] = (byReliever[n]||0)+1; }); });
  const topRelievers = Object.entries(byReliever).sort((a,b)=>b[1]-a[1]);
  const tallies = leaveTalliesByStaff(relief);

  const meetings = state.meetings.items.filter(m => m.date >= range.start && m.date <= range.end).sort((a,b)=>a.date.localeCompare(b.date));
  const meetingsByType = {};
  meetings.forEach(m => { meetingsByType[m.type] = (meetingsByType[m.type]||0)+1; });

  const tasksInRange = state.tasks.filter(t => t.createdAt && t.createdAt.slice(0,10) >= range.start && t.createdAt.slice(0,10) <= range.end);
  const tasksDone = tasksInRange.filter(t => t.status === "done").length;
  const completionRate = tasksInRange.length ? Math.round((tasksDone / tasksInRange.length) * 100) : null;

  const rowsHtml = (pairs) => pairs.length
    ? `<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%;">${pairs.map(([k,v]) => `<tr><td>${escapeHtml(k)}</td><td class="mono" style="text-align:right;">${v}</td></tr>`).join("")}</table>`
    : `<p>No data.</p>`;

  const el = document.getElementById("printSheet");
  el.innerHTML = `
    <div class="print-sheet">
      <h1>Summary Report — ${escapeHtml(range.label)}</h1>
      <p>${escapeHtml(state.meta.schoolName)} · ${escapeHtml(state.meta.learningArea)} · ${escapeHtml(state.meta.leaderName || "")}</p>

      <h2 style="margin-top:18px;">Relief absences</h2>
      <p>${relief.length} absence${relief.length===1?"":"s"} logged, covered by ${Object.keys(byReliever).length} ${Object.keys(byReliever).length===1?"person":"people"}.</p>
      <div class="grid grid-2">
        <div><h3>By reason</h3>${rowsHtml(topReasons)}</div>
        <div><h3>By reliever</h3>${rowsHtml(topRelievers)}</div>
      </div>
      <h3 style="margin-top:10px;">Leave tallies by staff member</h3>
      ${tallies.length ? `<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%;">
        <tr><th>Staff</th><th>Total</th><th>Breakdown</th></tr>
        ${tallies.map(t => `<tr><td>${escapeHtml(t.name)}</td><td class="mono">${t.total}</td><td>${escapeHtml(leaveTallyBreakdownText(t))}</td></tr>`).join("")}
      </table>` : `<p>No data.</p>`}

      <h2 style="margin-top:18px;">Meetings held</h2>
      <p>${meetings.length} meeting${meetings.length===1?"":"s"} in this period.</p>
      ${meetingsByType && Object.keys(meetingsByType).length ? rowsHtml(Object.entries(meetingsByType).sort((a,b)=>b[1]-a[1])) : ""}
      ${meetings.length ? `<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%; margin-top:8px;">
        <tr><th>Date</th><th>Type</th><th>Focus</th></tr>
        ${meetings.map(m => `<tr><td class="mono">${fmtDateShort(m.date)}</td><td>${escapeHtml(m.type)}</td><td>${escapeHtml(m.focus||"—")}</td></tr>`).join("")}
      </table>` : ""}

      <h2 style="margin-top:18px;">Tasks</h2>
      <p>${tasksInRange.length} task${tasksInRange.length===1?"":"s"} created in this period, ${tasksDone} completed${completionRate!==null ? ` (${completionRate}% completion rate, as at time of printing)` : ""}.</p>

      <p class="pfoot">Printed ${new Date().toLocaleString("en-AU")}</p>
    </div>
  `;
  window.print();
}

/** Search across tasks, relief log, meetings, team/relief pool and the
 * Teams upload queue — feeds the Dashboard's "Search this app" box. */
function globalSearch(query){
  const q = query.trim().toLowerCase();
  if(!q) return [];
  const results = [];
  state.tasks.forEach(t => { if(`${t.title} ${t.notes}`.toLowerCase().includes(q)) results.push({ type: "Task", label: t.title, tab: "tasks" }); });
  state.relief.log.forEach(r => { if(`${r.absentStaffName} ${allRelieverNames(r).join(" ")} ${r.reason||""} ${r.notes||""}`.toLowerCase().includes(q)) results.push({ type: "Relief", label: `${r.absentStaffName} — ${fmtDateShort(r.date)}`, tab: "relief" }); });
  state.meetings.items.forEach(m => { if(`${m.type} ${m.focus} ${m.minutes||""}`.toLowerCase().includes(q)) results.push({ type: "Meeting", label: `${m.type} — ${m.focus} (${fmtDateShort(m.date)})`, tab: "meetings" }); });
  reliefCandidateObjects().forEach(c => { if(`${c.name} ${c.subjects||""} ${c.availability||""}`.toLowerCase().includes(q)) results.push({ type: c.isTeam ? "Team" : "Relief pool", label: c.name, tab: c.isTeam ? "team" : "relief" }); });
  state.files.queue.forEach(f => { if(`${f.fileName} ${f.destination}`.toLowerCase().includes(q)) results.push({ type: "Teams queue", label: f.fileName, tab: "team" }); });
  return results.slice(0, 10);
}

/** The absent teacher's actual classes for the affected session(s), pulled
 * from classGrid — empty if there's no class data for them that day (e.g.
 * "Other" staff, a non-teaching duty, or the published copy with no
 * local-seed.js), in which case the message just omits this detail. */
function classesToCoverFor(r){
  const dayKey = dayKeyFromISO(r.date);
  if(!dayKey || r.type === "duty") return [];
  const all = classesForTeacherToday(r.absentStaffName, dayKey);
  if(r.type === "sessions" && r.sessions && r.sessions.length){
    return all.filter(c => r.sessions.includes(c.sessionIdx));
  }
  return all;
}

function openReliefOutputs(r){
  const card = document.getElementById("reliefOutputCard");
  card.style.display = "";
  const leader = state.meta.leaderName || "[Your name]";
  const leaderFirst = leader.split(" ")[0];
  const school = state.meta.schoolName;
  const isSplit = !!(r.relievers && r.relievers.length);
  const groups = relieverGroupsFor(r); // [{name, sessions}] -- one entry, or one per reliever when split
  const fullSess = sessionDescriptionFor(r);
  const summaryName = reliefSummaryText(r);

  /** Session description + classes-to-cover scoped to one reliever's own
   * sessions when coverage is split, or the whole absence otherwise. */
  function scopeFor(group){
    if(!isSplit || !group) return { sess: fullSess, classes: classesToCoverFor(r) };
    const dayKey = dayKeyFromISO(r.date);
    const dayInfo = state.timetable.days[dayKey];
    const times = state.timetable.times[dayInfo.kind];
    const idxs = (group.sessions||[]).slice().sort((a,b)=>a-b);
    const sess = { text: idxs.map(i => `S${times[i][0]} ${times[i][1]}–${times[i][2]} (${dayInfo.lines[i]})`).join(", "), lines: idxs.map(i => dayInfo.lines[i]) };
    const all = dayKey ? classesForTeacherToday(r.absentStaffName, dayKey) : [];
    return { sess, classes: all.filter(c => idxs.includes(c.sessionIdx)) };
  }

  /** SMS/email text addressed to one specific reliever (or nobody yet). */
  function messagesFor(group){
    const { sess, classes } = scopeFor(group);
    const name = group ? group.name : "";
    const classesShort = classes.length ? classes.map(c => `S${c.sessionLabel} ${c.subject}${c.room ? " (" + c.room + ")" : ""}`).join("; ") : "";
    const classesLines = classes.length ? classes.map(c => `  • S${c.sessionLabel} (${c.time}): ${c.subject}${c.room ? " — Room " + c.room : ""}`).join("\n") : "";

    const smsText = `Hi${name ? " " + name.split(" ")[0] : ""}, can you cover ${r.absentStaffName} on ${fmtDateShort(r.date)} — ${sess.text}${r.room ? " in " + r.room : ""}?${classesShort ? ` Classes: ${classesShort}.` : ""} ${r.notes ? r.notes + " " : ""}Thanks, ${leaderFirst}`;

    const mailSubject = `Relief cover needed — ${r.absentStaffName} — ${fmtDateShort(r.date)}`;
    const attachReminder = (r.attachments && r.attachments.length)
      ? `Please remember to attach ${r.attachments.map(a=>a.name).join(", ")} before sending this email — mailto links can't attach files automatically, so download ${r.attachments.length === 1 ? "it" : "them"} from the app first.`
      : `Please remember to attach the relief notes${r.notes ? "" : " (if the absent teacher has sent them)"} before sending this email — mailto links can't attach files automatically.`;
    const mailBody = `Hi${name ? " " + name.split(" ")[0] : ""},\n\n${r.absentStaffName} is away on ${fmtDateLong(r.date)} and needs cover for: ${sess.text}${r.room ? " in " + r.room : ""}.\n${classesLines ? "\nClasses to cover:\n" + classesLines + "\n" : ""}\nReason: ${r.reason || "—"}\n${r.notes ? "Notes: " + r.notes + "\n" : ""}\n${attachReminder}\n\nThanks,\n${leaderFirst}\n${school}`;
    const mailto = `mailto:?subject=${encodeURIComponent(mailSubject)}&body=${encodeURIComponent(mailBody)}`;
    const contact = poolContactByName(name);
    return { smsText, mailBody, mailto, contact, name };
  }

  // Whole-absence data (spreadsheet row + cover sheet describe every
  // reliever at once, regardless of which one's message is being drafted).
  const cols = state.settings.relief.columns;
  const rowVals = reliefRowValues(r, leader);
  const rowText = cols.map(c => rowVals[c] ?? "").join("\t");
  const headerText = cols.join("\t");
  const coverText = `RELIEF COVER SHEET\n\nAbsent: ${r.absentStaffName}\nDate: ${fmtDateLong(r.date)}\nSessions: ${fullSess.text}${r.room ? "\nRoom: " + r.room : ""}\nRelief: ${summaryName || "TBC"}\n\nNotes:\n${r.notes || "(attach relief notes / work set if provided by absent teacher)"}\n\nReminder: print a class list for each session from EduPoint.`;

  const tabsEl = document.getElementById("outputTabs");
  const panelEl = document.getElementById("outputPanel");
  let active = "SMS / message";
  let activeRelieverIdx = 0; // which reliever's SMS/email is being drafted, when split

  function draw(){
    const group = groups[activeRelieverIdx];
    const m = messagesFor(group);
    const panels = {
      "SMS / message": { body: m.smsText, mono:false, smsHref: m.contact && m.contact.phone ? smsHref(m.contact.phone, m.smsText) : null },
      "Email draft": { body: m.mailBody, mono:false, mailto: m.mailto },
      "Spreadsheet row": { body: headerText + "\n" + rowText, mono:true },
      "Cover sheet": { body: coverText, mono:false, printable:true },
    };
    const relieverPicker = groups.length > 1 ? `
      <div class="row" style="gap:6px; margin-bottom:8px; width:100%;">
        <span class="hint" style="align-self:center;">Message for:</span>
        ${groups.map((g,i) => `<button type="button" class="btn btn-sm ${i===activeRelieverIdx?"btn-primary":""}" data-reliever-idx="${i}">${escapeHtml(g.name)} (${sessionLabelList(g.sessions)})</button>`).join("")}
      </div>` : "";
    tabsEl.innerHTML = relieverPicker + Object.keys(panels).map(k =>
      `<button class="btn btn-sm ${k===active ? "btn-primary":""}" data-ok="${escapeHtml(k)}">${escapeHtml(k)}</button>`).join("");
    const p = panels[active];
    panelEl.innerHTML = `
      <div class="output-panel ${p.mono ? "mono-block":""}">${escapeHtml(p.body)}</div>
      <div class="copy-row">
        ${p.smsHref ? `<a class="btn btn-primary" href="${p.smsHref}">${icon("message")} Open in Messages</a>` : ""}
        ${p.mailto ? `<a class="btn btn-primary" href="${p.mailto}">${icon("mail")} Open in email</a>` : ""}
        ${p.printable ? `<button class="btn" id="printCoverBtn">${icon("print")} Print cover sheet</button>` : ""}
        <button class="btn btn-primary" id="copyOutBtn">${icon("copy")} Copy text</button>
      </div>
      ${active === "SMS / message" && m.name && !(m.contact && m.contact.phone) ? `<div class="hint" style="margin-top:6px;">No phone on file for ${escapeHtml(m.name)} — add one in Team &amp; Files to enable "Open in Messages".</div>` : ""}
      ${active === "Email draft" && r.attachments && r.attachments.length ? `
        <div class="card" style="background:var(--accent-soft); border-color:var(--accent); margin-top:10px; padding:10px 12px;">
          <div class="hint" style="margin-bottom:6px;"><code>mailto:</code> can't attach files automatically — download each one below, then drag it into the email window "Open in email" opens.</div>
          <div>${attachmentLinksHtml(r.attachments)}</div>
        </div>` : ""}
    `;
    tabsEl.querySelectorAll("[data-ok]").forEach(b => b.addEventListener("click", () => { active = b.dataset.ok; draw(); }));
    tabsEl.querySelectorAll("[data-reliever-idx]").forEach(b => b.addEventListener("click", () => { activeRelieverIdx = +b.dataset.relieverIdx; draw(); }));
    document.getElementById("copyOutBtn").addEventListener("click", () => copyText(p.body));
    const printBtn = document.getElementById("printCoverBtn");
    if(printBtn) printBtn.addEventListener("click", () => printCoverSheet(r, fullSess, summaryName));
  }
  draw();
}

function copyText(text){
  navigator.clipboard?.writeText(text).then(() => toast("Copied to clipboard.")).catch(() => {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand("copy"); ta.remove(); toast("Copied to clipboard.");
  });
}

function printCoverSheet(r, sess, reliefLabel){
  const el = document.getElementById("printSheet");
  el.innerHTML = `
    <div class="print-sheet">
      <h1>Relief Cover Sheet</h1>
      <p>${escapeHtml(state.meta.schoolName)} · ${escapeHtml(state.meta.learningArea)}</p>
      <table border="1" cellpadding="6" style="border-collapse:collapse; width:100%;">
        <tr><td><b>Absent teacher</b></td><td>${escapeHtml(r.absentStaffName)}</td></tr>
        <tr><td><b>Date</b></td><td>${fmtDateLong(r.date)}</td></tr>
        <tr><td><b>Sessions</b></td><td>${escapeHtml(sess.text)}</td></tr>
        <tr><td><b>Room</b></td><td>${escapeHtml(r.room||"—")}</td></tr>
        <tr><td><b>Relief teacher</b></td><td>${escapeHtml(reliefLabel || reliefSummaryText(r) || "TBC")}</td></tr>
        <tr><td><b>Reason</b></td><td>${escapeHtml(r.reason||"—")}</td></tr>
      </table>
      <p><b>Notes / work set:</b><br>${escapeHtml(r.notes||"(attach relief notes if provided)")}</p>
      <p class="pfoot">Remember: print a class list for each covered session from EduPoint.</p>
    </div>
  `;
  window.print();
}

/* ---------------------------------------------------------------------- */
/* MEETINGS                                                                */
/* ---------------------------------------------------------------------- */
/** "3:30 pm–4:15 pm (45 min)" from 24hr HH:MM strings — either end is
 * optional, and duration only shows when both are present and end > start. */
function formatMeetingTime(start, end){
  const fmt = hhmm => {
    const [h, m] = hhmm.split(":").map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  };
  if(start && end){
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    const mins = (eh * 60 + em) - (sh * 60 + sm);
    const dur = mins > 0 ? ` (${mins >= 60 ? `${Math.floor(mins/60)}h${mins%60 ? " " + (mins%60) + "m" : ""}` : mins + " min"})` : "";
    return `${fmt(start)}–${fmt(end)}${dur}`;
  }
  if(start) return `From ${fmt(start)}`;
  if(end) return `Until ${fmt(end)}`;
  return "";
}
function renderMeetings(){
  const root = document.getElementById("view-meetings");
  const today = todayISO();
  const upcoming = state.meetings.items.filter(m => m.date >= today).sort((a,b)=>a.date.localeCompare(b.date));
  const past = state.meetings.items.filter(m => m.date < today).sort((a,b)=>b.date.localeCompare(a.date));

  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>${icon("plus")} New meeting</h2></div>
      <form id="meetingForm">
        <div class="row">
          <div class="field">
            <label for="mf-type">Meeting type</label>
            <select id="mf-type">
              <option>PLT/LA</option>
              <option>GSM</option>
              <option>Senior Staff</option>
              <option value="__other">Other…</option>
            </select>
          </div>
          <div class="field" id="mf-type-other-wrap" style="display:none;">
            <label for="mf-type-other">Meeting name</label>
            <input type="text" id="mf-type-other" placeholder="e.g. Curriculum Day">
          </div>
          <div class="field">
            <label for="mf-date">Date</label>
            <input type="date" id="mf-date" value="${today}" required>
          </div>
          <div class="field">
            <label for="mf-start">Start time (optional)</label>
            <input type="time" id="mf-start">
          </div>
          <div class="field">
            <label for="mf-end">End time (optional)</label>
            <input type="time" id="mf-end">
          </div>
          <div class="field">
            <label for="mf-focus">Focus</label>
            <select id="mf-focus">
              <option>Reflective Practice</option>
              <option>Literacy Inquiry</option>
              <option>General</option>
              <option value="__other">Other…</option>
            </select>
          </div>
          <div class="field" id="mf-focus-other-wrap" style="display:none;">
            <label for="mf-focus-other">Focus name</label>
            <input type="text" id="mf-focus-other" placeholder="e.g. Numeracy">
          </div>
        </div>
        <div class="field">
          <label class="checkline"><input type="checkbox" id="mf-repeat"> Repeats weekly on this day</label>
        </div>
        <div class="field" id="mf-repeat-until-wrap" style="display:none;">
          <label for="mf-repeat-until">Repeat until (inclusive)</label>
          <input type="date" id="mf-repeat-until">
        </div>
        <button class="btn btn-primary" type="submit">${icon("plus")} Add meeting</button>
      </form>
    </div>

    <div class="grid grid-2 section-gap">
      <div class="card">
        <div class="card-head"><h2>Upcoming</h2></div>
        <div id="meetingsUpcoming" class="list"></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Past</h2></div>
        <div id="meetingsPast" class="list"></div>
      </div>
    </div>

    <div class="card section-gap" id="meetingDetailCard" style="display:none;"></div>
  `;

  const mfTypeSel = document.getElementById("mf-type");
  mfTypeSel.addEventListener("change", () => {
    document.getElementById("mf-type-other-wrap").style.display = mfTypeSel.value === "__other" ? "" : "none";
  });
  const mfFocusSel = document.getElementById("mf-focus");
  mfFocusSel.addEventListener("change", () => {
    document.getElementById("mf-focus-other-wrap").style.display = mfFocusSel.value === "__other" ? "" : "none";
  });
  document.getElementById("mf-repeat").addEventListener("change", e => {
    document.getElementById("mf-repeat-until-wrap").style.display = e.target.checked ? "" : "none";
  });

  document.getElementById("meetingForm").addEventListener("submit", e => {
    e.preventDefault();
    let type = mfTypeSel.value;
    if(type === "__other"){
      type = document.getElementById("mf-type-other").value.trim();
      if(!type){ toast("Enter a name for this meeting."); return; }
    }
    let focus = mfFocusSel.value;
    if(focus === "__other"){
      focus = document.getElementById("mf-focus-other").value.trim();
      if(!focus){ toast("Enter a name for this meeting's focus."); return; }
    }
    const baseDate = document.getElementById("mf-date").value;
    const shared = {
      type, focus,
      startTime: document.getElementById("mf-start").value,
      endTime: document.getElementById("mf-end").value,
      agenda: [...(state.meetings.standingItems[focus] || state.meetings.standingItems["General"])],
    };

    // Repeats weekly: one standalone meeting per week (same weekday, same
    // type/focus/times/agenda) up to the chosen end date -- each is its own
    // fully independent record, editable/deletable individually, same
    // pattern as the relief log's multi-day absence logging.
    const repeatCb = document.getElementById("mf-repeat");
    const repeatUntil = repeatCb.checked ? document.getElementById("mf-repeat-until").value : "";
    if(repeatUntil && repeatUntil > baseDate){
      const dates = [];
      const d = new Date(baseDate + "T00:00:00");
      const end = new Date(repeatUntil + "T00:00:00");
      while(d <= end){ dates.push(todayISO(d)); d.setDate(d.getDate()+7); }
      const created = dates.map(date => ({ id: uid(), date, ...shared, minutes: "", actions: [] }));
      state.meetings.items.push(...created);
      persist();
      toast(`${created.length} meetings added, weekly ${fmtDateShort(dates[0])}–${fmtDateShort(dates[dates.length-1])}.`);
      renderMeetings();
      openMeetingDetail(created[0].id);
      return;
    }

    const m = { id: uid(), date: baseDate, ...shared, minutes: "", actions: [] };
    state.meetings.items.push(m);
    persist(); toast("Meeting added."); renderMeetings(); openMeetingDetail(m.id);
  });

  const upBox = document.getElementById("meetingsUpcoming");
  upBox.innerHTML = upcoming.length ? upcoming.map(meetingItemHtml).join("") : `<div class="empty-state">No upcoming meetings.</div>`;
  const pastBox = document.getElementById("meetingsPast");
  pastBox.innerHTML = past.length ? past.map(meetingItemHtml).join("") : `<div class="empty-state">No past meetings logged.</div>`;

  root.querySelectorAll("[data-open-meeting]").forEach(b => b.addEventListener("click", () => openMeetingDetail(b.dataset.openMeeting)));
  root.querySelectorAll("[data-del-meeting]").forEach(b => b.addEventListener("click", () => {
    if(!confirm("Delete this meeting and its minutes?")) return;
    state.meetings.items = state.meetings.items.filter(m => m.id !== b.dataset.delMeeting);
    persist(); renderMeetings();
  }));
}

function meetingItemHtml(m){
  const timeStr = formatMeetingTime(m.startTime, m.endTime);
  return `<div class="item">
    <div class="item-main">
      <div class="item-title">${escapeHtml(m.type)} — ${escapeHtml(m.focus)}</div>
      <div class="item-sub mono">${fmtDateShort(m.date)}${timeStr ? " · " + escapeHtml(timeStr) : ""} · ${m.actions.filter(a=>!a.done).length} open action(s)</div>
    </div>
    <div class="item-actions">
      <button class="btn btn-sm" data-open-meeting="${m.id}">${icon("edit")} Open</button>
      <button class="btn btn-sm btn-danger" data-del-meeting="${m.id}">${icon("trash")}</button>
    </div>
  </div>`;
}

function openMeetingDetail(id){
  const m = state.meetings.items.find(x => x.id === id);
  if(!m) return;
  const card = document.getElementById("meetingDetailCard");
  card.style.display = "";
  const timeStrDetail = formatMeetingTime(m.startTime, m.endTime);
  const STANDARD_TYPES = ["PLT/LA", "GSM", "Senior Staff"];
  const STANDARD_FOCI = ["Reflective Practice", "Literacy Inquiry", "General"];
  const typeIsStandard = STANDARD_TYPES.includes(m.type);
  const focusIsStandard = STANDARD_FOCI.includes(m.focus);
  card.innerHTML = `
    <div class="card-head">
      <h2><span id="meetingDetailTypeFocus">${escapeHtml(m.type)} — ${escapeHtml(m.focus)}</span> <span class="eyebrow mono" id="meetingDetailTimeEyebrow">${fmtDateShort(m.date)}${timeStrDetail ? " · " + escapeHtml(timeStrDetail) : ""}</span></h2>
      <div class="row" style="gap:6px;">
        <button class="btn btn-sm" id="printMinutesBtn">${icon("print")} Print</button>
        <button class="btn btn-sm" id="closeMeetingBtn">Close</button>
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label for="detailType">Meeting type</label>
        <select id="detailType">
          <option>PLT/LA</option><option>GSM</option><option>Senior Staff</option>
          <option value="__other" ${!typeIsStandard ? "selected" : ""}>Other…</option>
        </select>
      </div>
      <div class="field" id="detailTypeOtherWrap" style="display:${typeIsStandard ? "none" : ""};">
        <label for="detailTypeOther">Meeting name</label>
        <input type="text" id="detailTypeOther" value="${!typeIsStandard ? escapeHtml(m.type) : ""}">
      </div>
      <div class="field">
        <label for="detailFocus">Focus</label>
        <select id="detailFocus">
          <option>Reflective Practice</option><option>Literacy Inquiry</option><option>General</option>
          <option value="__other" ${!focusIsStandard ? "selected" : ""}>Other…</option>
        </select>
      </div>
      <div class="field" id="detailFocusOtherWrap" style="display:${focusIsStandard ? "none" : ""};">
        <label for="detailFocusOther">Focus name</label>
        <input type="text" id="detailFocusOther" value="${!focusIsStandard ? escapeHtml(m.focus) : ""}">
      </div>
    </div>
    <div class="row">
      <div class="field"><label for="detailStart">Start time</label><input type="time" id="detailStart" value="${escapeHtml(m.startTime||"")}"></div>
      <div class="field"><label for="detailEnd">End time</label><input type="time" id="detailEnd" value="${escapeHtml(m.endTime||"")}"></div>
    </div>
    <div class="field">
      <label>Agenda</label>
      <div id="agendaList" class="list"></div>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="agendaNew" placeholder="Add agenda item…" style="flex:1;">
        <button class="btn" id="agendaAddBtn">${icon("plus")} Add</button>
      </div>
    </div>
    <div class="field">
      <label for="minutesText">Minutes</label>
      <textarea id="minutesText" style="min-height:140px;">${escapeHtml(m.minutes)}</textarea>
    </div>
    <div class="field">
      <label>Action items</label>
      <div id="actionsList" class="list"></div>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="actionNew" placeholder="New action item…" style="flex:1;">
        <select id="actionAssignee"><option value="">Unassigned</option>${allStaffNames().map(n=>`<option>${escapeHtml(n)}</option>`).join("")}</select>
        <button class="btn" id="actionAddBtn">${icon("plus")} Add</button>
      </div>
      <div class="hint" style="margin-top:6px;">Action items can be pushed to your Tasks list.</div>
    </div>
    <div class="banner" style="background:var(--accent-soft); border-color:var(--accent); color:var(--accent);">
      Agendas live on Teams — remember to add this meeting's agenda/minutes to the Teams channel once finalised.
    </div>
  `;

  function renderAgenda(){
    document.getElementById("agendaList").innerHTML = m.agenda.length ? m.agenda.map((a,i) => `
      <div class="item"><div class="item-main">${i+1}. ${escapeHtml(a)}</div>
      <div class="item-actions"><button class="btn btn-sm btn-danger" data-rm-agenda="${i}">${icon("trash")}</button></div></div>
    `).join("") : `<div class="empty-state" style="padding:10px;">No agenda items yet.</div>`;
    document.querySelectorAll("[data-rm-agenda]").forEach(b => b.addEventListener("click", () => {
      m.agenda.splice(+b.dataset.rmAgenda, 1); persist(); renderAgenda();
    }));
  }
  function renderActions(){
    document.getElementById("actionsList").innerHTML = m.actions.length ? m.actions.map(a => `
      <div class="item">
        <div class="item-main">
          <label class="checkline"><input type="checkbox" data-toggle-action="${a.id}" ${a.done?"checked":""}> <span style="${a.done?"text-decoration:line-through;color:var(--muted);":""}">${escapeHtml(a.text)}</span></label>
          <div class="item-sub">${a.assignee ? "Assigned: " + escapeHtml(a.assignee) : "Unassigned"}</div>
        </div>
        <div class="item-actions">
          ${!a.pushedToTasks ? `<button class="btn btn-sm" data-push-task="${a.id}">→ Task</button>` : `<span class="badge badge-good">In tasks</span>`}
          <button class="btn btn-sm btn-danger" data-rm-action="${a.id}">${icon("trash")}</button>
        </div>
      </div>
    `).join("") : `<div class="empty-state" style="padding:10px;">No action items yet.</div>`;

    document.querySelectorAll("[data-toggle-action]").forEach(cb => cb.addEventListener("change", () => {
      const a = m.actions.find(x=>x.id===cb.dataset.toggleAction); a.done = cb.checked; persist(); renderActions();
    }));
    document.querySelectorAll("[data-rm-action]").forEach(b => b.addEventListener("click", () => {
      m.actions = m.actions.filter(x=>x.id!==b.dataset.rmAction); persist(); renderActions();
    }));
    document.querySelectorAll("[data-push-task]").forEach(b => b.addEventListener("click", () => {
      const a = m.actions.find(x=>x.id===b.dataset.pushTask);
      state.tasks.push({ id: uid(), title: a.text, notes: `From ${m.type} meeting (${fmtDateShort(m.date)})`, due:"", assignee: a.assignee||"", status:"open", createdAt: new Date().toISOString() });
      a.pushedToTasks = true; persist(); renderActions(); toast("Added to Tasks.");
    }));
  }
  renderAgenda(); renderActions();

  document.getElementById("agendaAddBtn").addEventListener("click", () => {
    const v = document.getElementById("agendaNew").value.trim();
    if(!v) return; m.agenda.push(v); document.getElementById("agendaNew").value=""; persist(); renderAgenda();
  });
  document.getElementById("actionAddBtn").addEventListener("click", () => {
    const v = document.getElementById("actionNew").value.trim();
    if(!v) return;
    m.actions.push({ id: uid(), text: v, done:false, assignee: document.getElementById("actionAssignee").value, pushedToTasks:false });
    document.getElementById("actionNew").value=""; persist(); renderActions();
  });
  document.getElementById("minutesText").addEventListener("input", e => { m.minutes = e.target.value; persist(); });
  function refreshTimeEyebrow(){
    const t = formatMeetingTime(m.startTime, m.endTime);
    document.getElementById("meetingDetailTimeEyebrow").textContent = fmtDateShort(m.date) + (t ? " · " + t : "");
  }
  function refreshTypeFocusHeading(){
    document.getElementById("meetingDetailTypeFocus").textContent = `${m.type} — ${m.focus}`;
  }
  document.getElementById("detailStart").addEventListener("change", e => { m.startTime = e.target.value; persist(); refreshTimeEyebrow(); });
  document.getElementById("detailEnd").addEventListener("change", e => { m.endTime = e.target.value; persist(); refreshTimeEyebrow(); });

  const detailTypeSel = document.getElementById("detailType");
  const detailTypeOther = document.getElementById("detailTypeOther");
  if(typeIsStandard) detailTypeSel.value = m.type;
  detailTypeSel.addEventListener("change", () => {
    document.getElementById("detailTypeOtherWrap").style.display = detailTypeSel.value === "__other" ? "" : "none";
    if(detailTypeSel.value !== "__other"){ m.type = detailTypeSel.value; persist(); refreshTypeFocusHeading(); renderMeetings(); openMeetingDetail(m.id); }
  });
  detailTypeOther.addEventListener("input", e => {
    if(!e.target.value.trim()) return;
    m.type = e.target.value.trim(); persist(); refreshTypeFocusHeading();
  });

  const detailFocusSel = document.getElementById("detailFocus");
  const detailFocusOther = document.getElementById("detailFocusOther");
  if(focusIsStandard) detailFocusSel.value = m.focus;
  detailFocusSel.addEventListener("change", () => {
    document.getElementById("detailFocusOtherWrap").style.display = detailFocusSel.value === "__other" ? "" : "none";
    if(detailFocusSel.value !== "__other"){ m.focus = detailFocusSel.value; persist(); refreshTypeFocusHeading(); renderMeetings(); openMeetingDetail(m.id); }
  });
  detailFocusOther.addEventListener("input", e => {
    if(!e.target.value.trim()) return;
    m.focus = e.target.value.trim(); persist(); refreshTypeFocusHeading();
  });

  document.getElementById("closeMeetingBtn").addEventListener("click", () => { card.style.display = "none"; });
  document.getElementById("printMinutesBtn").addEventListener("click", () => printMeetingMinutes(m));
}

function printMeetingMinutes(m){
  const el = document.getElementById("printSheet") || (() => {
    const d = document.createElement("div"); d.id = "printSheet"; d.className = "print-only"; document.body.appendChild(d); return d;
  })();
  el.innerHTML = `
    <div class="print-sheet">
      <h1>${escapeHtml(m.type)} — ${escapeHtml(m.focus)}</h1>
      <p>${escapeHtml(state.meta.schoolName)} · ${escapeHtml(state.meta.learningArea)} · ${fmtDateLong(m.date)}${formatMeetingTime(m.startTime, m.endTime) ? " · " + escapeHtml(formatMeetingTime(m.startTime, m.endTime)) : ""}</p>
      <h3>Agenda</h3>
      <ol>${m.agenda.map(a=>`<li>${escapeHtml(a)}</li>`).join("")}</ol>
      <h3>Minutes</h3>
      <p style="white-space:pre-wrap;">${escapeHtml(m.minutes || "—")}</p>
      <h3>Action items</h3>
      <ul>${m.actions.map(a=>`<li>${a.done?"☑":"☐"} ${escapeHtml(a.text)}${a.assignee ? " — " + escapeHtml(a.assignee) : ""}</li>`).join("") || "<li>None</li>"}</ul>
    </div>
  `;
  window.print();
}

/* ---------------------------------------------------------------------- */
/* TASKS                                                                  */
/* ---------------------------------------------------------------------- */
function renderTasks(){
  const root = document.getElementById("view-tasks");
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>${icon("plus")} New task</h2></div>
      <form id="taskForm" class="row" style="align-items:flex-end;">
        <div class="field" style="flex:2 1 200px;"><label for="tf-title">Title</label><input type="text" id="tf-title" required placeholder="What needs doing?"></div>
        <div class="field"><label for="tf-due">Due</label><input type="date" id="tf-due"></div>
        <div class="field"><label for="tf-assignee">Assignee</label>
          <select id="tf-assignee"><option value="">Me</option>${allStaffNames().map(n=>`<option>${escapeHtml(n)}</option>`).join("")}</select>
        </div>
        <div class="field"><label class="checkline" title="Needs a due date to repeat from"><input type="checkbox" id="tf-repeat"> Repeat weekly</label></div>
        <div class="field" id="tf-repeat-until-wrap" style="display:none;"><label for="tf-repeat-until">Until</label><input type="date" id="tf-repeat-until"></div>
        <div class="field" style="align-self:flex-end;"><button class="btn btn-primary" type="submit">${icon("plus")} Add</button></div>
      </form>
    </div>

    <div class="card section-gap">
      <div class="card-head">
        <h2>Tasks</h2>
        <div class="row" style="gap:8px;">
          <select id="taskFilter">
            <option value="open">Open</option>
            <option value="overdue">Overdue</option>
            <option value="today">Due today</option>
            <option value="all">All</option>
            <option value="done">Done</option>
          </select>
        </div>
      </div>
      <div id="taskList" class="list"></div>
    </div>
  `;

  document.getElementById("tf-repeat").addEventListener("change", e => {
    document.getElementById("tf-repeat-until-wrap").style.display = e.target.checked ? "" : "none";
  });

  document.getElementById("taskForm").addEventListener("submit", e => {
    e.preventDefault();
    const title = document.getElementById("tf-title").value.trim();
    if(!title) return;
    const due = document.getElementById("tf-due").value;
    const assignee = document.getElementById("tf-assignee").value;
    const repeatCb = document.getElementById("tf-repeat");
    const repeatUntil = repeatCb.checked ? document.getElementById("tf-repeat-until").value : "";

    // Repeat weekly needs an anchor date to count from -- each week becomes
    // its own standalone task (same title/assignee), independently
    // completable/deletable, same pattern as recurring meetings.
    if(repeatUntil && due && repeatUntil > due){
      const dates = [];
      const d = new Date(due + "T00:00:00");
      const end = new Date(repeatUntil + "T00:00:00");
      while(d <= end){ dates.push(todayISO(d)); d.setDate(d.getDate()+7); }
      const created = dates.map(dueDate => ({ id: uid(), title, notes:"", due: dueDate, assignee, status:"open", createdAt: new Date().toISOString() }));
      state.tasks.unshift(...created);
      persist();
      toast(`${created.length} tasks added, weekly ${fmtDateShort(dates[0])}–${fmtDateShort(dates[dates.length-1])}.`);
      e.target.reset(); document.getElementById("tf-repeat-until-wrap").style.display = "none"; renderTaskList();
      return;
    }

    state.tasks.unshift({ id: uid(), title, notes:"", due, assignee, status:"open", createdAt: new Date().toISOString() });
    persist(); toast("Task added."); e.target.reset(); document.getElementById("tf-repeat-until-wrap").style.display = "none"; renderTaskList();
  });
  document.getElementById("taskFilter").addEventListener("change", renderTaskList);
  renderTaskList();
}

function renderTaskList(){
  const today = todayISO();
  const filter = document.getElementById("taskFilter")?.value || "open";
  let list = state.tasks;
  if(filter==="open") list = list.filter(t=>t.status!=="done");
  else if(filter==="overdue") list = list.filter(t=>t.status!=="done" && t.due && t.due<today);
  else if(filter==="today") list = list.filter(t=>t.status!=="done" && t.due===today);
  else if(filter==="done") list = list.filter(t=>t.status==="done");

  const box = document.getElementById("taskList");
  if(!list.length){ box.innerHTML = `<div class="empty-state">${icon("inbox")}<div>Nothing here. Add a task above.</div></div>`; return; }

  box.innerHTML = list.map(t => {
    const overdue = t.status!=="done" && t.due && t.due<today;
    return `<div class="item">
      <div class="item-main">
        <label class="checkline">
          <input type="checkbox" data-toggle-task="${t.id}" ${t.status==="done"?"checked":""}>
          <span style="${t.status==="done"?"text-decoration:line-through;color:var(--muted);":""}">${escapeHtml(t.title)}</span>
        </label>
        <div class="item-sub">
          ${t.due ? `<span class="mono">${fmtDateShort(t.due)}</span>` : "No due date"}
          ${overdue ? `<span class="badge badge-flag">Overdue</span>` : ""}
          ${t.assignee ? ` · ${escapeHtml(t.assignee)}` : " · Me"}
        </div>
      </div>
      <div class="item-actions"><button class="btn btn-sm btn-danger" data-del-task="${t.id}">${icon("trash")}</button></div>
    </div>`;
  }).join("");

  box.querySelectorAll("[data-toggle-task]").forEach(cb => cb.addEventListener("change", () => {
    const t = state.tasks.find(x=>x.id===cb.dataset.toggleTask);
    t.status = cb.checked ? "done" : "open"; persist(); renderTaskList();
  }));
  box.querySelectorAll("[data-del-task]").forEach(b => b.addEventListener("click", () => {
    const removedIdx = state.tasks.findIndex(x => x.id === b.dataset.delTask);
    if(removedIdx === -1) return;
    const [removed] = state.tasks.splice(removedIdx, 1);
    persist(); renderTaskList();
    toast("Task removed.", { actionLabel: "Undo", onAction: () => {
      state.tasks.splice(Math.min(removedIdx, state.tasks.length), 0, removed);
      persist(); renderTaskList();
      toast("Restored.");
    }});
  }));
}

/* ---------------------------------------------------------------------- */
/* TEAM & FILES                                                          */
/* ---------------------------------------------------------------------- */
function renderTeamFiles(){
  const root = document.getElementById("view-team");
  root.innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head">
          <h2>${icon("users")} Teachers</h2>
          <button class="btn btn-sm" id="viewFullStaffTimetableBtn">${icon("calendar")} Full staff timetable</button>
        </div>
        <div id="teacherList" class="list"></div>
        <div class="row section-gap">
          <input type="text" id="newTeacher" placeholder="Add teacher name…" style="flex:1;">
          <button class="btn" id="addTeacherBtn">${icon("plus")}</button>
        </div>
      </div>
      <div class="card">
        <div class="card-head">
          <h2>${icon("users")} Teacher assistants</h2>
          <button class="btn btn-sm" id="viewFullTaTimetableBtn">${icon("calendar")} Full TA timetable</button>
        </div>
        <div id="taList" class="list"></div>
        <div class="row section-gap">
          <input type="text" id="newTA" placeholder="Add TA name…" style="flex:1;">
          <button class="btn" id="addTABtn">${icon("plus")}</button>
        </div>
      </div>
    </div>

    <div class="card section-gap">
      <div class="card-head">
        <h2>${icon("phone")} Relief pool</h2>
        <button class="btn btn-primary btn-sm" id="poolAddBtn">${icon("plus")} Add contact</button>
      </div>
      <div class="hint" style="margin-bottom:10px;">The people who actually cover absences — shown ahead of your own team whenever you assign relief. Edit contact details, availability and subjects here; changes apply everywhere immediately.</div>
      <div class="field"><input type="search" id="poolManageSearch" placeholder="Search relief pool…"></div>
      <div class="field">
        <label>Filter by subject / area</label>
        <div class="chip-row" id="poolManageChips"></div>
      </div>
      <div id="poolManageList"></div>
    </div>

    <div class="card section-gap">
      <div class="card-head">
        <h2>${icon("file")} Teams upload queue</h2>
      </div>
      <div class="hint" style="margin-bottom:10px;">DECYP rules mean files can't be copied to Teams automatically. Track what needs to go up manually here — target: <strong>${escapeHtml(state.settings.teamsChannel)}</strong> (edit in Settings).</div>
      <form id="fileQueueForm" class="row" style="align-items:flex-end;">
        <div class="field" style="flex:2 1 200px;"><label for="fq-name">File / item</label><input type="text" id="fq-name" required placeholder="e.g. Term 3 Scope & Sequence.docx"></div>
        <div class="field" style="flex:1;"><label for="fq-dest">Destination</label><input type="text" id="fq-dest" value="${escapeHtml(state.settings.teamsChannel)}"></div>
        <div class="field" style="align-self:flex-end;"><button class="btn btn-primary" type="submit">${icon("plus")} Add</button></div>
      </form>
      <div id="fileQueueList" class="list section-gap"></div>
    </div>
  `;

  function renderStaffLists(){
    document.getElementById("teacherList").innerHTML = state.team.teachers.map(p => `
      <div class="item"><button type="button" class="item-main item-title" data-view-teacher-tt="${escapeHtml(p.name)}" style="background:none;border:none;text-align:left;cursor:pointer;color:inherit;padding:0;">${escapeHtml(p.name)}</button>
      <div class="item-actions"><button class="btn btn-sm btn-danger" data-rm-teacher="${p.id}">${icon("trash")}</button></div></div>
    `).join("") || `<div class="empty-state">No teachers yet.</div>`;
    document.getElementById("taList").innerHTML = state.team.tas.map(p => `
      <div class="item"><button type="button" class="item-main item-title" data-view-ta-tt="${escapeHtml(p.name)}" style="background:none;border:none;text-align:left;cursor:pointer;color:inherit;padding:0;">${escapeHtml(p.name)}</button>
      <div class="item-actions"><button class="btn btn-sm btn-danger" data-rm-ta="${p.id}">${icon("trash")}</button></div></div>
    `).join("") || `<div class="empty-state">No TAs yet.</div>`;

    document.querySelectorAll("[data-view-teacher-tt]").forEach(b=>b.addEventListener("click",()=> showTeacherTimetable(b.dataset.viewTeacherTt)));
    document.querySelectorAll("[data-view-ta-tt]").forEach(b=>b.addEventListener("click",()=> showTaTimetable(b.dataset.viewTaTt)));
    document.querySelectorAll("[data-rm-teacher]").forEach(b=>b.addEventListener("click",()=>{
      state.team.teachers = state.team.teachers.filter(p=>p.id!==b.dataset.rmTeacher); persist(); renderStaffLists();
    }));
    document.querySelectorAll("[data-rm-ta]").forEach(b=>b.addEventListener("click",()=>{
      state.team.tas = state.team.tas.filter(p=>p.id!==b.dataset.rmTa); persist(); renderStaffLists();
    }));
  }
  renderStaffLists();
  document.getElementById("viewFullStaffTimetableBtn").addEventListener("click", showFullStaffTimetable);
  document.getElementById("viewFullTaTimetableBtn").addEventListener("click", showFullTaTimetable);

  document.getElementById("addTeacherBtn").addEventListener("click", () => {
    const el = document.getElementById("newTeacher"); const v = el.value.trim();
    if(!v) return; state.team.teachers.push({id:uid(), name:v, role:"Teacher"}); el.value=""; persist(); renderStaffLists();
  });
  document.getElementById("addTABtn").addEventListener("click", () => {
    const el = document.getElementById("newTA"); const v = el.value.trim();
    if(!v) return; state.team.tas.push({id:uid(), name:v, role:"TA"}); el.value=""; persist(); renderStaffLists();
  });

  function renderQueue(){
    const box = document.getElementById("fileQueueList");
    const items = state.files.queue;
    box.innerHTML = items.length ? items.map(f => `
      <div class="item">
        <div class="item-main">
          <label class="checkline"><input type="checkbox" data-toggle-file="${f.id}" ${f.done?"checked":""}>
          <span style="${f.done?"text-decoration:line-through;color:var(--muted);":""}">${escapeHtml(f.fileName)}</span></label>
          <div class="item-sub">→ ${escapeHtml(f.destination)}</div>
        </div>
        <div class="item-actions"><button class="btn btn-sm btn-danger" data-rm-file="${f.id}">${icon("trash")}</button></div>
      </div>
    `).join("") : `<div class="empty-state">Queue is empty.</div>`;

    box.querySelectorAll("[data-toggle-file]").forEach(cb=>cb.addEventListener("change",()=>{
      const f = state.files.queue.find(x=>x.id===cb.dataset.toggleFile); f.done = cb.checked; persist(); renderQueue();
    }));
    box.querySelectorAll("[data-rm-file]").forEach(b=>b.addEventListener("click",()=>{
      state.files.queue = state.files.queue.filter(x=>x.id!==b.dataset.rmFile); persist(); renderQueue();
    }));
  }
  renderQueue();

  document.getElementById("fileQueueForm").addEventListener("submit", e => {
    e.preventDefault();
    const fileName = document.getElementById("fq-name").value.trim();
    if(!fileName) return;
    state.files.queue.unshift({ id: uid(), fileName, destination: document.getElementById("fq-dest").value.trim(), done:false, addedAt: new Date().toISOString() });
    persist(); e.target.reset(); document.getElementById("fq-dest").value = state.settings.teamsChannel; renderQueue();
  });

  function renderPoolManage(filter=""){
    const box = document.getElementById("poolManageList");
    const chipBox = document.getElementById("poolManageChips");
    const f = filter.trim().toLowerCase();

    let rows = state.relief.externalPool.map(c => ({ ...c, ...splitName(c.name) }));
    if(chipBox) renderSubjectChips(chipBox, collectSubjectTags(rows), poolManageSubjectFilter, () => renderPoolManage(document.getElementById("poolManageSearch").value));

    if(f) rows = rows.filter(c => `${c.name} ${c.availability} ${c.subjects}`.toLowerCase().includes(f));
    rows = rows.filter(c => matchesSubjectFilter(c, poolManageSubjectFilter));
    rows = poolManageSort.key ? sortRows(rows, poolManageSort) : rows;
    if(!rows.length){ box.innerHTML = `<div class="empty-state">${icon("inbox")}<div>No matching contacts.</div></div>`; return; }
    box.innerHTML = `
      ${poolManageSort.key ? `<div class="hint" style="margin-bottom:6px;">Sorted by ${escapeHtml(poolManageSort.key)} — <a href="#" id="poolManageSortReset">reset to list order</a>.</div>` : ""}
      <div class="table-wrap"><table>
      <thead><tr>
        <th class="sortable" data-sort-key="firstName">First name${sortArrow(poolManageSort,"firstName")}</th>
        <th class="sortable" data-sort-key="lastName">Surname${sortArrow(poolManageSort,"lastName")}</th>
        <th>Contact</th>
        <th class="sortable" data-sort-key="availability">Availability${sortArrow(poolManageSort,"availability")}</th>
        <th class="sortable" data-sort-key="subjects">Subjects${sortArrow(poolManageSort,"subjects")}</th>
        <th></th>
      </tr></thead>
      <tbody>${rows.map(p => `<tr>
        <td>
          <button type="button" class="icon-btn star-btn ${p.favorite ? "is-favorite" : ""}" data-pool-fav-toggle="${p.id}" title="${p.favorite ? "Unpin from top of Relief directory" : "Pin to top of Relief directory"}" style="width:22px;height:22px;padding:2px;vertical-align:-5px;">${starIcon(!!p.favorite)}</button>
          ${escapeHtml(p.firstName)}
        </td>
        <td>${escapeHtml(p.lastName)}</td>
        <td class="mono" style="white-space:nowrap;">${escapeHtml(p.phone||"—")}${p.email ? `<br><span style="font-family:inherit;">${escapeHtml(p.email)}</span>` : ""}</td>
        <td class="hint">${unavailableBadgeHtml(p)}${escapeHtml(p.availability||"—")}</td>
        <td class="hint">${escapeHtml(p.subjects||"—")}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm" data-pool-edit="${p.id}">${icon("edit")}</button>
          <button class="btn btn-sm btn-danger" data-pool-del="${p.id}">${icon("trash")}</button>
        </td>
      </tr>`).join("")}</tbody>
    </table></div>`;

    wireSortHeaders(box, poolManageSort, () => renderPoolManage(document.getElementById("poolManageSearch").value));
    const resetLink = document.getElementById("poolManageSortReset");
    if(resetLink) resetLink.addEventListener("click", e => {
      e.preventDefault(); poolManageSort = { key: null, dir: 1 };
      renderPoolManage(document.getElementById("poolManageSearch").value);
    });

    box.querySelectorAll("[data-pool-fav-toggle]").forEach(b => b.addEventListener("click", () => {
      const c = state.relief.externalPool.find(x => x.id === b.dataset.poolFavToggle);
      if(!c) return;
      c.favorite = !c.favorite;
      persist();
      renderPoolManage(document.getElementById("poolManageSearch").value);
    }));
    box.querySelectorAll("[data-pool-edit]").forEach(b => b.addEventListener("click", () => openPoolModal(b.dataset.poolEdit)));
    box.querySelectorAll("[data-pool-del]").forEach(b => b.addEventListener("click", () => {
      const c = state.relief.externalPool.find(x => x.id === b.dataset.poolDel);
      if(!confirm(`Remove ${c ? c.name : "this contact"} from the relief pool?`)) return;
      state.relief.externalPool = state.relief.externalPool.filter(x => x.id !== b.dataset.poolDel);
      persist(); renderPoolManage(document.getElementById("poolManageSearch").value);
    }));
  }
  renderPoolManage();
  document.getElementById("poolManageSearch").addEventListener("input", e => renderPoolManage(e.target.value));
  document.getElementById("poolAddBtn").addEventListener("click", () => openPoolModal());
}

/* ---------------------------------------------------------------------- */
/* Relief pool contact modal (add/edit) — used from Team & Files          */
/* ---------------------------------------------------------------------- */
let poolEditingId = null;

function openPoolModal(id = null){
  poolEditingId = id;
  const c = id ? state.relief.externalPool.find(p => p.id === id) : { name:"", phone:"", email:"", availability:"", subjects:"", unavailableUntil:"" };
  document.getElementById("poolModalTitle").textContent = id ? "Edit relief contact" : "Add relief contact";
  document.getElementById("pm-name").value = c.name;
  document.getElementById("pm-phone").value = c.phone;
  document.getElementById("pm-email").value = c.email;
  document.getElementById("pm-availability").value = c.availability;
  document.getElementById("pm-subjects").value = c.subjects;
  document.getElementById("pm-unavailable").value = c.unavailableUntil || "";
  document.getElementById("poolModalBackdrop").classList.add("show");
  document.getElementById("pm-name").focus();
}
function closePoolModal(){
  document.getElementById("poolModalBackdrop").classList.remove("show");
  poolEditingId = null;
}
function savePoolModal(){
  const name = document.getElementById("pm-name").value.trim();
  if(!name){ toast("Name is required."); return; }
  const data = {
    name,
    phone: document.getElementById("pm-phone").value.trim(),
    email: document.getElementById("pm-email").value.trim(),
    availability: document.getElementById("pm-availability").value.trim(),
    subjects: document.getElementById("pm-subjects").value.trim(),
    unavailableUntil: document.getElementById("pm-unavailable").value,
  };
  if(poolEditingId){
    const c = state.relief.externalPool.find(p => p.id === poolEditingId);
    if(c) Object.assign(c, data);
  } else {
    state.relief.externalPool.push({ id: uid(), ...data });
  }
  persist();
  closePoolModal();
  toast("Relief contact saved.");
  if(document.getElementById("view-team").classList.contains("active")) renderTeamFiles();
}

/* ---------------------------------------------------------------------- */
/* SETTINGS                                                               */
/* ---------------------------------------------------------------------- */
function renderSettings(){
  const root = document.getElementById("view-settings");
  root.innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><h2>Appearance</h2></div>
        <div class="field">
          <label>Theme</label>
          <div class="row">
            <button class="btn ${state.settings.theme==="workshop"?"btn-primary":""}" id="themeWorkshop">${icon("sun")} Workshop (light)</button>
            <button class="btn ${state.settings.theme==="console"?"btn-primary":""}" id="themeConsole">${icon("moon")} Console (dark)</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>About you / school</h2></div>
        <div class="field"><label for="st-leader">Your name</label><input type="text" id="st-leader" value="${escapeHtml(state.meta.leaderName)}" placeholder="For message/email sign-offs"></div>
        <div class="field"><label for="st-school">School</label><input type="text" id="st-school" value="${escapeHtml(state.meta.schoolName)}"></div>
        <div class="field"><label for="st-la">Learning area</label><input type="text" id="st-la" value="${escapeHtml(state.meta.learningArea)}"></div>
      </div>
    </div>

    <div class="grid grid-2 section-gap">
      <div class="card">
        <div class="card-head"><h2>Term dates</h2></div>
        <div class="hint" style="margin-bottom:10px;">DECYP's published 2026 dates, loaded automatically — the dashboard header uses these to work out the current term/week all year, and shows "Holidays" in between. Rosny is a senior secondary college, so Term 4 in particular may run to a different finish date around exams — adjust here if yours differs.</div>
        <div id="termEditor" class="list"></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Relief spreadsheet columns</h2></div>
        <div class="hint" style="margin-bottom:8px;">Order matches what gets copied when you generate a "Spreadsheet row" output. Comma-separated.</div>
        <textarea id="st-columns" style="min-height:60px;">${escapeHtml(state.settings.relief.columns.join(", "))}</textarea>
        <div class="field section-gap"><label for="st-teamschannel">Teams destination (for file queue default)</label><input type="text" id="st-teamschannel" value="${escapeHtml(state.settings.teamsChannel)}"></div>
      </div>
    </div>

    <div class="card section-gap">
      <div class="card-head"><h2>${icon("print")} Term / year summary report</h2></div>
      <div class="hint" style="margin-bottom:10px;">A printable summary of relief absences (including leave tallies per staff member), meetings held, and task completion for a chosen term or the whole year — handy for line-manager conversations.</div>
      <div class="row" style="gap:10px; align-items:flex-end;">
        <div class="field" style="margin:0; flex:1;">
          <label for="reportScope">Scope</label>
          <select id="reportScope">
            <option value="whole-year">Whole year (${new Date().getFullYear()})</option>
            ${state.settings.terms.map(t => `<option value="${t.number}">Term ${t.number} (${fmtDateShort(t.startDate)}–${fmtDateShort(t.endDate)})</option>`).join("")}
          </select>
        </div>
        <button class="btn btn-primary" id="generateReportBtn">${icon("print")} Generate &amp; print</button>
      </div>
    </div>

    <div class="card section-gap">
      <div class="card-head"><h2>Quick launch links</h2></div>
      <div id="qlEditor" class="list"></div>
      <div class="row section-gap">
        <input type="text" id="ql-new-label" placeholder="Label" style="flex:1;">
        <input type="url" id="ql-new-url" placeholder="https://…" style="flex:2;">
        <button class="btn" id="ql-add-btn">${icon("plus")} Add</button>
      </div>
    </div>

    <div class="grid grid-2 section-gap">
      <div class="card">
        <div class="card-head"><h2>${icon("export")} Backup</h2></div>
        <p class="hint">Your data auto-saves on this computer. Export regularly to keep a portable backup in this folder's <code>backups</code> subfolder — that also lets you carry data to your home PC via Google Drive sync.</p>
        <button class="btn btn-primary" id="exportBtn">${icon("export")} Export backup (.json)</button>
      </div>
      <div class="card">
        <div class="card-head"><h2>${icon("import")} Restore</h2></div>
        <p class="hint">Import a previously exported backup. This replaces all current data — export first if unsure.</p>
        <input type="file" id="importFile" accept="application/json" style="margin-bottom:10px;">
        <button class="btn" id="importBtn">${icon("import")} Import backup</button>
      </div>
    </div>

    <div class="card section-gap" id="syncCard">
      <div class="card-head">
        <h2>${icon("phone")} Sync across devices</h2>
        <span class="badge badge-muted" id="syncStatusIndicator">Not set up</span>
      </div>
      ${syncKey ? `
        <p class="hint">Sync is on for this device. Logging something here shows up on your other device within a few seconds, and vice versa.</p>
        <button class="btn btn-danger" id="syncForgetBtn">Turn off sync on this device</button>
      ` : `
        <p class="hint">One passphrase, entered on each device, keeps your laptop and phone in sync automatically. It's never sent anywhere — everything is encrypted in this browser before it leaves, so the sync service only ever sees scrambled data it can't read. <strong>If you forget this passphrase, synced data can't be recovered</strong> — worth saving it in a password manager.</p>
        <div class="field"><label for="sync-passphrase">Sync passphrase</label><input type="password" id="sync-passphrase" placeholder="Choose (or re-enter) your sync passphrase" autocomplete="off"></div>
        <div class="field"><label class="checkline"><input type="checkbox" id="sync-remember" checked> Remember on this device (skip re-entering it each visit)</label></div>
        <button class="btn btn-primary" id="syncEnableBtn">${icon("phone")} Turn on sync</button>
      `}
    </div>

    <div class="card section-gap">
      <div class="card-head"><h2>Danger zone</h2></div>
      <button class="btn btn-danger" id="resetBtn">Reset all data to defaults</button>
    </div>
  `;

  document.getElementById("themeWorkshop").addEventListener("click", () => setTheme("workshop"));
  document.getElementById("themeConsole").addEventListener("click", () => setTheme("console"));

  const save = (k, v) => { persist(); };
  document.getElementById("st-leader").addEventListener("input", e => { state.meta.leaderName = e.target.value; persist(); });
  document.getElementById("st-school").addEventListener("input", e => { state.meta.schoolName = e.target.value; persist(); });
  document.getElementById("st-la").addEventListener("input", e => { state.meta.learningArea = e.target.value; persist(); });
  function renderTermEditor(){
    document.getElementById("termEditor").innerHTML = state.settings.terms.map((t,i) => `
      <div class="item">
        <div class="item-main row" style="gap:8px;">
          <div class="field" style="flex:0 0 70px;"><label>Term</label><input type="number" min="1" max="4" data-term-num="${i}" value="${t.number}"></div>
          <div class="field"><label>Start</label><input type="date" data-term-start="${i}" value="${t.startDate}"></div>
          <div class="field"><label>End</label><input type="date" data-term-end="${i}" value="${t.endDate}"></div>
        </div>
      </div>
    `).join("");
    document.querySelectorAll("[data-term-num]").forEach(i => i.addEventListener("input", e => { state.settings.terms[+e.target.dataset.termNum].number = +e.target.value; persist(); renderDashboard(); }));
    document.querySelectorAll("[data-term-start]").forEach(i => i.addEventListener("input", e => { state.settings.terms[+e.target.dataset.termStart].startDate = e.target.value; persist(); renderDashboard(); }));
    document.querySelectorAll("[data-term-end]").forEach(i => i.addEventListener("input", e => { state.settings.terms[+e.target.dataset.termEnd].endDate = e.target.value; persist(); renderDashboard(); }));
  }
  renderTermEditor();
  document.getElementById("st-columns").addEventListener("input", e => { state.settings.relief.columns = e.target.value.split(",").map(s=>s.trim()).filter(Boolean); persist(); });
  document.getElementById("st-teamschannel").addEventListener("input", e => { state.settings.teamsChannel = e.target.value; persist(); });

  function renderQL(){
    document.getElementById("qlEditor").innerHTML = state.quickLaunch.map((q,i) => `
      <div class="item">
        <div class="item-main">
          <input type="text" data-ql-label="${i}" value="${escapeHtml(q.label)}" style="margin-bottom:4px;" placeholder="Label">
          <input type="url" data-ql-url="${i}" value="${escapeHtml(q.url)}" placeholder="https://… (website / fallback)" style="margin-bottom:4px;">
          <input type="text" data-ql-scheme="${i}" value="${escapeHtml(q.appScheme||"")}" placeholder="App protocol (optional) — e.g. msteams://, opens the desktop app instead of the website">
        </div>
        <div class="item-actions"><button class="btn btn-sm btn-danger" data-ql-rm="${i}">${icon("trash")}</button></div>
      </div>
    `).join("");
    document.querySelectorAll("[data-ql-label]").forEach(i=>i.addEventListener("input", e=>{ state.quickLaunch[+e.target.dataset.qlLabel].label = e.target.value; persist(); }));
    document.querySelectorAll("[data-ql-url]").forEach(i=>i.addEventListener("input", e=>{ state.quickLaunch[+e.target.dataset.qlUrl].url = e.target.value; persist(); }));
    document.querySelectorAll("[data-ql-scheme]").forEach(i=>i.addEventListener("input", e=>{ state.quickLaunch[+e.target.dataset.qlScheme].appScheme = e.target.value.trim(); persist(); }));
    document.querySelectorAll("[data-ql-rm]").forEach(b=>b.addEventListener("click", e=>{ state.quickLaunch.splice(+b.dataset.qlRm,1); persist(); renderQL(); }));
  }
  renderQL();
  document.getElementById("ql-add-btn").addEventListener("click", () => {
    const label = document.getElementById("ql-new-label").value.trim();
    const url = document.getElementById("ql-new-url").value.trim();
    if(!label) return;
    state.quickLaunch.push({label, url, icon:"globe"}); persist(); renderQL();
    document.getElementById("ql-new-label").value=""; document.getElementById("ql-new-url").value="";
  });

  document.getElementById("generateReportBtn").addEventListener("click", () => generateSummaryReport(document.getElementById("reportScope").value));
  document.getElementById("exportBtn").addEventListener("click", exportBackup);
  document.getElementById("importBtn").addEventListener("click", importBackup);

  updateSyncStatusUI();
  const syncEnableBtn = document.getElementById("syncEnableBtn");
  if(syncEnableBtn) syncEnableBtn.addEventListener("click", async () => {
    const pass = document.getElementById("sync-passphrase").value;
    if(!pass || pass.length < 6){ toast("Use a passphrase of at least 6 characters."); return; }
    const remember = document.getElementById("sync-remember").checked;
    syncEnableBtn.disabled = true; syncEnableBtn.textContent = "Connecting…";
    const ok = await enableSync(pass, remember);
    if(ok){ toast("Sync turned on."); renderSettings(); } else { syncEnableBtn.disabled = false; syncEnableBtn.textContent = "Turn on sync"; }
  });
  const syncForgetBtn = document.getElementById("syncForgetBtn");
  if(syncForgetBtn) syncForgetBtn.addEventListener("click", () => {
    if(!confirm("Turn off sync on this device? Your data here stays as-is, but this device will stop sending/receiving updates until you re-enter the passphrase.")) return;
    forgetSync();
    toast("Sync turned off on this device.");
    renderSettings();
  });
  document.getElementById("resetBtn").addEventListener("click", () => {
    if(!confirm("This will erase ALL data (team, relief log, tasks, meetings) and restore defaults. Export a backup first if unsure. Continue?")) return;
    state = defaultState(); persist(); toast("Reset to defaults."); renderAll();
  });
}

function setTheme(t){
  state.settings.theme = t;
  document.documentElement.dataset.theme = t;
  persist();
  renderSettings();
}

function exportBackup(){
  state.meta.lastBackup = new Date().toISOString();
  persist();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = todayISO();
  a.href = url; a.download = `command-centre-backup-${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast("Backup downloaded — move it into your backups folder.");
}

function importBackup(){
  const input = document.getElementById("importFile");
  const file = input.files[0];
  if(!file){ toast("Choose a backup file first."); return; }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      state = deepMerge(defaultState(), parsed);
      persist();
      toast("Backup restored.");
      renderAll();
    } catch(e){
      alert("That file couldn't be read as a valid backup.");
    }
  };
  reader.readAsText(file);
}

/* ---------------------------------------------------------------------- */
/* Backup reminder banner                                                 */
/* ---------------------------------------------------------------------- */
function maybeShowBackupBanner(){
  const el = document.getElementById("backupBanner");
  if(!el) return;
  const last = state.meta.lastBackup ? new Date(state.meta.lastBackup) : null;
  const daysSince = last ? (Date.now() - last.getTime()) / 86400000 : Infinity;
  if(daysSince > 7){
    el.style.display = "flex";
    el.querySelector(".msg").textContent = last
      ? `Last backup was ${Math.floor(daysSince)} days ago. Export a fresh one to keep your data safe.`
      : `You haven't exported a backup yet. Do it once so your data can travel with you.`;
  } else {
    el.style.display = "none";
  }
}

/* ---------------------------------------------------------------------- */
/* Init                                                                    */
/* ---------------------------------------------------------------------- */
function renderAll(){
  document.documentElement.dataset.theme = state.settings.theme;
  TABS.forEach(t => t.render());
  maybeShowBackupBanner();
}

function tickClock(){
  const el = document.getElementById("clockNow");
  if(!el) return;
  const now = new Date();
  el.textContent = now.toLocaleTimeString("en-AU", { hour:"2-digit", minute:"2-digit" });
}

document.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.theme = state.settings.theme;

  document.querySelectorAll(".tabnav button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
  document.getElementById("themeToggleBtn").addEventListener("click", () => setTheme(state.settings.theme === "workshop" ? "console" : "workshop"));
  document.getElementById("backupBtnTop").addEventListener("click", exportBackup);

  document.getElementById("poolModalClose").addEventListener("click", closePoolModal);
  document.getElementById("poolModalCancel").addEventListener("click", closePoolModal);
  document.getElementById("poolModalSave").addEventListener("click", savePoolModal);
  document.getElementById("poolModalBackdrop").addEventListener("click", e => { if(e.target.id === "poolModalBackdrop") closePoolModal(); });

  document.getElementById("timetableModalClose").addEventListener("click", closeTimetableModal);
  document.getElementById("timetableModalBackdrop").addEventListener("click", e => { if(e.target.id === "timetableModalBackdrop") closeTimetableModal(); });

  document.addEventListener("keydown", e => { if(e.key === "Escape"){ closePoolModal(); closeTimetableModal(); } });

  // Single persistent listener (registered once, not per-render) that closes
  // the global-search results dropdown on an outside click, whichever tab
  // is currently showing it.
  document.addEventListener("click", e => {
    const input = document.getElementById("appSearchInput");
    const results = document.getElementById("appSearchResults");
    if(!input || !results) return;
    if(!input.contains(e.target) && !results.contains(e.target)) results.style.display = "none";
  });

  const startTab = (location.hash || "#dashboard").replace("#","");
  showTab(TABS.some(t=>t.id===startTab) ? startTab : "dashboard");

  tickClock();
  setInterval(tickClock, 30000);
  maybeShowBackupBanner();

  window.addEventListener("beforeunload", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });

  loadRememberedSync();
});
