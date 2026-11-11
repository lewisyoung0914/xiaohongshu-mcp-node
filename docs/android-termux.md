# 在 Android / Termux 上跑（含改名前缀的 Termux）

官方的 [xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) 只提供 macOS(Apple 芯片) / Windows x64 / Linux x64 的二进制，
**没有 Linux ARM64**，所以手机上跑不起来。这个 Node 版绕开的正是这一环：不编译 Go，而是复用 Termux 里能装的 Chromium。

下面是在一台 Android 平板（aarch64、Android 17、Termux 血统的 shell）上实测通过的步骤。

## 1. 装 Chromium

```bash
# x11 仓库的 dist 名是 x11，不是 stable
echo "deb https://mirrors.ustc.edu.cn/termux/termux-x11/ x11 main" >> $PREFIX/etc/apt/sources.list
apt-get update
apt-get install -y chromium
```

> 普通 Termux 用 `pkg install x11-repo && pkg install chromium` 即可，然后跳到第 3 步。

## 2. 如果是"改名前缀"的 Termux（$PREFIX 不是 /data/data/com.termux/files/usr）

这种环境里标准 deb 装不进 `$PREFIX`（包内路径写死 `/data/data/com.termux/...`，dpkg 会写到一个影子目录）。
做法是把 chromium 和它的一百多个依赖解包到一个**独立前缀**，不碰现有环境：

```bash
A=$PREFIX                     # 例：/data/data/com.xxx/files/usr
R=$HOME/chromium-prefix       # 独立前缀
mkdir -p "$R"

# 1) 只下载不安装
apt-get install -d -y chromium
# 2) 把所有 deb 解到独立前缀（文件按 deb 内的原始路径落盘）
for f in "$A"/var/cache/apt/archives/*.deb; do dpkg-deb -x "$f" "$R"; done
```

得到的浏览器在 `$R/data/data/com.termux/files/usr/lib/chromium/headless_shell`。

## 3. 路径垫片（Android 版 Chromium 的资源路径问题）

Android 构建的 Chromium 会去 `/apex/com.android.runtime/bin/` 找 `icudtl.dat`、`*.pak`、`snapshot_blob.bin`，
没有就报 `Invalid file descriptor to ICU data received` 直接退出。用一个小 `LD_PRELOAD` 把这些路径重定向到解包目录：

```bash
cd $HOME
clang -shared -fPIC -O2 -o chromium-prefix/patched/termuxpath.so \
  /path/to/this/repo/scripts/android-termux/termuxpath.c -ldl
```

（`termuxpath.c` 在这个仓库的 `scripts/android-termux/` 里，会同时重定向 `/data/data/com.termux/files/usr` 开头的路径。）

## 4. 浏览器启动器

复制 `scripts/android-termux/xhs-browser.sh.example` 到 `$HOME/xhs-browser.sh`，按需改三个变量，然后 `chmod +x`：

```bash
export XHS_TERMUX_PREFIX=$HOME/chromium-prefix/data/data/com.termux/files/usr
export XHS_PATH_SHIM=$HOME/chromium-prefix/patched/termuxpath.so
exec "$XHS_TERMUX_PREFIX/lib/chromium/headless_shell" \
  --headless --no-sandbox --no-zygote --single-process --disable-gpu ... "$@"
```

关键点：

- **必须** `--no-zygote --single-process`：这台设备的 bionic 在 fork/exec 子进程时会报
  `error: expected absolute path: "--type=zygote"`，GPU/网络进程起不来，浏览器直接 FATAL 退出。
- `LD_PRELOAD` 垫片只对**浏览器进程**有意义，但它会继承给子进程，注意别把 shell 搞乱。
- 如果只是想"跑得动"，`--disable-gpu` 必须带（headless_shell 的 GPU 进程在这台设备上用不了）。

验证：

```bash
XHS_BROWSER_SCRIPT=$HOME/xhs-browser.sh node server.mjs &
curl -s http://127.0.0.1:9222/json/version
# {"Browser":"HeadlessChrome/157.0.8103.38", ...}
```

## 5. 跑服务

```bash
export XHS_BROWSER_SCRIPT=$HOME/xhs-browser.sh
node server.mjs          # 监听 127.0.0.1:18060/mcp
node call.mjs list_feeds '{}'
```

## 实测环境

| 项 | 值 |
|---|---|
| 设备 | Android 17 平板，aarch64，10 核 / 15GB |
| 浏览器 | Termux chromium 157.0.8103.38（`headless_shell`） |
| 解包体积 | 156 个 deb / 约 1.8GB |
| 已验证 | 服务启动、`tools/list`、`check_login_status`、`get_login_qrcode`、`list_feeds`、`get_feed_detail`、`user_profile` |
| 待登录后验证 | `search_feeds`、评论/点赞/收藏、发布 |

## 常见问题

- **`Invalid file descriptor to ICU data received`**：垫片没生效（`LD_PRELOAD` 路径不对，或 `.so` 是给错的架构编的）。
  `file termuxpath.so` 应该是 `ELF shared object, arm64`。
- **`CANNOT LINK EXECUTABLE ... libxxx.so not found`**：`LD_LIBRARY_PATH` 少了前缀的 `lib`，或者少了 `$PREFIX/lib`（app 自己的库）。
- **`error: expected absolute path: "--type=zygote"`**：没带 `--single-process --no-zygote`。
- **`Could not find a PHDR: broken executable?`**：拿 musl 静态版的 qemu/工具来跑 ARM64 Android 上了，换 bionic 版本。
- **风控（300012）**：手机 IP 被判定有风险时会出现，等几分钟、少打请求，别并发。