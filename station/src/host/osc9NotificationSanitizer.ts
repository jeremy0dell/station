const ESC = "\x1b";
const BEL = "\x07";
const C1_OSC = "\x9d";
const C1_ST = "\x9c";
const OSC9_PREFIXES = [`${ESC}]9;`, `${C1_OSC}9;`] as const;

export type Osc9NotificationSanitizerEvent =
  | { type: "data"; data: string }
  | { type: "notification" };

export type Osc9NotificationSanitizer = {
  write(data: string): Osc9NotificationSanitizerEvent[];
  flush(): Osc9NotificationSanitizerEvent[];
};

/** Strip OSC 9 payload text while retaining its empty control sequence and ordered edge. */
export function createOsc9NotificationSanitizer(): Osc9NotificationSanitizer {
  let candidate = "";
  let redacting = false;
  let sawEscape = false;

  const write = (data: string): Osc9NotificationSanitizerEvent[] => {
    const events: Osc9NotificationSanitizerEvent[] = [];
    let retained = "";
    const append = (value: string): void => {
      retained += value;
    };
    const flushRetained = (): void => {
      if (retained.length > 0) {
        events.push({ type: "data", data: retained });
        retained = "";
      }
    };

    for (const char of data) {
      if (redacting) {
        if (char === BEL || char === C1_ST) {
          append(char);
          flushRetained();
          events.push({ type: "notification" });
          redacting = false;
          sawEscape = false;
          continue;
        }
        if (sawEscape && char === "\\") {
          append(`${ESC}\\`);
          flushRetained();
          events.push({ type: "notification" });
          redacting = false;
          sawEscape = false;
          continue;
        }
        sawEscape = char === ESC;
        continue;
      }

      candidate += char;
      while (
        candidate.length > 0 &&
        !OSC9_PREFIXES.some((prefix) => prefix.startsWith(candidate))
      ) {
        append(candidate[0] ?? "");
        candidate = candidate.slice(1);
      }
      if (OSC9_PREFIXES.some((prefix) => prefix === candidate)) {
        append(candidate);
        candidate = "";
        redacting = true;
      }
    }

    flushRetained();
    return events;
  };

  return {
    write,
    flush: () => {
      if (candidate.length === 0) {
        return [];
      }
      const data = candidate;
      candidate = "";
      return [{ type: "data", data }];
    },
  };
}
