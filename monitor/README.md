# ninfer monitor

A dashboard for `ninfer-serve`, laid out like Strata's Monitor tab: model state, speed (decode and prefill),
GPU load / VRAM / temperature / power / PCIe, CPU, disk read, context fill, recent requests (prompt, **reused**,
output, tok/s, draft hit, duration) and the conversation cache.

The style resources (`web/tokens.css`, `components.css`, `sprite.svg`) are copied from the author's Strata web UI,
whose tokens derive from the Gainsty design system; `fonts/` is Outfit under the SIL OFL (`fonts/OFL.txt`).

It does not talk to `ninfer-serve`. It follows the server's structured log and samples the GPU itself:

| Data | Source |
| --- | --- |
| requests, reused prompt tokens, reuse path, tok/s, draft hit, timings | `request_done` events in the JSONL log |
| speed now, running / prefilling / waiting, cache slots and host KV | `throughput` events (every 5 s while busy, `--log-stats-interval-ms`) |
| model name, max context, KV type, speculative backend | the `server_start` event |
| GPU load, VRAM, temperature, power, PCIe | `nvidia-smi` once a second (`nvidia-smi dmon` for PCIe MB/s) |
| reuse paths, zero-reuse streak, TTFT / queue / phase timings, device wait vs host, thinking and tool calls, finish reasons | `request_done` events (`result`, `timings_seconds`, `engine_timing`) |
| speculative acceptance by draft position, fallback steps | `request_done.speculative`, summed over the log |
| cache pressure (evictions, drops, spills), host/device transfers | `throughput.context_cache.pressure` / `*_transfers`, which are per-interval deltas that the monitor accumulates |
| decode batch size, KV pages in use | `throughput.decode_batch`, `context_cache.occupancy.device_main_kv_pages` against `server_start.engine.kv_capacity_page_groups` |
| error reasons | `request_error` / `request_rejected` (`error.code`, `error.message`) |
| CPU, RAM, disk | `psutil` if installed, else `/proc` (no disk read) |

## Use

1. Start the server with a request log (a flag of `ninfer-serve`, docs/serving.md "Structured request log"):

   ```
   ninfer-serve ... --request-log-jsonl logs/requests.jsonl
   ```

2. Start the monitor (Python 3, standard library only):

   ```
   python3 monitor/monitor.py --log logs/requests.jsonl
   ```

3. Open <http://127.0.0.1:18081/>.

Options: `--port` (18081), `--host` (127.0.0.1), `--gpu` (GPU index for nvidia-smi, 0), `--api-key KEY`
(`/metrics` then needs `Authorization: Bearer KEY`; the page asks for the key once per browser session). Do not bind it beyond 127.0.0.1 without a key.

## Limits

- Heuristics: the "N requests in a row read in full" warning counts requests whose prompt is longer than the previous
  one of the same protocol and reused nothing (it may or may not be one conversation); a request is tagged `aux` when
  it wrote at most 16 tokens (`AUX_MAX_TOKENS` in monitor.py, `config.aux_max_tokens` in /metrics) and used no tools.
- Main KV pages is measured against `kv_capacity_page_groups` (64 tokens per page); with MTP / DFlash the pool has a few
  extra pages, so the bar can read slightly high. Transfer MB/s is bytes over transfer time in the last 60 s, not wall clock.
- Cache pressure, transfers, speculative and error counters start at the monitor's start (the log is replayed).
- Not available from the log: live prefill progress (needs a change in ninfer-serve), prompt/answer text.

- The log has no request text and no per-token progress, so the page cannot show prompts or answers, and
  "Context fill" is the last finished request, not the running one.
- Speed curves come from the engine's 5-second throughput events, so they are steps, not a smooth line.
- History is 60 seconds of samples held in memory; request rows are the newest 500 read from the log.
- A log shared by several server starts is read as a whole; the page follows the latest `server_start`.
- A log line that cannot be read or applied is skipped and counted (`log.skipped` in /metrics), never stops the follower.
- The log is read from its start when the monitor starts, so restarting the monitor keeps the request table.
