// Moves this PID namespace's PID counter past a target, without privilege.
//
//   bayma-advance-pids <target>
//
// Linux hands out PIDs in increasing order, so creating and reaping processes
// until one gets a PID at or above the target leaves every later process and
// thread above it. bayma runs this as its server starts, before any runtime,
// with a target past the highest PID any stored process snapshot uses: a
// restored tree finds its PIDs free, and a new tree never takes them. vfork
// keeps each step to a few microseconds.
//
// If the counter wraps before reaching the target, the target is above the
// namespace's PID limit, and no snapshot could have used it.
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  char *end;
  errno = 0;
  long target = argc == 2 ? strtol(argv[1], &end, 10) : 0;
  if (argc != 2 || errno != 0 || *end != '\0' || end == argv[1] ||
      target < 1) {
    fprintf(stderr, "usage: bayma-advance-pids <target PID>\n");
    return 2;
  }
  pid_t previous = 0;
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
    if (pid >= target || pid < previous) return 0;
    previous = pid;
  }
}
