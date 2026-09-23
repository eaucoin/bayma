# Encodes a folder of numbered PNG frames into an H.264 MP4 with Blender's
# own FFmpeg, through its video sequencer:
#   blender -b --factory-startup --python encode.py -- frames/ out.mp4 24
import os
import sys

import bpy

frames_dir, output, fps = sys.argv[sys.argv.index("--") + 1:]
frames = sorted(name for name in os.listdir(frames_dir) if name.endswith(".png"))
scene = bpy.context.scene
scene.render.fps = int(fps)
editor = scene.sequence_editor_create()
strip = editor.strips.new_image("frames", os.path.join(frames_dir, frames[0]), 1, 1)
for name in frames[1:]:
    strip.elements.append(name)
first = bpy.data.images.load(os.path.join(frames_dir, frames[0]))
scene.render.resolution_x, scene.render.resolution_y = first.size
scene.render.resolution_percentage = 100
scene.frame_start, scene.frame_end = 1, len(frames)
scene.render.image_settings.media_type = "VIDEO"  # Blender 5: video is its own media type
scene.render.image_settings.file_format = "FFMPEG"
scene.render.ffmpeg.format = "MPEG4"
scene.render.ffmpeg.codec = "H264"
scene.render.ffmpeg.constant_rate_factor = "HIGH"
scene.render.ffmpeg.ffmpeg_preset = "GOOD"
scene.render.filepath = output
bpy.ops.render.render(animation=True)
print(f"ENCODED {len(frames)} frames to {output}")
