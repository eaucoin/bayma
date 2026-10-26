// Moves this PID namespace's PID counter past a target, without privilege.
//
//   bayma-advance-pids [--wrap] <target>
//
// Linux hands out PIDs in increasing order, up to the namespace's pid_max,
// and then from its lowest free ones again. Where this process may write the
// namespace's ns_last_pid, as with CAP_CHECKPOINT_RESTORE and a /proc/sys
// mounted writable, the counter is set just below the target at once.
// Elsewhere, as in a container whose /proc/sys is read-only, creating and
// reaping processes until one gets a PID at or above the target leaves every
// later process and thread above it, until the counter wraps. Each step, a
// vfork, takes some 40 to 80 µs: 0.4 to 0.8 s for 10,000 PIDs, so bayma asks
// it for no target further ahead than it can reach within its start's budget.
//
// A counter already past the target stays where it is, unless --wrap is
// given: the target lies past the counter's wrap, behind it, which the
// counter is moved round to, past pid_max and up from the lowest PIDs.
//
// bayma runs this as its server starts, before any runtime, with a target past
// the highest PID a stored process snapshot uses that the counter is near,
// and before it starts each runtime it can snapshot, with one past the floor
// its runtimes start above: a restored tree finds its PIDs free, a new tree
// never takes them, and every tree lies above what a server starts before it
// can run this. It waits for it off its event loop, and starts it for no
// target the counter is past already.
//
// A target the namespace's PIDs cannot reach, at or above its pid_max, is
// refused: the counter would wrap to the lowest PIDs instead.
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

// Where the namespace's kernel settings are: /proc/sys/kernel, unless
// BAYMA_ADVANCE_PIDS_KERNEL names another directory holding pid_max and
// ns_last_pid, as the helper's own tests give it.
static const char *kernel_dir(void) {
  const char *dir = getenv("BAYMA_ADVANCE_PIDS_KERNEL");
  return dir && *dir ? dir : "/proc/sys/kernel";
}

// The path of the kernel setting `name`.
static const char *setting(const char *name) {
  static char path[4096];
  snprintf(path, sizeof path, "%s/%s", kernel_dir(), name);
  return path;
}

// The number the kernel setting `name` holds, or -1 where it holds none.
static long read_number(const char *name) {
  FILE *file = fopen(setting(name), "r");
  if (!file) return -1;
  long value;
  int parsed = fscanf(file, "%ld", &value);
  fclose(file);
  return parsed == 1 ? value : -1;
}

// Whether the counter was set just below `target` by writing ns_last_pid,
// where this process may: as the kernel then hands out `target` next.
static int set_last_pid(long target) {
  FILE *file = fopen(setting("ns_last_pid"), "w");
  if (!file) return 0;
  int written = fprintf(file, "%ld", target - 1) > 0;
  // The write itself happens as the file is closed.
  return fclose(file) == 0 && written;
}

int main(int argc, char **argv) {
  int wrap = argc == 3 && strcmp(argv[1], "--wrap") == 0;
  const char *given = argc == 2 + wrap ? argv[1 + wrap] : NULL;
  char *end;
  errno = 0;
  long target = given ? strtol(given, &end, 10) : 0;
  if (!given || errno != 0 || *end != '\0' || end == given || target < 1) {
    fprintf(stderr, "usage: bayma-advance-pids [--wrap] <target PID>\n");
    return 2;
  }
  long pid_max = read_number("pid_max");
  if (pid_max < 0) {
    fprintf(stderr, "bayma-advance-pids: %s holds no number\n", setting("pid_max"));
    return 1;
  }
  if (target >= pid_max) {
    fprintf(stderr,
            "bayma-advance-pids: PID %ld is not below this namespace's "
            "pid_max, %ld\n",
            target, pid_max);
    return 1;
  }
  long last = read_number("ns_last_pid");
  if (!wrap && last >= target) return 0;
  if (set_last_pid(target)) return 0;
  // Where the counter cannot be set, it is climbed: round past pid_max first
  // where the target lies behind it, unless the counter has wrapped since
  // the target was found behind it, and lies below it now. Each PID climbed
  // is compared with the one before, the first with the counter's last, so a
  // wrap is seen however soon it comes.
  int wrapped = wrap && last >= 0 && last < target;
  pid_t previous = (pid_t)last;
  for (;;) {
    pid_t pid = vfork();
    if (pid == 0) _exit(0);
    if (pid < 0) {
      perror("bayma-advance-pids: vfork");
      return 1;
    }
    if (waitpid(pid, NULL, 0) < 0) {
      perror("bayma-advance-pids: waitpid");
      return 1;
    }
    if (previous >= 0 && pid < previous) wrapped = 1;
    previous = pid;
    if (pid >= target && (!wrap || wrapped)) return 0;
  }
}
