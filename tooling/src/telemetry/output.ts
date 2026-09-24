// A process's output as the lines a terminal would show: split at line
// breaks, a carriage return's overwritten text dropped, colours and other
// escape sequences removed, and blank lines skipped.

// CSI sequences (colours, cursor movement), OSC sequences (titles, links),
// and the remaining two-character escapes.
const ESCAPES =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

export function terminalText(line: string): string {
  const ended = line.endsWith("\r") ? line.slice(0, -1) : line;
  const shown = ended.slice(ended.lastIndexOf("\r") + 1);
  return shown.replace(ESCAPES, "").trimEnd();
}

/** Splits text written in chunks into lines, each passed to `emit`. */
export class LineSplitter {
  private pending = "";
  private readonly emit: (line: string) => void;

  constructor(emit: (line: string) => void) {
    this.emit = emit;
  }

  write(chunk: string): void {
    const lines = (this.pending + chunk).split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  /** The last line, when the output did not end with a line break. */
  end(): void {
    if (this.pending !== "") this.line(this.pending);
    this.pending = "";
  }

  private line(raw: string): void {
    const text = terminalText(raw);
    if (text.trim() !== "") this.emit(text);
  }
}
