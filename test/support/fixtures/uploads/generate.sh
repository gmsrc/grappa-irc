#!/usr/bin/env bash
# Regenerates the metadata-bearing upload fixtures. Needs exiftool +
# ffmpeg (both in the grappa container image since the metadata-strip
# cluster). Fixtures are committed — rerun only if the strip test
# assertions change. Coordinates are the Colosseum; any real-looking
# value works, the tests assert on marker STRINGS, not coordinates.
set -euo pipefail
cd "$(dirname "$0")"

# jpeg: EXIF APP1 with GPS + device identity (the iPhone leak shape)
ffmpeg -y -loglevel error -f lavfi -i color=c=red:s=32x32 -frames:v 1 gps.jpg
exiftool -q -overwrite_original \
  -GPSLatitude=41.9028 -GPSLatitudeRef=N \
  -GPSLongitude=12.4964 -GPSLongitudeRef=E \
  -Make=Apple -Model="iPhone 15 Pro" \
  -DateTimeOriginal="2026:06:10 12:00:00" gps.jpg

# png: same EXIF, stored in the PNG eXIf chunk
ffmpeg -y -loglevel error -f lavfi -i color=c=red:s=32x32 -frames:v 1 gps.png
exiftool -q -overwrite_original \
  -GPSLatitude=41.9028 -GPSLatitudeRef=N \
  -GPSLongitude=12.4964 -GPSLongitudeRef=E \
  -Make=Apple gps.png

# mp4: udta loci + (c)xyz from ffmpeg, mdta Keys GPS + Make from
# exiftool — the three QuickTime spots Apple devices write GPS to
ffmpeg -y -loglevel error -f lavfi -i color=c=blue:s=64x64:d=1 \
  -c:v libx264 -pix_fmt yuv420p \
  -metadata location="+41.9028+12.4964/" \
  -metadata location-eng="+41.9028+12.4964/" gps.mp4
exiftool -q -overwrite_original \
  -Keys:GPSCoordinates="41.9028 12.4964" -Keys:Make=Apple gps.mp4

# mov: same QuickTime family as mp4, distinct container brand —
# pins the video/quicktime ext mapping
ffmpeg -y -loglevel error -f lavfi -i color=c=yellow:s=64x64:d=1 \
  -c:v libx264 -pix_fmt yuv420p \
  -metadata location="+41.9028+12.4964/" -f mov gps.mov
exiftool -q -overwrite_original \
  -Keys:GPSCoordinates="41.9028 12.4964" -Keys:Make=Apple gps.mov

# webm: Matroska Title/Comment — exiftool can't write Matroska, this
# fixture pins the ffmpeg-remux strip path
ffmpeg -y -loglevel error -f lavfi -i color=c=green:s=64x64:d=1 \
  -c:v libvpx-vp9 \
  -metadata title="secret title" \
  -metadata COMMENT="GPS 41.9028,12.4964" sample.webm
mv sample.webm tagged.webm

# oriented jpeg: EXIF Orientation=6 (Rotate 90 CW — portrait iPhone
# shape) ALONGSIDE the GPS/identity leak tags. Pins the strip
# whitelist: privacy tags must die, presentation-critical Orientation
# must survive (#39 round 2 — -all= alone made every portrait photo
# render sideways).
ffmpeg -y -loglevel error -f lavfi -i color=c=cyan:s=32x48 -frames:v 1 oriented.jpg
exiftool -q -overwrite_original \
  -GPSLatitude=41.9028 -GPSLatitudeRef=N \
  -GPSLongitude=12.4964 -GPSLongitudeRef=E \
  -Make=Apple -Model="iPhone 15 Pro" \
  -Orientation#=6 oriented.jpg

# p3 jpeg: a Display-P3 ICC profile embedded ALONGSIDE the GPS/identity
# leak — the iPhone wide-gamut shape (#416). Pins the whitelist in both
# directions: ICC_Profile is presentation-critical (stripping it makes
# the browser read P3 pixels as sRGB → washed out) and MUST survive,
# while GPS/Make/Model are privacy payload and MUST die. The profile
# source `display-p3.icc` is COMMITTED next to this script (the standard
# Display P3 matrix profile — the same colour space an iPhone embeds; a
# committed source keeps this reproducible in the container, which ships
# no ICC profiles). Its description is UTF-16 `mluc`, so the kept
# profile carries no ASCII marker string that could fool the strip test.
ffmpeg -y -loglevel error -f lavfi -i color=c=magenta:s=32x32 -frames:v 1 p3.jpg
exiftool -q -overwrite_original \
  -GPSLatitude=41.9028 -GPSLatitudeRef=N \
  -GPSLongitude=12.4964 -GPSLongitudeRef=E \
  -Make=Apple -Model="iPhone 15 Pro" \
  -DateTimeOriginal="2026:06:10 12:00:00" \
  "-icc_profile<=display-p3.icc" p3.jpg
