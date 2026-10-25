#!/usr/bin/env bash
# Build the Lambda package into ./build (zipped by Terraform's archive_file).
# Pillow is installed as a Linux wheel so it works in Lambda even when built on macOS.
# boto3 is already part of the python3.12 Lambda runtime and is not bundled.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf build && mkdir build
pip install -r requirements.txt --target build \
  --platform manylinux_2_28_x86_64 --python-version 3.12 --implementation cp \
  --only-binary=:all: --quiet
cp src/handler.py build/
echo "Built $(du -sh build | cut -f1) in ./build"
