#if defined(__APPLE__)
#define _DARWIN_C_SOURCE
#endif
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

#ifndef STATION_PROTOCOL_SCHEMA_VERSION
#error "STATION_PROTOCOL_SCHEMA_VERSION must be defined"
#endif
#ifndef STATION_OBSERVER_VERSION
#error "STATION_OBSERVER_VERSION must be defined"
#endif

#define MAX_STDIN_BYTES (8U * 1024U * 1024U)
#define MAX_RESPONSE_BYTES (1024U * 1024U)

struct byte_buffer {
  char *data;
  size_t length;
  size_t capacity;
};

static int buffer_reserve(struct byte_buffer *buffer, size_t additional) {
  if (additional > SIZE_MAX - buffer->length - 1U) return -1;
  const size_t required = buffer->length + additional + 1U;
  if (required <= buffer->capacity) return 0;
  size_t capacity = buffer->capacity == 0U ? 4096U : buffer->capacity;
  while (capacity < required) {
    if (capacity > SIZE_MAX / 2U) {
      capacity = required;
      break;
    }
    capacity *= 2U;
  }
  char *next = realloc(buffer->data, capacity);
  if (next == NULL) return -1;
  buffer->data = next;
  buffer->capacity = capacity;
  return 0;
}

static int buffer_append_bytes(struct byte_buffer *buffer, const char *value, size_t length) {
  if (buffer_reserve(buffer, length) != 0) return -1;
  memcpy(buffer->data + buffer->length, value, length);
  buffer->length += length;
  buffer->data[buffer->length] = '\0';
  return 0;
}

static int buffer_append(struct byte_buffer *buffer, const char *value) {
  return buffer_append_bytes(buffer, value, strlen(value));
}

static int buffer_append_json_string(struct byte_buffer *buffer, const char *value) {
  static const char hex[] = "0123456789abcdef";
  if (buffer_append(buffer, "\"") != 0) return -1;
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor += 1) {
    const unsigned char character = *cursor;
    if (character == '\"' || character == '\\') {
      const char escaped[2] = {'\\', (char)character};
      if (buffer_append_bytes(buffer, escaped, sizeof(escaped)) != 0) return -1;
    } else if (character < 0x20U) {
      const char escaped[6] = {'\\', 'u', '0', '0', hex[character >> 4U], hex[character & 0x0fU]};
      if (buffer_append_bytes(buffer, escaped, sizeof(escaped)) != 0) return -1;
    } else if (buffer_append_bytes(buffer, (const char *)cursor, 1U) != 0) {
      return -1;
    }
  }
  return buffer_append(buffer, "\"");
}

static int buffer_append_field(
    struct byte_buffer *buffer,
    const char *name,
    const char *value) {
  if (value == NULL || value[0] == '\0') return 0;
  return buffer_append(buffer, ",\"") != 0 ||
                 buffer_append(buffer, name) != 0 ||
                 buffer_append(buffer, "\":") != 0 ||
                 buffer_append_json_string(buffer, value) != 0
             ? -1
             : 0;
}

static int read_stdin(struct byte_buffer *payload) {
  char chunk[8192];
  for (;;) {
    const ssize_t count = read(STDIN_FILENO, chunk, sizeof(chunk));
    if (count == 0) return 0;
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if ((size_t)count > MAX_STDIN_BYTES - payload->length) {
      errno = EFBIG;
      return -1;
    }
    if (buffer_append_bytes(payload, chunk, (size_t)count) != 0) return -1;
  }
}

static int write_socket_all(int descriptor, const char *data, size_t length) {
  size_t offset = 0U;
  while (offset < length) {
#if defined(MSG_NOSIGNAL)
    const ssize_t count = send(descriptor, data + offset, length - offset, MSG_NOSIGNAL);
#else
    const ssize_t count = send(descriptor, data + offset, length - offset, 0);
#endif
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    offset += (size_t)count;
  }
  return 0;
}

static int read_response(int descriptor, struct byte_buffer *response) {
  char chunk[1024];
  while (response->length < MAX_RESPONSE_BYTES) {
    const ssize_t count = read(descriptor, chunk, sizeof(chunk));
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (count == 0) return -1;
    const char *newline = memchr(chunk, '\n', (size_t)count);
    const size_t accepted = newline == NULL ? (size_t)count : (size_t)(newline - chunk) + 1U;
    if (buffer_append_bytes(response, chunk, accepted) != 0) return -1;
    if (newline != NULL) return 0;
  }
  errno = EMSGSIZE;
  return -1;
}

static const char *nonempty_env(const char *name) {
  const char *value = getenv(name);
  return value != NULL && value[0] != '\0' ? value : NULL;
}

static int event_timestamp(char *output, size_t output_size, struct timespec *now) {
  if (clock_gettime(CLOCK_REALTIME, now) != 0) return -1;
  struct tm utc;
  if (gmtime_r(&now->tv_sec, &utc) == NULL) return -1;
  const int count = snprintf(
      output,
      output_size,
      "%04d-%02d-%02dT%02d:%02d:%02d.%03ldZ",
      utc.tm_year + 1900,
      utc.tm_mon + 1,
      utc.tm_mday,
      utc.tm_hour,
      utc.tm_min,
      utc.tm_sec,
      now->tv_nsec / 1000000L);
  return count > 0 && (size_t)count < output_size ? 0 : -1;
}

static int build_request(
    struct byte_buffer *request,
    const struct byte_buffer *payload,
    const char *provider,
    const char *event,
    const char *hook_id,
    const char *received_at) {
  if (buffer_append(request, "{\"schemaVersion\":\"") != 0 ||
      buffer_append(request, STATION_PROTOCOL_SCHEMA_VERSION) != 0 ||
      buffer_append(request, "\",\"jsonrpc\":\"2.0\",\"id\":") != 0 ||
      buffer_append_json_string(request, hook_id) != 0 ||
      buffer_append(
          request,
          ",\"method\":\"observer.ingestProviderHookEvent\",\"params\":{\"event\":{\"schemaVersion\":\"") != 0 ||
      buffer_append(request, STATION_PROTOCOL_SCHEMA_VERSION) != 0 ||
      buffer_append(request, "\",\"hookId\":") != 0 ||
      buffer_append_json_string(request, hook_id) != 0 ||
      buffer_append(request, ",\"provider\":") != 0 ||
      buffer_append_json_string(request, provider) != 0 ||
      buffer_append(request, ",\"kind\":\"harness\",\"event\":") != 0 ||
      buffer_append_json_string(request, event) != 0 ||
      buffer_append(request, ",\"receivedAt\":") != 0 ||
      buffer_append_json_string(request, received_at) != 0 ||
      buffer_append_field(request, "projectId", nonempty_env("STATION_PROJECT_ID")) != 0 ||
      buffer_append_field(request, "worktreeId", nonempty_env("STATION_WORKTREE_ID")) != 0 ||
      buffer_append_field(request, "worktreePath", nonempty_env("STATION_WORKTREE_PATH")) != 0 ||
      buffer_append_field(
          request,
          "worktreeManagedRoot",
          nonempty_env("STATION_WORKTREE_MANAGED_ROOT")) != 0 ||
      buffer_append_field(request, "sessionId", nonempty_env("STATION_SESSION_ID")) != 0 ||
      buffer_append_field(
          request,
          "terminalProvider",
          nonempty_env("STATION_TERMINAL_PROVIDER")) != 0 ||
      buffer_append_field(
          request,
          "terminalTargetId",
          nonempty_env("STATION_TERMINAL_TARGET_ID")) != 0 ||
      buffer_append(request, ",\"payload\":") != 0 ||
      buffer_append_bytes(request, payload->data, payload->length) != 0 ||
      buffer_append(request, "},\"expectedBuildVersion\":\"") != 0 ||
      buffer_append(request, STATION_OBSERVER_VERSION) != 0 ||
      buffer_append(request, "\"}}\n") != 0) {
    return -1;
  }
  return 0;
}

static int build_accepted_response(
    struct byte_buffer *expected,
    const char *provider,
    const char *event,
    const char *hook_id,
    const char *received_at) {
  if (buffer_append(expected, "{\"schemaVersion\":\"") != 0 ||
      buffer_append(expected, STATION_PROTOCOL_SCHEMA_VERSION) != 0 ||
      buffer_append(expected, "\",\"jsonrpc\":\"2.0\",\"id\":") != 0 ||
      buffer_append_json_string(expected, hook_id) != 0 ||
      buffer_append(expected, ",\"result\":{\"schemaVersion\":\"") != 0 ||
      buffer_append(expected, STATION_PROTOCOL_SCHEMA_VERSION) != 0 ||
      buffer_append(expected, "\",\"hookId\":") != 0 ||
      buffer_append_json_string(expected, hook_id) != 0 ||
      buffer_append(expected, ",\"provider\":") != 0 ||
      buffer_append_json_string(expected, provider) != 0 ||
      buffer_append(expected, ",\"event\":") != 0 ||
      buffer_append_json_string(expected, event) != 0 ||
      buffer_append(expected, ",\"status\":\"accepted\",\"receivedAt\":") != 0 ||
      buffer_append_json_string(expected, received_at) != 0 ||
      buffer_append(expected, "}}\n") != 0) {
    return -1;
  }
  return 0;
}

static int send_request(
    const char *socket_path,
    const struct byte_buffer *request,
    struct byte_buffer *response,
    int timeout_ms) {
  if (strlen(socket_path) >= sizeof(((struct sockaddr_un *)0)->sun_path)) {
    errno = ENAMETOOLONG;
    return -1;
  }
  const int descriptor = socket(AF_UNIX, SOCK_STREAM, 0);
  if (descriptor < 0) return -1;
#if defined(__APPLE__)
  const int no_sigpipe = 1;
  if (setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe)) != 0) {
    close(descriptor);
    return -1;
  }
#endif
  struct timeval timeout = {
      .tv_sec = timeout_ms / 1000,
      .tv_usec = (timeout_ms % 1000) * 1000,
  };
  if (setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) != 0 ||
      setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) != 0) {
    close(descriptor);
    return -1;
  }
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  memcpy(address.sun_path, socket_path, strlen(socket_path) + 1U);
  const int result = connect(descriptor, (struct sockaddr *)&address, sizeof(address)) == 0 &&
                             write_socket_all(descriptor, request->data, request->length) == 0 &&
                             read_response(descriptor, response) == 0
                         ? 0
                         : -1;
  const int saved_errno = errno;
  close(descriptor);
  errno = saved_errno;
  return result;
}

static int current_executable_path(const char *argv0, char *output, size_t output_size) {
  (void)argv0;
  char unresolved[PATH_MAX];
#if defined(__APPLE__)
  uint32_t unresolved_size = (uint32_t)sizeof(unresolved);
  if (_NSGetExecutablePath(unresolved, &unresolved_size) != 0) {
    errno = ENAMETOOLONG;
    return -1;
  }
#elif defined(__linux__)
  const ssize_t count = readlink("/proc/self/exe", unresolved, sizeof(unresolved) - 1U);
  if (count < 0 || (size_t)count >= sizeof(unresolved) - 1U) return -1;
  unresolved[count] = '\0';
#else
  if (strlen(argv0) >= sizeof(unresolved)) {
    errno = ENAMETOOLONG;
    return -1;
  }
  memcpy(unresolved, argv0, strlen(argv0) + 1U);
#endif
  return realpath(unresolved, output) == NULL || strlen(output) >= output_size ? -1 : 0;
}

struct runtime_plan {
  char executable[PATH_MAX];
  char **argv;
};

static int prepare_runtime(
    struct runtime_plan *plan,
    int argc,
    char **argv) {
  char resolved[PATH_MAX];
  if (current_executable_path(argv[0], resolved, sizeof(resolved)) != 0) return -1;
  char *separator = strrchr(resolved, '/');
  if (separator == NULL) {
    errno = EINVAL;
    return -1;
  }
  *separator = '\0';
  const int count = snprintf(plan->executable, sizeof(plan->executable), "%s/stn", resolved);
  if (count <= 0 || (size_t)count >= sizeof(plan->executable)) {
    errno = ENAMETOOLONG;
    return -1;
  }
  plan->argv = calloc((size_t)argc + 2U, sizeof(char *));
  if (plan->argv == NULL) return -1;
  plan->argv[0] = plan->executable;
  plan->argv[1] = "__ingress";
  for (int index = 1; index < argc; index += 1) plan->argv[index + 1] = argv[index];

  return 0;
}

static int prepare_replay(const struct byte_buffer *payload) {
  FILE *replay = tmpfile();
  if (replay == NULL || (payload->length > 0U &&
                         fwrite(payload->data, 1U, payload->length, replay) != payload->length) ||
      fflush(replay) != 0 ||
      fseek(replay, 0L, SEEK_SET) != 0 ||
      dup2(fileno(replay), STDIN_FILENO) < 0) {
    const int saved_errno = errno;
    if (replay != NULL) fclose(replay);
    errno = saved_errno;
    return -1;
  }
  fclose(replay);
  return 0;
}

static void exec_runtime(const struct runtime_plan *plan) {
  execv(plan->executable, plan->argv);
  const int saved_errno = errno;
  perror("stn-ingress: exec runtime");
  exit(saved_errno == ENOENT ? 127 : 126);
}

static int parse_positive_timeout(const char *value, int *output) {
  errno = 0;
  char *end = NULL;
  const long parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed <= 0L || parsed > INT_MAX) return -1;
  *output = (int)parsed;
  return 0;
}

int main(int argc, char **argv) {
  struct runtime_plan runtime = {0};
  if (prepare_runtime(&runtime, argc, argv) != 0) {
    perror("stn-ingress: canonical runtime setup");
    return 126;
  }

  int fast_requested = 0;
  for (int index = 1; index < argc; index += 1) {
    if (strcmp(argv[index], "--fast") == 0) {
      fast_requested = 1;
      break;
    }
  }
  if (fast_requested == 0) exec_runtime(&runtime);

  struct byte_buffer payload = {0};
  if (read_stdin(&payload) != 0) {
    perror("stn-ingress: stdin");
    free(payload.data);
    free(runtime.argv);
    return 1;
  }
  if (prepare_replay(&payload) != 0) {
    perror("stn-ingress: canonical replay setup");
    free(payload.data);
    free(runtime.argv);
    return 126;
  }

  int fast = 0;
  int fast_options_valid = 1;
  int delivery_timeout_ms = 2000;
  const char *socket_path = NULL;
  const char *provider = NULL;
  const char *event = NULL;
  int positional = 0;
  for (int index = 1; index < argc; index += 1) {
    const char *argument = argv[index];
    if (strcmp(argument, "--fast") == 0) {
      fast = 1;
      continue;
    }
    if (strcmp(argument, "--no-auto-start") == 0) continue;
    if (strcmp(argument, "--socket") == 0 || strcmp(argument, "--state-dir") == 0 ||
        strcmp(argument, "--spool-dir") == 0 || strcmp(argument, "--config") == 0 ||
        strcmp(argument, "--observer-entry") == 0 ||
        strcmp(argument, "--delivery-timeout-ms") == 0 ||
        strcmp(argument, "--startup-timeout-ms") == 0 ||
        strcmp(argument, "--rate-limit-ms") == 0) {
      if (index + 1 >= argc) break;
      if (strcmp(argument, "--socket") == 0) socket_path = argv[index + 1];
      if (strcmp(argument, "--delivery-timeout-ms") == 0 &&
          parse_positive_timeout(argv[index + 1], &delivery_timeout_ms) != 0) {
        fast_options_valid = 0;
      }
      index += 1;
      continue;
    }
    if (positional == 0) provider = argument;
    if (positional == 1) event = argument;
    positional += 1;
  }

  if (fast == 0 || fast_options_valid == 0 || socket_path == NULL || provider == NULL ||
      event == NULL || positional != 2 ||
      nonempty_env("STATION_SESSION_ID") == NULL ||
      nonempty_env("STATION_WORKTREE_ID") == NULL || payload.length == 0U) {
    exec_runtime(&runtime);
  }

  struct timespec now;
  char received_at[32];
  char hook_id[96];
  if (event_timestamp(received_at, sizeof(received_at), &now) != 0 ||
      snprintf(
          hook_id,
          sizeof(hook_id),
          "hook_%lld_%09ld_%ld",
          (long long)now.tv_sec,
          now.tv_nsec,
          (long)getpid()) <= 0) {
    exec_runtime(&runtime);
  }
  if (setenv("STATION_INTERNAL_PROVIDER_HOOK_ID", hook_id, 1) != 0) {
    perror("stn-ingress: hook id");
    return 126;
  }

  struct byte_buffer request = {0};
  struct byte_buffer response = {0};
  if (build_request(&request, &payload, provider, event, hook_id, received_at) == 0 &&
      send_request(socket_path, &request, &response, delivery_timeout_ms) == 0) {
    struct byte_buffer expected = {0};
    // Only the exact validated success shape may bypass canonical ingress;
    // protocol evolution or any ambiguous response must replay through it.
    const int accepted =
        build_accepted_response(&expected, provider, event, hook_id, received_at) == 0 &&
        response.length == expected.length &&
        memcmp(response.data, expected.data, response.length) == 0;
    free(expected.data);
    if (accepted) {
      free(request.data);
      free(response.data);
      free(payload.data);
      free(runtime.argv);
      return 0;
    }
  }
  free(request.data);
  free(response.data);
  exec_runtime(&runtime);
  return 126;
}
