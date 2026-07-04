#!/bin/bash
# 监控 Coderix 进程树内存消耗，每 2 秒刷新
# 用法: bash scripts/watch-mem.sh [PID]

ROOT_PID=${1:-$(pgrep -f "coderix-cli.*main" | head -1)}

if [ -z "$ROOT_PID" ]; then
  echo "找不到 Coderix 进程，请手动传入 PID"
  echo "用法: bash scripts/watch-mem.sh <PID>"
  exit 1
fi

echo "监控 PID: $ROOT_PID (Coderix 主进程)"
echo "格式: PID PPID RSS(KB) RSS(MB) 命令"
echo "----------------------------------------"

while true; do
  clear
  echo "=== Coderix 进程树内存监控 ==="
  echo "根 PID: $ROOT_PID | $(date +%H:%M:%S)"
  echo ""

  TOTAL_RSS_KB=0
  COUNT=0

  # 递归获取所有子孙进程
  print_tree() {
    local pid=$1
    local depth=$2
    local prefix=""
    for ((i=0; i<depth; i++)); do prefix="${prefix}  "; done

    while IFS= read -r line; do
      [ -z "$line" ] && continue
      read cPid ppid rss comm <<< "$line"
      local rss_mb=$((rss / 1024))
      TOTAL_RSS_KB=$((TOTAL_RSS_KB + rss))
      COUNT=$((COUNT + 1))
      printf "%s├─ PID:%-6s RSS:%-8s (%-4s MB) %s\n" "$prefix" "$cPid" "${rss}K" "$rss_mb" "$comm"
      print_tree $cPid $((depth + 1))
    done < <(ps -eo pid,ppid,rss,comm | awk -v ppid="$pid" '$2==ppid && $4!="ps" && $4!="sh"' | sort -k3 -rn)
  }

  # 打印根进程
  ROOT_LINE=$(ps -eo pid,ppid,rss,comm | awk -v pid="$ROOT_PID" '$1==pid {print $0}')
  if [ -n "$ROOT_LINE" ]; then
    read rPid rPpid rRss rComm <<< "$ROOT_LINE"
    rMb=$((rRss / 1024))
    TOTAL_RSS_KB=$rRss
    COUNT=1
    printf "┌─ PID:%-6s RSS:%-8s (%-4s MB) %s\n" "$rPid" "${rRss}K" "$rMb" "$rComm"
    print_tree $ROOT_PID 1
  else
    echo "进程 $ROOT_PID 不存在"
  fi

  TOTAL_MB=$((TOTAL_RSS_KB / 1024))
  echo ""
  echo "=========================================="
  echo "总计: ${COUNT} 个进程, 总 RSS: ${TOTAL_MB} MB"
  echo "按 Ctrl+C 退出"

  sleep 2
done
