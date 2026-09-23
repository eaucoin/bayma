---
name: bayma-platform-bpy
description: Inspect the Python API of and execute code against bpy in a headless Blender kept in this skill's folder; model, animate, light, and render 3D scenes and films.
---

# Blender Platform

This skill shows you where to find the relevant API and scripts to reference when writing correct source code or interactively executing code that interacts with the platform appropriately. The skill owns Blender, the official release, in its own folder, `<skill>` below. Code runs inside a headless Blender, through `bpy`, driven from a bayma Python session.

## Reference Materials

- https://docs.blender.org/api/5.2/: the `bpy` API reference
- `<skill>/blender/app/5.2/scripts/templates_py/*.py`: Blender's own example scripts
- `<skill>/blender/app/5.2/scripts/{startup,addons_core}/**`: Blender's user interface and add-ons, written in `bpy`
- `<skill>/blender_host.py`: the bridge, and `render_detached` and `encode`, for animations

If these materials are missing, install Blender, in a bayma Bun session whose `cwd` is `<skill>`:

```ts
await Bun.$`${process.execPath} install.ts 2>&1`.nothrow().text();
```

## Interactive Quickstart

In a bayma Python session whose `cwd` is `<skill>`:

```python
from blender_host import BlenderHost, BlenderError, render_detached, encode

blender = BlenderHost()
blender("bpy.app.version_string, bpy.context.scene.render.engine")
```

`blender(code)` runs Python inside Blender, where `bpy` and `mathutils` are imported and names persist between calls. It returns the repr of the code's trailing expression, and raises `BlenderError` with Blender's traceback. `blender.close()` ends Blender. Without a GPU, render with Cycles on the CPU. Render an animation with `render_detached` on a saved `.blend`, which outlives this session, and `encode` its frames into an MP4.
