# /tmp/bits-chromium-env.sh
# Sourced fragment: shared-lib path for the existing Google Chrome for Testing
#   /home/atlas/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome  (156.0.8078.4)
# NixOS: libs live in /nix/store; the ELF interpreter /lib64/ld-linux-x86-64.so.2 is the
# nix-ld 2.0.6 shim, which honours LD_LIBRARY_PATH. No system package was installed.
#
# Usage:
#   . /tmp/bits-chromium-env.sh
#   "$CHROME_BIN" --version          # -> Google Chrome for Testing 156.0.8078.4
#
# Verified: ldd reports no "not found"; --version exits 0. No browser instance started.

export CHROME_BIN="${CHROME_BIN:-/home/atlas/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome}"
export DISPLAY="${DISPLAY:-:0}"

_BITS_CHROMIUM_LIBS="\
/nix/store/7mf69bavdjazjvbhflj0s40d2a6mk5wb-glib-2.88.3/lib:\
/nix/store/ala3sdcr1r34kkhsa1nd3g3daf7bxhab-at-spi2-core-2.60.6/lib:\
/nix/store/923pgfgbhs1y8157yv2s7sxgvryabmk6-dbus-1.16.2-lib/lib:\
/nix/store/r1faw9jwwhwmm9xs5lc66lig8y6a90cq-cups-2.4.19-lib/lib:\
/nix/store/7rx5im6jbgyfhrl0lc0kyxd9yf14rdxc-expat-2.9.0/lib:\
/nix/store/b9c155jq2sjw757ywkazvlnl9kyjmcc7-libxcb-1.17.0/lib:\
/nix/store/n2wqk78za8grzs9088ya5qy6vw280p8x-libxkbcommon-1.13.2/lib:\
/nix/store/z6v6qc8cy50i90afg4kgbr4jrfg5fdnc-alsa-lib-1.2.16.1/lib:\
/nix/store/5sw8x6gdi0gwri8pj1vm7ikyyqzh02fi-mesa-libgbm-26.1.3/lib:\
/nix/store/2g9xwk5kis01003gynr7xfca667dpgv8-libx11-1.8.13/lib:\
/nix/store/c9asg9zdzspijnqay6jz1ddsxpaa2dvw-libxext-1.3.7/lib:\
/nix/store/4rpqihai8nnrjqdmk79jbf5hgxhl5zx6-libxcomposite-0.4.7/lib:\
/nix/store/3xz6nnla8wcq57adm8jzlxhda2vq5ws8-libxdamage-1.1.7/lib:\
/nix/store/2jwg8dipm605rfs9f6350nvx5yi7nnpw-libxfixes-6.0.2/lib:\
/nix/store/2cf75gbn2qk5hbm4kdzgg545mky5gxh7-libxrandr-1.5.5/lib:\
/nix/store/4kjswvfkf6y84p4yk61d04gcyny5v9kg-cairo-1.18.4/lib:\
/nix/store/bb2f9n4m0ym61y2wmg236312k5pjq1bj-pango-1.57.1/lib:\
/nix/store/qn46jzdrsvkpknd7zq7ndxw3l28syhcv-nss-3.128/lib:\
/nix/store/hs1dngj4cj52ndiiw29warswazbvgi67-nspr-4.40/lib:\
/run/current-system/sw/share/nix-ld/lib"

# Prepend; keep whatever the caller already had after it.
export LD_LIBRARY_PATH="/run/opengl-driver/lib:/nix/store/6pqvd4fj7azwfx8xp21fa8f9zmf8r1d6-system-path/lib:/nix/store/ww5pckflswny9whz04k06xh233jbg5kl-libglvnd-1.7.0/lib:${LD_LIBRARY_PATH:-}"
export LD_LIBRARY_PATH="${_BITS_CHROMIUM_LIBS}${LD_LIBRARY_PATH}"
unset _BITS_CHROMIUM_LIBS