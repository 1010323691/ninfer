// monitor/web/app.js - the ninfer monitor page. Same layout and charts as Strata's Monitor tab, fed by
// monitor.py's GET /metrics (which reads ninfer-serve's --request-log-jsonl). No framework.
"use strict";

const $ = (id) => document.getElementById(id);
const SPRITE = "sprite.svg";
const icon = (name, cls = "st-icon") => `<svg class="${cls}" aria-hidden="true"><use href="${SPRITE}#i-${name}"/></svg>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? "–" : Number(n).toLocaleString(undefined, {maximumFractionDigits: d, minimumFractionDigits: d}));
const kfmt = (n) => (n == null ? "–" : n >= 1000 ? `${fmt(n / 1000, n >= 10000 ? 0 : 1)}k` : fmt(n));
const ctxfmt = (n) => (n && n % 1024 === 0 ? `${fmt(n / 1024)}K` : kfmt(n));
const gb = (b, d = 1) => (b == null ? "–" : fmt(b / 1073741824, d));
const pct = (a, b) => (b ? Math.min(100, (100 * a) / b) : 0);
const VRAM_WARN_GIB = 1.5, VRAM_DANGER_GIB = 0.5;      // free VRAM below this turns the VRAM number amber / red
const STREAK_STALE_S = 600;                              // the zero-reuse warning goes away after 10 quiet minutes
const MB = 1048576;
const mbfmt = (b) => (b == null ? "–" : b >= 1073741824 ? `${fmt(b / 1073741824, 2)} GB` : `${fmt(b / MB, b < 10 * MB ? 1 : 0)} MB`);
const pretty = (k) => String(k).replace(/_/g, " ");

// ---- theme
function setTheme(t, save) {
  document.documentElement.dataset.theme = t;
  $("theme-icon").setAttribute("href", `${SPRITE}#i-${t === "dark" ? "sun" : "moon"}`);
  if (save) { try { localStorage.setItem("ninfer.theme", t); } catch (e) { /* private mode */ } }
}
$("theme-btn").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
setTheme(document.documentElement.dataset.theme || "light", false);

// ---- the eight cards
const METRICS = [
  {key: "speed", label: "Speed", icon: "gauge"},
  {key: "gpu", label: "GPU load", icon: "gpu"},
  {key: "vram", label: "VRAM", icon: "layers"},
  {key: "temp", label: "GPU temp", icon: "thermometer", tone: "warn"},
  {key: "power", label: "Power", icon: "bolt"},
  {key: "pcie", label: "PCIe", icon: "link", tone: "info"},
  {key: "cpu", label: "CPU", icon: "cpu"},
  {key: "disk", label: "Disk read", icon: "disk", tone: "info"},
  {key: "reuse", label: "Prefix reuse", icon: "layers", tone: "info"},
  {key: "batch", label: "Batch", icon: "gauge"},
  {key: "pressure", label: "Cache pressure", icon: "bolt", tone: "warn"},
];
const SPARK_PATHS = `<path class="area" fill="currentColor" opacity=".12"/><path class="line" fill="none" stroke="currentColor"
  stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
$("metrics").innerHTML = METRICS.map((m) => `
  <div class="st-card metric-card"><div class="st-metric">
    <span class="st-metric__label">${icon(m.icon, "st-icon st-icon--sm")}${esc(m.label)}${m.key === "pressure" ? ` <span class="st-badge st-badge--queued" id="pressure-badge" hidden>evicting</span>` : ""}</span>
    ${m.key === "speed" ? `<div class="speed-values">
      <div><span class="st-metric__value" id="mv-speed">–</span><span class="st-metric__sub" id="ms-speed">Decode</span></div>
      <div class="speed-prefill"><span class="st-metric__value" id="mv-prefill">–</span><span class="st-metric__sub" id="ms-prefill">Prefill</span></div>
    </div>` : `<span class="st-metric__value" id="mv-${m.key}">–</span><span class="st-metric__sub" id="ms-${m.key}"></span>`}
    <svg class="st-metric__spark" id="sp-${m.key}" viewBox="0 0 100 32" preserveAspectRatio="none"${m.tone ? ` data-tone="${m.tone}"` : ""}>
      ${SPARK_PATHS}${m.key === "speed" ? `<g id="sp-prefill" class="speed-prefill">${SPARK_PATHS}</g>` : ""}</svg>
    ${m.key === "pressure" ? `<details class="pressure-detail"><summary>Totals since the log start</summary><div id="pressure-detail"></div></details>` : ""}
  </div></div>`).join("");

function spark(id, values, max) {
  const svg = $(id);
  const v = (values || []).map((x) => (x == null ? 0 : x));
  if (v.length < 2) { svg.querySelector(".line").setAttribute("d", ""); svg.querySelector(".area").setAttribute("d", ""); return; }
  const top = Math.max(max || 0, ...v, 1e-9);
  const pts = v.map((x, i) => [(i / (v.length - 1)) * 100, 30 - (x / top) * 26]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join("");
  svg.querySelector(".line").setAttribute("d", line);
  svg.querySelector(".area").setAttribute("d", `${line}L100,32L0,32Z`);
}
function setMetric(key, value, unit, sub) {
  $(`mv-${key}`).innerHTML = value == null ? "–" : `${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ""}`;
  $(`ms-${key}`).textContent = sub || "";
}
function setPill(state, text) {
  $("pill").dataset.state = state === "error" ? "queued" : state;
  $("pill-text").textContent = text;
}

// ---- render
let reqShowAll = false, lastMetrics = null, failures = 0, hideAux = false;
const PATH_TONES = ["", "info", "warn", "danger"];
function render(m) {
  const live = m.live || {}, hw = m.hardware || {}, st = m.hardware_static || {}, eng = m.engine || {}, h = m.history || {};
  const cache = m.cache || {}, lg = m.log || {};
  const reqs = m.requests || [];
  const last = reqs.find((r) => r.finish !== "error") || null;
  $("model-name").textContent = eng.model || "";

  // notice: what to do when there is no data yet
  const notice = !lg.found ? `Log file not found: ${lg.path}. Start ninfer-serve with --request-log-jsonl pointing to it.`
               : !lg.started ? "The log has no server_start record yet. Restart ninfer-serve with --request-log-jsonl (it writes one at startup)." : "";
  $("notice").hidden = !notice;
  $("notice-text").textContent = notice;

  const on = live.queued > 0 ? "queued" : live.state;
  const pillText = {idle: "Idle", reading: "Reading prompt", generating: "Generating", queued: "Queued"}[on] || "Idle";
  setPill(on === "reading" ? "reading" : on === "generating" ? "generating" : on === "queued" ? "queued" : "idle", pillText);
  for (const b of document.querySelectorAll("#state-badges .st-badge")) b.classList.toggle("on", b.dataset.s === on || b.dataset.s === live.state);

  // model state: the log has no per-token progress, so the bar shows the request counts
  const prog = $("state-progress");
  let label = "Waiting for a request", detail = "", p = 0;
  if (live.state === "reading") {
    label = "Reading prompt"; prog.dataset.tone = "info"; p = 100;
    detail = `${fmt(live.prefilling)} prefilling · ${fmt(live.prefill_tok_s_mean)} tok/s`;
  } else if (live.state === "generating") {
    label = "Generating"; delete prog.dataset.tone; p = 100;
    detail = `${fmt(live.running)} running${live.queued ? ` · ${fmt(live.queued)} waiting` : ""} · ${fmt(live.tok_s, 1)} tok/s`;
  } else if (last) {
    delete prog.dataset.tone;
    detail = `last: ${fmt(last.output_tokens)} tokens${last.decode_tok_s ? ` at ${fmt(last.decode_tok_s, 1)} tok/s` : ""}`;
  }
  $("state-label").textContent = label;
  $("state-detail").textContent = detail;
  $("state-bar").style.width = `${p}%`;

  // speed: the engine's rate in the latest throughput interval while busy; 0 when idle (the last request's below it)
  const busy = live.state !== "idle";
  const lastDec = last && last.decode_tok_s ? `last request ${fmt(last.decode_tok_s, 1)}` : "Decode";
  const lastPre = last && last.prefill_tok_s ? `last request ${fmt(last.prefill_tok_s)}` : "Prefill";
  setMetric("speed", fmt(busy ? live.tok_s || 0 : 0, 1), "t/s", busy ? "Decode now" : lastDec);
  setMetric("prefill", fmt(busy ? live.prefill_tok_s_mean || 0 : 0), "t/s", busy ? "Prefill now" : lastPre);
  spark("sp-speed", h.tok_s);
  spark("sp-prefill", h.prefill_tok_s);

  setMetric("gpu", hw.gpu_util == null ? null : fmt(hw.gpu_util), "%", st.gpu_name || "");
  spark("sp-gpu", h.gpu_util, 100);
  setMetric("vram", hw.gpu_mem_used == null ? null : gb(hw.gpu_mem_used), hw.gpu_mem_total ? `/ ${gb(hw.gpu_mem_total, 0)} GB` : "GB",
            [eng.kv_cache ? `KV ${eng.kv_cache}` : "", eng.speculative && eng.speculative !== "none" ? eng.speculative : ""].filter(Boolean).join(" · "));
  spark("sp-vram", h.gpu_mem_used, hw.gpu_mem_total);
  if (hw.gpu_mem_total) {          // headroom: the number turns amber / red when little VRAM is left
    const free = (hw.gpu_mem_total - hw.gpu_mem_used) / 1073741824;
    $("ms-vram").textContent = `${fmt(free, 1)} GiB free` + ($("ms-vram").textContent ? ` · ${$("ms-vram").textContent}` : "");
    $("mv-vram").style.color = free < VRAM_DANGER_GIB ? "var(--st-danger)" : free < VRAM_WARN_GIB ? "var(--st-warn)" : "";
  }
  setMetric("temp", hw.gpu_temp == null ? null : fmt(hw.gpu_temp), "°C", "");
  spark("sp-temp", h.gpu_temp, 90);
  setMetric("power", hw.gpu_power == null ? null : fmt(hw.gpu_power), "W", hw.gpu_power_limit ? `of ${fmt(hw.gpu_power_limit)} W limit` : "");
  spark("sp-power", h.gpu_power, hw.gpu_power_limit);
  const gen = hw.gpu_pcie_gen_max || hw.gpu_pcie_gen;
  setMetric("pcie", gen ? `Gen${gen}` : null, hw.gpu_pcie_width ? `x${hw.gpu_pcie_width}` : "",
            hw.gpu_pcie_rx_mb == null ? "" : `rx ${fmt(hw.gpu_pcie_rx_mb, hw.gpu_pcie_rx_mb < 10 ? 1 : 0)} / tx ${fmt(hw.gpu_pcie_tx_mb, (hw.gpu_pcie_tx_mb || 0) < 10 ? 1 : 0)} MB/s` +
            (hw.gpu_pcie_gen && gen && hw.gpu_pcie_gen < gen ? ` · idle Gen${hw.gpu_pcie_gen}` : ""));
  spark("sp-pcie", h.gpu_pcie_rx_mb);
  setMetric("cpu", hw.cpu == null ? null : fmt(hw.cpu), "%", st.threads ? `${st.cores ? `${st.cores} cores · ` : ""}${st.threads} threads` : "");
  spark("sp-cpu", h.cpu, 100);
  if (hw.disk_read_mb == null) {
    setMetric("disk", null, "", st.psutil ? "" : "needs psutil (pip install psutil)");
  } else {
    const big = hw.disk_read_mb >= 1000;
    setMetric("disk", big ? fmt(hw.disk_read_mb / 1024, 2) : fmt(hw.disk_read_mb, hw.disk_read_mb < 10 ? 1 : 0), big ? "GB/s" : "MB/s",
              hw.disk_write_mb == null ? "" : `write ${fmt(hw.disk_write_mb, 1)} MB/s`);
  }
  spark("sp-disk", h.disk_read_mb);

  // reuse trend, batch size, cache pressure
  const reuseHist = h.reuse || [];
  setMetric("reuse", reuseHist.length ? fmt(reuseHist[reuseHist.length - 1] * 100, 0) : null, "%", reuseHist.length ? `last request · ${reuseHist.length} in trend` : "");
  spark("sp-reuse", reuseHist, 1);
  const bt = m.batch || {};
  setMetric("batch", bt.avg == null ? null : fmt(bt.avg, 1), bt.concurrency ? `/ ${bt.concurrency}` : "", `${fmt(bt.running)} running · ${fmt(bt.waiting)} waiting`);
  spark("sp-batch", h.batch_size, bt.concurrency);
  const pr = m.pressure || {};
  setMetric("pressure", pr.last60s == null ? null : fmt(pr.last60s), "", "evicted / dropped, last 60 s");
  spark("sp-pressure", pr.series);
  $("pressure-badge").hidden = !(pr.last60s > 0);
  $("pressure-detail").innerHTML = Object.entries(pr.total || {}).map(([k, v]) => `<div class="p-row"><span>${esc(pretty(k))}</span><span>${fmt(v)}</span></div>`).join("");

  // context fill: the running request is not in the log, so this is the last finished one
  const ctx = eng.max_context || 0;
  const used = last ? (last.prompt_tokens || 0) + (last.output_tokens || 0) : 0;
  const frac = ctx ? Math.min(1, used / ctx) : 0;
  $("ctx-fill").setAttribute("stroke-dasharray", `${(235.6 * frac).toFixed(1)} 314.2`);
  $("ctx-fill").style.opacity = 235.6 * frac >= 3 ? "1" : "0";
  $("ctx-pct").textContent = `${Math.round(frac * 100)}%`;
  $("ctx-sub").textContent = ctx ? `${kfmt(used)} / ${ctxfmt(ctx)}` : "–";
  $("ctx-note").textContent = eng.kv_capacity ? `Per request (--max-context). KV pool for all cached chats: ${fmt(eng.kv_capacity)} tokens.` : "Per request (--max-context).";

  const rr = (m.reuse || {}).recent;
  $("reuse-text").textContent = rr == null ? "–" : `${fmt(rr * 100, 1)}%` + (m.reuse.zero_of[0] ? ` · ${m.reuse.zero_of[0]} of ${m.reuse.zero_of[1]} read in full` : "");
  $("reuse-bar").style.width = `${rr == null ? 0 : rr * 100}%`;
  $("ram-text").textContent = hw.ram_total ? `${gb(hw.ram_used)} / ${gb(hw.ram_total, 0)} GB` : "–";
  const ramPct = pct(hw.ram_used, hw.ram_total);
  $("ram-bar").style.width = `${ramPct}%`;
  if (ramPct > 92) $("ram-progress").dataset.tone = "danger"; else delete $("ram-progress").dataset.tone;
  $("temp-text").textContent = hw.gpu_temp == null ? "–" : `${fmt(hw.gpu_temp)} °C`;
  $("temp-bar").style.width = hw.gpu_temp == null ? "0%" : `${Math.min(100, hw.gpu_temp)}%`;

  // recent requests
  const body = $("req-body");
  const shownReqs = hideAux ? reqs.filter((r) => r.kind !== "aux") : reqs;
  if (!shownReqs.length) {
    body.innerHTML = `<tr><td colspan="13" class="muted">${reqs.length ? "Only aux requests so far" : "No requests yet"}</td></tr>`;
  } else {
    const badge = {stop: ["", "Done"], length: ["", "Max tokens"], cancel: ["st-badge--queued", "Stopped"], error: ["st-badge--error", "Error"]};
    body.innerHTML = shownReqs.map((r) => {
      let [cls, text] = badge[r.finish] || ["", r.finish || "–"];
      if (r.finish_raw === "context_capacity") [cls, text] = ["st-badge--queued", "Context full"];
      const t = new Date(r.time * 1000).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"});
      const pathTip = r.reuse_path ? ` title="prefix reuse path: ${esc(r.reuse_path)}"` : r.message ? ` title="${esc(r.message)}"` : "";
      const draft = r.drafted ? `${fmt((100 * r.accepted) / r.drafted, 0)}%` : "–";
      const sec = (v) => (v == null ? "–" : `${fmt(v, v < 10 ? 2 : 1)} s`);
      const think = r.thinking_tokens
        ? `<span title="${r.output_tokens ? fmt((100 * r.thinking_tokens) / r.output_tokens, 0) : 0}% of the output${r.thinking_budget ? ` · budget ${fmt(r.thinking_budget)}` : ""}">${fmt(r.thinking_tokens)}</span>` : "–";
      const budget = r.thinking_applied ? `<span class="tag tag--warn" title="The thinking budget was reached and thinking was cut off">budget</span>` : "";
      const tools = r.tool_calls ? fmt(r.tool_calls) : "–";
      const fb = r.tool_fallback ? `<span class="tag tag--danger" title="tool call parse fallback: ${esc(r.tool_fallback)}">${esc(pretty(r.tool_fallback))}</span>` : "";
      return `<tr${r.zero_reuse ? ' class="zero" title="Longer prompt than the previous request but nothing reused (possibly the same conversation)"' : ""}>
        <td>${esc(t)}</td><td><span class="st-badge ${cls}"${pathTip}>${esc(text)}</span>${r.kind === "aux" ? '<span class="tag" title="aux: very short request without tools">aux</span>' : ""}${budget}</td>
        <td class="num">${fmt(r.prompt_tokens)}</td><td class="num"${pathTip}>${fmt(r.reused)}</td><td class="num">${fmt(r.output_tokens)}</td>
        <td class="num">${fmt(r.decode_tok_s, 1)}</td><td class="num">${draft}</td><td class="num">${sec(r.ttft_s)}</td><td class="num">${sec(r.queue_s)}</td>
        <td class="num">${think}</td><td class="num">${tools}${fb}</td><td class="num">${durCell(r)}</td></tr>`;
    }).join("");
  }
  const all = $("req-all");
  all.hidden = (m.kept || 0) <= 12;
  all.textContent = reqShowAll ? "Show fewer" : `Show all (${m.kept})`;
  $("req-wrap").classList.toggle("all", reqShowAll);
  $("req-totals").textContent = renderTotals(m.totals || {}, m.finish_counts || {});

  // conversation cache: the engine's own gauges from the latest throughput event
  const bar = (key, used, total, text) => {
    $(`cc-${key}-text`).textContent = total ? text : "–";
    $(`cc-${key}-bar`).style.width = `${pct(used, total)}%`;
  };
  bar("dev", cache.device_slots_used, cache.device_slots_total, `${fmt(cache.device_slots_used)} / ${fmt(cache.device_slots_total)}`);
  if (cache.host_slots_total) {
    bar("host", cache.host_slots_used, cache.host_slots_total, `${fmt(cache.host_slots_used)} / ${fmt(cache.host_slots_total)}`);
  } else {  // shared Host pool: states have no separate cap, so the bar follows the pool
    bar("host", cache.host_kv_used, cache.host_kv_total, `${fmt(cache.host_slots_used)} states (shared pool)`);
  }
  bar("kv", cache.host_kv_used, cache.host_kv_total, `${gb(cache.host_kv_used, 2)} / ${gb(cache.host_kv_total, 1)} GB`);
  $("cc-sum").textContent = cache.enabled === false ? "context cache off" : cache.prefix_reuse === false ? "prefix reuse off (--no-prefix-reuse)" : "";
  bar("pg", cache.kv_pages_used, cache.kv_pages_total, `${fmt(cache.kv_pages_used)} / ${fmt(cache.kv_pages_total)} pages (×64 tok)`);
  $("cc-note").textContent = cache.device_slots_used == null ? "Slot gauges appear after the first throughput event (every few seconds while busy)." : "";
  const tr = m.transfers || {};
  const xrow = (label, a, b) => {
    const bytes = (a.bytes || 0) + (b.bytes || 0), sec = (a.seconds || 0) + (b.seconds || 0);
    const rate = a.mb_s_60s == null ? b.mb_s_60s : b.mb_s_60s == null ? a.mb_s_60s : Math.max(a.mb_s_60s, b.mb_s_60s);
    return `<div><strong>${label}</strong>: ${bytes ? `${mbfmt(bytes)} in ${fmt(sec, 2)} s` : "none yet"}${rate == null ? "" : ` · ${fmt(rate, 0)} MB/s (last 60 s)`}</div>`;
  };
  const z = {};
  $("xfer").innerHTML = xrow("Host ← Device", tr.state_d2h || z, tr.kv_d2h || z) + xrow("Device ← Host", tr.state_h2d || z, tr.kv_h2d || z);

  // reuse paths, last 100 requests
  const pe = Object.entries((m.reuse || {}).paths || {}).sort((a, b) => b[1].n - a[1].n);
  const pn = pe.reduce((a, [, v]) => a + v.n, 0);
  $("paths-sum").textContent = pn ? `${pn} requests` : "–";
  $("paths").innerHTML = pn ? pe.map(([k, v], i) => `<div><div class="p-row"><span>${esc(pretty(k))}</span><span class="muted">${v.n} · ${fmt((100 * v.n) / pn, 0)}% · ${kfmt(v.tokens)} tok</span></div>
    <div class="st-progress"${PATH_TONES[i % 4] ? ` data-tone="${PATH_TONES[i % 4]}"` : ""}><div class="st-progress__bar" style="width:${(100 * v.n) / pn}%"></div></div></div>`).join("")
    : '<span class="muted small">–</span>';

  // warning when the same conversation keeps being read in full
  const zs = (m.reuse || {}).zero_streak || 0;
  const zAge = (m.reuse || {}).streak_age_s;
  $("warn-strip").hidden = zs < ((m.reuse || {}).alert_at || 3) || zAge == null || zAge > STREAK_STALE_S;
  $("warn-text").textContent = `${zs} requests in a row read a longer prompt in full with no reuse (possibly one conversation whose cache was lost).`;

  // speculative decoding: acceptance rate by draft position
  const sp = m.speculative || {};
  const pos = sp.per_position || [];
  const nb = Math.max(sp.window || 0, pos.length);
  $("spec-bars").innerHTML = nb ? Array.from({length: nb}, (_, i) => {
    const r = pos[i] || 0, w = 140 / nb, x = i * w + w * 0.15, bw = w * 0.7, hh = 54 * Math.min(1, r);
    return `<rect class="track" x="${x.toFixed(1)}" y="2" width="${bw.toFixed(1)}" height="54" rx="2"/><rect class="fill" x="${x.toFixed(1)}" y="${(56 - hh).toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" rx="2"><title>position ${i + 1}: ${fmt(r * 100, 0)}%</title></rect>` +
           `<text x="${(x + bw / 2).toFixed(1)}" y="66">${i + 1}</text>`;
  }).join("") : "";
  $("spec-note").textContent = sp.rounds ? `${sp.backend || "draft"} · accepted ${fmt((100 * sp.accepted) / Math.max(1, sp.drafted), 0)}% of ${fmt(sp.drafted)} drafted · ${fmt(sp.rounds)} rounds · fallback ${fmt(sp.fallback_steps)}` : "No speculative requests yet";

  // GPU wait vs host
  const pf = m.perf || {};
  const share = (key, tid, bid) => { $(tid).textContent = pf[key] == null ? "–" : `${fmt(pf[key] * 100, 1)}%`; $(bid).style.width = `${pf[key] == null ? 0 : pf[key] * 100}%`; };
  share("gpu_wait_share", "wait-text", "wait-bar");
  share("host_share", "host-text", "host-bar");
  $("host-note").textContent = (pf.top_host_stages || []).length ? `Largest host stages: ${pf.top_host_stages.map(([k, v]) => `${pretty(k)} ${v == null ? "–" : fmt(v * 100, 1) + "%"}`).join(", ")} (of request time, last ${pf.n})` : "Share of request time, last 20 requests";

  // prefill speed by prompt size
  const bks = m.prefill_buckets || [];
  const bmax = Math.max(1, ...bks.map((b) => b.avg_tok_s || 0));
  $("buckets").innerHTML = bks.map((b) => `<div class="bar-row"><span>${esc(b.name)} <span class="muted">(${b.n})</span></span><span class="muted">${b.avg_tok_s == null ? "–" : `${fmt(b.avg_tok_s)} tok/s`}</span></div>
    <div class="st-progress" data-tone="info"><div class="st-progress__bar" style="width:${b.avg_tok_s == null ? 0 : (100 * b.avg_tok_s) / bmax}%"></div></div>`).join("");

  // errors
  const er = m.errors || {};
  $("err-badge").hidden = !er.total;
  $("err-badge").textContent = er.total ? `${fmt(er.total)} ${er.total === 1 ? "error" : "errors"}` : "";
  $("err-note").textContent = er.total ? `${(er.by_reason || []).length} distinct reasons` : "No errors";
  $("err-details").hidden = !er.total;
  $("err-list").innerHTML = (er.by_reason || []).map(([k, v]) => {
    const last = (er.recent || []).find((e) => (e.code || e.message.slice(0, 60)) === k);
    return `<div title="${esc(last ? last.message : "")}"><span>${esc(k)}</span><span class="muted">${fmt(v)}</span></div>`;
  }).join("");
}
function durCell(r) {
  if (r.duration_s == null) return "–";
  const parts = [["d-prep", r.prepare_s, "prepare"], ["d-queue", r.queue_s, "queue"], ["d-pre", r.prefill_s, "prefill"], ["d-dec", r.decode_s, "decode"]];
  const sum = parts.reduce((a, p) => a + (p[1] || 0), 0);
  const scale = Math.max(r.duration_s, sum) || 1;
  const tip = parts.map((p) => `${p[2]} ${p[1] == null ? "–" : fmt(p[1], 2) + " s"}`).join(" · ") + ` · total ${fmt(r.duration_s, 2)} s`;
  return `<div class="dur" title="${esc(tip)}">${parts.map((p) => `<i class="${p[0]}" style="width:${(100 * (p[1] || 0)) / scale}%"></i>`).join("")}</div>${fmt(r.duration_s, 1)} s`;
}
function renderTotals(t, fc) {
  if (!t.requests) return "";
  const since = t.since ? new Date(t.since * 1000).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}) : "the log start";
  const read = t.computed || 0;
  const pSpeed = t.prefill_s > 0 && read > 0 ? ` at ${fmt(read / t.prefill_s)} tok/s` : "";
  const oSpeed = t.decode_s > 0 && t.output_tokens > 0 ? ` at ${fmt(t.output_tokens / t.decode_s, 1)} tok/s` : "";
  return `Since ${since}: ${fmt(t.requests)} requests · ${fmt(read)} prompt tokens read${pSpeed} (${fmt(t.reused)} reused of ${fmt(t.prompt_tokens)}) · ` +
         `${fmt(t.output_tokens)} written${oSpeed}${t.errors ? ` · ${fmt(t.errors)} errors` : ""}` +
         (fc.output_limit ? ` · ${fmt(fc.output_limit)} hit max tokens` : "") + (fc.context_capacity ? ` · ${fmt(fc.context_capacity)} context full` : "");
}
$("hide-aux").addEventListener("change", (e) => { hideAux = e.target.checked; if (lastMetrics) render(lastMetrics); });
$("req-all").addEventListener("click", () => { reqShowAll = !reqShowAll; if (lastMetrics) render(lastMetrics); poll(true); });

// ---- poll once a second; the next poll is queued after the previous one finishes
let timer = null, apiKey = "", keyDeclined = false;
try { apiKey = sessionStorage.getItem("ninfer.key") || ""; } catch (e) { /* private mode */ }
async function poll(once) {
  try {
    const r = await fetch(reqShowAll ? "metrics?requests=all" : "metrics", apiKey ? {headers: {Authorization: `Bearer ${apiKey}`}} : {});
    if (r.status === 401) {
      setPill("error", "API key needed");
      const k = keyDeclined ? null : prompt(apiKey ? "That key was rejected. API key for the monitor (--api-key):" : "API key for the monitor (--api-key):");
      if (!k) keyDeclined = true;            // asked once; reload the page to be asked again
      else { apiKey = k.trim(); try { sessionStorage.setItem("ninfer.key", apiKey); } catch (e) { /* private mode */ } }
    }
    else if (r.ok) { lastMetrics = await r.json(); failures = 0; render(lastMetrics); }
  } catch (e) {
    if (++failures >= 3) setPill("error", "Monitor not reachable");
  }
  if (!once) { clearTimeout(timer); timer = setTimeout(poll, 1000); }
}
poll();
