# gptImg — 项目说明

Vite + React 18 SPA，调用 OpenAI 风格的 `/v1/images/generations` 与 `/v1/images/edits`。无后端，所有状态本地存储（IndexedDB / localStorage）。

## 本地开发

- 需要 Node 22+（Vite 8 不支持 Node 18）。本机系统默认装的是 Node 18，先 `source ~/.nvm/nvm.sh && nvm use 22` 再跑命令。
- `.env.local` 里有 `VITE_DEFAULT_API_KEY`，用于本地预填，**不要**带进生产构建。
- 启动：`source ~/.nvm/nvm.sh && nvm use 22 && npm run dev` → http://localhost:5173

## 部署到 VPS

站点已经部署在 VPS，**不要再问连接方式**，按下面流程直接做。

- SSH：`ssh root@154.26.182.181`（已配置免密）
- 域名 / 反代：`img.pubwhere.cn`，由 Caddy 静态托管，配置在 `/etc/caddy/Caddyfile`
- 站点目录：`/var/www/img.pubwhere.cn/`
- VPS 网络出口被阿里云壳网关接管，从本机公网 curl 站点会拿到 403（拦截页内容里有「云壳-防护记录-域名拦截」字样）—— 这跟部署无关。要从 VPS 内部验证，用 `--resolve img.pubwhere.cn:443:127.0.0.1`。

### 标准部署流程

```bash
# 1. 临时移走 .env.local，避免默认 API Key 进入生产 bundle
mv .env.local .env.local.deploybak

# 2. 用 Node 22 构建
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && rm -rf dist && npm run build

# 3. 立即恢复 .env.local，避免本地 dev 环境失效
mv .env.local.deploybak .env.local

# 4. 校验 bundle 里没有 API Key（应输出 0）
grep -c "sk-" dist/assets/*.js

# 5. 在 VPS 上备份当前线上版（用于回滚）
ssh root@154.26.182.181 "cp -r /var/www/img.pubwhere.cn /var/www/img.pubwhere.cn.bak.\$(date +%s)"

# 6. 同步新构建（带 --delete 清理旧 hash 资源）
rsync -avz --delete dist/ root@154.26.182.181:/var/www/img.pubwhere.cn/

# 7. 在 VPS 上验证 Caddy 服务的 bundle 内容
ssh root@154.26.182.181 "curl -sk --resolve img.pubwhere.cn:443:127.0.0.1 https://img.pubwhere.cn/index.html | grep -oE '/assets/[^\"]+'"
```

### 回滚

```bash
ssh root@154.26.182.181 "ls -td /var/www/img.pubwhere.cn.bak.* | head -1"
# 拿到最新 backup 路径后：
ssh root@154.26.182.181 "rm -rf /var/www/img.pubwhere.cn && mv <BACKUP_PATH> /var/www/img.pubwhere.cn"
```

旧备份建议偶尔清理：`ssh root@154.26.182.181 "ls -td /var/www/img.pubwhere.cn.bak.* | tail -n +6 | xargs -r rm -rf"`（只保留最近 5 份）。

## 注意事项

- 永远不要把 `VITE_DEFAULT_API_KEY` 打进生产 bundle —— 部署前必检查 `grep -c "sk-" dist/assets/*.js` 输出 0。
- Vite 8 / Node 22 的依赖：跑 `npm run build`、`npm run dev` 之前都要先 `nvm use 22`，否则会报 `CustomEvent is not defined`。
- 生产部署没有 CI/CD、没有 Docker —— 直接 rsync 静态资源到 Caddy 目录即可。
