// Bayma redirects Python's stdout and stderr through its harness. Tools such
// as pytest's terminal reporter probe those streams as real text streams;
// this probe asserts the properties they rely on, through the live harness.

export const PYTHON_STREAM_CONTRACT_STDOUT = "€bayma-stream-stdout\n";
export const PYTHON_STREAM_CONTRACT_STDERR = "�€bayma-stream-stderr\n";

export function pythonStreamContractProbe(): string {
  return [
    "import sys",
    "class TerminalReporterProbe:",
    "    def __init__(self, stream):",
    "        self.hasmarkup = stream.isatty()",
    "        self.encoding = stream.encoding",
    "        self.errors = stream.errors",
    "        self.writable = stream.writable()",
    "for stream in (sys.stdout, sys.stderr):",
    "    probe = TerminalReporterProbe(stream)",
    "    assert probe.hasmarkup is False",
    '    assert probe.encoding.lower().replace("_", "-") == "utf-8"',
    '    assert probe.errors == "replace"',
    "    assert probe.writable is True",
    "    assert stream.buffer.writable() is True",
    '    assert stream.write("") == 0',
    "    stream.flush()",
    "    try:",
    '        stream.write(b"not-text")',
    "    except TypeError:",
    "        pass",
    "    else:",
    '        raise AssertionError("text stream accepted bytes")',
    "assert sys.stdout.buffer.write(bytes([0xe2])) == 1",
    "sys.stdout.flush()",
    'assert sys.stdout.write("") == 0',
    "assert sys.stdout.buffer.write(bytes([0x82, 0xac])) == 2",
    'assert sys.stdout.write("bayma-stream-stdout\\n") == 20',
    "assert sys.stderr.buffer.write(bytes([0xff])) == 1",
    "assert sys.stderr.buffer.write(bytes([0xe2])) == 1",
    "sys.stderr.flush()",
    'assert sys.stderr.write("") == 0',
    "assert sys.stderr.buffer.write(bytes([0x82, 0xac])) == 2",
    'assert sys.stderr.write("bayma-stream-stderr\\n") == 20',
    "sys.stdout.flush()",
    "sys.stderr.flush()",
  ].join("\n");
}
