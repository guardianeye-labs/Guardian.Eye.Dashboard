#!/usr/bin/env python3
"""Preserve immutable version URLs and the legacy entry point; publish the current catalog."""
import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
site = args.output.resolve()
assert not site.exists(), 'Use a new output directory'
site.mkdir(parents=True)
(site / '.nojekyll').touch()
for tag in subprocess.check_output(['git', 'tag', '--list', 'v*'], cwd=root, text=True).splitlines():
    with tempfile.TemporaryDirectory() as scratch:
        archive = Path(scratch) / 'tag.tar'
        with archive.open('wb') as f:
            subprocess.run(['git', 'archive', tag, 'dist'], cwd=root, stdout=f, check=True)
        with tarfile.open(archive) as tar:
            tar.extractall(scratch, filter='data')
        shutil.copytree(Path(scratch) / 'dist', site / tag)
# Older GE clients cannot negotiate compatibility. Never give them a newer incompatible 'latest'.
shutil.copytree(site / 'v1.0.10', site / 'latest')
shutil.copy2(root / 'legacy-dashboard-release.json', site / 'latest/guardian-eye-dashboard-release.json')
shutil.copy2(root / 'releases.json', site / 'releases.json')
