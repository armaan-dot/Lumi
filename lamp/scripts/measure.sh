#!/usr/bin/env bash
# Sample CPU% and RSS of the brain and the browser while you run the demo.
# usage: scripts/measure.sh [seconds=60]     (Linux; needs procps)
D=${1:-60}
echo "t,brain_cpu%,brain_rss_MB,browser_cpu%,browser_rss_MB,load1"
for ((i=0;i<D;i++)); do
  b=$(pgrep -f "server/index.js" | head -1)
  bc=$(ps -p "$b" -o %cpu= 2>/dev/null | tr -d ' '); br=$(ps -p "$b" -o rss= 2>/dev/null | awk '{printf "%.0f",$1/1024}')
  read -r wc wr < <(ps -eo %cpu,rss,args | awk '/chrom(e|ium)/ && !/awk/ {c+=$1; r+=$2} END {printf "%.1f %.0f", c, r/1024}')
  echo "$i,${bc:-0},${br:-0},$wc,$wr,$(cut -d' ' -f1 /proc/loadavg)"
  sleep 1
done | tee data/measure.csv
echo "--- brain metrics ---"; curl -s localhost:8765/metrics
