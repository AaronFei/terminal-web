# terminal-web 交接筆記

寫於 **2026-09-23**。給下一個接手的人（或 AI）：這份文件描述**現在這一刻**兩台機器的實際狀態、哪些東西還沒進版控、以及接下來該做什麼。

專案本身的說明在 `README.md`，這裡只記錄**現況與待辦**。

---

## 0. 三十秒摘要

- 兩台機器跑著**不同版本**，而且各有對方沒有的東西。
- **Mac 上有一整包沒提交的功能**（`/api/prefs`），只存在那顆硬碟上，已經上線跑了三天。
- 有三條分支沒部署到任何地方，其中一條是**沒實戰測試過的大改寫**。
- NUC 的 tmux「一直 crash」已經查清楚並修好了（原因是關分頁）。

---

## 1. 部署拓撲

| | Mac（mac mini） | NUC |
|---|---|---|
| 路徑 | `~/Workspace/terminal-web` | `~/Workspace/terminal-web`（SSH 用 **`afei`**，不是 aaronfei） |
| 主機名 | — | `afei-company-nuc` |
| 服務 | launchd `com.aaronfei.terminal-web` | `systemd --user` `terminal-web.service` |
| 網址 | `http://100.81.231.8:8090/` | `http://100.84.185.98:8090/` |
| 對外 | Cloudflare Tunnel `terminal-macmini.a-fei.com`（token 驗證，只有 CF 路徑需要） | 同樣有 tunnel 設定 |
| 部署指令 | `bash scripts/deploy.sh` | `bash scripts/deploy.sh` |
| tmux | 3.6b（Homebrew） | 3.6b（**自行編譯在 `~/.local`**，見第 5 節） |

Node / npm / tmux 都在 `/opt/homebrew/bin`，不在預設 PATH 上（Mac）。

**兩台都不會自動重載**（tsx 沒有 hot-reload），任何改動都要重啟服務。

---

## 2. 版本現況 ⚠️ 最重要的一節

```
main                        9918fcb   ← Mac 的分支（但工作區是髒的，見下）
tmux-kill-snapshot          847de27   ← NUC 目前 checkout 的分支（= 9918fcb + 1 commit）
worktree-stamp-styles-css   d242fcf   ← 兩台都沒有（3 個 commit）
```

| | Mac | NUC |
|---|---|---|
| kill 前先存快照 | ❌ | ✅ |
| `/api/prefs`（未提交） | ✅ 線上 200 | ❌ 404 |
| styles.css 版本戳 / 分頁掃除修正 / split 改寫 | ❌ | ❌ |

### 2.1 Mac 上未提交的工作（有遺失風險）

`~/Workspace/terminal-web` 的工作區是**髒的**，三個檔案：

| 檔案 | 變動行數 |
|---|---|
| `web/terminal.ts` | 136 |
| `src/server.ts` | 118 |
| `README.md` | 33 |

內容是「**UI 偏好存到伺服器**」：新增 `GET/POST /api/prefs`，資料放在 `~/.terminal-web/prefs.json`，把字級、按鍵列開關、目前開哪個分頁同步到伺服器端；依裝置類別（`touch` / `desktop`）分開存。程式註解寫的動機是：iOS launcher 裡這頁跑在跨來源 iframe，localStorage 一關 app 就沒了，每次重開都像第一次造訪。

**這包東西 2026-09-20 06:30 建置、06:31 重啟，從那時起就一直在 Mac 上線跑，但沒有 commit、沒有 push。**

> 它是怎麼被發現的：Mac 送出的 `terminal.js` 雜湊（`ef817d01…`）跟「用它自己 commit 的原始碼重建」的結果（`dfe04b10…`）對不上，大了 1453 bytes。再從 `public/dist/terminal.js.map` 裡取出建置當下保存的原始碼，發現它對得上硬碟上的檔案、對不上 commit。

**⚠️ 合併順序**：`tmux-kill-snapshot` 改的是 `src/server.ts` 的 `handleKillSession`，而未提交的 `/api/prefs` 就加在它正下方（約 531 行起）。**先把 Mac 這包 commit 掉，再合併分支**；不要在工作區髒的狀態下 `git pull --ff-only`。

### 2.2 三條分支的內容

**`tmux-kill-snapshot`（847de27）— 已部署 NUC，Mac 還沒有**
- `snapshotBeforeKill()`：每次 `tmux kill-session` 前先存一份 resurrect 快照並**等它完成**（關分頁、⟳ 重啟兩條路徑都涵蓋）。10 秒上限，失敗也不會擋住 kill。

**`worktree-stamp-styles-css`（3 個 commit）— 兩台都沒有**

1. `ca98955` **styles.css 版本戳**：`index.html` 原本只有 `/dist/*` 帶 `?v=`，`/styles.css` 沒有，於是 Cloudflare 的 4 小時瀏覽器快取讓 iPad 拿到「新 JS + 舊 CSS」，觸控選取列因此看不見（它的樣式在 styles.css 裡）。現在 `STAMPED_ASSETS` 涵蓋 index.html 連到的每個資源。**這是 iPad 選取列跳不出來的真正原因，還沒部署。**
2. `12c872b` **掃除分頁前先讓伺服器認領**：分頁清單來自 tmux session 上的 `@twtab` 標記，而 resurrect 復原時不會帶回這個標記；自從分頁改成 lazy attach 之後沒有東西會重新標記它們，於是 tmux 重啟後幾秒，沒開過的分頁會被同步邏輯整批刪掉。現在掃除前會先把名字交還給伺服器認領，並把自訂標籤一起帶回去。
3. `d242fcf` **split 改寫（大改動，⚠️ 沒有實戰測試過）**：分割從「一個 tmux window 兩個 pane 畫在同一個 grid」改成**兩個獨立 session**（`work` 配 `work__b`），中間分隔線變成 CSS 空隙。連帶刪掉 divider 欄位傳遞、選取裁切、以及一段戳 xterm 私有 selection service 的 block-selection hack。淨減 156 行。**只在獨立 tmux socket 上跑過 7 項端對端測試，沒有真人用過。**

---

## 3. tmux「一直 crash」：已查清並修好

**症狀**：NUC 上 tmux server 死掉，所有 session 內容一起消失，一週好幾次。

**真正原因**：**關掉一個分頁會把整個 tmux server 帶走**。14 天內 4 次死亡（9/19 13:06、9/19 13:40、9/22 11:56、9/23 07:57），每一次都在 `tmux kill-session` 之後一秒內，其他時間一次都沒死過。那個指令自己的 stderr 就是 `server exited unexpectedly`。死後重連的分頁用 `new-session -A` 把 session 建回來，所以看起來像「全部重置」。

**排除掉的**：OOM（29G 裡 23G 可用、journal 無 oom-kill）、segfault（核心會記錄，只有別的程式在 9/3 的四筆）、服務重啟（`NRestarts=0`，且 `KillMode=process`）、15 分鐘快照（離每次死亡 12–25 秒）、繼承的 `$TMUX`、tmux hook（一個都沒設）。

**在獨立 socket 上重現不出來** —— 用同一份設定檔，在 0 個 / 1 個 / 2 個 client、2 個 pane 的情況下殺 session，server 每次都活著。所以觸發條件在真實 session 的狀態裡。

**兩個修正（都已生效）**：

1. kill 前先存快照（`tmux-kill-snapshot` 分支，已上 NUC）—— 治的是損失，不是原因。
2. tmux 3.4 → **3.6b**（Mac 一直都是 3.6b，從來沒出過這個事）。

**升級後在真機驗證**：故意透過 web API 關掉一個 session，tmux server 活著、13 個 session 全在，log 是 `requested` → `saved 27 pane(s) … (before killing …)` → `done`。

**如果再犯**：在 service journal 裡 grep `server exited unexpectedly`，看它正上方是不是一行 `kill-session`。那個配對就是全部的特徵。

---

## 4. 已知問題 / 待辦

依重要性排序：

1. **把 Mac 未提交的 `/api/prefs` 工作 commit 起來**（第 2.1 節）。只存在一顆硬碟上。
2. **合併 `tmux-kill-snapshot` 到 main，兩台都部署**，讓 Mac 也有 kill 前快照。順序見 2.1 的警告。
3. **部署 `ca98955`（styles.css 版本戳）** —— iPad 上選取列跳不出來就是它。改動很小、風險很低。
4. **部署 `12c872b`（分頁掃除修正）** —— tmux 重啟後分頁整批消失的那個。
5. **`d242fcf`（split 改寫）需要真人測試再上**。它改變了分割的整個模型。
6. **NUC 上 `ai-dashboard.service` 無限重啟** —— 重啟計數器 130 萬次、每 5 秒一輪，錯誤是 `ModuleNotFoundError: No module named 'teams_management'`（`~/Workspace/AI_rawdata/analysis/app.py`）。跟 terminal-web 無關，但把 journal 灌到 4GB，查任何 log 都很痛苦。
7. **4 個 session 還帶著舊功能自動開的第二個 pane**（`lay3`、`terminal-web`、`train`、`travel-map`，裡面都是閒置的 zsh）。split 改寫上線後它們仍會在第一半裡顯示 tmux 自己畫的分隔線。要清掉的話先確認每個都只是閒置 shell。
8. **iPhone 還沒測過**觸控選取（iPad 測過了）。

---

## 5. 機器上的特殊設定（會咬人的地方）

### NUC 的 tmux 是自己編的

`/usr/bin/tmux` 還是發行版的 **3.4**；服務和 shell 用的是 `~/.local/bin/tmux`（**3.6b**）。**3.4 的 client 沒辦法跟 3.6b 的 server 講話**（protocol version mismatch），所以哪個 shell 找到哪個 binary 很重要：

- systemd user unit 的 `Environment=PATH` 開頭是 `/home/afei/.local/bin`（備份在 `/tmp/terminal-web.service.bak`）
- `~/.bashrc` **最上面**（在它的非互動 guard 之前）加了一行 PATH，讓 `ssh afei@nuc 'tmux …'` 也找得到（備份在 `/tmp/bashrc.bak`）

**NUC 沒有免密碼 sudo**，所以全部裝在家目錄。重建配方（原始碼留在 `~/.local/src`）：

```bash
# libevent
./configure --prefix=$HOME/.local --disable-openssl && make -j4 && make install

# ncurses（最後安裝 terminfo 那步會失敗，沒關係，我們用系統的）
./configure --prefix=$HOME/.local --enable-widec --without-ada --without-manpages \
  --without-progs --without-tests \
  --with-default-terminfo-dir=/usr/share/terminfo \
  --with-terminfo-dirs=/usr/share/terminfo:$HOME/.terminfo && make -j4 && make install
ln -sf libncursesw.a ~/.local/lib/libncurses.a   # configure 的探測會連 -lncurses
ln -sf libncursesw.a ~/.local/lib/libtinfo.a

# tmux：需要 PATH 上有個 yacc 空殼（tarball 已附預先產生的 cmd-parse.c，
#       但 `make distclean` 會刪掉它 —— 記得重新解壓那個檔案）
./configure --prefix=$HOME/.local \
  CPPFLAGS="-I$HOME/.local/include -I$HOME/.local/include/ncursesw" \
  LDFLAGS="-L$HOME/.local/lib -Wl,-rpath,$HOME/.local/lib" && make -j4 && make install
```

### 快取：`?v=` 版本戳

伺服器對靜態檔回 `Cache-Control: no-cache`，但 **Cloudflare 會把它改寫成 `max-age=14400`**（只有走公開網域時）。所以 `index.html` 會把資源 URL 蓋上 `?v=<build>` 戳記。**新增任何 `<link>` / `<script>` 到 index.html 時，記得同時加進 `src/server.ts` 的 `STAMPED_ASSETS`**，否則就會重演「新 JS 配舊 CSS」。走 tailnet IP 不受影響 —— 這也是它很難被發現的原因。

### tmux session 持久化

- resurrect + continuum，手動 clone 在 `~/.tmux/plugins`（不是 TPM）
- **快照是 terminal-web 自己存的**（每 5 分鐘，`src/server.ts` 的 "Session snapshots"），因為 continuum 的自動存檔靠狀態列重繪驅動，而設定檔把狀態列關掉了 —— 兩個外掛都載入、選項都設了，卻從來沒存過任何東西，直到某次 tmux 死掉才發現最新快照是十週前的
- 快照位置：`~/.local/share/tmux/resurrect/`（不是 `~/.tmux/resurrect`）
- 還原是 continuum 的（server 啟動時跑），那個是正常的
- 有「崩塌保護」：session 數量突然大幅減少時**不會**存檔，以免覆蓋掉唯一的紀錄

### systemd `KillMode=process`（NUC）

必須保持這樣。預設的 `control-group` 會在重啟服務時把整個 cgroup SIGTERM 掉，而 tmux server 是 `terminal-web.service` 的 cgroup 子程序 —— 以前每次重啟服務都會清掉所有人的 session。

### NUC 的 package-lock 漂移

NUC 的 npm 每次 `npm install` 都會改寫 `package-lock.json`（加一些 `"license"` / `"peer"` 行），讓下一次 `git pull` 失敗。部署時前面加 `git restore package-lock.json` 就好。

---

## 6. 怎麼確認現在的狀態（給接手的人）

```bash
# 每台各自的 commit
cd ~/Workspace/terminal-web && git log --oneline -1 && git status --short
ssh afei@afei-company-nuc 'cd ~/Workspace/terminal-web && git rev-parse --abbrev-ref HEAD && git log --oneline -1'

# 兩台送出的客戶端 bundle 是不是同一份
curl -s http://100.81.231.8:8090/dist/terminal.js  | shasum   # Mac
curl -s http://100.84.185.98:8090/dist/terminal.js | shasum   # NUC

# 某台送出的 bundle 是不是跟它自己的原始碼一致（重建後比雜湊）
node esbuild.mjs && shasum public/dist/terminal.js

# 某台有沒有某個功能上線
curl -s -o /dev/null -w "%{http_code}\n" "http://<ip>:8090/api/prefs?scope=desktop"

# tmux 版本（client 和 server 要一致）
tmux -V && tmux display -p '#{version}'

# 找 tmux 死亡事件（NUC）
ssh afei@afei-company-nuc 'journalctl --user -u terminal-web --since "14 days ago" | grep -B1 "server exited unexpectedly"'
```

---

## 7. 工作慣例

- 提交訊息用**完整句子的散文**說明**為什麼**這樣改，以及當初怎麼發現問題的 —— 看一下 `git log` 就知道風格。程式註解也是同樣密度。
- 破壞性操作（殺 session、重啟 tmux、改系統設定）**一律先在獨立的 tmux socket（`-L <name>` 或 `TMUX_TMPDIR`）上驗證**，而且動手前先 `list-sessions` 確認打到的是哪一台 server。`$TMUX` 會蓋過 `TMUX_TMPDIR`。
- 改動要驗證到「拿得出證據」的程度，而不是「應該會動」。
