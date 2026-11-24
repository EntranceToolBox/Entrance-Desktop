#!/usr/bin/env bash
set -euo pipefail

build=$1
dist=$2
version=$3
node=$4
arch=$(uname -m)
mkdir -p "$dist"
work=$(mktemp -d "$dist/.appimage.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
appdir="$work/Entrance.AppDir"
cmake --install "$build" --config Release --prefix "$appdir/usr" > "$work/install.log" || {
    cat "$work/install.log" >&2
    exit 1
}

ln -s usr/bin/entrance-desktop "$appdir/AppRun"
cp "$appdir/usr/share/applications/entrance-desktop.desktop" "$appdir/"
# Desktop integration launches the AppImage itself, outside the AppDir's PATH.
sed -i '/^TryExec=/d' "$appdir/entrance-desktop.desktop"
cp "$appdir/usr/share/icons/hicolor/512x512/apps/entrance-desktop.png" "$appdir/"
ln -s entrance-desktop.png "$appdir/.DirIcon"

# Distributions can link Node against system ICU, OpenSSL or libnode. Keep
# their lookup path private to Node so GTK and WebKit use the host libraries.
install -m 755 "$node" "$appdir/usr/bin/node"
libdir="$appdir/usr/lib/entrance-node"
mkdir -p "$libdir"
ldd "$node" > "$work/node.libs"
if grep -q '=> not found' "$work/node.libs"; then
    cat "$work/node.libs" >&2
    exit 1
fi
while read -r soname resolved; do
    case "$soname" in
        libc.so.*|libm.so.*|libdl.so.*|libpthread.so.*|librt.so.*|libresolv.so.*|libutil.so.*) continue ;;
    esac
    cp -L -- "$resolved" "$libdir/$soname"
done < <(awk '$2 == "=>" && $3 ~ /^\// { print $1, $3 }' "$work/node.libs")
patchelf --force-rpath --set-rpath '$ORIGIN/../lib/entrance-node' "$appdir/usr/bin/node"

image="Entrance-Desktop-$version-$arch.AppImage"
if command -v appimagetool >/dev/null && [[ -z ${APPIMAGE_RUNTIME:-} ]]; then
    ARCH="$arch" VERSION="$version" appimagetool "$appdir" "$work/$image"
else
    # Reuse the Type 2 runtime from earlier electron-builder builds if present.
    case "$arch" in
        x86_64) suffix=x64 ;; aarch64) suffix=arm64 ;; armv7l) suffix=armv7l ;;
        i?86) suffix=ia32 ;; *) suffix="$arch" ;;
    esac
    cache=${ELECTRON_BUILDER_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/electron-builder}
    runtime=${APPIMAGE_RUNTIME:-$cache/appimage/appimage-12.0.1/runtime-$suffix}
    if [[ ! -r "$runtime" ]]; then
        echo 'Install appimagetool or set APPIMAGE_RUNTIME to a matching Type 2 runtime and install squashfs-tools.' >&2
        exit 1
    fi
    mksquashfs "$appdir" "$work/payload" -noappend -comp gzip -all-root -no-progress
    cat "$runtime" "$work/payload" > "$work/$image"
fi
chmod 755 "$work/$image"
mv -f -- "$work/$image" "$dist/$image"
echo "$dist/$image"
