# 操作系统及版本
NAME="Kylin Linux Advanced Server"
VERSION="V10 (Halberd)"
ID="kylin"
VERSION_ID="V10"
PRETTY_NAME="Kylin Linux Advanced Server V10 (Halberd)"
ANSI_COLOR="0;31"

# CPU架构：
x86_64

# 内核版本：
Linux localhost.localdomain 4.19.90-89.11.v2401.ky10.x86_64 #1 SMP Tue May 7 18:33:01 CST 2024 x86_64 x86_64 x86_64 GNU/Linux

# GLIBC版本：
ldd (GNU libc) 2.28

nohup python -m uvicorn main:app --app-dir webservice --host 0.0.0.0 --port 3003 > uvicorn.log 2>&1 &

echo $! > uvicorn.pid

kill "$(cat webservice/uvicorn.pid)"

ps -ef | grep '[u]vicorn.*main:app'

kill <PID>

firewall-cmd --permanent --add-port=3003/tcp
firewall-cmd --reload

# 部署运维人员
1. 安装 fastsite wheel 到宿主机的 sql_agent 环境。

2. 设置运行参数：
export FASTSITE_BIND=127.0.0.1:3003
export FASTSITE_PID_FILE=/path/to/run/fastsite.pid
export FASTSITE_EXTENSIONS_DIR=/path/to/webservice/plugins
export FASTSITE_DATABASE_CONFIG=/path/to/config/databases.toml
export FASTSITE_TRUSTED_HOSTS=127.0.0.1,localhost,10.120.92.138

3. 启动服务：
/opt/sql_agent/bin/python3 -m gunicorn \
  --config /path/to/fastsite/gunicorn.conf.py
生产建议使用 systemd，配置模板在 fastsite/fastsite.service.example。

4. 检查：
curl http://127.0.0.1:3003/healthz
curl http://127.0.0.1:3003/readyz
线上模型
线上模型不启动服务、不直接操作进程。它只通过 webservice skill 修改 webservice/plugins，然后使用：

fastsite-cli validate-plugins \
  --extensions-dir /path/to/webservice/plugins

fastsite-cli reload \
  --extensions-dir /path/to/webservice/plugins \
  --pid-file /path/to/run/fastsite.pid \
  --status-url http://127.0.0.1:3003

业务插件的最小结构：
webservice/plugins/<plugin-id>/
  manifest.json
  plugin.py
  templates/
发布过程是：修改插件 -> validate-plugins -> reload -> 检查 /readyz。旧 Worker 会继续处理已开始的请求，新 Worker 加
载新插件后接管流量。



# FastSite部署和运维:
• 部署步骤
1. 在本机 Docker Desktop 构建正式 Linux wheel。build-config.yml 填线上 Doris/MySQL 配置，不提交到仓库：
cd D:\git\python\askdata-agent\fastsite
docker buildx build --platform linux/amd64 `
  --secret id=fastsite_config,src=build-config.yml `
  --output type=local,dest=dist-secure `
  -f Dockerfile.wheel .
得到：
dist-secure/fastsite-0.2.1-cp311-cp311-linux_x86_64.whl

2. 上传 wheel 和 gunicorn.conf.py 到线上宿主机，再复制进 Fenix 容器。容器内 /opt/sql_agent 是只读挂载，不能往那里安装：
docker cp fastsite-0.2.1-cp311-cp311-linux_x86_64.whl 05083fd49615:/app/data/fastsite/
docker cp /tmp/gunicorn.conf.py 05083fd49615:/app/data/fastsite/

3. 部署
3.1 在容器中安装到可写目录：
docker exec -it 05083fd49615 sh
mkdir -p /app/data/fastsite/python
/opt/sql_agent/bin/python3 -m pip install  --upgrade --force-reinstall --no-deps  --target /app/data/fastsite/python  /app/data/fastsite/fastsite-0.2.1-cp311-cp311-linux_x86_64.whl

安装后验证：
export PYTHONPATH=/app/data/fastsite/python
python3 -c "import fastsite; from fastsite.host import app; print(fastsite.__file__); print(app.title)"

3.2 直接在宿主机中安装
conda activate sql_agent
python -m pip install --upgrade --force-reinstall --no-deps /tmp/fastsite-0.2.1-cp311-cp311-linux_x86_64.whl

4. 配置运行环境。FASTSITE_EXTENSIONS_DIR 填实际插件目录：
export PYTHONPATH=/app/data/fastsite/python   如果fastsite安装在宿主机，则无需这一条
export PUBLIC_BASE_URL=http://10.120.92.138:3002
export FASTSITE_EXTENSIONS_DIR=/app/workspaces/webservice/plugins
export FASTSITE_BIND=0.0.0.0:3003
export FASTSITE_PID_FILE=/app/data/fastsite/fastsite.pid
export FASTSITE_TRUSTED_HOSTS=127.0.0.1,localhost,10.120.92.138
echo $PUBLIC_BASE_URL
echo $FASTSITE_EXTENSIONS_DIR
echo $FASTSITE_BIND
echo $FASTSITE_PID_FILE
  数据库配置已通过 build-config.yml 编译进 wheel 时，不要再设置 FASTSITE_DATABASE_CONFIG。若设置了外部 TOML，该文件会覆盖内置配置。

5. 启动前验证：
5.1、
/opt/sql_agent/bin/python3 -c "import fastsite; from fastsite.host import app; print(fastsite.__file__, app.title)"
如：
# /opt/sql_agent/bin/python3 -c "import fastsite; from fastsite.host import app; print(fastsite.__file__, app.title)"
/opt/sql_agent/lib/python3.11/site-packages/fastsite/__init__.py Fastsite
5.2、
/opt/sql_agent/bin/python3 -m fastsite.cli validate-plugins --extensions-dir "$FASTSITE_EXTENSIONS_DIR"
如
# /opt/sql_agent/bin/python3 -m fastsite.cli validate-plugins --extensions-dir "$FASTSITE_EXTENSIONS_DIR"
{"ok": true, "extensions_dir": "/app/workspaces/webservice/plugins", "extensions": []}

6. 启动服务：
先创建/app/data/fastsite目录
nohup /opt/sql_agent/bin/python3 -m gunicorn  "fastsite.host:app"  --config /app/data/fastsite/gunicorn.conf.py > /app/data/fastsite/fastsite.log 2>&1 &

nohup env \
  PUBLIC_BASE_URL=http://10.120.92.138:3002 \
  FASTSITE_EXTENSIONS_DIR=/app/workspaces/webservice/plugins \
    FASTSITE_BIND=0.0.0.0:3003 \
    FASTSITE_PID_FILE=/app/data/fastsite/fastsite.pid \
  FASTSITE_TRUSTED_HOSTS=127.0.0.1,localhost,10.120.92.138 \
  /opt/sql_agent/bin/python3 -m gunicorn "fastsite.host:app" \
    --config /app/data/fastsite/gunicorn.conf.py \
  > /app/data/fastsite/fastsite.log 2>&1 &

7. 健康检查：

cat /app/data/fastsite/fastsite.pid
curl http://127.0.0.1:3003/healthz
curl http://127.0.0.1:3003/readyz
cat /app/data/fastsite/fastsite.log

8. 后续仅发布插件时，更新 webservice/plugins 后优雅重载：

export PYTHONPATH=/app/data/fastsite/python
/opt/sql_agent/bin/python3 -m fastsite.cli reload  --extensions-dir "$FASTSITE_EXTENSIONS_DIR"  --pid-file /app/data/fastsite/fastsite.pid  --status-url http://127.0.0.1:3003
Fastsite wheel 升级也是“替换 wheel -> pip install --force-reinstall -> fastsite-cli reload”这一流程。旧 Worker 会继续完成在途请求，新 Worker 会加载新 wheel 和新插件。

查看进程
for d in /proc/[0-9]*; do
  [ -r "$d/cmdline" ] || continue
  cmd=$(cat "$d/cmdline" 2>/dev/null)
  case "$cmd" in
    *gunicorn*)
      parent=
      while IFS=: read -r key value; do
        [ "$key" = "PPid" ] && parent=$value
      done < "$d/status"
      echo "PID=${d#/proc/} PPID=$parent CMD=$cmd"
      ;;
  esac
done

kill -TERM 46868  优雅退出信号
kill -QUIT 46868  快速退出信号
kill -KILL 46868
kill -QUIT "$(cat /app/data/fastsite/fastsite.pid)"  停止服务

[ -d /proc/46868 ] && echo "仍在运行" || echo "已停止"
[ -d /proc/46869 ] && echo "仍在运行" || echo "已停止"

使用 webservice-skill 校验并受控重载 webservice。
检查fastsite内部环境变量：
PID=$(cat "$FASTSITE_PID_FILE")
tr '\0' '\n' < "/proc/$PID/environ" | grep '^PUBLIC_BASE_URL='


重启：
PID=$(cat "$FASTSITE_PID_FILE")
kill -TERM "$PID"

while kill -0 "$PID" 2>/dev/null; do
  sleep 1
done

  再按现有配置启动，不要设置 FASTSITE_MAX_REQUEST_BYTES：

nohup env \
  PUBLIC_BASE_URL=http://10.120.92.138:3022 \
  FASTSITE_EXTENSIONS_DIR=/app/workspaces/webservice/plugins \
  FASTSITE_BIND=0.0.0.0:3003 \
  FASTSITE_PID_FILE=/app/data/fastsite/fastsite.pid \
  FASTSITE_TRUSTED_HOSTS=127.0.0.1,localhost,10.120.92.138 \
  /opt/sql_agent/bin/python3 -m gunicorn "fastsite.host:app" \
    --config /app/data/fastsite/gunicorn.conf.py \
  > /app/data/fastsite/fastsite.log 2>&1 &

验证：
  curl http://127.0.0.1:3003/healthz
  curl http://127.0.0.1:3003/readyz
