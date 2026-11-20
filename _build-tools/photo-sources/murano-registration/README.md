# Murano overview registration source

This directory preserves the three genuine merchant photographs and the deterministic recipe used to make `../murano-registered-master.png`.

The overview photograph supplies the entire composition, color, and low-frequency structure. Detail photographs 2 and 4 contribute only a high-frequency luminance band inside upper-crown patches that pass all of these gates: SIFT matching, MAGSAC homography, bounded piecewise flow, independent 32 x 32 high-pass correlation, gradient agreement, intensity agreement, and texture checks. Pixels outside the feathered accepted mask are copied back from the overview byte-for-byte. No generative imagery is used.

## Reproduce

The verified build used CPython 3.12.13, `numpy==2.5.5`, and
`opencv-python-headless==5.1.0.95`. From the repository root, create an
isolated environment with those same dependencies and run the recipe:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install \
  "numpy==2.5.5" \
  "opencv-python-headless==5.1.0.95"

.venv/bin/python \
  _build-tools/photo-sources/murano-registration/fuse.py \
  --output-dir /tmp/kigb-murano-registration

shasum -a 256 \
  /tmp/kigb-murano-registration/output/murano-overview-genuine-multiframe-master-1280.png
```

The expected SHA-256 is recorded in `provenance.json`. The temporary output also contains masks, registered-frame evidence, same-scale upper-crown crops, and measured registration metrics.

## Honest scope

Only the upper crown has defensible higher-sampling overlap. The lower chandelier, room, and every area without accepted correspondence remain the enlarged overview photograph. This master is therefore a surgical merchant-photo restoration, not a newly reconstructed or universally tack-sharp photograph.
