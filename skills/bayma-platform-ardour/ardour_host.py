"""Ardour's engine, libardour, driven from a bayma Python session.

    ardour = ArdourHost()      # starts Ardour's Lua session
    ardour('AudioEngine:set_backend("None (Dummy)", "", "")')
    ardour("Session and Session:name()")   # the trailing expression's value
    ardour.close()

Ardour's headless Lua cannot import files, so these add them to a session's
file instead; close the session in Lua first, and load it again after:

    add_midi_region(session_dir, "Bass", [(0, 1, 40, 100), (1, 1, 43, 100)])
    add_audio_region(session_dir, "Crowd", "assets/roar.flac", at_seconds=46.3)
"""

import array
import ctypes
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET

SKILL = os.path.dirname(os.path.abspath(__file__))
INSTALL = os.path.join(SKILL, "ardour")
TICKS_PER_BEAT = 1920  # Temporal::ticks_per_beat
MARK = "\x01BAYMA-"


class ArdourError(Exception):
    """Ardour could not start, or a cell raised in it (the traceback)."""


def _launch():
    install = f"{os.environ.get('BAYMA_BUN_BIN', 'bun')} {os.path.join(SKILL, 'install.ts')}"
    try:
        with open(os.path.join(INSTALL, "env.json")) as file:
            return json.load(file)
    except FileNotFoundError:
        raise ArdourError(f"Ardour is not installed; install it: {install}") from None


class ArdourHost:
    """Ardour's Lua session, which keeps globals between cells."""

    def __init__(self):
        launch = _launch()
        run = os.path.join(INSTALL, "run")
        os.makedirs(run, exist_ok=True)
        self.cell_path = os.path.join(run, "cell.lua")
        self.log_path = os.path.join(run, "ardour.log")
        with open(self.log_path, "wb") as log:
            self.process = subprocess.Popen(
                [launch["command"], "-i", os.path.join(SKILL, "runner.lua")],
                env={**os.environ, **launch["env"]},
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=log,
                text=True,
                bufsize=1,
            )

    def __call__(self, code):
        """Runs Lua; prints what it printed, returns its trailing value as text."""
        with open(self.cell_path, "w") as file:
            file.write(code)
        command = f"__bayma_cell({json.dumps(self.cell_path)})"
        self.process.stdin.write(command + "\n")
        self.process.stdin.flush()
        printed, value = [], None
        while True:
            line = self.process.stdout.readline()
            if not line:
                raise ArdourError(f"Ardour ended; see {self.log_path}")
            line = line.rstrip("\n")
            if line.endswith(command):  # the interpreter echoes each command
                continue
            if line == MARK + "VALUE-BEGIN":
                lines = []
                for line in iter(self.process.stdout.readline, ""):
                    if line.rstrip("\n") == MARK + "VALUE-END":
                        break
                    lines.append(line.rstrip("\n"))
                value = "\n".join(lines)
            elif line.startswith(MARK + "END "):
                break
            else:
                printed.append(line)
        if printed:
            print("\n".join(printed))
        if line == MARK + "END error":
            problem = []
            for line in iter(self.process.stdout.readline, ""):
                if line.startswith(MARK + "ERROR-END"):
                    break
                problem.append(line.rstrip("\n"))
            raise ArdourError("\n".join(problem))
        return value

    def close(self):
        """Ends Ardour's Lua session; close any session in it first."""
        self.process.stdin.close()
        self.process.wait(timeout=60)


# Session files --------------------------------------------------------------


def _session(session_dir):
    """The session's XML tree and file, and its name."""
    name = os.path.basename(os.path.normpath(session_dir))
    path = os.path.join(session_dir, f"{name}.ardour")
    if not os.path.exists(path):
        raise ArdourError(f"{session_dir} has no session file {name}.ardour")
    return ET.parse(path), path, name


def _playlist(root, track):
    for playlist in root.find("Playlists").findall("Playlist"):
        if playlist.get("name") == track:
            return playlist
    raise ArdourError(f"the session has no track {track!r}")


def _unique_stem(directory, stem):
    """A stem no file in directory is named for, alone or with a channel."""
    candidate, n = os.path.join(directory, stem), 1
    while os.path.exists(f"{candidate}.wav") or os.path.exists(f"{candidate}-1.wav"):
        n += 1
        candidate = os.path.join(directory, f"{stem}-{n}")
    return candidate


def _unique(directory, stem, extension):
    candidate, n = os.path.join(directory, f"{stem}{extension}"), 1
    while os.path.exists(candidate):
        n += 1
        candidate = os.path.join(directory, f"{stem}-{n}{extension}")
    return candidate


def _region(root, playlist, name, kind, span, sources, extra=()):
    """Adds a region over sources, whose time span is Temporal's `length`."""
    counter = int(root.get("id-counter"))
    origin = "a0" if kind == "audio" else "b0"
    region = {
        "name": name, "muted": "0", "opaque": "1", "locked": "0", "video-locked": "0",
        "automatic": "0", "whole-file": "0", "import": "0", "external": "0",
        "sync-marked": "0", "left-of-split": "0", "right-of-split": "0", "hidden": "0",
        "position-locked": "0", "valid-transients": "0", "start": origin, "length": span,
        "sync-position": origin, "layer": "0", "ancestral-start": origin,
        "ancestral-length": span, "stretch": "1", "shift": "1", "layering-index": "0",
        "tags": "", "contents": "0", "id": str(counter), "type": kind, "first-edit": "nothing",
    }
    # Ardour reads sources past source-0 only up to the region's channel count.
    region["channels"] = str(len(sources))
    for index, source_id in enumerate(sources):
        region[f"source-{index}"] = str(source_id)
        region[f"master-source-{index}"] = str(source_id)
    region.update(extra)
    ET.SubElement(playlist, "Region", region)
    root.set("id-counter", str(counter + 1))


def _add_source(root, attributes):
    counter = int(root.get("id-counter"))
    ET.SubElement(root.find("Sources"), "Source", {**attributes, "id": str(counter)})
    root.set("id-counter", str(counter + 1))
    return counter


def _varlen(value):
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    return bytes(reversed(out))


def write_midi(path, notes):
    """Writes notes, (start beat, length in beats, pitch, velocity[, channel]),
    as a Standard MIDI File at Ardour's ticks per beat."""
    events = []
    for note in notes:
        start, length, pitch, velocity, channel = (*note, 0)[:5]
        on = round(start * TICKS_PER_BEAT)
        off = round((start + length) * TICKS_PER_BEAT)
        events.append((on, 1, bytes([0x90 | channel, pitch, velocity])))
        events.append((off, 0, bytes([0x80 | channel, pitch, 0])))
    events.sort(key=lambda event: (event[0], event[1]))  # offs before ons
    track, now = bytearray(), 0
    for tick, _, message in events:
        track += _varlen(tick - now) + message
        now = tick
    track += _varlen(0) + b"\xff\x2f\x00"
    with open(path, "wb") as file:
        file.write(b"MThd" + (6).to_bytes(4, "big") + (0).to_bytes(2, "big")
                   + (1).to_bytes(2, "big") + TICKS_PER_BEAT.to_bytes(2, "big"))
        file.write(b"MTrk" + len(track).to_bytes(4, "big") + track)


def add_midi_region(session_dir, track, notes, at_beat=0, name=None):
    """Adds notes, (start beat, length in beats, pitch, velocity[, channel])
    from the region's start, as a region on the MIDI track at at_beat."""
    tree, path, session = _session(session_dir)
    root = tree.getroot()
    playlist = _playlist(root, track)
    stem = (name or track).replace(" ", "-")
    midi = _unique(os.path.join(session_dir, "interchange", session, "midifiles"), stem, ".mid")
    write_midi(midi, notes)
    beats = -(-max(start + length for start, length, *_ in notes) // 1)  # whole beats
    source = _add_source(root, {"name": os.path.basename(midi), "take-id": "",
                                "type": "midi", "flags": "", "origin": ""})
    span = f"b{round(beats * TICKS_PER_BEAT)}@b{round(at_beat * TICKS_PER_BEAT)}"
    _region(root, playlist, os.path.basename(midi)[:-4], "midi", span, [source])
    tree.write(path, encoding="UTF-8", xml_declaration=True)
    return midi


def _convert(source, stem, rate):
    """Decodes any file libsndfile reads into mono float WAVs at rate, one per
    channel as Ardour keeps them, resampling with libsamplerate; runs where
    the bundle's libraries load."""

    class SF_INFO(ctypes.Structure):
        _fields_ = [("frames", ctypes.c_int64), ("samplerate", ctypes.c_int),
                    ("channels", ctypes.c_int), ("format", ctypes.c_int),
                    ("sections", ctypes.c_int), ("seekable", ctypes.c_int)]

    class SRC_DATA(ctypes.Structure):
        _fields_ = [("data_in", ctypes.POINTER(ctypes.c_float)),
                    ("data_out", ctypes.POINTER(ctypes.c_float)),
                    ("input_frames", ctypes.c_long), ("output_frames", ctypes.c_long),
                    ("input_frames_used", ctypes.c_long), ("output_frames_gen", ctypes.c_long),
                    ("end_of_input", ctypes.c_int), ("src_ratio", ctypes.c_double)]

    sndfile = ctypes.CDLL("libsndfile.so.1")
    sndfile.sf_open.restype = ctypes.c_void_p
    sndfile.sf_open.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.POINTER(SF_INFO)]
    for frames_function in (sndfile.sf_readf_float, sndfile.sf_writef_float):
        frames_function.restype = ctypes.c_int64
        frames_function.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_int64]
    sndfile.sf_close.argtypes = [ctypes.c_void_p]
    sndfile.sf_strerror.restype = ctypes.c_char_p
    sndfile.sf_strerror.argtypes = [ctypes.c_void_p]

    info = SF_INFO()
    handle = sndfile.sf_open(source.encode(), 0x10, ctypes.byref(info))  # SFM_READ
    if not handle:
        raise ArdourError(f"cannot read {source}: {sndfile.sf_strerror(None).decode()}")
    frames = (ctypes.c_float * (info.frames * info.channels))()
    frames_read = sndfile.sf_readf_float(handle, frames, info.frames)
    sndfile.sf_close(handle)

    if info.samplerate != rate:
        samplerate = ctypes.CDLL("libsamplerate.so.0")
        samplerate.src_simple.argtypes = [ctypes.POINTER(SRC_DATA), ctypes.c_int, ctypes.c_int]
        ratio = rate / info.samplerate
        capacity = int(frames_read * ratio) + 64
        out = (ctypes.c_float * (capacity * info.channels))()
        data = SRC_DATA(frames, out, frames_read, capacity, 0, 0, 1, ratio)
        error = samplerate.src_simple(ctypes.byref(data), 0, info.channels)  # best quality
        if error:
            raise ArdourError(f"cannot resample {source} (libsamplerate error {error})")
        frames, frames_read = out, data.output_frames_gen

    interleaved = array.array("f", bytes(frames)[: frames_read * info.channels * 4])
    files = []
    for channel in range(info.channels):
        target = f"{stem}.wav" if info.channels == 1 else f"{stem}-{channel + 1}.wav"
        mono = interleaved[channel :: info.channels]
        written = SF_INFO(0, rate, 1, 0x010000 | 0x0006, 0, 0)  # WAV, float
        handle = sndfile.sf_open(target.encode(), 0x20, ctypes.byref(written))  # SFM_WRITE
        if not handle:
            raise ArdourError(f"cannot write {target}: {sndfile.sf_strerror(None).decode()}")
        sndfile.sf_writef_float(handle, (ctypes.c_float * len(mono)).from_buffer(mono), len(mono))
        sndfile.sf_close(handle)
        files.append(target)
    return {"files": files, "frames": frames_read}


def add_audio_region(session_dir, track, file, at_seconds=0.0, length_seconds=None, name=None):
    """Adds an audio file, in any format libsndfile reads, as a region on the
    audio track at at_seconds, converted to the session's sample rate; one
    channel of the file per channel of the track. Returns the files made."""
    tree, path, session = _session(session_dir)
    root = tree.getroot()
    playlist = _playlist(root, track)
    rate = int(root.get("sample-rate"))
    superclock = int(root.find("TempoMap").get("superclocks-per-second"))
    stem = (name or os.path.splitext(os.path.basename(file))[0]).replace(" ", "-")
    stem = _unique_stem(os.path.join(session_dir, "interchange", session, "audiofiles"), stem)
    converted = subprocess.run(
        [sys.executable, __file__, "convert", os.path.abspath(file), stem, str(rate)],
        env={**os.environ, **_launch()["env"]}, capture_output=True, text=True)
    if converted.returncode != 0:
        raise ArdourError(converted.stderr.strip().splitlines()[-1])
    audio = json.loads(converted.stdout)
    sources = [_add_source(root, {"name": os.path.basename(wav), "type": "audio", "flags": "",
                                  "captured-for": "", "take-id": "", "channel": "0",
                                  "origin": "", "gain": "1"})
               for wav in audio["files"]]
    seconds = audio["frames"] / rate if length_seconds is None else length_seconds
    span = f"a{round(seconds * superclock)}@a{round(at_seconds * superclock)}"
    _region(root, playlist, os.path.basename(stem), "audio", span, sources, {
        "scale-amplitude": "1", "envelope-active": "0", "default-fade-in": "1",
        "default-fade-out": "1", "fade-in-active": "1", "fade-out-active": "1"})
    tree.write(path, encoding="UTF-8", xml_declaration=True)
    return audio["files"]


if __name__ == "__main__" and sys.argv[1:2] == ["convert"]:
    try:
        print(json.dumps(_convert(sys.argv[2], sys.argv[3], int(sys.argv[4]))))
    except ArdourError as error:
        sys.exit(str(error))
