// Moves this PID namespace's PID counter past a target, without privilege.
//
//   bayma-advance-pids <target>
//
// Linux hands out PIDs in increasing order, so creating and reaping processes
// until one gets a PID at or above the target leaves every later process and
// thread above it, until the counter wraps; a counter already past the target
// stays where it is. Each step, a vfork, takes some 40 µs: 0.4 s for 10,000
// PIDs.
//
// bayma runs this as its server starts, before any runtime, with a target past
// the highest PID any stored process snapshot uses, and before it starts each
// runtime it can snapshot, with one past the floor its runtimes start above: a
// restored tree finds its PIDs free, a new tree never takes them, and every
// tree lies above what a server starts before it can run this. It waits for it
// off its event loop, and starts it for no target the counter is past already.
//
// A target the namespace's PIDs cannot reach, at or above its pid_max, is
// refused: the counter would wrap to the lowest PIDs instead.
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

#define PID_MAX "/proc/sys/kernel/pid_max"

int main(int argc, char **argv) {
  char *end;
  errno = 0;
  long target = argc == 2 ? strtol(argv[1], &end, 10) : 0;
  if (argc != 2 || errno != 0 || *end != '\0' || end == argv[1] ||
      target < 1) {
    fprintf(stderr, "usage: bayma-advance-pids <target PID>\n");
    return 2;
  }
  FILE *limit = fopen(PID_MAX, "r");
  if (!limit) {
    perror("bayma-advance-pids: " PID_MAX);
    return 1;
  }
  long pid_max;
  int parsed = fscanf(limit, "%ld", &pid_max);
  fclose(limit);
  if (parsed != 1) {
    fprintf(stderr, "bayma-advance-pids: " PID_MAX " holds no number\n");
    return 1;
  }
  if (target >= pid_max) {
    fprintf(stderr,
            "bayma-advance-pids: PID %ld is not below this namespace's "
            "pid_max, %ld\n",
            target, pid_max);
    return 1;
  }
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
    if (pid >= target) return 0;
  }
}
