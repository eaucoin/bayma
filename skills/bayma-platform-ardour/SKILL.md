---
name: bayma-platform-ardour
description: Inspect the Lua bindings of and execute code against libardour, Ardour's engine, kept with its instruments and effects in this skill's folder; compose, arrange, mix, and render music and audio.
---

# Ardour Platform

This skill shows you where to find the relevant bindings and scripts to reference when writing correct source code or interactively executing code that interacts with the platform appropriately. The skill owns Ardour, Ubuntu 24.04's GPL build of Ardour 8.4 with LV2 instruments and effects, in its own folder, `<skill>` below. Code runs in Ardour's Lua session, driven from a bayma Python session.

## Reference Materials

- https://manual.ardour.org/lua-scripting/class_reference/: the Lua bindings, of the current Ardour; 8.4 lacks a few, such as `set_plugin_insert_property`
- `<skill>/ardour/root/usr/share/ardour8/scripts/*.lua`: Ardour's own scripts
- `<skill>/ardour_host.py`: the Lua bridge, and `add_midi_region` and `add_audio_region`, which add MIDI and audio files to a session, as Ardour's headless Lua cannot
- In Ardour: `ARDOUR.LuaAPI.list_plugins()` for its instruments and effects, once a session is open
- Sounds and samples: `<skill>/freesound/FREESOUND.md`

If these materials are missing, install Ardour, in a bayma Bun session whose `cwd` is `<skill>`:

```ts
await Bun.$`${process.execPath} install.ts 2>&1`.nothrow().text();
```

## Interactive Quickstart

In a bayma Python session whose `cwd` is `<skill>`:

```python
from ardour_host import ArdourHost, ArdourError, add_midi_region, add_audio_region

ardour = ArdourHost()
ardour('AudioEngine:set_backend("None (Dummy)", "", "")')
ardour("AudioEngine:start()")
ardour("AudioEngine:running()")
```

`ardour(code)` runs Lua in Ardour, where globals persist between calls; it returns the text of the code's trailing expression, and raises `ArdourError` with Ardour's traceback. `create_session(dir, name, rate)`, `load_session(dir, name)`, and `close_session()` manage the session, which is `Session` while open. Close it before `add_midi_region` or `add_audio_region`, which edit its file, and load it again after. `Session:simple_export()` renders WAV, FLAC, or Ogg; there is no MP3 encoder.
