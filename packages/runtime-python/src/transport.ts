import { ensureRuntimeAsset } from "@bayma/core";
import { payloadValue, ProcessTransport } from "@bayma/core";
import type { RuntimeTransport } from "@bayma/core";
import type { RuntimeCheckpointCodec } from "@bayma/core";
import {
  RUNTIME_OUTPUT_CAPTURE_POLICY,
  RUNTIME_OUTPUT_TRUNCATION_MARKER,
} from "@bayma/core";

const PYTHON_PROMPT = "BAYMA> ";
export const PYTHON_CHECKPOINT_CODEC = {
  codecId: "python-pickle-protocol5-v1",
  codecVersion: 1,
  payloadKind: "binary-sidecar",
} as const satisfies RuntimeCheckpointCodec;

const PYTHON_HARNESS = String.raw`
import ast
import asyncio
import builtins
import codecs
import contextlib
import json
import os
import pickle
import reprlib
import sys
import traceback

MAX_MESSAGE_BYTES = ${RUNTIME_OUTPUT_CAPTURE_POLICY.maxMessageBytes}
TRUNCATION_MARKER = ${JSON.stringify(RUNTIME_OUTPUT_TRUNCATION_MARKER)}.encode("utf8")
RESULT_REPR = reprlib.Repr()
RESULT_REPR.maxlevel = 6
RESULT_REPR.maxdict = 100
RESULT_REPR.maxlist = 100
RESULT_REPR.maxtuple = 100
RESULT_REPR.maxset = 100
RESULT_REPR.maxfrozenset = 100
RESULT_REPR.maxdeque = 100
RESULT_REPR.maxstring = 16_384
RESULT_REPR.maxother = 16_384


def bound_text(value: str) -> str:
    encoded = value.encode("utf8", errors="replace")
    if len(encoded) <= MAX_MESSAGE_BYTES:
        return value
    payload_bytes = MAX_MESSAGE_BYTES - len(TRUNCATION_MARKER)
    left_bytes = payload_bytes // 2
    right_bytes = payload_bytes - left_bytes
    return (
        encoded[:left_bytes].decode("utf8", errors="ignore")
        + TRUNCATION_MARKER.decode("utf8")
        + encoded[-right_bytes:].decode("utf8", errors="ignore")
    )

SESSION_GLOBALS = {
    "__name__": "__main__",
    "__builtins__": builtins,
    "_": None,
    "_error": None,
}
CHECKPOINT = None

SESSION_CWD = os.getcwd()
if SESSION_CWD not in sys.path:
    sys.path.insert(0, SESSION_CWD)


def emit(prefix: str, kind: str, text: str | None = None) -> None:
    payload = {"kind": kind}
    if text is not None:
        payload["text"] = bound_text(text)
    write_protocol_line(prefix + json.dumps(payload, ensure_ascii=False))


def write_protocol_line(value: str) -> None:
    # sys.__stdout__ uses the active Windows code page on hosted runners.
    # Protocol JSON is UTF-8 on every platform, independent of terminal locale.
    sys.__stdout__.buffer.write((value + "\n").encode("utf8"))
    sys.__stdout__.buffer.flush()


class ChannelBufferWriter:
    def __init__(self, owner):
        self.owner = owner
        self.decoder = codecs.getincrementaldecoder("utf8")(errors="replace")

    def write(self, data) -> int:
        payload = bytes(data)
        text = self.decoder.decode(payload, final=False)
        if text:
            self.owner.emit_text(text)
        return len(payload)

    def flush(self) -> None:
        return None

    def finish(self) -> None:
        text = self.decoder.decode(b"", final=True)
        self.decoder.reset()
        if text:
            self.owner.emit_text(text)

    def writable(self) -> bool:
        return True


class ChannelWriter:
    encoding = "utf-8"
    errors = "replace"

    def __init__(self, prefix: str, kind: str):
        self.prefix = prefix
        self.kind = kind
        self.buffer = ChannelBufferWriter(self)

    def emit_text(self, text: str) -> None:
        emit(self.prefix, self.kind, text)

    def write(self, text: str) -> int:
        if not isinstance(text, str):
            raise TypeError("write() argument must be str")
        if text:
            # Empty text writes do not establish an ordering boundary and must
            # not flush an incomplete UTF-8 scalar from the binary surface.
            self.buffer.finish()
            self.emit_text(text)
        return len(text)

    def flush(self) -> None:
        self.buffer.flush()

    def finish(self) -> None:
        self.buffer.finish()

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False


def bayma_read_checkpoint():
    return CHECKPOINT


def bayma_write_checkpoint(value):
    global CHECKPOINT
    CHECKPOINT = value
    return value


SESSION_GLOBALS["bayma_read_checkpoint"] = bayma_read_checkpoint
SESSION_GLOBALS["bayma_write_checkpoint"] = bayma_write_checkpoint


def compile_submission(source: str, filename: str):
    tree = ast.parse(source, filename=filename, mode="exec")
    result_name = "__bayma_result__"
    has_result = bool(tree.body) and isinstance(tree.body[-1], ast.Expr)
    if has_result:
        tree.body[-1] = ast.Assign(
            targets=[ast.Name(id=result_name, ctx=ast.Store())],
            value=tree.body[-1].value,
        )
        ast.fix_missing_locations(tree)
    flags = getattr(ast, "PyCF_ALLOW_TOP_LEVEL_AWAIT", 0)
    code = compile(tree, filename, "exec", flags=flags, dont_inherit=True)
    return code, has_result, result_name


def format_result(value):
    try:
        return RESULT_REPR.repr(value)
    except Exception:
        return "<unreprable result>"


def run_submission(spec_path: str) -> None:
    global CHECKPOINT
    with open(spec_path, "r", encoding="utf8") as handle:
        spec = json.load(handle)
    prefix = spec["event_prefix"]
    if spec.get("durability_mode") == "checkpointed":
        checkpoint = spec.get("checkpoint")
        if checkpoint is None:
            CHECKPOINT = None
        elif checkpoint.get("payload_kind") == "binary-sidecar":
            with open(checkpoint["payload_path"], "rb") as payload:
                CHECKPOINT = pickle.load(payload)
        elif checkpoint.get("payload_kind") == "json-inline":
            CHECKPOINT = checkpoint.get("inline_json")
        else:
            raise RuntimeError("unsupported Python checkpoint payload kind: " + str(checkpoint.get("payload_kind")))
    stdout = ChannelWriter(prefix, "stdout")
    stderr = ChannelWriter(prefix, "stderr")
    try:
        SESSION_GLOBALS.pop("__bayma_result__", None)
        code, has_result, result_name = compile_submission(spec["code"], spec["source_path"])
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            value = eval(code, SESSION_GLOBALS)
            if asyncio.iscoroutine(value):
                asyncio.run(value)
        if has_result and result_name in SESSION_GLOBALS:
            result = SESSION_GLOBALS.pop(result_name)
            if result is not None:
                SESSION_GLOBALS["_"] = result
                emit(prefix, "result", format_result(result))
    except BaseException as error:
        SESSION_GLOBALS["_error"] = error
        emit(prefix, "error", "".join(traceback.format_exception(error)).rstrip())
    finally:
        stdout.finish()
        stderr.finish()
        if spec.get("durability_mode") == "checkpointed":
            try:
                checkpoint_output_path = spec["checkpoint_output_path"]
                with open(checkpoint_output_path, "wb") as payload:
                    pickle.dump(CHECKPOINT, payload, protocol=5)
                event = {
                    "kind": "checkpoint",
                    "checkpoint": {
                        "runtimeId": "python",
                        "codecId": ${JSON.stringify(PYTHON_CHECKPOINT_CODEC.codecId)},
                        "codecVersion": ${PYTHON_CHECKPOINT_CODEC.codecVersion},
                        "payloadKind": ${JSON.stringify(PYTHON_CHECKPOINT_CODEC.payloadKind)},
                        "payloadPath": checkpoint_output_path,
                        "compatibility": {
                            "runtimeVersion": sys.version.split()[0],
                            "languageVersion": sys.version.split()[0],
                            "platform": sys.platform,
                        },
                    },
                }
                write_protocol_line(prefix + json.dumps(event, ensure_ascii=False))
            except Exception as error:
                emit(prefix, "error", "".join(traceback.format_exception(error)).rstrip())
        emit(prefix, "done")


def main() -> None:
    sys.stdout.write("BAYMA> ")
    sys.stdout.flush()
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            sys.stdout.write("BAYMA> ")
            sys.stdout.flush()
            continue
        if line.startswith(":exec "):
            run_submission(line[len(":exec "):])
        elif line.startswith(":probe "):
            write_protocol_line("__BAYMA_READY_" + line[len(":probe "):] + "__")
        sys.stdout.write("BAYMA> ")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
`;

function pythonHarnessPath(): string {
  return ensureRuntimeAsset(
    "python",
    "python-harness.py",
    PYTHON_HARNESS.trimStart(),
  );
}

export function createPythonTransport(): RuntimeTransport {
  return new ProcessTransport({
    platformId: "stdio",
    promptRe: /(?:^|[\r\n])BAYMA> /g,
    interruptStrategy: "sigint",
    interruptProbe: (nonce) => ({
      input: `:probe ${nonce}\n`,
      expectedOutput: `__BAYMA_READY_${nonce}__`,
    }),
    command: () => ({
      file: payloadValue("BAYMA_PYTHON_BIN"),
      args: ["-u", pythonHarnessPath()],
      env: {
        PYTHONNOUSERSITE: "1",
        PYTHONUNBUFFERED: "1",
      },
    }),
  });
}

export { PYTHON_PROMPT };
