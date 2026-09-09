#!/usr/bin/env python3
"""Build a version-consistent HA bundle from an exported public repository."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile


def package(root, output):
    root, output = Path(root), Path(output)
    release = json.loads((root / 'dist/guardian-eye-dashboard-release.json').read_text())
    catalog = json.loads((root / 'releases.json').read_text())
    component = root / 'integration/custom_components/guardian_eye'
    manifest = json.loads((component / 'manifest.json').read_text())
    assert re.fullmatch(r'\d+\.\d+\.\d+', release['version']), 'Invalid dashboard version'
    assert release in catalog['releases'], 'Current release is absent or different in compatibility catalog'
    assert release['integrationVersion'] == manifest['version'], 'Component and dashboard versions disagree'
    assert json.loads((root / 'package.json').read_text())['version'] == release['version']
    assert json.loads((component / 'frontend/guardian-eye-dashboard-release.json').read_text()) == release, \
        'Bundled panel does not match the component release'
    for source in (root / 'dist').iterdir():
        if source.is_file():
            assert (component / 'frontend' / source.name).read_bytes() == source.read_bytes(), \
                f'Bundled panel file is missing or stale: {source.name}'
    for f in (root / 'dist').glob('*.js'):
        revisions = re.findall(r'\?v=(\d+\.\d+\.\d+)', f.read_text())
        assert all(v == release['version'] for v in revisions), f'Stale module revision in {f.name}'
    assert 'custom_components' not in str(root / 'dist'), 'Invalid export directory'
    for f in component.glob('*.py'):
        compile(f.read_text(), str(f), 'exec')
    for f in component.rglob('*.json'):
        json.loads(f.read_text())
    output.mkdir(parents=True, exist_ok=True)

    def files(folder, prefix):
        return [(f, prefix + f.relative_to(folder).as_posix()) for f in sorted(folder.rglob('*'))
                if f.is_file() and '__pycache__' not in f.parts and f.suffix != '.pyc']

    def write(name, entries):
        target = output / name
        with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for source, relative in entries:
                info = zipfile.ZipInfo(relative, date_time=(2026, 1, 1, 0, 0, 0))
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, source.read_bytes())
            info = zipfile.ZipInfo('guardian-eye-package.json', date_time=(2026, 1, 1, 0, 0, 0))
            z.writestr(info, json.dumps(release, indent=2) + '\n')
        return target

    guides = [(root / 'docs/INSTALL.md', 'INSTALL.md'), (root / 'docs/INSTALL.ru.md', 'INSTALL.ru.md')]
    assets = [
        write('guardian-eye-dashboard.zip', files(root / 'dist', 'guardian-eye-dashboard/') + guides),
        write('guardian-eye-integration.zip', files(component, 'custom_components/guardian_eye/') + guides),
        write('guardian-eye-ha-setup.zip', files(component, 'custom_components/guardian_eye/') + guides),
    ]
    (output / 'SHA256SUMS.txt').write_text(''.join(
        f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in assets))
    print(f"Built dashboard {release['version']} + component {manifest['version']} ({len(assets)} packages)")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    package(args.root, args.output)
