#!/bin/sh
set -e

# 在 gunicorn 启动前、仅由单一入口进程执行一次：
# 建表 + 初始示例数据，避免多 worker 同时首启造成重复播种。
python -c "from app import init_db; init_db()"

exec gunicorn \
  --bind "0.0.0.0:${PORT:-8000}" \
  --workers "${WEB_CONCURRENCY:-2}" \
  --timeout 60 \
  app:app
