---
name: bayma-platform-ardour
description: Inspect the headers of and execute C++ against libardour, Ardour's engine, built with its instruments and effects in this skill's folder; compose, arrange, mix, and render music and audio.
---

# Ardour Platform

This skill shows you where to find the relevant headers and scripts to reference when writing correct source code or interactively executing code that interacts with the platform appropriately. The skill owns Ardour's engine, libardour, built from Ardour 9.8's source with LV2 instruments and effects, in its own folder, `<skill>` below. Code runs in a bayma C++ session, against libardour itself.

## Reference Materials

- `<skill>/ardour/include/ardour/libs/ardour/ardour/*.h`: libardour: sessions, tracks and buses, regions and playlists, plugins, and export
- `<skill>/ardour/include/ardour/libs/{pbd,temporal,evoral}/**`: what it builds on: properties and signals, time and tempo, MIDI events
- `<skill>/ardour/engine/share/ardour9/scripts/*.lua`: Ardour's own scripts, which use the same classes through Lua
- https://manual.ardour.org/lua-scripting/class_reference/: those classes, as Lua sees them
- `<skill>/ardour_session.h`: libardour, started headless
- Sounds and samples: `<skill>/freesound/FREESOUND.md`

If these materials are missing, install Ardour's engine, in a bayma Bun session whose `cwd` is `<skill>`; it builds Ardour, which takes a while:

```ts
await Bun.$`${process.execPath} install.ts 2>&1`.nothrow().text();
```

## Interactive Quickstart

In a bayma C++ session whose `cwd` is `<skill>`, where the `compile_flags.txt` the install wrote gives it libardour's headers and loads it:

```cpp
#include "ardour_session.h"
#include "ardour/session.h"

ARDOUR::AudioEngine *engine = bayma_ardour::start();
ARDOUR::BusProfile busProfile;
busProfile.master_out_channels = 2;
ARDOUR::Session *session =
    new ARDOUR::Session(*engine, "/path/to/new/song", "song", &busProfile);
session->name()
```

`bayma_ardour::start()` initializes libardour with this skill's instruments and effects, once per session, and starts the audio engine on Ardour's dummy backend, which renders as fast as the machine can. `Session::import_files` brings audio into a session, `RegionFactory::create` makes regions of what it imported, and a track's `playlist()` places them; `ARDOUR::LuaAPI::new_plugin` finds a plugin by name and type, `LV2` for the skill's instruments and effects and `Lua` for Ardour's own scripted ones, such as ACE High/Low Pass Filter; a `PluginInsert`'s `automation_control(Evoral::Parameter(PluginAutomation, 0, port))` sets a parameter by its port, and `SimpleExport` renders WAV, FLAC, or Ogg. Ardour's API is C++17, which `compile_flags.txt` sets.
