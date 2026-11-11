// 把 Android Chromium（Termux 构建）里写死的 /data/data/com.termux/files/usr
// 重定向到我们实际的 prefix，这样它就能找到 icudtl.dat 等资源。
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>

static void logpath(const char *what, const char *path, int rc) {
  FILE *(*rf)(const char *, const char *) = 0;
  static FILE *(*realf)(const char *, const char *) = 0;
  if (!realf) realf = dlsym(RTLD_NEXT, "fopen");
  FILE *fp = realf("/data/data/com.dsharnessmobile.shell/files/home/chromium-prefix/patched/open.log", "a");
  if (!fp) return;
  fprintf(fp, "%s rc=%d %s\n", what, rc, path ? path : "(null)");
  fclose(fp);
}


static const char *FROM = "/data/data/com.termux/files/usr";
static __thread char tl_buf[4096];


static void logexec(const char *path, char *const argv[]) {
  static FILE *(*realf)(const char *, const char *) = 0;
  if (!realf) realf = dlsym(RTLD_NEXT, "fopen");
  FILE *fp = realf("/data/data/com.dsharnessmobile.shell/files/home/chromium-prefix/patched/exec.log", "a");
  if (!fp) return;
  fprintf(fp, "exec path=%s argv0=%s argv1=%s argv2=%s\n", path ? path : "(null)",
          argv && argv[0] ? argv[0] : "-", argv && argv[1] ? argv[1] : "-", argv && argv[2] ? argv[2] : "-");
  fclose(fp);
}

int execve(const char *path, char *const argv[], char *const envp[]) {
  static int (*real)(const char *, char *const[], char *const[]) = 0;
  if (!real) real = dlsym(RTLD_NEXT, "execve");
  logexec(path, argv);
  return real(path, argv, envp);
}

static const char *fix(const char *path) {
  const char *to = getenv("DSH_TERMUX_PREFIX_MAP");
  if (!to || !path) return path;
  // Android 构建把资源当成"运行时资产"去找，落点常常是 /apex/com.android.runtime/bin/，
  // 我们把这些资源名统一重定向到解出来的那份。
  {
    const char *base = strrchr(path, '/');
    const char *name = base ? base + 1 : path;
    static const char *assets[] = {
        "icudtl.dat", "resources.pak", "chrome_100_percent.pak", "chrome_200_percent.pak",
        "snapshot_blob.bin", "v8_context_snapshot.bin", "natives_blob.bin", "headless_lib_data.pak",
        "headless_lib_strings.pak", NULL};
    for (int i = 0; assets[i]; i++) {
      if (strcmp(name, assets[i]) == 0) {
        snprintf(tl_buf, sizeof tl_buf, "%s/lib/chromium/%s", to, name);
        return tl_buf;
      }
    }
    if (strstr(path, "/locales/") && strstr(name, ".pak")) {
      snprintf(tl_buf, sizeof tl_buf, "%s/lib/chromium/locales/%s", to, name);
      return tl_buf;
    }
  }
  size_t n = strlen(FROM);
  if (strncmp(path, FROM, n) == 0) {
    snprintf(tl_buf, sizeof tl_buf, "%s%s", to, path + n);
    return tl_buf;
  }
  return path;
}

int open(const char *path, int flags, ...) {
  static int (*real)(const char *, int, ...) = 0;
  if (!real) real = dlsym(RTLD_NEXT, "open");
  mode_t mode = 0;
  if (flags & O_CREAT) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); }
  int rc = real(fix(path), flags, mode);
  if (rc < 0 || (path && strstr(path, "icu"))) logpath("open", path, rc);
  return rc;
}

int open64(const char *path, int flags, ...) {
  static int (*real)(const char *, int, ...) = 0;
  if (!real) real = dlsym(RTLD_NEXT, "open64");
  mode_t mode = 0;
  if (flags & O_CREAT) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); }
  return real(fix(path), flags, mode);
}

int openat(int dirfd, const char *path, int flags, ...) {
  static int (*real)(int, const char *, int, ...) = 0;
  if (!real) real = dlsym(RTLD_NEXT, "openat");
  mode_t mode = 0;
  if (flags & O_CREAT) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); }
  int rc = real(dirfd, fix(path), flags, mode);
  if (rc < 0 || (path && strstr(path, "icu"))) logpath("openat", path, rc);
  return rc;
}

FILE *fopen(const char *path, const char *mode) {
  static FILE *(*real)(const char *, const char *) = 0;
  if (!real) real = dlsym(RTLD_NEXT, "fopen");
  return real(fix(path), mode);
}

int access(const char *path, int mode) {
  static int (*real)(const char *, int) = 0;
  if (!real) real = dlsym(RTLD_NEXT, "access");
  return real(fix(path), mode);
}
