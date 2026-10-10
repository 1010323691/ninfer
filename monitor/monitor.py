#!/usr/bin/env python3
"""ninfer monitor: a small dashboard that reads ninfer-serve's --request-log-jsonl file.

    ninfer-serve ... --request-log-jsonl logs/requests.jsonl
    python3 monitor/monitor.py --log logs/requests.jsonl

Then open http://127.0.0.1:18081/. Standard library only (psutil is used when installed). It never
talks to ninfer-serve: it tails the log file, samples the GPU with nvidia-smi once a second, and
serves the page plus GET /metrics (the numbers the page draws).
"""
import argparse
import collections
import json
import mimetypes
import os
import re
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

try:
    import psutil
except ImportError:  # CPU / RAM then come from /proc, disk read is not shown
    psutil = None

HERE = os.path.dirname(os.path.abspath(__file__))
HISTORY = 60                      # one point per second, like Strata's monitor
KEEP_REQUESTS = 500
REUSE_WINDOW = 100                # requests behind the reuse-path bars and the reuse trend
PERF_WINDOW = 20                  # requests behind the GPU-wait / host split
RATE_WINDOW_S = 60.0              # cache pressure and transfer rates look back this far
AUX_MAX_TOKENS = 16               # a request that wrote this few tokens (and used no tools) is tagged "aux"
ZERO_REUSE_ALERT = 3              # consecutive full prefills before the page warns
BUCKETS = ((0, 4096, "<4K"), (4096, 16384, "4-16K"), (16384, 65536, "16-64K"), (65536, 1 << 62, ">64K"))
PRESSURE_KEYS = ("checkpoints_dropped", "private_owners_evicted", "private_owners_degraded", "shared_owners_evicted",
                 "shared_owners_degraded", "spill_pages", "maximal_fallback_selections", "partial_tail_cow_pages",
                 "historical_fork_hits", "searches", "search_budget_exhaustions")
EVICT_KEYS = ("checkpoints_dropped", "private_owners_evicted", "shared_owners_evicted", "spill_pages")
XFER_GROUPS = (("state", "state_transfers"), ("kv", "main_kv_transfers"))
STATS_INTERVAL_DEFAULT_MS = 5000  # ninfer-serve --log-stats-interval-ms (the throughput event cadence)

FINISH = {"stop_token": "stop", "stop_string": "stop", "output_limit": "length",
          "context_capacity": "length", "cancelled": "cancel", "none": "stop"}
SERIES = ("tok_s", "prefill_tok_s", "gpu_util", "gpu_mem_used", "gpu_temp", "gpu_power",
          "gpu_pcie_rx_mb", "gpu_pcie_tx_mb", "cpu", "disk_read_mb", "ram_used")


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.server = None                     # the latest server_start record
        self.instance = None
        self.active = {}                       # request_id -> request_start time
        self.requests = collections.deque(maxlen=KEEP_REQUESTS)
        self.totals = collections.Counter()
        self.throughput = None                 # the latest throughput record
        self.throughput_at = 0.0
        self.hw = {}
        self.hw_static = {}
        self.history = {k: collections.deque(maxlen=HISTORY) for k in SERIES}
        self.log_path = ""
        self.log_seen = False
        self.skipped = 0                       # log lines that could not be read or applied
        self.last_event_at = 0.0
        self.last_done_at = 0.0
        self.history["batch_size"] = collections.deque(maxlen=HISTORY)
        self.history["cache_pressure"] = collections.deque(maxlen=HISTORY)     # one point per throughput interval
        self.history["reuse"] = collections.deque(maxlen=REUSE_WINDOW)         # one point per finished request
        self.pressure_total = collections.Counter()
        self.pressure_events = collections.deque()                              # (time, evictions in that interval)
        self.xfer_total = collections.defaultdict(lambda: {"bytes": 0, "seconds": 0.0, "count": 0})
        self.xfer_events = collections.deque()                                  # (time, key, bytes, seconds)
        self.spec = {"rounds": 0, "drafted": 0, "accepted": 0, "fallback": 0, "window": 0, "backend": "", "positions": []}
        self.finish_counts = collections.Counter()
        self.error_counts = collections.Counter()
        self.error_recent = collections.deque(maxlen=20)
        self.zero_streak = 0
        self.zero_streak_at = 0.0                                               # when the streak last grew
        self.last_prompt = {}                                                   # protocol -> prompt tokens of the previous request

    # ---- log events
    def apply(self, ev):
        kind = ev.get("event")
        ts = ev.get("timestamp_unix_ms", 0) / 1000.0
        with self.lock:
            if ev.get("server_instance_id") != self.instance and kind == "server_start":
                self.instance = ev.get("server_instance_id")
                self.active.clear()
                self.zero_streak, self.zero_streak_at = 0, 0.0      # a restarted engine starts with a cold cache
                self.last_prompt.clear()
            if kind == "server_start":
                self.server = ev
                self.last_event_at = ts
                return
            if self.instance is not None and ev.get("server_instance_id") not in (None, self.instance):
                return                          # an older process's records in a shared campaign file
            self.last_event_at = ts or self.last_event_at
            req = ev.get("request") or {}
            rid = req.get("request_id")
            if kind == "request_start":
                self.active[rid] = ts
            elif kind == "request_done":
                self.active.pop(rid, None)
                self.last_done_at = ts
                self._done(ev, req, ts)
            elif kind == "request_error":
                self.active.pop(rid, None)
                self._failed(req, ts, "error", *self._err(ev))
            elif kind == "request_rejected":
                self._failed(req, ts, "error", *self._err(ev))
            elif kind == "throughput":
                self.throughput = ev
                self.throughput_at = ts
                self._throughput(ev, ts)

    @staticmethod
    def _err(ev):
        e = ev.get("error") or {}
        return str(e.get("message", "")), str(e.get("code", e.get("type", "")) or "")

    def _throughput(self, ev, ts):
        cc = ev.get("context_cache") or {}
        press = cc.get("pressure") or {}
        for k in PRESSURE_KEYS:
            self.pressure_total[k] += press.get(k) or 0
        evicted = sum(press.get(k) or 0 for k in EVICT_KEYS)
        self.pressure_events.append((ts, evicted))
        self.history["cache_pressure"].append(evicted)
        for name, field in XFER_GROUPS:
            for d in ("d2h", "h2d"):
                x = (cc.get(field) or {}).get(d) or {}
                b, sec = x.get("bytes") or 0, x.get("seconds") or 0.0
                if b or sec:
                    t = self.xfer_total[f"{name}_{d}"]
                    t["bytes"] += b
                    t["seconds"] += sec
                    t["count"] += x.get("count", x.get("pages", 0)) or 0
                    self.xfer_events.append((ts, f"{name}_{d}", b, sec))
        horizon = ts - 2 * RATE_WINDOW_S
        while self.pressure_events and self.pressure_events[0][0] < horizon:
            self.pressure_events.popleft()
        while self.xfer_events and self.xfer_events[0][0] < horizon:
            self.xfer_events.popleft()

    def _done(self, ev, req, ts):
        res, tm, sp = ev.get("result", {}), ev.get("timings_seconds", {}), ev.get("speculative", {})
        et = ev.get("engine_timing") or {}
        hx = et.get("host_exposed_seconds") or {}
        tp = res.get("tool_call_parse") or {}
        fb = tp.get("fallback_reason")
        prompt, out = res.get("prompt_tokens", 0), res.get("completion_tokens", 0)
        reused = res.get("prefix_cache_hit_tokens", 0)
        computed = res.get("computed_prefill_tokens", max(0, prompt - reused))
        dec, pre = tm.get("decode", 0) or 0, tm.get("prefill", 0) or 0
        rec = {"id": req.get("request_id"), "time": ts, "protocol": req.get("protocol", ""),
               "finish": FINISH.get(res.get("finish_reason"), res.get("finish_reason", "stop")),
               "prompt_tokens": prompt, "reused": reused, "output_tokens": out,
               "decode_tok_s": out / dec if dec > 0 and out > 0 else None,
               "prefill_tok_s": computed / pre if pre > 0 and computed > 0 else None,
               "ttft_s": tm.get("ttft"), "duration_s": tm.get("total"),
               "reuse_path": res.get("prefix_reuse_path", ""),
               "drafted": sp.get("drafted_tokens", 0), "accepted": sp.get("accepted_tokens", 0),
               "queue_s": et.get("queue_wait_seconds"), "finish_raw": res.get("finish_reason", ""),
               "prepare_s": tm.get("prepare"), "prefill_s": tm.get("prefill"), "decode_s": tm.get("decode"),
               "device_wait_s": et.get("device_wait_exposed_seconds"), "host_exposed_s": hx.get("total"),
               "host_stages": {k: v for k, v in hx.items() if k != "total"},
               "thinking_tokens": res.get("model_thinking_tokens"),
               "thinking_budget": res.get("thinking_budget"), "thinking_applied": bool(res.get("thinking_control_applied")),
               "tool_calls": res.get("tool_call_count", 0), "tool_fallback": fb if fb and fb != "none" else None,
               "message_count": req.get("message_count"), "tool_count": req.get("tool_count", 0),
               "media_count": req.get("media_item_count", 0),
               "kind": "aux" if out <= AUX_MAX_TOKENS and not req.get("tool_count") else "main",
               "zero_reuse": False}
        proto = rec["protocol"]
        prev = self.last_prompt.get(proto)
        if reused > 0:
            self.zero_streak = 0
        elif prompt and prev is not None and prompt > prev:
            self.zero_streak += 1
            self.zero_streak_at = ts               # a longer prompt than the previous one that reused nothing
            rec["zero_reuse"] = True
        self.last_prompt[proto] = prompt
        if prompt:
            self.history["reuse"].append(reused / prompt)
        self.finish_counts[res.get("finish_reason", "none")] += 1
        if sp.get("rounds"):
            s = self.spec
            s["rounds"] += sp.get("rounds", 0)
            s["drafted"] += sp.get("drafted_tokens", 0)
            s["accepted"] += sp.get("accepted_tokens", 0)
            s["fallback"] += sp.get("fallback_steps", 0)
            s["window"] = sp.get("draft_window", s["window"])
            s["backend"] = sp.get("backend", s["backend"])
            pos = sp.get("accepted_per_position") or []
            s["positions"] = [(s["positions"][i] if i < len(s["positions"]) else 0) + (pos[i] if i < len(pos) else 0)
                              for i in range(max(len(pos), len(s["positions"])))]
        self.requests.appendleft(rec)
        t = self.totals
        t["requests"] += 1
        t["prompt_tokens"] += prompt
        t["reused"] += reused
        t["output_tokens"] += out
        t["prefill_s"] += pre
        t["computed"] += computed
        t["decode_s"] += dec
        if t["since"] == 0:
            t["since"] = ts

    def _failed(self, req, ts, finish, message, code=""):
        reason = code or (message[:60] if message else "unknown")
        self.error_counts[reason] += 1
        self.error_recent.appendleft({"time": ts, "code": code, "message": (message or "")[:200]})
        self.requests.appendleft({"id": req.get("request_id"), "time": ts, "finish": finish, "message": message,
                                  "protocol": req.get("protocol", ""), "prompt_tokens": 0, "reused": 0,
                                  "output_tokens": 0, "decode_tok_s": None, "prefill_tok_s": None,
                                  "ttft_s": None, "duration_s": None, "reuse_path": "", "drafted": 0, "accepted": 0,
                                  "queue_s": None, "kind": "main", "zero_reuse": False, "finish_raw": "error"})
        self.totals["errors"] += 1

    def fresh_seconds(self):
        """How long a throughput event still describes "now": two and a half report intervals."""
        ms = ((self.server or {}).get("engine") or {}).get("log_stats_interval_ms") or STATS_INTERVAL_DEFAULT_MS
        return max(2.5, 2.5 * ms / 1000.0)

    # ---- the numbers the page draws
    def metrics(self, show_all):
        now = time.time()
        with self.lock:
            srv = self.server or {}
            eng = srv.get("engine", {})
            art = srv.get("artifact", {})
            env = srv.get("environment", {})
            cc = eng.get("context_cache", {})
            tp = self.throughput
            fresh = tp is not None and now - self.throughput_at < self.fresh_seconds()
            sch = (tp or {}).get("scheduler", {}) if fresh else {}
            running = len(self.active)
            if sch.get("prefilling"):
                state = "reading"
            elif sch.get("running") or sch.get("decode_ready") or (running and not sch):
                state = "generating"
            else:
                state = "idle"
            if running and state == "idle":
                state = "generating"
            if not running and self.last_done_at >= self.throughput_at:
                state, sch, fresh = "idle", {}, False      # the last request finished after the engine's last report
            if state == "idle":
                fresh = False                  # nothing is running: the speeds are 0, not the last interval's
            rates = (tp or {}).get("throughput_tokens_per_second", {}) if fresh else {}
            live = {"state": state, "queued": sch.get("waiting", 0), "running": running,
                    "tok_s": rates.get("decode"), "prefill_tok_s_mean": rates.get("prefill"),
                    "prefilling": sch.get("prefilling", 0)}
            occ = ((tp or {}).get("context_cache") or {}).get("occupancy", {})
            mem = srv.get("memory", {})
            cache = {"device_slots_used": occ.get("device_state_slots"),
                     "device_slots_total": cc.get("total_device_state_slots"),
                     "host_slots_used": occ.get("host_state_slots"),
                     # Upstream has one shared Host budget for retained State and KV (no separate
                     # slot or KV caps); older builds reported them separately.
                     "host_slots_total": cc.get("host_state_slots"),
                     "host_kv_used": occ.get("host_context_occupied_bytes", occ.get("host_kv_bytes")),
                     "host_kv_total": mem.get("host_context_capacity_bytes",
                                              mem.get("host_kv_capacity_bytes")),
                     "device_kv_pages": occ.get("device_main_kv_pages"),
                     "kv_pages_used": occ.get("device_main_kv_pages"), "kv_pages_total": eng.get("kv_capacity_page_groups"),
                     "enabled": cc.get("enabled"), "prefix_reuse": eng.get("prefix_reuse")}
            recent = list(self.requests)
            shown = recent if show_all else recent[:12]
            tot = dict(self.totals)
            window = recent[:20]
            wp = sum(r["prompt_tokens"] for r in window)
            reuse_recent = (sum(r["reused"] for r in window) / wp) if wp else None
            done = [r for r in recent if r["finish"] != "error"]
            paths = {}
            for r in done[:REUSE_WINDOW]:
                p = paths.setdefault(r["reuse_path"] or "none", {"n": 0, "tokens": 0})
                p["n"] += 1
                p["tokens"] += r["reused"]
            perf_rows = done[:PERF_WINDOW]
            wall = sum(r["duration_s"] or 0 for r in perf_rows)
            stages = collections.Counter()
            for r in perf_rows:
                stages.update(r.get("host_stages") or {})
            perf = {"n": len(perf_rows),
                    "gpu_wait_share": min(1.0, sum(r["device_wait_s"] or 0 for r in perf_rows) / wall) if wall else None,
                    "host_share": min(1.0, sum(r["host_exposed_s"] or 0 for r in perf_rows) / wall) if wall else None,
                    "top_host_stages": [[k, v / wall if wall else None] for k, v in stages.most_common(2)]}
            buckets = []
            for lo, hi, name in BUCKETS:
                rows = [r["prefill_tok_s"] for r in done if lo <= r["prompt_tokens"] < hi and r["prefill_tok_s"]]
                buckets.append({"name": name, "n": len(rows), "avg_tok_s": sum(rows) / len(rows) if rows else None})
            cutoff = now - RATE_WINDOW_S
            press = {"total": dict(self.pressure_total),
                     "last60s": sum(v for t, v in self.pressure_events if t >= cutoff),
                     "series": list(self.history["cache_pressure"])}
            xfers = {}
            for key in ("state_d2h", "state_h2d", "kv_d2h", "kv_h2d"):
                acc = self.xfer_total.get(key) or {"bytes": 0, "seconds": 0.0, "count": 0}
                wb = sum(b for t, k, b, _ in self.xfer_events if k == key and t >= cutoff)
                ws = sum(sec for t, k, _, sec in self.xfer_events if k == key and t >= cutoff)
                xfers[key] = dict(acc, mb_s_60s=wb / ws / 1048576 if ws > 0 else None)
            sp = self.spec
            speculative = {"backend": sp["backend"] or eng.get("speculative_backend"), "window": sp["window"],
                           "rounds": sp["rounds"], "drafted": sp["drafted"], "accepted": sp["accepted"],
                           "fallback_steps": sp["fallback"],
                           "per_position": [a / sp["rounds"] for a in sp["positions"]] if sp["rounds"] else []}
            bs = list(self.history["batch_size"])
            batch = {"avg": ((tp or {}).get("decode_batch") or {}).get("average_size") if fresh and state != "idle" else None,
                     "running": live["running"], "waiting": live["queued"], "concurrency": eng.get("max_concurrency")}
            errors = {"total": tot.get("errors", 0),
                      "by_reason": [[k, v] for k, v in self.error_counts.most_common()],
                      "recent": list(self.error_recent)}
            zero = sum(1 for r in window if r["finish"] != "error" and r["prompt_tokens"] and not r["reused"])
            streak = self.zero_streak
            return {
                "engine": {"model": art.get("name"), "max_context": eng.get("max_context"),
                           "concurrency": eng.get("max_concurrency"), "kv_cache": eng.get("kv_cache"),
                           "kv_capacity": eng.get("kv_capacity"), "stats_interval_ms": eng.get("log_stats_interval_ms"),
                           "speculative": eng.get("speculative_backend"),
                           "draft_window": eng.get("speculative_draft_window"),
                           "vision": eng.get("vision"), "instance": self.instance},
                "live": live, "cache": cache,
                "reuse": {"recent": reuse_recent, "paths": paths, "window": min(REUSE_WINDOW, len(done)), "zero_streak": streak,
                          "streak_age_s": now - self.zero_streak_at if self.zero_streak_at else None,
                          "alert_at": ZERO_REUSE_ALERT, "zero_of": [zero, sum(1 for r in window if r["finish"] != "error")]},
                "perf": perf, "prefill_buckets": buckets, "pressure": press, "transfers": xfers,
                "speculative": speculative, "batch": batch, "errors": errors, "finish_counts": dict(self.finish_counts),
                "config": {"aux_max_tokens": AUX_MAX_TOKENS},
                "hardware": dict(self.hw),
                "hardware_static": dict(self.hw_static, gpu_name=env.get("gpu_name") or self.hw_static.get("gpu_name")),
                "history": {k: list(v) for k, v in self.history.items()},
                "requests": shown, "kept": len(recent), "totals": tot,
                "log": {"path": self.log_path, "found": self.log_seen, "skipped": self.skipped, "last_event": self.last_event_at,
                        "started": bool(self.server)},
                "now": now}


STATE = State()


def tail_log(path):
    """Follow the JSONL file: read what is there, then new lines; start over if it is replaced."""
    STATE.log_path = path
    f, ino, pos, buf = None, None, 0, b""
    while True:
        try:
            st = os.stat(path)
            if f is None or st.st_ino != ino or st.st_size < pos:
                if f:
                    f.close()
                f, ino, pos, buf = open(path, "rb"), st.st_ino, 0, b""
                STATE.log_seen = True
            chunk = f.read(1 << 20)
            if chunk:
                pos += len(chunk)
                buf += chunk
                *lines, buf = buf.split(b"\n")
                for line in lines:
                    if line.strip():
                        try:
                            STATE.apply(json.loads(line))
                        except ValueError:
                            STATE.skipped += 1             # not JSON (a torn line)
                        except Exception:                  # one odd record must not stop the follower
                            STATE.skipped += 1
                continue
        except FileNotFoundError:
            STATE.log_seen = False
            f = None
        time.sleep(0.5)


# ------------------------------------------------------------------ hardware sampling
def parse_dmon(line):
    """One `nvidia-smi dmon -s t` row (gpu rxpci txpci) -> (rx, tx) in MB/s, or None."""
    cols = line.split()
    if len(cols) >= 3 and all(c.replace(".", "").isdigit() for c in cols[1:3]):
        return float(cols[1]), float(cols[2])
    return None


class PcieRx:
    """nvidia-smi dmon -s t prints rxpci / txpci in MB/s once a second."""

    def __init__(self, gpu):
        self.value, self.tx, self.gpu = None, None, gpu
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        try:
            p = subprocess.Popen(["nvidia-smi", "dmon", "-s", "t", "-d", "1", "-i", str(self.gpu)],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            for line in p.stdout:
                if line.startswith("#") or not line.strip():
                    continue
                rx_tx = parse_dmon(line)
                if rx_tx:
                    self.value, self.tx = rx_tx
        except OSError:
            pass


def smi(gpu):
    q = "name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,pcie.link.gen.current,pcie.link.gen.max,pcie.link.width.current"
    out = subprocess.run(["nvidia-smi", f"--query-gpu={q}", "--format=csv,noheader,nounits", "-i", str(gpu)],
                         capture_output=True, text=True, timeout=5).stdout.strip()
    v = [x.strip() for x in out.split(",")]
    num = lambda s: float(s) if re.fullmatch(r"-?\d+(\.\d+)?", s or "") else None
    return {"name": v[0], "util": num(v[1]), "mem_used": (num(v[2]) or 0) * 1048576,
            "mem_total": (num(v[3]) or 0) * 1048576, "temp": num(v[4]), "power": num(v[5]), "power_limit": num(v[6]),
            "pcie_gen": num(v[7]), "pcie_gen_max": num(v[8]), "pcie_width": num(v[9])}


def cpu_name():
    try:
        for line in open("/proc/cpuinfo"):
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return None


def proc_cpu(prev):
    with open("/proc/stat") as f:
        parts = [int(x) for x in f.readline().split()[1:8]]
    idle, total = parts[3] + parts[4], sum(parts)
    if prev is None:
        return None, (idle, total)
    di, dt = idle - prev[0], total - prev[1]
    return (100.0 * (1 - di / dt) if dt else None), (idle, total)


def sampler(gpu):
    pcie = PcieRx(gpu)
    prev_cpu, prev_disk, prev_t = None, None, time.time()
    if psutil:
        psutil.cpu_percent(None)
    STATE.hw_static.update(cpu_name=cpu_name(), cores=psutil.cpu_count(logical=False) if psutil else None,
                           threads=os.cpu_count(), psutil=bool(psutil))
    while True:
        t0 = time.time()
        hw = {}
        try:
            g = smi(gpu)
            hw.update(gpu_util=g["util"], gpu_mem_used=g["mem_used"], gpu_mem_total=g["mem_total"], gpu_temp=g["temp"],
                      gpu_power=g["power"], gpu_power_limit=g["power_limit"], gpu_pcie_gen=g["pcie_gen"],
                      gpu_pcie_gen_max=g["pcie_gen_max"], gpu_pcie_width=g["pcie_width"], gpu_pcie_rx_mb=pcie.value,
                      gpu_pcie_tx_mb=pcie.tx)
            STATE.hw_static["gpu_name"] = g["name"]
        except (OSError, subprocess.SubprocessError, IndexError):
            pass
        if psutil:
            hw["cpu"] = psutil.cpu_percent(None)
            vm = psutil.virtual_memory()
            hw["ram_used"], hw["ram_total"] = vm.total - vm.available, vm.total
            io = psutil.disk_io_counters()
            if io and prev_disk:
                dt = max(1e-3, t0 - prev_t)
                hw["disk_read_mb"] = (io.read_bytes - prev_disk.read_bytes) / dt / 1048576
                hw["disk_write_mb"] = (io.write_bytes - prev_disk.write_bytes) / dt / 1048576
            prev_disk, prev_t = io, t0
        else:
            try:
                hw["cpu"], prev_cpu = proc_cpu(prev_cpu)
                info = dict(l.split(":") for l in open("/proc/meminfo"))
                kb = lambda k: int(info[k].split()[0]) * 1024
                hw["ram_total"], hw["ram_used"] = kb("MemTotal"), kb("MemTotal") - kb("MemAvailable")
            except (OSError, KeyError, ValueError):
                pass
        with STATE.lock:
            STATE.hw = hw
            fresh = STATE.throughput and time.time() - STATE.throughput_at < STATE.fresh_seconds()
            if fresh and not STATE.active and STATE.last_done_at >= STATE.throughput_at:
                fresh = False
            rates = STATE.throughput.get("throughput_tokens_per_second", {}) if fresh else {}
            avg = ((STATE.throughput or {}).get("decode_batch") or {}).get("average_size") if fresh else None
            STATE.history["batch_size"].append(avg or 0)
            row = dict(hw, tok_s=rates.get("decode", 0) if fresh else 0, prefill_tok_s=rates.get("prefill", 0) if fresh else 0)
            for k in SERIES:
                STATE.history[k].append(row.get(k))
        time.sleep(max(0.05, 1.0 - (time.time() - t0)))


# ------------------------------------------------------------------ HTTP
class Handler(BaseHTTPRequestHandler):
    api_key = ""

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path
        if path in ("/metrics", "/api/metrics"):
            if self.api_key and self.headers.get("Authorization") != f"Bearer {self.api_key}":
                return self._send(401, b'{"error":"API key needed"}', "application/json")
            body = json.dumps(STATE.metrics("requests=all" in (u.query or "")), default=str).encode()
            return self._send(200, body, "application/json")
        rel = "index.html" if path in ("/", "/index.html") else os.path.normpath(path.lstrip("/"))
        if rel.startswith(("..", "/")):
            return self._send(404, b"not found", "text/plain")
        # the page is served from web/ at the site root; fonts/ stays its own folder (tokens.css asks for ../fonts/)
        full = next((p for p in (os.path.join(HERE, "web", rel), os.path.join(HERE, rel) if rel.startswith("fonts") else "")
                     if p and os.path.isfile(p)), None)
        if full is None:
            return self._send(404, b"not found", "text/plain")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--log", default=os.path.join(HERE, "..", "logs", "requests.jsonl"),
                    help="the JSONL file ninfer-serve writes with --request-log-jsonl")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18081)
    ap.add_argument("--gpu", type=int, default=0, help="GPU index to sample with nvidia-smi")
    ap.add_argument("--api-key", default="", help="require 'Authorization: Bearer KEY' on /metrics")
    a = ap.parse_args()
    Handler.api_key = a.api_key
    threading.Thread(target=tail_log, args=(os.path.abspath(a.log),), daemon=True).start()
    threading.Thread(target=sampler, args=(a.gpu,), daemon=True).start()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"ninfer monitor: http://{a.host}:{a.port}/  (log: {os.path.abspath(a.log)})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
