/*
 * Agent 365 Setup — native launcher.
 *
 * Apple will notarise a bundle only when its executable is real code, so this
 * tiny program is the app: it locates launch.sh next to itself and hands over
 * to it. Everything the customer sees still comes from the shell script.
 */
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <libgen.h>

int main(int argc, char **argv) {
  char path[4096]; uint32_t size = sizeof(path);
  if (_NSGetExecutablePath(path, &size) != 0) { fprintf(stderr, "launcher: path too long\n"); return 1; }
  char real[4096]; if (!realpath(path, real)) { perror("launcher: realpath"); return 1; }
  char dir[4096]; strncpy(dir, dirname(real), sizeof(dir) - 1); dir[sizeof(dir) - 1] = 0;
  /* Contents/MacOS/launch -> Contents/Resources/launch.sh: resources are sealed by hash, never signed as code. */
  char script[4300]; snprintf(script, sizeof(script), "%s/../Resources/launch.sh", dir);
  execl("/bin/bash", "bash", script, (char *)NULL);
  perror("launcher: exec"); return 1;
}
