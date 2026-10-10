#!/usr/bin/env bash
# 2 槽位，262k 上下文，KV 池 auto，开启图像，DFlash2。
set -euo pipefail
MON_PID=
cleanup() {
  if [[ -n "$MON_PID" ]]; then kill "$MON_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT
fail() { echo "[错误] $*" >&2; exit 1; }
DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVE="$DEPLOY/build/apps/ninfer-serve"
MODEL="$DEPLOY/models/qwen3_8_27b_nvfp4.ninfer"
PORT=18080
MON_PORT=18081
[[ -f "$HOME/.config/ninfer/env.sh" ]] && source "$HOME/.config/ninfer/env.sh"
API_KEY="${NINFER_API_KEY:-}"
[[ -n "$API_KEY" ]] || fail "未设置环境变量 NINFER_API_KEY（可写入 ~/.config/ninfer/env.sh）。"
source "$HOME/.config/ninfer/cuda-env.sh"
[[ -x "$SERVE" ]] || fail "找不到引擎：$SERVE"
[[ -f "$MODEL" ]] || fail "找不到模型：$MODEL"
if ldd "$SERVE" | grep -F 'not found'; then fail '缺少动态库。'; fi
if [[ -n "$(ss -H -ltn "sport = :$PORT")" ]]; then
  ss -ltnp "sport = :$PORT"
  fail "$PORT 已被占用，请停止已有服务。"
fi
if pgrep -x ninfer-serve >/dev/null; then fail '已有 ninfer-serve 运行，请先停止（显存会冲突）。'; fi
# 显存余量：KV 容量由引擎按 auto 计算（权重与运行时之后保留 1024 MiB 余量）。
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader | awk -F', ' '{print "启动前显存占用：" $1 " / " $2}'
cd "$DEPLOY"
mkdir -p logs
# 监控台跟随引擎启动、退出；端口已被占用时不重复启动。
if [[ -z "$(ss -H -ltn "sport = :$MON_PORT")" ]]; then
  python3 "$DEPLOY/monitor/monitor.py" --host 0.0.0.0 --port "$MON_PORT" --api-key "$API_KEY" --log "$DEPLOY/logs/requests.jsonl" >/dev/null 2>&1 &
  MON_PID=$!
  echo "监控台：http://127.0.0.1:$MON_PORT/（局域网：http://<本机 IP>:$MON_PORT/）"
else
  echo "[提示] $MON_PORT 已被占用，未启动监控台。"
fi
args=(
  --vision --spec dflash2 --draft-tokens 7 --lm-head-draft
  --max-context 200000 --kv-capacity auto --kv-dtype fp8
  --prefill-chunk 1024 --max-concurrency 2 --device-state-slots 2
  --preserve-thinking --default-thinking-budget 4096
  --host 0.0.0.0 --port "$PORT" --api-key "$API_KEY"
  --model-id qwen3.8-27b-dflash2-vision
  --request-log-jsonl logs/requests.jsonl
  --log-stats-interval-ms 1000
  --pending-timeout-ms 600000
)
echo "服务地址：http://<本机 IP>:$PORT/v1（本机 127.0.0.1）；Model：qwen3.8-27b-dflash2-vision"
echo '按 Ctrl+C 停止服务。'
"$SERVE" "$MODEL" "${args[@]}"
