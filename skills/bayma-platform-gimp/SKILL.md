---
name: bayma-platform-gimp
description: Inspect the source of and execute code against libgimp in a headless GIMP kept, with its fonts, in this skill's folder; edit, compose, filter, and export images as GIMP does.
---

# GIMP Platform

This skill shows you where to find the relevant sources to reference when writing correct source code or interactively executing code that interacts with the platform appropriately. The skill owns GIMP: the application, its fonts, and its settings live in its own folder, `<skill>` below. Code runs inside a headless GIMP, as a plug-in's would, through libgimp's Python bindings.

## Reference Materials

- `<skill>/gimp/reference/libgimp/*.c`: libgimp, with every function documented; `gimp_image_new` is `Gimp.Image.new`
- `<skill>/gimp/reference/libgimp{base,color,config,math}/*.c`: the libraries under it
- `<skill>/gimp/reference/plug-ins/python/*.py`: GIMP's own Python plug-ins
- In GIMP: `Gimp.get_pdb().lookup_procedure(name)` for any of its procedures, `Gegl.list_operations()` for the filters `Gimp.DrawableFilter` applies, and `Gimp.fonts_get_list("")` for its fonts, by the full names `Gimp.Font.get_by_name` takes, such as `Noto Sans SC Regular`

If these materials are missing, install GIMP, in a bayma Bun session whose `cwd` is `<skill>`:

```ts
await Bun.$`${process.execPath} install.ts 2>&1`.nothrow().text();
```

`<skill>/fonts.json` chooses the fonts; set `googleFonts` to `true`, and install again, for the whole Google Fonts library (about 2.5 GB).

## Interactive Quickstart

In a bayma Python session whose `cwd` is `<skill>`:

```python
from gimp_host import GimpHost, GimpError

gimp = GimpHost()
gimp("Gimp.version(), len(Gimp.fonts_get_list(''))")
```

`gimp(code)` runs Python inside GIMP, where `Gimp`, `Gegl`, `Gio`, and `GLib` are imported and names persist between calls. It returns the repr of the code's trailing expression, and raises `GimpError` with GIMP's traceback. `gimp.close()` ends GIMP.
