#!/usr/bin/env python3
"""Write one release version into every file that carries it.

The version comes from GitVersion in CI. Everything else in the release record (Guardian Eye
compatibility, Home Assistant minimum) is edited by hand in dist/guardian-eye-dashboard-release.json
and kept as is; only the version and the version-derived links change here.
"""
import argparse
import json
from pathlib import Path
import re

PAGES = 'https://guardianeye-labs.github.io/Guardian.Eye.Dashboard'
REPO = 'https://github.com/guardianeye-labs/Guardian.Eye.Dashboard'


def dump(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def stamp(root, version):
    assert re.fullmatch(r'\d+\.\d+\.\d+', version), f'Invalid release version: {version}'
    component = root / 'integration/custom_components/guardian_eye'
    tag = f'v{version}'

    package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
    package['version'] = version
    dump(root / 'package.json', package)

    # Component and dashboard ship together, so they carry one number.
    manifest = json.loads((component / 'manifest.json').read_text(encoding='utf-8'))
    manifest['version'] = version
    dump(component / 'manifest.json', manifest)

    release_path = root / 'dist/guardian-eye-dashboard-release.json'
    release = json.loads(release_path.read_text(encoding='utf-8'))
    release.update(
        version=version,
        resourceUrl=f'{PAGES}/{tag}/Guardian.Eye.Dashboard.js',
        integrationVersion=version,
        integrationDownloadUrl=f'{REPO}/releases/download/{tag}/guardian-eye-integration.zip',
        setupDownloadUrl=f'{REPO}/releases/download/{tag}/guardian-eye-ha-setup.zip',
        installationUrl=f'{REPO}/blob/{tag}/docs/INSTALL.md',
    )
    dump(release_path, release)
    dump(component / 'frontend/guardian-eye-dashboard-release.json', release)

    for folder in (root / 'dist', component / 'frontend'):
        for script in folder.glob('*.js'):
            text = script.read_text(encoding='utf-8')
            stamped = re.sub(r'\?v=\d+\.\d+\.\d+', f'?v={version}', text)
            if stamped != text:
                script.write_text(stamped, encoding='utf-8')

    # The catalog keeps every published release: the current one is replaced or added on top.
    catalog_path = root / 'releases.json'
    catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
    catalog['releases'] = [release] + [r for r in catalog['releases'] if r['version'] != version]
    dump(catalog_path, catalog)
    print(f'Stamped {version}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('version')
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    stamp(args.root, args.version)
