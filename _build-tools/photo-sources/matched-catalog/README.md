# Exact-frame catalog masters

`manifest.json` binds each merchant image key to a verified, higher-resolution
manufacturer photograph, its source URL and SHA-256, the repository-relative
master path, the master SHA-256, dimensions, and the geometric verification.

The two square product photographs are byte-for-byte copies of the official
manufacturer files because their framing already matches the merchant images
to subpixel error. The Oros room photograph uses a frozen similarity transform
to reproduce the merchant image's portrait placement and white square matte on
a 2048 x 2048 canvas. The transform has one uniform scale and a negligible
rotation; it does not stretch, generatively extend, or replace scene content.

The original manufacturer downloads are preserved under `originals/`.

## Rebuild

The verified build used CPython 3.12.13, NumPy 2.5.5, and
opencv-python-headless 5.1.0.95:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install \
  "numpy==2.5.5" \
  "opencv-python-headless==5.1.0.95"
.venv/bin/python _build-tools/photo-sources/matched-catalog/build.py
```
