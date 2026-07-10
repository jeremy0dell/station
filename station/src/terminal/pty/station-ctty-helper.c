#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <unistd.h>

/*
 * Give a Bun PTY payload a real controlling terminal, then replace this
 * process so signals and exit status continue to describe the payload itself.
 * Exit codes follow sysexits/command conventions: 64 usage, 126 setup or
 * execution failure, and 127 command not found.
 */
int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: station-ctty-helper <command> [args...]\n");
    return 64;
  }

  /* A fresh session must exist before the PTY slave can become its ctty. */
  if (setsid() == -1) {
    perror("station-ctty-helper: setsid");
    return 126;
  }
  if (ioctl(STDIN_FILENO, TIOCSCTTY, 0) == -1) {
    perror("station-ctty-helper: TIOCSCTTY");
    return 126;
  }

  execvp(argv[1], &argv[1]);
  const int saved_errno = errno;
  perror("station-ctty-helper: execvp");
  return saved_errno == ENOENT ? 127 : 126;
}
