# -*- mode: python ; coding: utf-8 -*-
import os
from pathlib import Path

src_dir = str(Path('src/smux/static').resolve())

a = Analysis(
    ['smux_app.py'],
    pathex=['src'],
    binaries=[],
    datas=[
        ('src/smux/static', 'static'),
    ],
    hiddenimports=[
        'smux.main',
        'smux.daemon',
        'smux.server',
        'smux.pty_manager',
        'webview',
        'webview.platforms.cocoa',
        'aiohttp',
        'aiohttp.web',
        'aiohttp.web_runner',
        'ptyprocess',
        'multiprocessing',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='smux',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='smux',
)

app = BUNDLE(
    coll,
    name='smux.app',
    icon='smux.app/Contents/Resources/AppIcon.icns',
    bundle_identifier='com.smux.app',
    info_plist={
        'CFBundleName': 'smux',
        'CFBundleDisplayName': 'smux',
        'CFBundleVersion': '1.0.0',
        'CFBundleShortVersionString': '1.0.0',
        'NSHighResolutionCapable': True,
        'LSMinimumSystemVersion': '12.0',
        'NSRequiresAquaSystemAppearance': False,
    },
)
