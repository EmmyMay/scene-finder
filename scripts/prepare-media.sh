#!/usr/bin/env bash
set -euo pipefail
# Build the two command-line media tools from verified, bundled source archives.
# macOS: Xcode CLI tools, make, pkg-config (and nasm on Intel).
# Linux: compiler, make, pkg-config, nasm, curl, tar, xz.
# Windows: run in an MSYS2 MINGW64 shell with GCC, make, pkgconf, nasm, curl, tar, xz.
root=$(cd "$(dirname "$0")/.." && pwd)
source_dir=$(cd "$(dirname "$0")" && pwd)
cache="$root/.data/media-downloads"
out="$root/.data/media"
mkdir -p "$cache" "$out/sources"
build=$(mktemp -d "${TMPDIR:-/tmp}/scene-finder-media.XXXXXX")
trap 'rm -rf "$build"' EXIT
ffmpeg_version=8.0.1
x264_commit=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
fetch() {
  local url=$1 name=$2 expected=$3 actual
  if [ ! -f "$cache/$name" ]; then
    if [ -f "$source_dir/$name" ]; then cp "$source_dir/$name" "$cache/$name";
    else
      curl --fail --location --retry 3 "$url" -o "$cache/$name.partial"
      mv "$cache/$name.partial" "$cache/$name"
    fi
  fi
  if command -v sha256sum >/dev/null; then actual=$(sha256sum "$cache/$name" | cut -d' ' -f1);
  else actual=$(shasum -a 256 "$cache/$name" | cut -d' ' -f1); fi
  if [ "$actual" != "$expected" ]; then echo "Checksum mismatch: $name" >&2; exit 1; fi
  cp "$cache/$name" "$out/sources/$name"
  tar -xf "$cache/$name" -C "$build"
}
fetch "https://ffmpeg.org/releases/ffmpeg-$ffmpeg_version.tar.xz" "ffmpeg-$ffmpeg_version.tar.xz" 05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41
fetch "https://code.videolan.org/videolan/x264/-/archive/$x264_commit/x264-$x264_commit.tar.gz" "x264-$x264_commit.tar.gz" cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9
export PKG_CONFIG_PATH="$build/prefix/lib/pkgconfig"
extra=(--disable-autodetect)
suffix=""
case "$(uname -s)" in
  Darwin) export MACOSX_DEPLOYMENT_TARGET=13.0; jobs=$(sysctl -n hw.ncpu) ;;
  Linux) jobs=$(getconf _NPROCESSORS_ONLN) ;;
  MINGW*|MSYS*) jobs=${NUMBER_OF_PROCESSORS:-4}; suffix=.exe; extra+=(--target-os=mingw32 --arch=x86_64 --cc=gcc --extra-ldflags=-static) ;;
  *) echo 'Unsupported build host' >&2; exit 1 ;;
esac
cd "$build/x264-$x264_commit"
./configure --prefix="$build/prefix" --enable-static --enable-pic --disable-cli --disable-opencl
make -j"$jobs"
make install
cp COPYING "$out/COPYING.x264"
cd "$build/ffmpeg-$ffmpeg_version"
./configure --disable-network --enable-gpl --enable-libx264 --enable-pthreads --enable-static --disable-shared --disable-doc --disable-debug --disable-ffplay --pkg-config-flags=--static "${extra[@]}"
make -j"$jobs" ffmpeg"$suffix" ffprobe"$suffix"
cp ffmpeg"$suffix" ffprobe"$suffix" COPYING.GPLv2 "$out/"
cp "$source_dir/prepare-media.sh" "$out/sources/prepare-media.sh"
./ffmpeg"$suffix" -buildconf > "$out/BUILD_CONFIGURATION.txt" 2>&1
printf 'Built native FFmpeg and FFprobe in %s\n' "$out"
